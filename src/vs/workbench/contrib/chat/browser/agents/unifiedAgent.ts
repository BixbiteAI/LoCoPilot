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
		this.MAX_ITERATIONS = Math.min(100, Math.max(1, maxIterations));
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

			const results: Array<{ toolResult: any; images: IChatMessageImagePart[] }> = new Array(toolCalls.length);
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
	): Promise<{ toolResult: any; images: IChatMessageImagePart[] }> {
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

			return {
				toolResult: {
					type: 'tool_result',
					toolCallId: toolCall.toolCallId,
					value: resultContent,
					isError: false
				},
				images
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
				images
			};
		}
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
