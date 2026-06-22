/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILoCoPilotFileLog } from '../locopilotFileLog.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { IChatAgentRequest, IChatAgentResult } from '../../common/participants/chatAgents.js';
import { IChatProgress } from '../../common/chatService/chatService.js';
import { ChatImageMimeType, ChatMessageRole, IChatMessage, IChatMessageImagePart, IChatResponseToolUsePart, ILanguageModelsService, LanguageModelPartAudience } from '../../common/languageModels.js';
import { ILanguageModelToolsService, IToolData, toolMatchesModel } from '../../common/tools/languageModelToolsService.js';
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

const DEFAULT_MAX_ITERATIONS = 25;

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
const MUTATING_TOOL_IDS = new Set<string>(['modifyFile', 'editFile_internal']);

/**
 * Tool ids that are safe to run concurrently within a single agent turn: read-only inspection
 * tools plus runSubagent (used for read-only parallel research). Edit/mutating tools are
 * deliberately excluded so they run sequentially and never race on the same files.
 */
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

export class UnifiedAgent {
	private readonly MAX_ITERATIONS: number;
	private readonly contextManager: ContextManager;

	constructor(
		private readonly languageModelsService: ILanguageModelsService,
		private readonly toolsService: ILanguageModelToolsService,
		private readonly logService: ILogService,
		_workspaceService: IWorkspaceContextService,
		private readonly locopilotFileLog: ILoCoPilotFileLog,
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

	async run(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		messages: IChatMessage[],
		modelId: string,
		token: CancellationToken
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
		const allTools = await this.getAvailableTools(modelMetadata, request);

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
					}
				}
			}

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
			const sameKeyCount = thisRoundKeys.length > 0
				? recentToolKeys.filter(k => k === thisRoundKeys[0]).length
				: 0;
			if (sameKeyCount >= REPEATED_TOOL_CALL_THRESHOLD) {
				this.logService.warn(`[LoCoPilot] Repeated tool call detected (${sameKeyCount}x): ${thisRoundKeys[0]}. Stopping to avoid loop.`);
				this.locopilotFileLog.log(`[LoCoPilot] Repeated tool call detected (${sameKeyCount}x): ${thisRoundKeys[0]}. Stopping to avoid loop.`);
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`\n*Stopped: the same tool was called repeatedly with no progress. If the task is done, you can start a new message.*\n`)
				}]);
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

		this._log(`[LoCoPilot] UnifiedAgent.run completed after ${iterationCount} iterations`);
		return {};
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
			specific = ' ROOT CAUSE: a path you are treating as a folder already exists as a FILE. Do NOT keep retrying writes. Either delete that file first (run_in_terminal with `rm <path>`) and retry, or just write your target file directly (modifyFile with path like `dir/file.ext` creates parent folders automatically - there is no separate mkdir step).';
		} else if (toolId === 'modifyFile' && lower.includes('string not found')) {
			specific = ' ROOT CAUSE: your oldString does not match the file. Call readFile to get the exact current text and copy it character-for-character, or use the exact hint from the error - do not guess again.';
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
			`Consider using the todo tool to record what is done vs. remaining so you stop repeating steps.`;
	}

	/**
	 * Get available tools for the model, filtered by user selection and model compatibility
	 */
	private async getAvailableTools(modelMetadata: any, request: IChatAgentRequest): Promise<IToolData[]> {
		const allTools = Array.from(this.toolsService.getTools(undefined));
		const userSelectedTools = request.userSelectedTools || {};

		// Filter tools
		const availableTools = allTools.filter(tool => {
			// Check if tool matches the model
			if (!toolMatchesModel(tool, modelMetadata)) {
				return false;
			}

			// Check user selection (if specified)
			const toolId = tool.id;
			if (Object.keys(userSelectedTools).length > 0) {
				// User has made explicit selections
				if (userSelectedTools[toolId] === false) {
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
