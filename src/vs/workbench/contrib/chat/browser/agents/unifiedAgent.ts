/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { hash } from '../../../../../base/common/hash.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILoCoPilotFileLog } from '../locopilotFileLog.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { IChatAgentRequest, IChatAgentResult } from '../../common/participants/chatAgents.js';
import { IChatProgress, IChatToolInvocation } from '../../common/chatService/chatService.js';
import { ChatToolInvocation } from '../../common/model/chatProgressTypes/chatToolInvocation.js';
import { ChatImageMimeType, ChatMessageRole, IChatMessage, IChatMessageImagePart, IChatMessageTextPart, IChatMessageToolResultPart, IChatResponseToolUsePart, ILanguageModelsService, LanguageModelPartAudience } from '../../common/languageModels.js';
import { ILanguageModelToolsService, IToolData, toolMatchesModel } from '../../common/tools/languageModelToolsService.js';
import { IChatTodo, IChatTodoListService } from '../../common/tools/chatTodoListService.js';
import { ManageTodoListToolToolId } from '../../common/tools/builtinTools/manageTodoListTool.js';
import { AGENT_LOOP_EXCLUDED_TOOL_IDS, EDIT_TOOL_IDS, isToolExcluded } from '../../common/tools/builtinTools/agentToolPolicy.js';
import { parsePartialJsonObject } from '../../common/tools/partialJsonInput.js';
import { ContextManager } from './contextManager.js';
/**
 * Unified agent that runs the language model with the given messages and streams progress.
 * This implements a full agentic loop with tool calling support.
 * Iterates until the LLM makes no more tool calls (natural completion) or max iterations.
 */
/** Max times the same tool+args can be called before we force-stop to avoid loops. */
const REPEATED_TOOL_CALL_THRESHOLD = 5;

/** Sliding window size for detecting repeated tool calls. */
const REPEATED_TOOL_CALL_WINDOW = 6;

const DEFAULT_MAX_ITERATIONS = 50;

/**
 * Self-correction scaffolding. Small/local models don't reliably form recovery hypotheses from raw
 * tool errors, and they keep re-trying logically-identical actions with slightly different args
 * (which the exact-args repeat guard above can't see). These thresholds drive a *semantic* layer:
 * we classify each error into a signature and escalate HINTS based on how often the same CLASS of
 * error recurs, regardless of the exact arguments. These hints never halt the agent.
 */
/** After the same error CLASS recurs this many times, inject a corrective "change your approach" nudge. */
const SEMANTIC_ERROR_CORRECTION_THRESHOLD = 2;
/**
 * Repeated errors NEVER hard-stop the agent - they only escalate hints. The model is given
 * progressively stronger guidance and left free to keep trying. The only hard stops are the two
 * existing safety nets: MAX_ITERATIONS and the exact same-tool+same-args repeat guard
 * (REPEATED_TOOL_CALL_THRESHOLD). This keeps the agent unblocked, per the "hint, don't halt" rule.
 */
/** Consecutive iterations where every tool call errored (no successful edit) before we force a re-orient. */
const NO_PROGRESS_REORIENT_THRESHOLD = 3;

/** Tool ids that mutate the workspace - a successful call to one of these counts as real progress. */
const MUTATING_TOOL_IDS = new Set<string>(['createFile', 'editFile', 'insertCode', 'modifyFile', 'editFile_internal']);

/**
 * Tool ids that are safe to run concurrently within a single agent turn: read-only inspection
 * tools plus runSubagent (used for read-only parallel research). Edit/mutating tools are
 * deliberately excluded so they run sequentially and never race on the same files.
 */
/** Minimum time between streaming tool-card repaints, so we don't re-render per generated token. */
const TOOL_STREAM_UPDATE_INTERVAL_MS = 100;

/**
 * A tool-invocation card begun while the call's arguments were still streaming from the model.
 * `invocation` is undefined when the tool doesn't implement handleToolStream (no card shown).
 */
interface IStreamingToolCard {
	invocation: IChatToolInvocation | undefined;
	/** Latest full raw argument text waiting to be pushed to the card (coalesces bursts of deltas). */
	pendingArgs?: string;
	flushing: boolean;
}

const PARALLELIZABLE_TOOL_IDS = new Set<string>([
	'semanticSearch',
	'readFile',
	'listDirectory',
	'grep',
	'findFiles',
	'readLints',
	'outline',
	'gitStatus',
	'gitDiff',
	'webSearch',
	'runSubagent',
]);

/** Max chat sessions whose transcripts we keep in memory (LRU eviction). */
const MAX_STORED_TRANSCRIPTS = 20;

/**
 * Hard cap on the stored cross-turn transcript, in characters (~4k tokens at ~4 chars/token).
 * This is deliberately an ABSOLUTE cap, not a fraction of the model window: replaying a huge
 * transcript makes every follow-up turn pay full prompt re-processing on local models (SWA
 * models like Gemma periodically re-evaluate the ENTIRE prompt - 16k replayed tokens took
 * ~2.5 minutes on an M3). ~4k tokens keeps follow-up turns as fast as the old markdown rebuild
 * while still carrying WHAT happened (calls made, files touched, outcomes).
 */
const STORED_TRANSCRIPT_MAX_CHARS = 16000;
/** Per-part cap inside the stored transcript (~200 tokens): results were already acted on. */
const STORED_PART_MAX_CHARS = 800;
/** Cap per string argument in a stored tool_use: paths/snippets survive, full file bodies don't. */
const STORED_TOOL_ARG_MAX_CHARS = 400;

/** A session's real conversation (tool calls + results included), stored after each turn. */
interface IStoredTranscript {
	/** Non-system messages, compacted for storage (large payloads stubbed, total size capped). */
	readonly messages: IChatMessage[];
	/** History length the NEXT request must have for this transcript to still be valid. */
	readonly expectedHistoryLength: number;
}

/** A ready-to-send warm-up request plus a content signature that keys its persisted KV slot cache. */
export interface IWarmPrefix {
	/** The system + trivial-user messages a real first turn's prefix would begin with. */
	readonly messages: IChatMessage[];
	/** Request options (carries the tool set when non-empty). */
	readonly options: any;
	/** Stable hex hash of the prefix content (system prompt + tool JSON); identifies a matching disk cache. */
	readonly signature: string;
}

export class UnifiedAgent {
	private readonly MAX_ITERATIONS: number;
	private readonly contextManager: ContextManager;

	/**
	 * Real per-session transcripts (tool_use/tool_result included), keyed by session resource.
	 * Rebuilding history from rendered markdown loses all tool activity - on turn 2 the model
	 * would not know which files it edited on turn 1. Keeping the actual messages (already
	 * compacted by the ContextManager) preserves that knowledge at whatever size the model's
	 * window allows. In-memory only: after a window reload we fall back to the markdown rebuild.
	 */
	private readonly sessionTranscripts = new Map<string, IStoredTranscript>();

	constructor(
		private readonly languageModelsService: ILanguageModelsService,
		private readonly toolsService: ILanguageModelToolsService,
		private readonly logService: ILogService,
		_workspaceService: IWorkspaceContextService,
		private readonly locopilotFileLog: ILoCoPilotFileLog,
		private readonly chatTodoListService: IChatTodoListService,
		maxIterations: number = DEFAULT_MAX_ITERATIONS
	) {
		// Honor the user's "Max iterations per request" setting, which the settings UI allows up to 500.
		// (Previously capped at 100 here, silently overriding higher user-chosen values.)
		this.MAX_ITERATIONS = Math.min(500, Math.max(1, maxIterations));
		this.contextManager = new ContextManager(
			this.languageModelsService,
			(msg, ...args) => this._log(msg, ...args)
		);
	}

	private _log(msg: string, ...args: unknown[]): void {
		this.logService.info(msg, ...args);
		this.locopilotFileLog.log(msg, ...args);
	}

	/**
	 * The stored transcript for a session, or undefined when none exists or the chat history no
	 * longer matches (user edited/regenerated/deleted a turn - the transcript would then contain
	 * responses that no longer exist, so it is discarded and the caller rebuilds from history).
	 */
	getStoredTranscript(sessionKey: string, currentHistoryLength: number): IChatMessage[] | undefined {
		const stored = this.sessionTranscripts.get(sessionKey);
		if (!stored) {
			return undefined;
		}
		if (stored.expectedHistoryLength !== currentHistoryLength) {
			this._log(`[LoCoPilot] Stored transcript for session invalidated (expected history ${stored.expectedHistoryLength}, got ${currentHistoryLength})`);
			this.sessionTranscripts.delete(sessionKey);
			return undefined;
		}
		return stored.messages;
	}

	/**
	 * Remove assistant tool_use parts that have no matching tool_result (a cancelled turn can end
	 * mid-call). Providers like Anthropic reject a replayed tool_use without its result, so the
	 * stored transcript must never contain an unpaired one.
	 */
	private sanitizeTranscript(messages: IChatMessage[]): IChatMessage[] {
		const resultIds = new Set<string>();
		for (const m of messages) {
			for (const p of m.content) {
				if (p.type === 'tool_result') {
					resultIds.add((p as IChatMessageToolResultPart).toolCallId);
				}
			}
		}
		const out: IChatMessage[] = [];
		for (const m of messages) {
			if (m.role !== ChatMessageRole.Assistant) {
				out.push(m);
				continue;
			}
			const content = m.content.filter(p => p.type !== 'tool_use' || resultIds.has((p as IChatResponseToolUsePart).toolCallId));
			if (content.length > 0) {
				out.push(content.length === m.content.length ? m : { role: m.role, content });
			}
		}
		return out;
	}

	/** Approximate size of a message for the storage cap (JSON covers text, args and results). */
	private messageSizeChars(msg: IChatMessage): number {
		try {
			return JSON.stringify(msg.content).length;
		} catch {
			return STORED_PART_MAX_CHARS; // circular/unserializable content: assume a stub-sized cost
		}
	}

	/**
	 * Shrink a transcript for cross-turn storage:
	 *  1. Stub large tool results and text parts (they were already acted on this turn).
	 *  2. Truncate long string arguments inside tool_use parts (a modifyFile call carries the whole
	 *     file body in newString - the path and a snippet are enough for memory).
	 *  3. Enforce an absolute total cap by dropping the OLDEST messages, pair-safe.
	 * Keeps follow-up turns as cheap as the old markdown history rebuild (see cap docs above).
	 */
	private compactForStorage(messages: IChatMessage[], budgetChars: number): IChatMessage[] {
		// Keep the transcript VERBATIM while it still fits the model's context window. The stored transcript
		// is what the next turn's prompt prefix is rebuilt from, and the local server has that exact prefix in
		// its KV cache - so stubbing tool results or dropping old messages here rewrites the prefix and forces
		// the server to re-process the entire conversation (the 90s "full prompt re-processing" stall). Only
		// once the transcript would genuinely exceed the window do we compact - which is the point at which a
		// re-process is unavoidable anyway. Small-window models keep the old aggressive cap via budgetChars.
		const totalChars = messages.reduce((acc, m) => acc + this.messageSizeChars(m), 0);
		if (totalChars <= budgetChars) {
			return messages;
		}
		const compacted: IChatMessage[] = messages.map(m => {
			let changed = false;
			const content = m.content.map(part => {
				if (part.type === 'tool_result') {
					const tr = part as IChatMessageToolResultPart;
					const text = tr.value.map(v => v.type === 'text' ? v.value : '').join('');
					if (text.length > STORED_PART_MAX_CHARS) {
						changed = true;
						const stub: IChatMessageToolResultPart = {
							type: 'tool_result',
							toolCallId: tr.toolCallId,
							value: [{ type: 'text', value: `${text.slice(0, STORED_PART_MAX_CHARS)}\n…[rest of tool result omitted from stored history - already acted on]` }],
							isError: tr.isError,
						};
						return stub;
					}
				} else if (part.type === 'text') {
					const tp = part as IChatMessageTextPart;
					if ((tp.value?.length ?? 0) > STORED_PART_MAX_CHARS) {
						changed = true;
						return { ...tp, value: `${tp.value.slice(0, STORED_PART_MAX_CHARS)}\n…[truncated in stored history]` };
					}
				} else if (part.type === 'tool_use') {
					const tu = part as IChatResponseToolUsePart;
					const params = tu.parameters;
					if (params && typeof params === 'object') {
						let paramsChanged = false;
						const newParams: Record<string, unknown> = { ...(params as Record<string, unknown>) };
						for (const key of Object.keys(newParams)) {
							const value = newParams[key];
							if (typeof value === 'string' && value.length > STORED_TOOL_ARG_MAX_CHARS) {
								newParams[key] = `${value.slice(0, STORED_TOOL_ARG_MAX_CHARS)}…[truncated]`;
								paramsChanged = true;
							} else if (Array.isArray(value)) {
								// Arrays of objects (e.g. modifyFile's edits[]) carry oldString/newString file
								// bodies inside each element - truncate those nested strings too, not just top-level.
								const newArr = value.map(item => {
									if (item && typeof item === 'object' && !Array.isArray(item)) {
										const obj = item as Record<string, unknown>;
										let itemChanged = false;
										const newObj: Record<string, unknown> = { ...obj };
										for (const k of Object.keys(newObj)) {
											const v = newObj[k];
											if (typeof v === 'string' && v.length > STORED_TOOL_ARG_MAX_CHARS) {
												newObj[k] = `${v.slice(0, STORED_TOOL_ARG_MAX_CHARS)}…[truncated]`;
												itemChanged = true;
											}
										}
										if (itemChanged) { paramsChanged = true; return newObj; }
									}
									return item;
								});
								if (paramsChanged) { newParams[key] = newArr; }
							}
						}
						if (paramsChanged) {
							changed = true;
							return { ...tu, parameters: newParams };
						}
					}
				}
				return part;
			});
			return changed ? { role: m.role, content } : m;
		});

		// Absolute cap: drop oldest messages first, never the final two (latest exchange). Uses the same
		// window-derived budget as the verbatim gate above, so we only shrink to fit the context window.
		let total = compacted.reduce((acc, m) => acc + this.messageSizeChars(m), 0);
		while (total > budgetChars && compacted.length > 2) {
			total -= this.messageSizeChars(compacted[0]);
			compacted.shift();
			// Don't leave an orphaned tool_result at the new front.
			while (compacted.length > 2 && compacted[0].content.some(p => p.type === 'tool_result')) {
				total -= this.messageSizeChars(compacted[0]);
				compacted.shift();
			}
		}
		return compacted;
	}

	private storeTranscript(sessionKey: string, conversationMessages: IChatMessage[], historyLength: number, maxInputTokens?: number): void {
		// Budget for storing the transcript verbatim: a slice of the model's context window (leaving room for
		// the system+tools prefix, the new user turn, and the reply), floored at the legacy cap so small-window
		// models keep the old conservative behavior. A large-window local model (e.g. 131k) thus stores the
		// full conversation and its cached KV keeps hitting; only a genuinely near-window transcript is compacted.
		const CHARS_PER_TOKEN = 3.5;
		const windowBudget = maxInputTokens && maxInputTokens > 0 ? Math.floor(maxInputTokens * CHARS_PER_TOKEN * 0.7) : 0;
		const budgetChars = Math.max(STORED_TRANSCRIPT_MAX_CHARS, windowBudget);
		const transcript = this.compactForStorage(this.sanitizeTranscript(conversationMessages.filter(m => m.role !== ChatMessageRole.System)), budgetChars);
		this._log(`[LoCoPilot] Stored transcript compacted to ${transcript.length} messages, ~${Math.ceil(transcript.reduce((a, m) => a + this.messageSizeChars(m), 0) / 4)} tokens`);
		// Re-insert for LRU recency, then evict the oldest entry beyond the cap.
		this.sessionTranscripts.delete(sessionKey);
		// Next request's history will include the turn that just finished, hence +1.
		this.sessionTranscripts.set(sessionKey, { messages: transcript, expectedHistoryLength: historyLength + 1 });
		if (this.sessionTranscripts.size > MAX_STORED_TRANSCRIPTS) {
			const oldest = this.sessionTranscripts.keys().next().value;
			if (oldest !== undefined) {
				this.sessionTranscripts.delete(oldest);
			}
		}
	}

	async run(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		messages: IChatMessage[],
		modelId: string,
		token: CancellationToken,
		/** False in read-only modes (Ask / Plan): edit tools are hard-removed from the payload, not just discouraged by the prompt. */
		allowEdits: boolean = true,
		/** Chat history length of this request; when provided, the final transcript is stored for reuse on the next turn. */
		historyLength?: number
	): Promise<IChatAgentResult> {
		this._log(`[LoCoPilot] UnifiedAgent.run starting - modelId=${modelId}, initialMessages=${messages.length}`);

		let iterationCount = 0;
		let hasEverEmitted = false;
		let conversationMessages = [...messages];
		// Track recent tool invocations (toolKey) to detect repeated same tool+args loops
		const recentToolKeys: string[] = [];

		// --- Self-correction state (the "running model" a strong model would keep in its head) ---
		// The user's goal, used when we force the model to re-orient after getting stuck.
		const originalUserGoal = this.extractUserGoal(messages);
		// How many times each error CLASS (signature) has been seen across the whole run.
		const errorSignatureCounts = new Map<string, number>();
		// Count of successful workspace mutations so far (real forward progress).
		let successfulMutations = 0;
		// Consecutive iterations that produced an error and zero successful edits (thrash detector).
		let consecutiveStuckIterations = 0;

		// Get model metadata and available tools
		const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
		const allTools = await this.getAvailableTools(modelMetadata, request.userSelectedTools, allowEdits);

		// LLM providers (Anthropic/OpenAI) require function names matching ^[a-zA-Z0-9_-]{1,64}$.
		// Built-in tool ids satisfy this, but MCP/extension tool ids can contain other characters
		// (or collide after truncation), which makes the provider reject the whole request. Build a
		// bidirectional map: send sanitized names to the model, translate them back to real tool ids
		// when invoking. The map is rebuilt per run so it always reflects the current tool set.
		const { llmNameById, idByLlmName } = this.buildToolNameMap(allTools);

		this._log(`[LoCoPilot] Available tools: ${allTools.length}`);
		if (allTools.length > 0) {
			this._log(`[LoCoPilot] Tools: ${allTools.map(t => t.id).join(', ')}`);
		}

		// Main agentic loop
		while (iterationCount < this.MAX_ITERATIONS && !token.isCancellationRequested) {
			iterationCount++;
			this._log(`[LoCoPilot] === Iteration ${iterationCount} ===`);
			this._log(`[LoCoPilot] Current conversation has ${conversationMessages.length} messages`);

			// Tiered context compaction: keep the growing conversation inside the model's usable
			// input budget. Cheap stubbing first, then summarize the middle, then drop oldest.
			try {
				const compaction = await this.contextManager.compactIfNeeded(
					modelId,
					modelMetadata,
					conversationMessages,
					token
				);
				if (compaction.compacted) {
					conversationMessages = compaction.messages;
					this._log(`[LoCoPilot] Context compacted [${compaction.tiers.join(', ')}]: ${compaction.tokensBefore} -> ${compaction.tokensAfter} tokens, ${conversationMessages.length} messages`);
				}
			} catch (e) {
				this._log(`[LoCoPilot] Context compaction failed (continuing uncompacted): ${e}`);
			}

			// Send request to LLM with tools
			const tools = this.formatToolsForLLM(allTools, llmNameById);
			const options: any = {};
			// Mark this as the foreground panel turn so the provider reports real token/rate stats to the timer
			// bar for it only. Background/auxiliary model calls (title generation, context compaction, capability
			// probes) don't set this, so their tokens never leak into the panel's "tokens / tokens-per-sec" display.
			options.locopilotForegroundTurn = true;
			// Ask the provider to emit tool_use_start/tool_use_delta parts while a tool call's
			// arguments are still streaming (llama.cpp streams them token by token), so the chat can
			// show a live "editing file.ts" card instead of going silent until the call completes.
			options.locopilotStreamToolCalls = true;
			if (tools.length > 0) {
				options.tools = tools;
				this._log(`[LoCoPilot] Sending ${tools.length} tools to LLM`);
			}

			const response = await this.languageModelsService.sendChatRequest(
				modelId,
				nullExtensionDescription.identifier,
				conversationMessages,
				options,
				token
			);

			// Process response stream
			let fullText = '';
			let fullThinking = '';
			const toolCalls: IChatResponseToolUsePart[] = [];
			// Invocation cards begun while tool-call arguments were still streaming, keyed by call id.
			// invokeTool later adopts a card via the same callId and transitions it out of streaming.
			const streamingToolCards = new Map<string, IStreamingToolCard>();
			// Chat model merges markdownContent/thinking by appending; emit only deltas to avoid duplication
			let lastEmittedDisplayLength = 0;
			let lastEmittedThinkingLength = 0;

			for await (const part of response.stream) {
				if (token.isCancellationRequested) {
					break;
				}

				const parts = Array.isArray(part) ? part : [part];
				for (const p of parts) {
					if (p.type === 'text') {
						fullText += p.value;
						const displaySoFar = fullText;
						const delta = displaySoFar.slice(lastEmittedDisplayLength);
						if (delta) {
							progress([{
								kind: 'markdownContent',
								content: new MarkdownString(delta)
							}]);
							lastEmittedDisplayLength = displaySoFar.length;
							hasEverEmitted = true;
						}
					} else if (p.type === 'thinking' && p.value) {
						const chunk = Array.isArray(p.value) ? p.value.join('') : p.value;
						fullThinking += chunk;
						// Emit each thinking delta immediately for token-by-token streaming
						const thinkingDelta = fullThinking.slice(lastEmittedThinkingLength);
						if (thinkingDelta) {
							progress([{ kind: 'thinking', value: thinkingDelta }]);
							lastEmittedThinkingLength = fullThinking.length;
						}
						this._log(`[LoCoPilot] Thinking: ${fullThinking.substring(0, 200)}...`);
					} else if (p.type === 'tool_use') {
						// LLM wants to call a tool
						toolCalls.push(p as IChatResponseToolUsePart);
						this._log(`[LoCoPilot] Tool call requested: ${p.name} (id: ${p.toolCallId})`);
					} else if (p.type === 'tool_use_start') {
						// A tool call's arguments are streaming: show its invocation card immediately
						// (only tools that implement handleToolStream get a card; others return undefined).
						if (request.sessionResource && !streamingToolCards.has(p.toolCallId)) {
							const realToolId = idByLlmName.get(p.name) ?? p.name;
							const invocation = this.toolsService.beginToolCall({
								toolCallId: p.toolCallId,
								toolId: realToolId,
								chatRequestId: request.requestId,
								sessionResource: request.sessionResource
							});
							streamingToolCards.set(p.toolCallId, { invocation, flushing: false });
							if (invocation) {
								this._log(`[LoCoPilot] Tool call streaming started: ${p.name} (id: ${p.toolCallId})`);
							}
						}
					} else if (p.type === 'tool_use_delta') {
						const card = streamingToolCards.get(p.toolCallId);
						if (card?.invocation) {
							card.pendingArgs = p.argsText;
							// Fire-and-forget: the pump throttles itself and always applies the latest args.
							void this._flushToolStreamUpdates(p.toolCallId, card, token);
						}
					}
				}
			}

			// Finalize any card whose call never completed (cancelled mid-stream, or the provider
			// never emitted the final tool_use). Cards for calls in toolCalls are adopted and
			// transitioned by invokeTool below, so leave those alone.
			this._finalizeDanglingToolCards(streamingToolCards, new Set(toolCalls.map(t => t.toolCallId)));

			// Emit final thinking delta so we don't duplicate
			const finalThinkingDelta = fullThinking.slice(lastEmittedThinkingLength);
			if (finalThinkingDelta) {
				progress([{ kind: 'thinking', value: finalThinkingDelta }]);
			}

			const displayText = fullText;

			// Emit final delta so UI has full text (chat model appends each progress chunk)
			const finalDelta = displayText.slice(lastEmittedDisplayLength);
			if (finalDelta) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(finalDelta)
				}]);
				hasEverEmitted = true;
			} else if (displayText.length > 0 && lastEmittedDisplayLength === 0) {
				// Safety: ensure we emit at least once when there is content
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(displayText)
				}]);
				hasEverEmitted = true;
			}

			await response.result;

			// Add assistant message to conversation (keep fullText including signal for context)
			const assistantMessageContent: any[] = [];
			if (fullText) {
				assistantMessageContent.push({
					type: 'text',
					value: fullText,
					audience: [LanguageModelPartAudience.User, LanguageModelPartAudience.Assistant]
				});
			}
			if (toolCalls.length > 0) {
				assistantMessageContent.push(...toolCalls);
			}

			if (assistantMessageContent.length > 0) {
				conversationMessages.push({
					role: ChatMessageRole.Assistant,
					content: assistantMessageContent
				});
			}

			// No tool calls: the model has given its final response, stop the loop
			if (toolCalls.length === 0) {
				this._log(`[LoCoPilot] Agent completed: no tool calls in response`);
				// Safety net: if this turn produced no visible assistant text at all (e.g. the model
				// answered right after a tool call with content that got fully caught by the textual
				// tool-call suppression, or returned only reasoning), the chat would otherwise end
				// completely blank. Surface a short message so the turn is never silent.
				if (!hasEverEmitted) {
					this._log(`[LoCoPilot] Agent finished with no visible output; emitting fallback message.`);
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString('The model finished without a text response. If the task looks incomplete, try rephrasing or using another model.')
					}]);
					hasEverEmitted = true;
				}
				break;
			}

			// Build keys for this round's tool calls to check for repetition
			const thisRoundKeys: string[] = [];
			for (const tc of toolCalls) {
				const paramsKey = JSON.stringify(tc.parameters || {});
				thisRoundKeys.push(`${tc.name}:${paramsKey}`);
			}
			recentToolKeys.push(...thisRoundKeys);
			if (recentToolKeys.length > REPEATED_TOOL_CALL_WINDOW) {
				recentToolKeys.splice(0, recentToolKeys.length - REPEATED_TOOL_CALL_WINDOW);
			}
			// Check EVERY key issued this round, not just the first - a model that repeats the
			// second call of a multi-call round used to slip past this guard.
			let repeatedKey: string | undefined;
			let sameKeyCount = 0;
			for (const key of thisRoundKeys) {
				const count = recentToolKeys.filter(k => k === key).length;
				if (count > sameKeyCount) {
					sameKeyCount = count;
					repeatedKey = key;
				}
			}
			if (sameKeyCount >= REPEATED_TOOL_CALL_THRESHOLD) {
				this.logService.warn(`[LoCoPilot] Repeated tool call detected (${sameKeyCount}x): ${repeatedKey}. Stopping to avoid loop.`);
				this.locopilotFileLog.log(`[LoCoPilot] Repeated tool call detected (${sameKeyCount}x): ${repeatedKey}. Stopping to avoid loop.`);
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`\n*Stopped: the same tool was called repeatedly with no progress. If the task is done, you can start a new message.*\n`)
				}]);
				// These calls will never be invoked; don't leave their cards spinning.
				this._finalizeDanglingToolCards(streamingToolCards);
				break;
			}

			// Execute tools and add results to conversation.
			// Read-only tools (and research subagents) have no side effects on each other, so we
			// run them concurrently for speed. Anything that can mutate the workspace (edits, etc.)
			// runs sequentially after the reads to avoid races. Results are reassembled in the
			// original tool-call order so each tool_result lines up with its tool_use id.
			this._log(`[LoCoPilot] Executing ${toolCalls.length} tool call(s)...`);

			const results: Array<Awaited<ReturnType<UnifiedAgent['executeToolCall']>>> = new Array(toolCalls.length);
			const parallelIndexes: number[] = [];
			const sequentialIndexes: number[] = [];
			toolCalls.forEach((tc, i) => {
				const realToolId = idByLlmName.get(tc.name) ?? tc.name;
				(PARALLELIZABLE_TOOL_IDS.has(realToolId) ? parallelIndexes : sequentialIndexes).push(i);
			});

			if (parallelIndexes.length > 1) {
				this._log(`[LoCoPilot] Running ${parallelIndexes.length} read-only tool call(s) in parallel`);
			}

			// Run all read-only calls concurrently...
			await Promise.all(parallelIndexes.map(async i => {
				results[i] = await this.executeToolCall(toolCalls[i], request, token, idByLlmName);
			}));
			// ...then the (potentially mutating) calls one at a time, preserving order.
			for (const i of sequentialIndexes) {
				results[i] = await this.executeToolCall(toolCalls[i], request, token, idByLlmName);
			}

			const toolResults: any[] = [];
			const imagePartsForVision: IChatMessageImagePart[] = [];
			for (const r of results) {
				toolResults.push(r.toolResult);
				imagePartsForVision.push(...r.images);
			}

			// --- Self-correction: classify this round's outcomes and decide whether to coach/stop. ---
			// This is the "running model" a strong model keeps in its head, made explicit so weak
			// models inherit it: count real progress, classify repeated error CLASSES (not exact
			// args), and inject targeted guidance instead of letting the model spin.
			let progressedThisRound = false;
			let erroredThisRound = false;
			const coachingNotes: string[] = [];
			// First pass: did we make REAL progress (a successful edit) this round? Progress means the
			// model is not stuck, so we must not punish it for unrelated errors in the same round.
			for (const r of results) {
				if (r && MUTATING_TOOL_IDS.has(r.realToolId) && !r.isError) {
					successfulMutations++;
					progressedThisRound = true;
				}
				if (r && r.isError) { erroredThisRound = true; }
			}

			if (progressedThisRound) {
				// Forward progress clears the "stuck" memory: a legitimate multi-file task that hits the
				// same error CLASS on independent files (e.g. several "string not found") between
				// successful edits is not stuck. Only an unbroken run of pure-error rounds keeps escalating.
				errorSignatureCounts.clear();
				consecutiveStuckIterations = 0;
			} else if (erroredThisRound) {
				// Pure-error round: classify each failure by CLASS (not exact args) and HINT. We never hard-stop
				// here - we just escalate guidance and let the model keep trying. Termination is left to the two
				// safety nets (MAX_ITERATIONS and the exact same-tool+args repeat guard).
				for (const r of results) {
					if (!r || !r.isError) { continue; }
					const sig = this.errorSignature(r.realToolId, r.errorText);
					const count = (errorSignatureCounts.get(sig) ?? 0) + 1;
					errorSignatureCounts.set(sig, count);
					if (count >= SEMANTIC_ERROR_CORRECTION_THRESHOLD) {
						// Re-issued each round the failure persists; the note's wording escalates with count.
						coachingNotes.push(this.buildCorrectionNote(r.realToolId, r.errorText, count));
					}
				}
				// Thrash detector: consecutive pure-error rounds with only first-seen errors (no single class
				// repeating) still mean the model is circling - nudge a full re-orient against the goal.
				consecutiveStuckIterations++;
				if (consecutiveStuckIterations >= NO_PROGRESS_REORIENT_THRESHOLD && coachingNotes.length === 0) {
					coachingNotes.push(this.buildReorientNote(originalUserGoal, successfulMutations, consecutiveStuckIterations));
				}
			} else {
				// Reads-only round with no errors (normal exploration): not stuck.
				consecutiveStuckIterations = 0;
			}
			// Append guidance as a text part inside the SAME tool-results user message. This keeps the
			// required assistant(tool_use) -> user(tool_result) pairing intact (no stray messages) while
			// putting the nudge exactly where the model reads its results.
			if (coachingNotes.length > 0 && toolResults.length > 0) {
				toolResults.push({ type: 'text', value: `\n\n\u2500\u2500 SELF-CORRECTION \u2500\u2500\n${coachingNotes.join('\n\n')}` });
			}

			// Re-inject the current TODO plan into the SAME tail tool-results message so the model keeps
			// following it across turns. It rides ONLY on this fresh tail message - never the cached
			// system/tools prefix - so it adds nothing to the KV-cached prefix and can't force a reprocess
			// (see buildTodoReminder). Skipped on rounds where the model just wrote the list, since the
			// state is already fresh in its context and re-stating it would be pure noise.
			if (toolResults.length > 0 && !results.some(r => r && r.realToolId === ManageTodoListToolToolId)) {
				const todoReminder = this.buildTodoReminder(request.sessionResource);
				if (todoReminder) {
					toolResults.push({ type: 'text', value: todoReminder });
				}
			}

			// Add tool results to conversation
			if (toolResults.length > 0) {
				conversationMessages.push({
					role: ChatMessageRole.User,
					content: toolResults
				});
			}


			// Add a user message with image(s) from readFile so the LLM can use vision (tool messages are text-only)
			if (imagePartsForVision.length > 0) {
				conversationMessages.push({
					role: ChatMessageRole.User,
					content: [
						{ type: 'text', value: 'Image(s) from readFile - view below for vision:' },
						...imagePartsForVision
					]
				});
			}

			this._log(`[LoCoPilot] Completed iteration ${iterationCount}, continuing loop...`);
		}

		if (iterationCount >= this.MAX_ITERATIONS) {
			this.logService.warn(`[LoCoPilot] Agent stopped: Reached maximum iterations`);
			this.locopilotFileLog.log(`[LoCoPilot] Agent stopped: Reached maximum iterations`);

			if (!hasEverEmitted) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString('The model did not return a response. Please try again or try with another model.')
				}]);
			} else {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString('\n\n*Note: Reached maximum number of iterations. The task may be incomplete.*')
				}]);
			}
		}

		// Persist the real transcript (tool calls + results, post-compaction) so the next turn can
		// continue from what actually happened instead of a markdown reconstruction.
		if (request.sessionResource && historyLength !== undefined) {
			try {
				this.storeTranscript(request.sessionResource.toString(), conversationMessages, historyLength, modelMetadata?.maxInputTokens);
			} catch (e) {
				this._log(`[LoCoPilot] Failed to store session transcript (ignored): ${e}`);
			}
		}

		this._log(`[LoCoPilot] UnifiedAgent.run completed after ${iterationCount} iterations`);
		return {};
	}

	/**
	 * Pre-process the stable system+tools prefix on the model server so the user's FIRST real message
	 * doesn't pay the full cold prompt-eval cost (on local models this prefix is ~thousands of tokens
	 * and can take >2 minutes to process from cold). We send the EXACT same system prompt + tool set a
	 * real agent turn sends, with a trivial user message, as a background (non-foreground) call. The
	 * llama.cpp prompt cache then holds the system+tools prefix; the first real turn matches it by
	 * longest-common-prefix and only processes the few new user tokens.
	 *
	 * For local models, sendChatRequest also auto-starts the server and waits for readiness, so this
	 * doubles as "start the server on selection" without any extra plumbing. Best-effort: every
	 * failure is swallowed (the model may not be downloaded, the server may be busy, etc.).
	 */
	async warmUp(modelId: string, systemPrompt: string, token: CancellationToken): Promise<void> {
		try {
			const prefix = await this.buildWarmPrefix(modelId, systemPrompt);
			await this.warmUpWithPrefix(modelId, prefix, token);
		} catch (e) {
			this._log(`[LoCoPilot] Prefix warm-up failed (ignored): ${e}`);
		}
	}

	/**
	 * Build the exact system+tools warm-up request a real first turn would send, plus a stable
	 * {@link IWarmPrefix.signature} derived from its content. The signature is what the persisted KV
	 * slot cache is keyed by: it changes whenever the system prompt (prompt version, project memory,
	 * workspace facts) OR the tool set changes, so a blob saved by an earlier session with a different
	 * prefix can never be restored into a mismatched context (the stale root cause of a full turn-1
	 * re-prefill). Kept separate from {@link warmUpWithPrefix} so the caller can compute the signature,
	 * look for a matching cache, and only pay the tool build once.
	 */
	async buildWarmPrefix(modelId: string, systemPrompt: string): Promise<IWarmPrefix> {
		const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
		// Same tool set a real turn sends with the default (no explicit) tool selection.
		const allTools = await this.getAvailableTools(modelMetadata, {});
		const { llmNameById } = this.buildToolNameMap(allTools);
		const tools = this.formatToolsForLLM(allTools, llmNameById);

		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
		];
		// Only the PREFILL of this request matters - the server caches the prefix KV as soon as the prompt is
		// processed, and the generated text is thrown away by warmUpWithPrefix. Cap generation at a single
		// token so the warm ends the instant its job is done. This matters most on mlx_lm, which serves one
		// request at a time: an uncapped warm kept generating for over a minute past the useful work while
		// the user's real (already cache-hitting) message waited its turn in the queue.
		const options: any = { locopilotForegroundTurn: false, locopilotMaxOutputTokens: 1 };
		if (tools.length > 0) {
			options.tools = tools;
		}

		// Hash the FULL prefix content (system prompt + the exact tool JSON sent), not just names -
		// a changed tool description shifts the rendered prompt tokens too. Unsigned hex keeps it
		// filesystem-safe. NUL separator so prompt/tool boundaries can't collide.
		const signature = (hash(systemPrompt + '\u0000' + JSON.stringify(tools)) >>> 0).toString(16);
		return { messages, options, signature };
	}

	/** Send a prefix built by {@link buildWarmPrefix}; drains and discards the output (only the cached KV matters). */
	async warmUpWithPrefix(modelId: string, prefix: IWarmPrefix, token: CancellationToken): Promise<void> {
		try {
			const toolCount = Array.isArray(prefix.options?.tools) ? prefix.options.tools.length : 0;
			this._log(`[LoCoPilot] Warming prefix for ${modelId} (${toolCount} tools, sig=${prefix.signature})...`);
			const response = await this.languageModelsService.sendChatRequest(
				modelId,
				nullExtensionDescription.identifier,
				prefix.messages,
				prefix.options,
				token
			);
			// Drain the stream; we discard the output - only the cached prefix matters.
			for await (const _ of response.stream) {
				if (token.isCancellationRequested) {
					break;
				}
			}
			await response.result;
			this._log(`[LoCoPilot] Prefix warm-up completed for ${modelId}`);
		} catch (e) {
			this._log(`[LoCoPilot] Prefix warm-up failed (ignored): ${e}`);
		}
	}

	/**
	 * Throttled pump for a streaming tool call's argument updates. Best-effort parses the latest
	 * partial JSON and forwards it to the tools service, which re-renders the invocation card
	 * (via the tool's handleToolStream). Runs at most one update chain per card, paced at
	 * TOOL_STREAM_UPDATE_INTERVAL_MS, always applying the newest pending args.
	 */
	private async _flushToolStreamUpdates(toolCallId: string, card: IStreamingToolCard, token: CancellationToken): Promise<void> {
		if (card.flushing) {
			return;
		}
		card.flushing = true;
		try {
			while (card.pendingArgs !== undefined && !token.isCancellationRequested) {
				const argsText = card.pendingArgs;
				card.pendingArgs = undefined;
				const partialInput = parsePartialJsonObject(argsText);
				if (partialInput) {
					await this.toolsService.updateToolStream(toolCallId, partialInput, token);
				}
				// Pace repaints and let more argument tokens coalesce before the next update.
				await timeout(TOOL_STREAM_UPDATE_INTERVAL_MS);
			}
		} catch (e) {
			this._log(`[LoCoPilot] Streaming tool-card update failed (ignored): ${e}`);
		} finally {
			card.flushing = false;
		}
	}

	/**
	 * Finalize streaming invocation cards that will never be picked up by invokeTool (the call was
	 * cancelled mid-stream, its arguments never completed, or the loop stopped before executing).
	 * Without this the card would sit in the streaming/spinner state forever.
	 */
	private _finalizeDanglingToolCards(streamingToolCards: Map<string, IStreamingToolCard>, willBeInvoked?: Set<string>): void {
		for (const [callId, card] of streamingToolCards) {
			if (willBeInvoked?.has(callId)) {
				continue;
			}
			card.pendingArgs = undefined;
			const invocation = card.invocation;
			if (invocation instanceof ChatToolInvocation && IChatToolInvocation.isStreaming(invocation)) {
				this._log(`[LoCoPilot] Finalizing dangling streamed tool call (id: ${callId})`);
				invocation.transitionFromStreaming(undefined, undefined, undefined);
				invocation.didExecuteTool(undefined, true);
			}
		}
	}

	/**
	 * Execute a single tool call and format its result for the conversation.
	 * Returns the tool_result message plus any image parts to surface to the model for vision.
	 * Never throws - tool errors are returned as an error tool_result so the loop can recover.
	 */
	private async executeToolCall(
		toolCall: IChatResponseToolUsePart,
		request: IChatAgentRequest,
		token: CancellationToken,
		idByLlmName: Map<string, string>
	): Promise<{ toolResult: any; images: IChatMessageImagePart[]; realToolId: string; isError: boolean; errorText: string }> {
		const images: IChatMessageImagePart[] = [];
		// The model calls tools by their sanitized name; map back to the real tool id to invoke.
		const realToolId = idByLlmName.get(toolCall.name) ?? toolCall.name;
		try {
			this._log(`[LoCoPilot] Executing tool: ${toolCall.name} (id: ${realToolId})`);

			// Tool display uses existing formats only: invokeTool appends toolInvocation via appendProgress when context is set; chat renders via ChatToolInvocationPart (no custom progress text here).
			const result = await this.toolsService.invokeTool(
				{
					callId: toolCall.toolCallId,
					toolId: realToolId,
					parameters: toolCall.parameters,
					context: request.sessionResource ? {
						sessionId: request.sessionResource.toString(),
						sessionResource: request.sessionResource
					} : undefined,
					chatRequestId: request.requestId
				},
				async () => 0, // token counter
				token
			);

			this._log(`[LoCoPilot] Tool ${toolCall.name} executed successfully`);

			// Format tool result: text parts go to tool message; image data parts go to a separate user message so the LLM can use vision
			const resultContent: any[] = [];
			if (result.content) {
				for (const item of result.content) {
					if (item.kind === 'text') {
						resultContent.push({
							type: 'text',
							value: item.value
						});
					} else if (item.kind === 'data' && item.value?.mimeType?.startsWith('image/')) {
						resultContent.push({
							type: 'text',
							value: 'Image file - see the image in the next user message for vision.'
						});
						// Collect image for a user message so the model can use vision (tool messages are text-only)
						images.push({
							type: 'image_url',
							value: {
								mimeType: item.value.mimeType as ChatImageMimeType,
								data: item.value.data
							}
						});
					}
				}
			}

			if (resultContent.length === 0) {
				resultContent.push({
					type: 'text',
					value: 'Tool executed successfully (no output)'
				});
			}

			// A tool can "soft-fail": it returns normally (no throw) but sets toolResultError and an
			// "Error: ... Next: ..." message. The conversation still shows that text, but for our own
			// loop-detection we need to know it was a failure, so surface it here.
			const softError = result.toolResultError;
			const softErrorText = softError
				? softError
				: (resultContent.find(c => typeof c.value === 'string' && c.value.startsWith('Error:'))?.value ?? '');

			return {
				toolResult: {
					type: 'tool_result',
					toolCallId: toolCall.toolCallId,
					value: resultContent,
					isError: !!softError
				},
				images,
				realToolId,
				isError: !!softError || softErrorText.length > 0,
				errorText: softErrorText
			};
		} catch (error: any) {
			this.logService.error(`[LoCoPilot] Tool ${toolCall.name} failed: ${error}`);
			this.locopilotFileLog.log(`[LoCoPilot] Tool ${toolCall.name} failed: ${error}`);

			return {
				toolResult: {
					type: 'tool_result',
					toolCallId: toolCall.toolCallId,
					value: [{
						type: 'text',
						value: `Error executing tool: ${error.message || error}`
					}],
					isError: true
				},
				images,
				realToolId,
				isError: true,
				errorText: `${error?.message || error}`
			};
		}
	}

	/**
	 * Pull the user's actual request out of the initial messages so we can remind the model of its
	 * goal when it gets stuck. We take the last user-authored text (the current ask), trimmed.
	 */
	private extractUserGoal(messages: IChatMessage[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== ChatMessageRole.User) { continue; }
			const text = (Array.isArray(m.content) ? m.content : [m.content])
				.map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? c.value : ''))
				.join(' ')
				.trim();
			if (text) { return text.length > 300 ? text.slice(0, 300) + '…' : text; }
		}
		return '';
	}

	/**
	 * Reduce a raw error message to a stable "class" so we can tell when the model is hitting the
	 * SAME underlying problem with different arguments (e.g. the same write error on three paths).
	 * We strip quoted strings, paths, and numbers - the variable parts - and key by tool id.
	 */
	private errorSignature(toolId: string, errorText: string): string {
		const norm = (errorText || 'error')
			.toLowerCase()
			.replace(/["'`][^"'`]*["'`]/g, ' ')   // quoted paths/strings
			.replace(/[a-z]:\\[^\s)]+/gi, ' ')    // windows-style paths
			.replace(/\/[^\s)]+/g, ' ')           // unix-style paths
			.replace(/\d+/g, ' ')                  // line numbers, counts
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 80);
		return `${toolId}::${norm}`;
	}

	/**
	 * Targeted "stop and change approach" guidance for a repeated error class. Includes a couple of
	 * concrete recovery patterns small models otherwise fail to infer (e.g. a path they want as a
	 * folder is actually a file - delete it first via the terminal).
	 */
	private buildCorrectionNote(toolId: string, errorText: string, count: number): string {
		const lower = (errorText || '').toLowerCase();
		let specific = '';
		if (lower.includes('not a directory') || lower.includes('already exists but is not a directory')) {
			specific = ' ROOT CAUSE: a path you are treating as a folder already exists as a FILE. Do NOT keep retrying writes. Either delete that file first (run_in_terminal with `rm <path>`) and retry, or just write your target file directly (createFile with path like `dir/file.ext` creates parent folders automatically - there is no separate mkdir step).';
		} else if ((toolId === 'editFile' || toolId === 'modifyFile' || toolId === 'insertCode') && (lower.includes('string not found') || lower.includes('anchor for insertion not found'))) {
			specific = ' ROOT CAUSE: your oldString/anchor does not match the file. Call readFile to get the exact current text and copy it character-for-character - do not guess again.';
		} else if (lower.includes('no workspace folder')) {
			specific = ' ROOT CAUSE: no folder is open. Stop retrying; tell the user to open a folder.';
		}
		// Escalate the tone the longer the same failure persists - but we never halt; the model stays
		// free to keep trying until it recovers or hits a safety-net stop (max iterations / exact repeat).
		const escalation = count >= 4
			? ` This is attempt ${count} - the current approach is clearly NOT working. ABANDON it entirely and try something fundamentally different (a different tool, fix the underlying state with run_in_terminal, or stop and tell the user exactly what is blocking you).`
			: '';
		return `The action \`${toolId}\` has now failed ${count} times with the same kind of error: "${(errorText || '').slice(0, 160)}".${specific}${escalation} Before acting again: in ONE sentence state the root cause, then take a DIFFERENT action that addresses it. Do not repeat a variant of the call that just failed.`;
	}

	/**
	 * Force a re-orientation after several unproductive iterations: restate goal, name the blocker,
	 * pick one different next action. Nudges the todo tool so progress is tracked going forward.
	 */
	private buildReorientNote(goal: string, edits: number, stuckCount: number): string {
		return `No progress in the last ${stuckCount} iterations (errors, no successful edits; ${edits} edit(s) total so far). STOP and re-orient before calling another tool:\n` +
			`1. Restate the goal in one line${goal ? ` (the user asked: "${goal}")` : ''}.\n` +
			`2. State the current blocker and its root cause in one line.\n` +
			`3. Choose ONE concrete next action that is DIFFERENT from what has been failing - e.g. fix filesystem state with run_in_terminal, re-read a file/dir to correct a wrong assumption, or write the target file directly.\n` +
			`Consider using \`manage_todo_list\` to record what is done vs. remaining so you stop repeating steps.`;
	}

	/**
	 * Compact reminder of the session's current TODO plan, re-injected each round so the model keeps
	 * following it instead of drifting once the original write scrolls out of its effective context.
	 *
	 * KV-cache safety: this string is appended ONLY to the fresh tail tool-results message (see the
	 * call site), never to the system/tools prefix. The prefix - which is what the model server keeps
	 * cached - is therefore byte-identical across turns, so re-injection costs zero extra prompt-eval
	 * and cannot degrade a running model. The tail message is new every turn and must be processed
	 * regardless, so carrying the reminder there is effectively free.
	 *
	 * Returns undefined when there is nothing worth reminding: no list, or every item completed (in
	 * which case we let the model wrap up rather than nag it into a loop).
	 */
	private buildTodoReminder(sessionResource: URI | undefined): string | undefined {
		if (!sessionResource) {
			return undefined;
		}
		let todos: IChatTodo[];
		try {
			todos = this.chatTodoListService.getTodos(sessionResource);
		} catch {
			return undefined;
		}
		if (!todos || todos.length === 0 || !todos.some(t => t.status !== 'completed')) {
			return undefined;
		}

		const lines = todos.map(t => {
			const box = t.status === 'completed' ? '[x]' : t.status === 'in-progress' ? '[-]' : '[ ]';
			return `- ${box} ${t.title}`;
		});

		const inProgress = todos.filter(t => t.status === 'in-progress').length;
		const hint = inProgress === 0
			? 'No item is in-progress - mark the next item in-progress before working on it.'
			: inProgress > 1
				? 'More than one item is in-progress - keep exactly ONE and finish it before starting another.'
				: 'Finish the in-progress item, mark it completed the moment it is done, then start the next.';

		return `\n\n\u2500\u2500 TODO LIST (your plan - keep following it) \u2500\u2500\n${lines.join('\n')}\n${hint} Update statuses via \`manage_todo_list\`.`;
	}

	/**
	 * Get available tools for the model, filtered by user selection and model compatibility
	 */
	private async getAvailableTools(modelMetadata: any, userSelectedTools: IChatAgentRequest['userSelectedTools'], allowEdits: boolean = true): Promise<IToolData[]> {
		const allTools = Array.from(this.toolsService.getTools(undefined));
		const selected = userSelectedTools || {};

		// Filter tools
		const availableTools = allTools.filter(tool => {
			// Tools that never belong in the agent loop (internal VS Code flows, demo/confirmation
			// helpers, and editFile_internal which overlaps modifyFile). See agentToolPolicy.ts.
			if (isToolExcluded(tool.id, AGENT_LOOP_EXCLUDED_TOOL_IDS)) {
				return false;
			}

			// Read-only modes (Ask/Plan): remove edit tools from the payload entirely so the
			// prompt's "do not edit" is enforced by the harness, not model discipline.
			if (!allowEdits && isToolExcluded(tool.id, EDIT_TOOL_IDS)) {
				return false;
			}

			// Check if tool matches the model
			if (!toolMatchesModel(tool, modelMetadata)) {
				return false;
			}

			// Check user selection (if specified)
			const toolId = tool.id;
			if (Object.keys(selected).length > 0) {
				// User has made explicit selections
				if (selected[toolId] === false) {
					return false; // Explicitly disabled
				}
			}

			return true;
		});

		return availableTools;
	}

	/**
	 * Build a bidirectional map between real tool ids and provider-safe function names.
	 * Provider rule: name must match ^[a-zA-Z0-9_-]{1,64}$. We replace illegal characters,
	 * cap length at 64, and disambiguate collisions (e.g. two ids that match after truncation)
	 * so every tool gets a unique, valid name that round-trips back to its real id.
	 */
	private buildToolNameMap(tools: IToolData[]): { llmNameById: Map<string, string>; idByLlmName: Map<string, string> } {
		const llmNameById = new Map<string, string>();
		const idByLlmName = new Map<string, string>();
		for (const tool of tools) {
			let name = tool.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
			if (idByLlmName.has(name)) {
				// Collision: append a numeric suffix, trimming the base to keep within 64 chars.
				const base = name.slice(0, 58);
				let i = 1;
				while (idByLlmName.has(`${base}_${i}`)) {
					i++;
				}
				name = `${base}_${i}`;
			}
			llmNameById.set(tool.id, name);
			idByLlmName.set(name, tool.id);
		}
		return { llmNameById, idByLlmName };
	}

	/**
	 * Format tools for LLM (OpenAI/Anthropic format)
	 */
	private formatToolsForLLM(tools: IToolData[], llmNameById: Map<string, string>): any[] {
		return tools.map(tool => ({
			type: 'function',
			function: {
				name: llmNameById.get(tool.id) ?? tool.id,
				description: tool.modelDescription,
				parameters: tool.inputSchema || {
					type: 'object',
					properties: {},
					required: []
				}
			}
		}));
	}
}
