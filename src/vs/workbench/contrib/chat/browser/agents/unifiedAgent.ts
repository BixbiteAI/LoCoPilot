/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILoCoPilotFileLog } from '../locopilotFileLog.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { IChatAgentRequest, IChatAgentResult } from '../../common/participants/chatAgents.js';
import { IChatProgress } from '../../common/chatService/chatService.js';
import { ChatImageMimeType, ChatMessageRole, IChatMessage, IChatMessageImagePart, IChatResponseToolUsePart, ILanguageModelsService } from '../../common/languageModels.js';
import { ILanguageModelToolsService, IToolData, toolMatchesModel } from '../../common/tools/languageModelToolsService.js';
import { LanguageModelPartAudience } from '../../common/languageModels.js';
import { TASK_COMPLETE_SIGNAL } from './agentPrompts.js';

/** Re-export for consumers that need the completion signal. */
export { TASK_COMPLETE_SIGNAL };

/**
 * Unified agent that runs the language model with the given messages and streams progress.
 * This implements a full agentic loop with tool calling support.
 * Iterates until the LLM includes TASK_COMPLETE_SIGNAL in its response or max iterations.
 */
/** Max times the same tool+args can be called before we force-stop to avoid loops. */
const REPEATED_TOOL_CALL_THRESHOLD = 5;

/** Sliding window size for detecting repeated tool calls. */
const REPEATED_TOOL_CALL_WINDOW = 6;

const DEFAULT_MAX_ITERATIONS = 25;

export class UnifiedAgent {
	private readonly MAX_ITERATIONS: number;

	constructor(
		private readonly languageModelsService: ILanguageModelsService,
		private readonly toolsService: ILanguageModelToolsService,
		private readonly logService: ILogService,
		_workspaceService: IWorkspaceContextService,
		private readonly locopilotFileLog: ILoCoPilotFileLog,
		maxIterations: number = DEFAULT_MAX_ITERATIONS
	) {
		this.MAX_ITERATIONS = Math.min(100, Math.max(1, maxIterations));
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
		let consecutiveNoCompleteCount = 0;
		let hasEverEmitted = false;
		const conversationMessages = [...messages];
		// Track recent tool invocations (toolKey) to detect repeated same tool+args loops
		const recentToolKeys: string[] = [];

		// Get model metadata and available tools
		const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
		const allTools = await this.getAvailableTools(modelMetadata, request);
		
		this._log(`[LoCoPilot] Available tools: ${allTools.length}`);
		if (allTools.length > 0) {
			this._log(`[LoCoPilot] Tools: ${allTools.map(t => t.id).join(', ')}`);
		}

		// Main agentic loop
		while (iterationCount < this.MAX_ITERATIONS && !token.isCancellationRequested) {
			iterationCount++;
			this._log(`[LoCoPilot] === Iteration ${iterationCount} ===`);
			this._log(`[LoCoPilot] Current conversation has ${conversationMessages.length} messages`);

			// Send request to LLM with tools
			const tools = this.formatToolsForLLM(allTools);
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
			let lastProgressUpdate = Date.now();
			let lastThinkingUpdate = Date.now();
			const PROGRESS_UPDATE_INTERVAL = 100; // ms - throttle UI updates
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
						const displaySoFar = fullText.replace(/\s*\[TASK_COMPLETE\]\s*/g, '').trim();
						const delta = displaySoFar.slice(lastEmittedDisplayLength);
						// Emit first chunk immediately so the response is created and UI shows content
						const now = Date.now();
						const throttleElapsed = now - lastProgressUpdate > PROGRESS_UPDATE_INTERVAL;
						if (delta && (throttleElapsed || lastEmittedDisplayLength === 0)) {
							progress([{
								kind: 'markdownContent',
								content: new MarkdownString(delta)
							}]);
							lastEmittedDisplayLength = displaySoFar.length;
							hasEverEmitted = true;
							if (throttleElapsed) {
								lastProgressUpdate = now;
							}
						}
					} else if (p.type === 'thinking' && p.value) {
						const chunk = Array.isArray(p.value) ? p.value.join('') : p.value;
						fullThinking += chunk;
						// Emit only thinking delta so merge-by-append doesn't duplicate
						const now = Date.now();
						const thinkingDelta = fullThinking.slice(lastEmittedThinkingLength);
						if (thinkingDelta && (now - lastThinkingUpdate > PROGRESS_UPDATE_INTERVAL || lastEmittedThinkingLength === 0)) {
							progress([{ kind: 'thinking', value: thinkingDelta }]);
							lastEmittedThinkingLength = fullThinking.length;
							lastThinkingUpdate = now;
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

			// Strip completion signal from displayed text (escape [ ] for regex)
			const displayText = fullText.includes(TASK_COMPLETE_SIGNAL)
				? fullText.replace(/\s*\[TASK_COMPLETE\]\s*/g, '').trim()
				: fullText;

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

			// No tool calls: check for completion signal
			if (toolCalls.length === 0) {
				if (fullText.includes(TASK_COMPLETE_SIGNAL)) {
					this._log(`[LoCoPilot] Agent completed: received ${TASK_COMPLETE_SIGNAL}`);
					break;
				}
				consecutiveNoCompleteCount++;
				// After 2 text-only responses without [TASK_COMPLETE], stop to avoid infinite loop and garbled UI
				if (consecutiveNoCompleteCount >= 2) {
					this._log(`[LoCoPilot] Stopping: ${consecutiveNoCompleteCount} responses without ${TASK_COMPLETE_SIGNAL} (max nudge limit)`);
					break;
				}
				// Nudge once: ask LLM to use tools or signal complete
				this._log(`[LoCoPilot] No tool calls and no ${TASK_COMPLETE_SIGNAL}; sending nudge (${consecutiveNoCompleteCount}/2)`);
				conversationMessages.push({
					role: ChatMessageRole.User,
					content: [{
						type: 'text',
						value: `Use the available tools to complete the task, or if you have given your final answer, end your next message with ${TASK_COMPLETE_SIGNAL}.`
					}]
				});
				continue;
			}

			consecutiveNoCompleteCount = 0;

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

			// Execute tools and add results to conversation
			this._log(`[LoCoPilot] Executing ${toolCalls.length} tool call(s)...`);
			
			const toolResults: any[] = [];
			const imagePartsForVision: IChatMessageImagePart[] = [];
			for (const toolCall of toolCalls) {
				try {
					this._log(`[LoCoPilot] Executing tool: ${toolCall.name}`);

					// Tool display uses existing formats only: invokeTool appends toolInvocation via appendProgress when context is set; chat renders via ChatToolInvocationPart (no custom progress text here).
					const result = await this.toolsService.invokeTool(
						{
							callId: toolCall.toolCallId,
							toolId: toolCall.name,
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
									value: 'Image file — see the image in the next user message for vision.'
								});
								// Collect image for a user message so the model can use vision (tool messages are text-only)
								imagePartsForVision.push({
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

					toolResults.push({
						type: 'tool_result',
						toolCallId: toolCall.toolCallId,
						value: resultContent,
						isError: false
					});

					// Tool result is shown in chat via toolInvocation state (languageModelToolsService updates invocation with result)

				} catch (error: any) {
					this.logService.error(`[LoCoPilot] Tool ${toolCall.name} failed: ${error}`);
					this.locopilotFileLog.log(`[LoCoPilot] Tool ${toolCall.name} failed: ${error}`);
					
					toolResults.push({
						type: 'tool_result',
						toolCallId: toolCall.toolCallId,
						value: [{
							type: 'text',
							value: `Error executing tool: ${error.message || error}`
						}],
						isError: true
					});

					// Error is reflected in toolInvocation state in chat UI
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
						{ type: 'text', value: 'Image(s) from readFile — view below for vision:' },
						...imagePartsForVision
					]
				});
			}

			this._log(`[LoCoPilot] Completed iteration ${iterationCount}, continuing loop...`);
		}

		if (iterationCount >= this.MAX_ITERATIONS || consecutiveNoCompleteCount >= 2) {
			const reason = iterationCount >= this.MAX_ITERATIONS ? 'Reached maximum iterations' : 'No response from model';
			this.logService.warn(`[LoCoPilot] Agent stopped: ${reason}`);
			this.locopilotFileLog.log(`[LoCoPilot] Agent stopped: ${reason}`);
			
			if (consecutiveNoCompleteCount >= 2 && !hasEverEmitted) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString('The model did not return a response. Please try again or try with another model.')
				}]);
			} else if (iterationCount >= this.MAX_ITERATIONS) {
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
	 * Format tools for LLM (OpenAI/Anthropic format)
	 */
	private formatToolsForLLM(tools: IToolData[]): any[] {
		return tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.id,
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
