/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource } from '../../../../base/common/async.js';
import { encodeBase64, streamToBuffer } from '../../../../base/common/buffer.js';
import { createMarkdownCommandLink } from '../../../../base/common/htmlContent.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { listenStream } from '../../../../base/common/stream.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { ILoCoPilotFileLog } from './locopilotFileLog.js';
import { ICustomLanguageModelsService, ICustomLanguageModel } from '../common/customLanguageModelsService.js';
import { IChatMessage, ILanguageModelChatInfoOptions, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatResponse, ILanguageModelsService, IChatResponsePart, ChatMessageRole } from '../common/languageModels.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { LOCOPILOT_SETTINGS_SECTION_LIST_MODELS } from './chatManagement/locopilotSettingsEditorInput.js';

import { ILoCoPilotLocalModelRunner } from './locopilotLocalModelRunner.js';

export class LoCoPilotLanguageModelProvider extends Disposable implements ILanguageModelChatProvider, IWorkbenchContribution {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@ILoCoPilotFileLog private readonly locopilotFileLog: ILoCoPilotFileLog,
		@ILoCoPilotLocalModelRunner private readonly localModelRunner: ILoCoPilotLocalModelRunner,
	) {
		super();
		this._log('[LoCoPilot] Initializing Language Model Provider');
		
		// Register the 'locopilot' vendor first, otherwise registerLanguageModelProvider will throw
		this.languageModelsService.deltaLanguageModelChatProviderDescriptors([{
			vendor: 'locopilot',
			displayName: 'LoCoPilot',
			configuration: undefined,
			managementCommand: undefined,
			when: undefined
		}], []);

		this._register(this.languageModelsService.registerLanguageModelProvider('locopilot', this));
		
		// Set up listener for custom model changes
		this._register(this.customLanguageModelsService.onDidChangeCustomModels(() => {
			this._log('[LoCoPilot] Custom models changed, refreshing');
			this._onDidChange.fire();
		}));
		
		// Trigger initial model resolution if we have custom models
		// Use setTimeout to ensure the provider registration is fully complete
		setTimeout(async () => {
			const customModels = this.customLanguageModelsService.getVisibleCustomModels();
			if (customModels.length > 0) {
				this._log(`[LoCoPilot] Found ${customModels.length} custom models, triggering resolution...`);
				// Fire change event to trigger model resolution
				this._onDidChange.fire();
				// Also try to trigger resolution by selecting models for the vendor
				try {
					const modelIds = await this.languageModelsService.selectLanguageModels({ vendor: 'locopilot' });
					this._log(`[LoCoPilot] Resolved ${modelIds.length} models: ${modelIds.join(', ')}`);
				} catch (e) {
					this.logService.warn(`[LoCoPilot] Failed to trigger model resolution: ${e}`);
				this.locopilotFileLog.log(`[LoCoPilot] Failed to trigger model resolution: ${e}`);
				}
			}
		}, 0);
	}

	private _log(msg: string, ...args: unknown[]): void {
		this.logService.info(msg, ...args);
		this.locopilotFileLog.log(msg, ...args);
	}

	/**
	 * Returns a user-friendly message when the user cancels the request (any model/provider).
	 */
	private _getCanceledMessage(): string {
		return 'Request was canceled. You can start a new request anytime.';
	}

	private _isCanceledError(errMsg: string): boolean {
		return /canceled|cancellation/i.test(errMsg);
	}

	/**
	 * Returns a user-friendly error message for API status codes shown in the chat panel.
	 * For 400, the example model name is provider-specific (e.g. Gemini for Google, Claude for Anthropic).
	 */
	private _getApiErrorMessage(provider: string, statusCode: number): string {
		switch (statusCode) {
			case 400: {
				const example = provider === 'Google' ? 'gemini-2.0-flash' : provider === 'OpenAI' ? 'gpt-4o' : 'claude-sonnet-4-5-20250929';
				return `Invalid request for ${provider}. Please check your model name (e.g. ${example}) and that it's valid for this provider.`;
			}
			case 401:
				return `Invalid or missing API key for ${provider}. Please check your API key in LoCoPilot model settings.`;
			case 403:
				return `Access denied for ${provider}. Your API key may not have permission to use this model.`;
			case 404:
				if (provider === 'Ollama') {
					return `Model not found in Ollama. Please make sure you have pulled the model (e.g., 'ollama pull llama3') or added it in LoCoPilot Settings.`;
				}
				return `Resource not found for ${provider}.`;
			case 429:
				return `Rate limit exceeded for ${provider}. Please try again in a few moments.`;
			case 500:
			case 502:
			case 503:
				if (provider === 'Ollama') {
					return `Ollama server is not responding. Please make sure Ollama is installed and running (http://localhost:11434). You can download it from ollama.com.`;
				}
				return `${provider} service is temporarily unavailable. Please try again later.`;
			default:
				return `Something went wrong while calling ${provider} (error ${statusCode}). Please try again.`;
		}
	}

	/** Chat error panel renders this as Markdown; includes a command link (see chatListRenderer trusted command for this id). */
	private _getLocalLlamaServerNotRunningMessage(modelName: string): string {
		const openLanguageModels = createMarkdownCommandLink({
			title: 'Open Language Models',
			id: 'workbench.action.chat.openLoCoPilotSettings',
			arguments: [{ section: LOCOPILOT_SETTINGS_SECTION_LIST_MODELS }],
		});
		return `Local model server is not running. ${openLanguageModels} — find **${modelName}** and click **Run server** to start the llama.cpp server.`;
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const customModels = this.customLanguageModelsService.getVisibleCustomModels();
		this._log(`[LoCoPilot Provider] provideLanguageModelChatInfo called, found ${customModels.length} custom models`);
		const result = customModels.map(m => {
			// Local llama.cpp models typically have a default context of 4096 unless configured otherwise.
			// The logs show the server is started with -c 4096.
			const isLocal = m.provider === 'huggingface' || m.provider === 'localhost' || m.provider === 'ollama';
			const defaultMaxInput = isLocal ? 32000 : 100000;
			const defaultMaxOutput = isLocal ? 1000 : 8000;

			return {
				identifier: m.id,
				metadata: {
					extension: new ExtensionIdentifier('locopilot'),
					name: m.name,
					id: m.id,
					vendor: 'locopilot',
					version: '1.0.0',
					family: m.modelName,
					maxInputTokens: m.maxInputTokens ?? defaultMaxInput,
					maxOutputTokens: m.maxOutputTokens ?? defaultMaxOutput,
					isDefaultForLocation: {},
					isUserSelectable: true,
					modelPickerCategory: { label: 'Custom Models', order: 100 },
					capabilities: {
						vision: true,
						toolCalling: true
					}
				}
			};
		});
		this._log(`[LoCoPilot Provider] Returning ${result.length} models: ${result.map(m => m.identifier).join(', ')}`);
		return result;
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], from: ExtensionIdentifier, options: { [name: string]: unknown }, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		this._log(`[LoCoPilot Provider] sendChatRequest called for modelId: ${modelId}`);
		const customModel = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!customModel) {
			this.logService.error(`[LoCoPilot Provider] Model ${modelId} not found in custom models. Available: ${this.customLanguageModelsService.getCustomModels().map(m => m.id).join(', ')}`);
			this.locopilotFileLog.log(`[LoCoPilot Provider] Model ${modelId} not found in custom models. Available: ${this.customLanguageModelsService.getCustomModels().map(m => m.id).join(', ')}`);
			throw new Error(`Model ${modelId} not found`);
		}

		this._log(`[LoCoPilot Provider] Found model: ${customModel.name} (${customModel.provider}), sending request...`);
		if (options.tools) {
			this._log(`[LoCoPilot Provider] Tools provided: ${Array.isArray(options.tools) ? options.tools.length : 'unknown'}`);
		}
		const stream = new AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>();
		const resultPromise = this._doSendChatRequest(customModel, messages, options, stream, token);

		return {
			stream: stream.asyncIterable,
			result: resultPromise
		};
	}

	private async _doSendChatRequest(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		let rejected = false;
		try {
			if (model.provider === 'openai') {
				return await this._callOpenAI(model, messages, options, stream, token);
			} else if (model.provider === 'anthropic') {
				return await this._callAnthropic(model, messages, options, stream, token);
			} else if (model.provider === 'google') {
				return await this._callGoogle(model, messages, options, stream, token);
			} else if (model.provider === 'huggingface') {
				return await this._callLocalModel(model, messages, options, stream, token);
			} else if (model.provider === 'ollama') {
				return await this._callOllamaModel(model, messages, options, stream, token);
			} else if (model.provider === 'localhost') {
				return await this._callLocalhostModel(model, messages, options, stream, token);
			} else {
				throw new Error(`Unsupported provider: ${model.provider}`);
			}
		} catch (e) {
			rejected = true;
			const errMsg = e && typeof (e as Error).message === 'string' ? (e as Error).message : String(e);
			const toThrow = this._isCanceledError(errMsg) ? new Error(this._getCanceledMessage()) : e;
			this.logService.error(`LoCoPilot provider error: ${e}`);
			this.locopilotFileLog.log(`LoCoPilot provider error: ${e}`);
			stream.reject(toThrow);
			throw toThrow;
		} finally {
			if (!rejected) {
				stream.resolve();
			}
		}
	}

	private async _callOpenAI(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		const url = 'https://api.openai.com/v1/chat/completions';
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${model.apiKey}`,
			'Content-Type': 'application/json',
			'Accept': 'text/event-stream'
		};

		const mappedMessages = messages.flatMap(m => this._mapMessageToOpenAI(m));
		this._log(`[LoCoPilot Provider] OpenAI request: ${mappedMessages.length} messages`);
		for (let i = 0; i < mappedMessages.length; i++) {
			const msg = mappedMessages[i];
			const contentStr = typeof msg.content === 'string' ? msg.content.substring(0, 100) : JSON.stringify(msg.content).substring(0, 100);
			this._log(`[LoCoPilot Provider]   Message ${i + 1} (${msg.role}): ${contentStr}...`);
		}

		const maxOutputTokens = model.maxOutputTokens ?? 8000;
		const body: any = {
			model: model.modelName,
			messages: mappedMessages,
			stream: true,
			temperature: 0.3,
			max_tokens: maxOutputTokens
		};

		// Add tools if provided
		if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
			body.tools = options.tools;
			body.tool_choice = 'auto';
			this._log(`[LoCoPilot Provider] OpenAI request: ${options.tools.length} tools`);
		} else {
			this._log(`[LoCoPilot Provider] OpenAI request: No tools`);
		}

		const response = await this.requestService.request({
			type: 'POST',
			url,
			headers,
			data: JSON.stringify(body)
		}, token);

		if (response.res.statusCode !== 200) {
			throw new Error(this._getApiErrorMessage('OpenAI', response.res.statusCode ?? 0));
		}

		return new Promise<void>((resolve, reject) => {
			let buffer = '';
			// OpenAI streams tool_calls in deltas: id, function.name, and function.arguments arrive in separate chunks. Accumulate by index and emit on stream end.
			const accumulatedToolCalls: Map<number, { id?: string; name?: string; args: string }> = new Map();

			listenStream(response.stream, {
				onData: chunk => {
					buffer += chunk.toString();
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						const trimmed = line.trim();
						if (trimmed.startsWith('data: ')) {
							const data = trimmed.slice(6);
							if (data === '[DONE]') continue;
							try {
								const json = JSON.parse(data);
								const choice = json.choices?.[0];
								if (choice?.delta?.content) {
									stream.emitOne({ type: 'text', value: choice.delta.content });
								}
								if (choice?.delta?.reasoning_content) {
									stream.emitOne({ type: 'thinking', value: choice.delta.reasoning_content });
								}
								// Accumulate tool call deltas by index (id, function.name, function.arguments stream separately)
								if (choice?.delta?.tool_calls) {
									for (const tc of choice.delta.tool_calls) {
										const idx = tc.index ?? 0;
										let acc = accumulatedToolCalls.get(idx);
										if (!acc) {
											acc = { args: '' };
											accumulatedToolCalls.set(idx, acc);
										}
										if (tc.id) acc.id = tc.id;
										if (tc.function?.name) acc.name = tc.function.name;
										if (tc.function?.arguments !== undefined) acc.args += tc.function.arguments;
									}
								}
							} catch (e) {
								// Ignore parse errors
							}
						}
					}
				},
				onError: error => reject(error),
				onEnd: () => {
					// Emit complete accumulated tool calls once stream ends
					const indices = Array.from(accumulatedToolCalls.keys()).sort((a, b) => a - b);
					for (const idx of indices) {
						const acc = accumulatedToolCalls.get(idx)!;
						if (acc.id && acc.name) {
							try {
								const parameters = acc.args ? JSON.parse(acc.args) : {};
								stream.emitOne({
									type: 'tool_use',
									name: acc.name,
									toolCallId: acc.id,
									parameters
								});
							} catch (_e) {
								// If arguments are incomplete/invalid JSON, still emit so agent can handle
								stream.emitOne({
									type: 'tool_use',
									name: acc.name,
									toolCallId: acc.id,
									parameters: {}
								});
							}
						}
					}
					resolve();
				}
			}, token);
		});
	}

	private async _callAnthropic(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		const url = 'https://api.anthropic.com/v1/messages';
		const headers: Record<string, string> = {
			'x-api-key': model.apiKey || '',
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json',
			'Accept': 'text/event-stream'
		};

		const systemMessage = messages.find(m => m.role === ChatMessageRole.System);
		const maxOutputTokens = model.maxOutputTokens ?? 8000;
		const body: any = {
			model: model.modelName,
			messages: messages.filter(m => m.role !== ChatMessageRole.System).map(m => this._mapMessageToAnthropic(m)),
			stream: true,
			max_tokens: maxOutputTokens
		};

		if (systemMessage) {
			body.system = systemMessage.content.map(p => p.type === 'text' ? p.value : '').join('');
		}

		// Add tools if provided
		if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
			body.tools = options.tools.map((tool: any) => ({
				name: tool.function.name,
				description: tool.function.description,
				input_schema: tool.function.parameters
			}));
		}

		const response = await this.requestService.request({
			type: 'POST',
			url,
			headers,
			data: JSON.stringify(body)
		}, token);

		if (response.res.statusCode !== 200) {
			throw new Error(this._getApiErrorMessage('Anthropic', response.res.statusCode ?? 0));
		}

		return new Promise<void>((resolve, reject) => {
			let buffer = '';
			// Anthropic streams tool_use input via input_json_delta; accumulate until content_block_stop
			let pendingToolUse: { id: string; name: string } | null = null;
			let inputJsonAccum = '';

			listenStream(response.stream, {
				onData: chunk => {
					buffer += chunk.toString();
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						const trimmed = line.trim();
						if (trimmed.startsWith('data: ')) {
							const data = trimmed.slice(6);
							try {
								const json = JSON.parse(data);
								const delta = json.delta;

								if (json.type === 'content_block_delta') {
									if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
										stream.emitOne({ type: 'text', value: delta.text });
									} else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
										this._log(`[LoCoPilot Provider] Anthropic thinking delta: ${delta.thinking}`);
										stream.emitOne({ type: 'thinking', value: delta.thinking });
									} else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
										inputJsonAccum += delta.partial_json;
									}
								} else if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
									const toolUse = json.content_block;
									pendingToolUse = { id: toolUse.id, name: toolUse.name };
									inputJsonAccum = '';
								} else if (json.type === 'content_block_stop' && pendingToolUse) {
									let parameters: object = {};
									if (inputJsonAccum.trim()) {
										try {
											parameters = JSON.parse(inputJsonAccum) as object;
										} catch {
											// partial JSON may be incomplete; use empty object
										}
									}
									stream.emitOne({
										type: 'tool_use',
										name: pendingToolUse.name,
										toolCallId: pendingToolUse.id,
										parameters
									});
									pendingToolUse = null;
									inputJsonAccum = '';
								}
							} catch (e) {
								// Ignore parse errors
							}
						}
					}
				},
				onError: error => reject(error),
				onEnd: () => resolve()
			}, token);
		});
	}

	private async _callGoogle(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.modelName}:streamGenerateContent?key=${model.apiKey}&alt=sse`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'text/event-stream'
		};

		const systemMessage = messages.find(m => m.role === ChatMessageRole.System);
		const nonSystemMessages = messages.filter(m => m.role !== ChatMessageRole.System);
		// Build contents with tool-call name resolution: user tool_result parts need the function name from the previous assistant tool_use
		const contents: any[] = [];
		let toolCallIdToName: Record<string, string> = {};
		for (let i = 0; i < nonSystemMessages.length; i++) {
			const msg = nonSystemMessages[i];
			if (msg.role === ChatMessageRole.Assistant) {
				toolCallIdToName = {};
				for (const part of msg.content) {
					if (part.type === 'tool_use' && part.toolCallId && part.name) {
						toolCallIdToName[part.toolCallId] = part.name;
					}
				}
			}
			const mapped = this._mapMessageToGoogle(msg, toolCallIdToName);
			if (mapped && mapped.parts.length > 0) {
				contents.push(mapped);
			}
		}
		const maxOutputTokens = model.maxOutputTokens ?? 8000;
		const body: any = {
			contents,
			generationConfig: {
				temperature: 0.3,
				maxOutputTokens
			}
		};

		if (systemMessage) {
			const systemParts = systemMessage.content.filter(p => p.type === 'text').map(p => ({ text: (p as { type: 'text'; value: string }).value }));
			if (systemParts.length > 0) {
				body.system_instruction = { parts: systemParts };
			}
		}

		// Add tools if provided (Google uses function_declarations; parameters must be a Schema with type "object").
		// Google's API does not support OpenAPI/JSON Schema fields like additionalProperties - strip them.
		if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
			body.tools = [{
				function_declarations: options.tools.map((tool: any) => {
					const params = tool.function.parameters;
					const rawSchema = (params && typeof params === 'object' && (params.type === 'object' || params.properties))
						? params
						: { type: 'object' as const, properties: params?.properties ?? {}, required: params?.required ?? [] };
					return {
						name: tool.function.name,
						description: tool.function.description ?? '',
						parameters: this._sanitizeSchemaForGoogle(rawSchema)
					};
				})
			}];
		}

		const response = await this.requestService.request({
			type: 'POST',
			url,
			headers,
			data: JSON.stringify(body)
		}, token);

		if (response.res.statusCode !== 200) {
			let detail = '';
			try {
				const buf = await streamToBuffer(response.stream);
				const json = JSON.parse(buf.toString()) as { error?: { message?: string; status?: string } };
				if (json?.error?.message) {
					detail = ` ${json.error.message}`;
				}
			} catch {
				// ignore
			}
			throw new Error(this._getApiErrorMessage('Google', response.res.statusCode ?? 0) + detail);
		}

		return new Promise<void>((resolve, reject) => {
			let buffer = '';
			listenStream(response.stream, {
				onData: chunk => {
					buffer += chunk.toString();
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						const trimmed = line.trim();
						if (trimmed.startsWith('data: ')) {
							const data = trimmed.slice(6);
							try {
								const json = JSON.parse(data);
								const candidate = json.candidates?.[0];
								if (candidate?.content?.parts) {
									for (const part of candidate.content.parts) {
										if (part.text) {
											stream.emitOne({ type: 'text', value: part.text });
										} else if (part.thought) {
											this._log(`[LoCoPilot Provider] Google thought: ${part.thought}`);
											stream.emitOne({ type: 'thinking', value: part.thought });
										} else if (part.functionCall) {
											// Handle tool calls. Capture thoughtSignature for Gemini 3 so we can resend it in the next turn.
											const thoughtSig = part.thoughtSignature ?? part.thought_signature;
											stream.emitOne({
												type: 'tool_use',
												name: part.functionCall.name,
												toolCallId: `call_${Date.now()}_${Math.random()}`,
												parameters: part.functionCall.args || {},
												...(thoughtSig !== undefined && thoughtSig !== null && { thoughtSignature: thoughtSig })
											});
										}
									}
								}
							} catch (e) {
								// Ignore parse errors
							}
						}
					}
				},
				onError: error => reject(error),
				onEnd: () => resolve()
			}, token);
		});
	}

	private async _callLocalModel(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		this._log(`[LoCoPilot Provider] Calling local model: ${model.modelName}`);
		if (!model.localPath) {
			this._log(`[LoCoPilot Provider] Model ${model.modelName} is not downloaded yet.`);
			throw new Error(`The model "${model.modelName}" is not downloaded yet. Add it in LoCoPilot Settings with provider HuggingFace and wait for the download to complete.`);
		}
		const baseUrl = this.localModelRunner.getServerBaseUrl(model.id);
		if (!baseUrl) {
			throw new Error(this._getLocalLlamaServerNotRunningMessage(model.modelName));
		}
		const url = `${baseUrl}/chat/completions`;
		const mappedMessages = messages.flatMap(m => this._mapMessageToOpenAI(m));
		const maxOutputTokens = model.maxOutputTokens ?? 1000;
		const body: any = {
			model: model.modelName,
			messages: mappedMessages,
			stream: true,
			temperature: 0.3,
			max_tokens: maxOutputTokens
		};

		// Add tools if provided. 
		// Fallback logic: if the request is too large for the local context (4096), 
		// we try to send it without tools to reduce the prompt size.
		if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
			// Tool exclusion list for local models
			const excludedTools = [
				'setup_tools_createNewWorkspace',
				'inline_chat_exit',
				'vscode_searchExtensions_internal',
				'vscode_get_terminal_confirmation',
				'get_terminal_output',
				'await_terminal',
				'terminal_selection',
				'terminal_last_command',
				'create_and_run_task',
				'vscode_fetchWebPage_internal',
				// 'run_in_terminal',
				// 'vscode_readFile',
				// 'vscode_listDirectory',
				// 'vscode_readLints',
				// 'vscode_grep',
				// 'vscode_findFiles',
				// 'vscode_webSearch',
				// 'vscode_modifyFile',
				// 'vscode_editFile_internal',
				'manage_todo_list',
				'vscode_get_confirmation',
				'runSubagent'
			];

			const filteredTools = options.tools.filter((t: any) => {
				const name = t.function?.name || t.name;
				return name && !excludedTools.includes(name);
			});

			if (filteredTools.length > 0) {
				// Check if we should use manual tool injection as fallback or primary for local
				// const useManualTools = !model.useNativeTools;
				// if (useManualTools) {
				// 	const toolDefinitions = filteredTools.map((t: any) => {
				// 		const func = t.function || t;
				// 		return `- ${func.name}: ${func.description}\n  Parameters: ${JSON.stringify(func.parameters)}`;
				// 	}).join('\n');
				// 	
				// 	const systemPromptExtension = `\n\nYou have access to the following tools. To call a tool, respond ONLY with a JSON object in this format: {"tool_calls": [{"id": "call_abc123", "type": "function", "function": {"name": "tool_name", "arguments": "{\\"arg1\\": \\"val1\\"}"}}]}. \n\nIMPORTANT: After outputting the JSON tool call, you MUST STOP your response immediately. Do not provide any explanation or tool response yourself.\n\nAvailable tools:\n${toolDefinitions}`;
				// 	
				// 	// Find system message or add one
				// 	let systemMessage = mappedMessages.find(m => m.role === 'system');
				// 	if (systemMessage) {
				// 		systemMessage.content += systemPromptExtension;
				// 	} else {
				// 		mappedMessages.unshift({ role: 'system', content: `You are a helpful assistant.${systemPromptExtension}` });
				// 	}
				// 	this._log(`[LoCoPilot Provider] Injected ${filteredTools.length} tools into system prompt for local model (Excluded: ${options.tools.length - filteredTools.length})`);
				// } else {
				if (model.useNativeTools) {
					body.tools = filteredTools;
					this._log(`[LoCoPilot Provider] Local model request: ${filteredTools.length} tools`);
				}
			} else {
				this._log(`[LoCoPilot Provider] All ${options.tools.length} tools were excluded for local model`);
			}
		}

		const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
		try {
			let response = await this.requestService.request({
				type: 'POST',
				url,
				headers,
				data: JSON.stringify(body)
			}, token);

			// Fallback: If 400 error and tools were provided, try again without tools
			if (response.res.statusCode === 400 && body.tools) {
				this._log(`[LoCoPilot Provider] Local model request failed with 400, retrying without tools as fallback...`);
				const fallbackBody = { ...body };
				delete fallbackBody.tools;
				response = await this.requestService.request({
					type: 'POST',
					url,
					headers,
					data: JSON.stringify(fallbackBody)
				}, token);
			}

			if (response.res.statusCode !== 200) {
				const msg = response.res.statusCode === 404 || response.res.statusCode === 502 || response.res.statusCode === 503
					? this._getLocalLlamaServerNotRunningMessage(model.modelName)
					: `Local model "${model.modelName}" request failed (${response.res.statusCode}).`;
				throw new Error(msg);
			}
			let buffer = '';
			return new Promise<void>((resolve, reject) => {
				// OpenAI streams tool_calls in deltas: id, function.name, and function.arguments arrive in separate chunks. Accumulate by index and emit on stream end.
				const accumulatedToolCalls: Map<number, { id?: string; name?: string; args: string }> = new Map();

				listenStream(response.stream, {
					onData: chunk => {
						buffer += chunk.toString();
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';
						for (const line of lines) {
							const trimmed = line.trim();
							if (trimmed.startsWith('data: ')) {
								const data = trimmed.slice(6);
								if (data === '[DONE]') continue;
								try {
									const json = JSON.parse(data);
									// Debug log for thinking content
									if (json.choices?.[0]?.delta?.reasoning_content) {
										this._log(`[LoCoPilot Provider] Reasoning delta: ${json.choices[0].delta.reasoning_content}`);
									}
									const choice = json.choices?.[0];
									if (choice?.delta?.content) {
										const content = choice.delta.content;
										// accumulatedContent += content;
										// 
										// // Check for manual tool call in accumulated content
										// if (accumulatedContent.includes('"tool_calls"')) {
										// 	try {
										// 		// Try to find a complete JSON block in the accumulated content
										// 		const match = accumulatedContent.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
										// 		if (match) {
										// 			const potentialJson = JSON.parse(match[0]);
										// 			if (potentialJson.tool_calls) {
										// 				for (const tc of potentialJson.tool_calls) {
										// 					const idx = tc.index ?? 0;
										// 					let acc = accumulatedToolCalls.get(idx);
										// 					if (!acc) {
										// 						acc = { args: '' };
										// 						accumulatedToolCalls.set(idx, acc);
										// 					}
										// 					if (tc.id) acc.id = tc.id;
										// 					if (tc.function?.name) acc.name = tc.function.name;
										// 					if (tc.function?.arguments) {
										// 						acc.args = typeof tc.function.arguments === 'string' 
										// 							? tc.function.arguments 
										// 							: JSON.stringify(tc.function.arguments);
										// 					}
										// 				}
										// 				// If we successfully parsed a tool call, remove it from accumulatedContent so it's not emitted as text
										// 				accumulatedContent = accumulatedContent.replace(match[0], '');
										// 				continue;
										// 			}
										// 		}
										// 	} catch {
										// 		// JSON might be incomplete, wait for more chunks
										// 	}
										// }
										// 
										// // Only emit content if it doesn't look like the start of a tool call
										// if (!accumulatedContent.trim().startsWith('{') || accumulatedContent.length > 1000) {
										// 	stream.emitOne({ type: 'text', value: accumulatedContent });
										// 	accumulatedContent = '';
										// }
										stream.emitOne({ type: 'text', value: content });
									}
									if (choice?.delta?.reasoning_content) {
										stream.emitOne({ type: 'thinking', value: choice.delta.reasoning_content });
									}
									// Accumulate tool call deltas by index (id, function.name, function.arguments stream separately)
									if (choice?.delta?.tool_calls) {
										for (const tc of choice.delta.tool_calls) {
											const idx = tc.index ?? 0;
											let acc = accumulatedToolCalls.get(idx);
											if (!acc) {
												acc = { args: '' };
												accumulatedToolCalls.set(idx, acc);
											}
											if (tc.id) acc.id = tc.id;
											if (tc.function?.name) acc.name = tc.function.name;
											if (tc.function?.arguments !== undefined) acc.args += tc.function.arguments;
										}
									}
								} catch {
									// ignore parse errors
								}
							}
						}
					},
					onError: error => reject(error),
					onEnd: () => {
						// Emit complete accumulated tool calls once stream ends
						const indices = Array.from(accumulatedToolCalls.keys()).sort((a, b) => a - b);
						for (const idx of indices) {
							const acc = accumulatedToolCalls.get(idx)!;
							if (acc.id && acc.name) {
								try {
									const parameters = acc.args ? JSON.parse(acc.args) : {};
									stream.emitOne({
										type: 'tool_use',
										name: acc.name,
										toolCallId: acc.id,
										parameters
									});
								} catch (_e) {
									// If arguments are incomplete/invalid JSON, still emit so agent can handle
									stream.emitOne({
										type: 'tool_use',
										name: acc.name,
										toolCallId: acc.id,
										parameters: {}
									});
								}
							}
						}
						resolve();
					}
				}, token);
			});
		} catch (e: unknown) {
			const errMsg = e && typeof (e as Error).message === 'string' ? (e as Error).message : String(e);
			if (this._isCanceledError(errMsg)) {
				throw new Error(this._getCanceledMessage());
			}
			const isConnectionRefused = /ECONNREFUSED|ERR_CONNECTION_REFUSED|net::ERR_CONNECTION_REFUSED|fetch failed|Failed to fetch/i.test(errMsg);
			const msg = isConnectionRefused
				? this._getLocalLlamaServerNotRunningMessage(model.modelName)
				: `Local model "${model.modelName}" error: ${errMsg}`;
			throw new Error(msg);
		}
	}

	/**
	 * Ollama native `/api/chat` expects string `content` per message; OpenAI-style multimodal arrays need `/v1/chat/completions`.
	 */
	private _ollamaMessagesNeedOpenAiCompat(mappedMessages: unknown[]): boolean {
		for (const m of mappedMessages) {
			if (m && typeof m === 'object' && 'content' in m) {
				const c = (m as { content?: unknown }).content;
				if (c !== undefined && c !== null && typeof c !== 'string') {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Calls an Ollama model via native `/api/chat` (NDJSON) so `message.thinking` streams to the thinking UI.
	 * Falls back to OpenAI-compatible `/v1/chat/completions` for multimodal / non-string message content.
	 */
	private async _callOllamaModel(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		const baseUrl = (model.localPath || 'http://localhost:11434').replace(/\/$/, '');
		const mappedMessages = messages.flatMap(m => this._mapMessageToOpenAI(m));
		const maxOutputTokens = model.maxOutputTokens ?? 1000;

		const excludedTools = [
			'setup_tools_createNewWorkspace',
			'inline_chat_exit',
			'vscode_searchExtensions_internal',
			'vscode_get_terminal_confirmation',
			'get_terminal_output',
			'await_terminal',
			'terminal_selection',
			'terminal_last_command',
			'create_and_run_task',
			'vscode_fetchWebPage_internal',
			'manage_todo_list',
			'vscode_get_confirmation',
			'runSubagent'
		];

		let filteredTools: unknown[] | undefined;
		if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
			filteredTools = options.tools.filter((t: any) => {
				const name = t.function?.name || t.name;
				return name && !excludedTools.includes(name);
			});
			if (filteredTools.length === 0) {
				filteredTools = undefined;
			}
		}

		if (this._ollamaMessagesNeedOpenAiCompat(mappedMessages)) {
			this._log(`[LoCoPilot Provider] Ollama: using OpenAI-compatible endpoint (multimodal or non-string content)`);
			return this._callOllamaOpenAICompat(model, baseUrl, mappedMessages, options, stream, token, maxOutputTokens, filteredTools);
		}

		this._log(`[LoCoPilot Provider] Calling Ollama native API: ${model.modelName} at ${baseUrl}/api/chat`);
		return this._callOllamaNativeChat(model, baseUrl, mappedMessages, options, stream, token, maxOutputTokens, filteredTools);
	}

	/**
	 * Ollama `/api/chat` — streams `application/x-ndjson` with `message.thinking` and `message.content` deltas.
	 */
	private async _callOllamaNativeChat(
		model: ICustomLanguageModel,
		baseUrl: string,
		mappedMessages: unknown[],
		options: { [name: string]: unknown },
		stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>,
		token: CancellationToken,
		maxOutputTokens: number,
		filteredTools: unknown[] | undefined,
	): Promise<void> {
		const url = `${baseUrl}/api/chat`;
		const body: Record<string, unknown> = {
			model: model.modelName,
			messages: mappedMessages,
			stream: true,
			think: true,
			options: {
				temperature: 0.3,
				num_predict: maxOutputTokens,
			},
		};

		if (filteredTools && filteredTools.length > 0 && model.useNativeTools) {
			body.tools = filteredTools;
			this._log(`[LoCoPilot Provider] Ollama native request: ${filteredTools.length} tools`);
		}

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/x-ndjson, application/json;q=0.9, */*;q=0.8',
		};

		try {
			const response = await this.requestService.request({
				type: 'POST',
				url,
				headers,
				data: JSON.stringify(body),
			}, token);

			if (response.res.statusCode !== 200) {
				const errorBody = await streamToBuffer(response.stream).then(b => b.toString());
				throw new Error(this._getApiErrorMessage('Ollama', response.res.statusCode ?? 0) + (errorBody ? `: ${errorBody}` : ''));
			}

			let lineBuffer = '';
			let hasEmittedAnything = false;
			let ndjsonError: Error | undefined;

			return new Promise<void>((resolve, reject) => {
				const accumulatedToolCalls = new Map<number, { id?: string; name?: string; args: string }>();

				const mergeToolCallDeltas = (toolCalls: unknown[]) => {
					for (const tc of toolCalls) {
						if (!tc || typeof tc !== 'object') {
							continue;
						}
						const t = tc as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
						const idx = t.index ?? 0;
						let acc = accumulatedToolCalls.get(idx);
						if (!acc) {
							acc = { args: '' };
							accumulatedToolCalls.set(idx, acc);
						}
						if (t.id) {
							acc.id = t.id;
						}
						if (t.function?.name) {
							acc.name = t.function.name;
						}
						if (t.function?.arguments !== undefined) {
							acc.args += t.function.arguments;
						}
					}
				};

				const emitToolCallsEnd = () => {
					const indices = Array.from(accumulatedToolCalls.keys()).sort((a, b) => a - b);
					for (const idx of indices) {
						const acc = accumulatedToolCalls.get(idx)!;
						if (acc.id && acc.name) {
							try {
								const parameters = acc.args ? JSON.parse(acc.args) : {};
								stream.emitOne({
									type: 'tool_use',
									name: acc.name,
									toolCallId: acc.id,
									parameters,
								});
							} catch (_e) {
								stream.emitOne({
									type: 'tool_use',
									name: acc.name,
									toolCallId: acc.id,
									parameters: {},
								});
							}
						}
					}
				};

				listenStream(response.stream, {
					onData: chunk => {
						lineBuffer += chunk.toString();
						const lines = lineBuffer.split('\n');
						lineBuffer = lines.pop() || '';
						for (const line of lines) {
							const trimmed = line.trim();
							if (!trimmed) {
								continue;
							}
							try {
								const json = JSON.parse(trimmed) as {
									error?: unknown;
									message?: {
										content?: string;
										thinking?: string;
										reasoning?: string;
										tool_calls?: unknown[];
									};
								};

								if (json.error !== undefined) {
									const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
									ndjsonError = new Error(msg);
									return;
								}

								const msg = json.message;
								if (!msg) {
									continue;
								}

								// Reasoning trace: native `thinking` (optional alias `reasoning` for compatibility)
								const thinkingDelta = msg.thinking ?? msg.reasoning;
								if (typeof thinkingDelta === 'string' && thinkingDelta.length > 0) {
									stream.emitOne({ type: 'thinking', value: thinkingDelta });
									hasEmittedAnything = true;
								}

								if (typeof msg.content === 'string' && msg.content.length > 0) {
									stream.emitOne({ type: 'text', value: msg.content });
									hasEmittedAnything = true;
								}

								if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
									mergeToolCallDeltas(msg.tool_calls);
								}
							} catch {
								// Incomplete line or non-JSON — wait for more data
							}
						}
					},
					onError: error => reject(error),
					onEnd: () => {
						if (ndjsonError) {
							reject(ndjsonError);
							return;
						}
						emitToolCallsEnd();
						if (!hasEmittedAnything && accumulatedToolCalls.size === 0 && !options.tools) {
							stream.emitOne({ type: 'text', value: 'The model did not return a response. Please try again or try with another model.' });
						} else if (!hasEmittedAnything && accumulatedToolCalls.size === 0 && options.tools) {
							this._log(`[LoCoPilot Provider] Ollama native model returned empty response for tool-calling request. This might trigger a nudge.`);
						}
						resolve();
					},
				}, token);
			});
		} catch (e: unknown) {
			const errMsg = e && typeof (e as Error).message === 'string' ? (e as Error).message : String(e);
			if (this._isCanceledError(errMsg)) {
				throw new Error(this._getCanceledMessage());
			}
			const isConnectionRefused = /ECONNREFUSED|fetch failed|Failed to fetch/i.test(errMsg);
			const msg = isConnectionRefused
				? `Ollama server is not running at ${baseUrl}. Please start Ollama and try again.`
				: `Ollama model "${model.modelName}" error: ${errMsg}`;
			throw new Error(msg);
		}
	}

	/**
	 * Ollama `/v1/chat/completions` — OpenAI-compatible SSE (e.g. `delta.reasoning_content`); used for multimodal prompts.
	 */
	private async _callOllamaOpenAICompat(
		model: ICustomLanguageModel,
		baseUrl: string,
		mappedMessages: unknown[],
		options: { [name: string]: unknown },
		stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>,
		token: CancellationToken,
		maxOutputTokens: number,
		filteredTools: unknown[] | undefined,
	): Promise<void> {
		const url = `${baseUrl}/v1/chat/completions`;
		this._log(`[LoCoPilot Provider] Calling Ollama OpenAI-compat: ${model.modelName} at ${baseUrl}`);
		const body: any = {
			model: model.modelName,
			messages: mappedMessages,
			stream: true,
			temperature: 0.3,
			max_tokens: maxOutputTokens
		};

		if (filteredTools && filteredTools.length > 0 && model.useNativeTools) {
			body.tools = filteredTools;
			this._log(`[LoCoPilot Provider] Ollama OpenAI-compat request: ${filteredTools.length} native tools`);
		}

		const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
		try {
			let response = await this.requestService.request({
				type: 'POST',
				url,
				headers,
				data: JSON.stringify(body)
			}, token);

			if (response.res.statusCode !== 200) {
				const errorBody = await streamToBuffer(response.stream).then(b => b.toString());
				throw new Error(this._getApiErrorMessage('Ollama', response.res.statusCode ?? 0) + (errorBody ? `: ${errorBody}` : ''));
			}

			let buffer = '';
			let accumulatedContent = '';
			let hasEmittedAnything = false;

			return new Promise<void>((resolve, reject) => {
				const accumulatedToolCalls: Map<number, { id?: string; name?: string; args: string }> = new Map();

				listenStream(response.stream, {
					onData: chunk => {
						buffer += chunk.toString();
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';
						for (const line of lines) {
							const trimmed = line.trim();
							if (trimmed.startsWith('data: ')) {
								const data = trimmed.slice(6);
								if (data === '[DONE]') continue;
								try {
									const json = JSON.parse(data);
									if (json.choices?.[0]?.delta?.reasoning_content) {
										this._log(`[LoCoPilot Provider] Reasoning delta: ${json.choices[0].delta.reasoning_content}`);
									}
									const choice = json.choices?.[0];
									if (choice?.delta?.content) {
										const content = choice.delta.content;
										stream.emitOne({ type: 'text', value: content });
										hasEmittedAnything = true;
									}
									if (choice?.delta?.reasoning_content) {
										stream.emitOne({ type: 'thinking', value: choice.delta.reasoning_content });
									}
									if (choice?.delta?.tool_calls) {
										for (const tc of choice.delta.tool_calls) {
											const idx = tc.index ?? 0;
											let acc = accumulatedToolCalls.get(idx);
											if (!acc) {
												acc = { args: '' };
												accumulatedToolCalls.set(idx, acc);
											}
											if (tc.id) acc.id = tc.id;
											if (tc.function?.name) acc.name = tc.function.name;
											if (tc.function?.arguments !== undefined) acc.args += tc.function.arguments;
										}
									}
								} catch {
								}
							}
						}
					},
					onError: error => reject(error),
					onEnd: () => {
						if (accumulatedContent.includes('"tool_calls"')) {
							try {
								const match = accumulatedContent.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
								if (match) {
									const potentialJson = JSON.parse(match[0]);
									if (potentialJson.tool_calls) {
										for (const tc of potentialJson.tool_calls) {
											const idx = tc.index ?? 0;
											let acc = accumulatedToolCalls.get(idx);
											if (!acc) {
												acc = { args: '' };
												accumulatedToolCalls.set(idx, acc);
											}
											if (tc.id) acc.id = tc.id;
											if (tc.function?.name) acc.name = tc.function.name;
											if (tc.function?.arguments) {
												acc.args = typeof tc.function.arguments === 'string'
													? tc.function.arguments
													: JSON.stringify(tc.function.arguments);
											}
										}
										accumulatedContent = accumulatedContent.replace(match[0], '');
									}
								}
							} catch { /* empty */ }
						}

						if (accumulatedContent.trim()) {
							stream.emitOne({ type: 'text', value: accumulatedContent });
							hasEmittedAnything = true;
						}

						if (!hasEmittedAnything && accumulatedToolCalls.size === 0 && !options.tools) {
							stream.emitOne({ type: 'text', value: 'The model did not return a response. Please try again or try with another model.' });
						} else if (!hasEmittedAnything && accumulatedToolCalls.size === 0 && options.tools) {
							this._log(`[LoCoPilot Provider] Ollama model returned empty response for tool-calling request. This might trigger a nudge.`);
						}

						const indices = Array.from(accumulatedToolCalls.keys()).sort((a, b) => a - b);
						for (const idx of indices) {
							const acc = accumulatedToolCalls.get(idx)!;
							if (acc.id && acc.name) {
								try {
									const parameters = acc.args ? JSON.parse(acc.args) : {};
									stream.emitOne({
										type: 'tool_use',
										name: acc.name,
										toolCallId: acc.id,
										parameters
									});
								} catch (_e) {
									stream.emitOne({
										type: 'tool_use',
										name: acc.name,
										toolCallId: acc.id,
										parameters: {}
									});
								}
							}
						}
						resolve();
					}
				}, token);
			});
		} catch (e: unknown) {
			const errMsg = e && typeof (e as Error).message === 'string' ? (e as Error).message : String(e);
			if (this._isCanceledError(errMsg)) {
				throw new Error(this._getCanceledMessage());
			}
			const isConnectionRefused = /ECONNREFUSED|fetch failed|Failed to fetch/i.test(errMsg);
			const msg = isConnectionRefused
				? `Ollama server is not running at ${baseUrl}. Please start Ollama and try again.`
				: `Ollama model "${model.modelName}" error: ${errMsg}`;
			throw new Error(msg);
		}
	}

	/**
	 * Calls a user-configured localhost URL. model.modelName holds the complete endpoint URL
	 * (e.g. http://localhost:1234/v1/chat/completions) as provided by the user.
	 */
	private async _callLocalhostModel(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		const url = model.modelName?.trim();
		if (!url) {
			throw new Error('Localhost URL is not set. Edit this model in LoCoPilot Settings and enter the complete endpoint URL.');
		}
		this._log(`[LoCoPilot Provider] Calling localhost model at: ${url}`);
		const mappedMessages = messages.flatMap(m => this._mapMessageToOpenAI(m));
		const maxOutputTokens = model.maxOutputTokens ?? 1000;
		const body: any = {
			model: model.name || 'local',
			messages: mappedMessages,
			stream: true,
			temperature: 0.3,
			max_tokens: maxOutputTokens
		};

		// Add tools if provided
		if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
			// Tool exclusion list for localhost models
			const excludedTools = [
				'setup_tools_createNewWorkspace',
				'inline_chat_exit',
				'vscode_searchExtensions_internal',
				'vscode_get_terminal_confirmation',
				'get_terminal_output',
				'await_terminal',
				'terminal_selection',
				'terminal_last_command',
				'create_and_run_task',
				'vscode_fetchWebPage_internal',
				// 'run_in_terminal',
				// 'vscode_readFile',
				// 'vscode_listDirectory',
				// 'vscode_readLints',
				// 'vscode_grep',
				// 'vscode_findFiles',
				// 'vscode_webSearch',
				// 'vscode_modifyFile',
				// 'vscode_editFile_internal',
				'manage_todo_list',
				'vscode_get_confirmation',
				'runSubagent'
			];

			const filteredTools = options.tools.filter((t: any) => {
				const name = t.function?.name || t.name;
				return name && !excludedTools.includes(name);
			});

			if (filteredTools.length > 0) {
				// const useManualTools = !model.useNativeTools;
				// if (useManualTools) {
				// 	const toolDefinitions = filteredTools.map((t: any) => {
				// 		const func = t.function || t;
				// 		return `- ${func.name}: ${func.description}\n  Parameters: ${JSON.stringify(func.parameters)}`;
				// 	}).join('\n');
				// 	
				// 	const systemPromptExtension = `\n\nYou have access to the following tools. To call a tool, respond ONLY with a JSON object in this format: {"tool_calls": [{"id": "call_abc123", "type": "function", "function": {"name": "tool_name", "arguments": "{\\"arg1\\": \\"val1\\"}"}}]}. \n\nIMPORTANT: After outputting the JSON tool call, you MUST STOP your response immediately. Do not provide any explanation or tool response yourself.\n\nAvailable tools:\n${toolDefinitions}`;
				// 	
				// 	// Find system message or add one
				// 	let systemMessage = mappedMessages.find(m => m.role === 'system');
				// 	if (systemMessage) {
				// 		systemMessage.content += systemPromptExtension;
				// 	} else {
				// 		mappedMessages.unshift({ role: 'system', content: `You are a helpful assistant.${systemPromptExtension}` });
				// 	}
				// 	this._log(`[LoCoPilot Provider] Injected ${filteredTools.length} tools into system prompt for localhost model (Excluded: ${options.tools.length - filteredTools.length})`);
				// } else {
				if (model.useNativeTools) {
					body.tools = filteredTools;
					this._log(`[LoCoPilot Provider] Localhost model request: ${filteredTools.length} native tools`);
				}
			} else {
				this._log(`[LoCoPilot Provider] All ${options.tools.length} tools were excluded for localhost model`);
			}
		}

		const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
		try {
			let response = await this.requestService.request({
				type: 'POST',
				url,
				headers,
				data: JSON.stringify(body)
			}, token);

			// Fallback: If 400 error and tools were provided, try again without tools
			if (response.res.statusCode === 400 && body.tools) {
				this._log(`[LoCoPilot Provider] Localhost model request failed with 400, retrying without tools as fallback...`);
				const fallbackBody = { ...body };
				delete fallbackBody.tools;
				response = await this.requestService.request({
					type: 'POST',
					url,
					headers,
					data: JSON.stringify(fallbackBody)
				}, token);
			}

			if (response.res.statusCode !== 200) {
				const msg = response.res.statusCode === 404 || response.res.statusCode === 502 || response.res.statusCode === 503
					? `Localhost server not responding at ${url}. Check that the server is running and the URL is correct.`
					: `Localhost model "${model.name}" request failed (${response.res.statusCode}).`;
				throw new Error(msg);
			}
			let buffer = '';
			return new Promise<void>((resolve, reject) => {
				// OpenAI streams tool_calls in deltas: id, function.name, and function.arguments arrive in separate chunks. Accumulate by index and emit on stream end.
				const accumulatedToolCalls: Map<number, { id?: string; name?: string; args: string }> = new Map();

				listenStream(response.stream, {
					onData: chunk => {
						buffer += chunk.toString();
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';
						for (const line of lines) {
							const trimmed = line.trim();
							if (trimmed.startsWith('data: ')) {
								const data = trimmed.slice(6);
								if (data === '[DONE]') continue;
								try {
									const json = JSON.parse(data);
									// Debug log for thinking content
									if (json.choices?.[0]?.delta?.reasoning_content) {
										this._log(`[LoCoPilot Provider] Reasoning delta: ${json.choices[0].delta.reasoning_content}`);
									}
									const choice = json.choices?.[0];
									if (choice?.delta?.content) {
										const content = choice.delta.content;
										// accumulatedContent += content;
										// 
										// // Check for manual tool call in accumulated content
										// if (accumulatedContent.includes('"tool_calls"')) {
										// 	try {
										// 		// Try to find a complete JSON block in the accumulated content
										// 		const match = accumulatedContent.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
										// 		if (match) {
										// 			const potentialJson = JSON.parse(match[0]);
										// 			if (potentialJson.tool_calls) {
										// 				for (const tc of potentialJson.tool_calls) {
										// 					const idx = tc.index ?? 0;
										// 					let acc = accumulatedToolCalls.get(idx);
										// 					if (!acc) {
										// 						acc = { args: '' };
										// 						accumulatedToolCalls.set(idx, acc);
										// 					}
										// 					if (tc.id) acc.id = tc.id;
										// 					if (tc.function?.name) acc.name = tc.function.name;
										// 					if (tc.function?.arguments) {
										// 						acc.args = typeof tc.function.arguments === 'string' 
										// 							? tc.function.arguments 
										// 							: JSON.stringify(tc.function.arguments);
										// 					}
										// 				}
										// 				// If we successfully parsed a tool call, remove it from accumulatedContent so it's not emitted as text
										// 				accumulatedContent = accumulatedContent.replace(match[0], '');
										// 				continue;
										// 			}
										// 		}
										// 	} catch {
										// 		// JSON might be incomplete, wait for more chunks
										// 	}
										// }
										// 
										// // Only emit content if it doesn't look like the start of a tool call
										// if (!accumulatedContent.trim().startsWith('{') || accumulatedContent.length > 1000) {
										// 	stream.emitOne({ type: 'text', value: accumulatedContent });
										// 	accumulatedContent = '';
										// }
										stream.emitOne({ type: 'text', value: content });
									}
									if (choice?.delta?.reasoning_content) {
										stream.emitOne({ type: 'thinking', value: choice.delta.reasoning_content });
									}
									// Accumulate tool call deltas by index (id, function.name, function.arguments stream separately)
									if (choice?.delta?.tool_calls) {
										for (const tc of choice.delta.tool_calls) {
											const idx = tc.index ?? 0;
											let acc = accumulatedToolCalls.get(idx);
											if (!acc) {
												acc = { args: '' };
												accumulatedToolCalls.set(idx, acc);
											}
											if (tc.id) acc.id = tc.id;
											if (tc.function?.name) acc.name = tc.function.name;
											if (tc.function?.arguments !== undefined) acc.args += tc.function.arguments;
										}
									}
								} catch {
									// ignore parse errors
								}
							}
						}
					},
					onError: error => reject(error),
					onEnd: () => {
						// Emit complete accumulated tool calls once stream ends
						const indices = Array.from(accumulatedToolCalls.keys()).sort((a, b) => a - b);
						for (const idx of indices) {
							const acc = accumulatedToolCalls.get(idx)!;
							if (acc.id && acc.name) {
								try {
									const parameters = acc.args ? JSON.parse(acc.args) : {};
									stream.emitOne({
										type: 'tool_use',
										name: acc.name,
										toolCallId: acc.id,
										parameters
									});
								} catch (_e) {
									// If arguments are incomplete/invalid JSON, still emit so agent can handle
									stream.emitOne({
										type: 'tool_use',
										name: acc.name,
										toolCallId: acc.id,
										parameters: {}
									});
								}
							}
						}
						resolve();
					}
				}, token);
			});
		} catch (e: unknown) {
			const errMsg = e && typeof (e as Error).message === 'string' ? (e as Error).message : String(e);
			if (this._isCanceledError(errMsg)) {
				throw new Error(this._getCanceledMessage());
			}
			const isConnectionRefused = /ECONNREFUSED|fetch failed|Failed to fetch/i.test(errMsg);
			const msg = isConnectionRefused
				? `Cannot reach localhost at ${url}. Check that the server is running and the URL in LoCoPilot Settings is correct.`
				: `Localhost model "${model.name}" error: ${errMsg}`;
			throw new Error(msg);
		}
	}

	/** Allowed keys for Gemini function declaration parameters (subset of OpenAPI schema; no additionalProperties etc.). */
	private static readonly _GOOGLE_SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum']);

	/**
	 * Recursively strips schema fields that Google's API does not support (e.g. additionalProperties).
	 */
	private _sanitizeSchemaForGoogle(schema: any): any {
		if (schema === null || schema === undefined) {
			return schema;
		}
		if (Array.isArray(schema)) {
			return schema.map(item => this._sanitizeSchemaForGoogle(item));
		}
		if (typeof schema !== 'object') {
			return schema;
		}
		const out: any = {};
		for (const key of Object.keys(schema)) {
			if (!LoCoPilotLanguageModelProvider._GOOGLE_SCHEMA_KEYS.has(key)) {
				continue;
			}
			const val = schema[key];
			if (key === 'properties' && typeof val === 'object' && !Array.isArray(val)) {
				const sanitized: any = {};
				for (const prop of Object.keys(val)) {
					sanitized[prop] = this._sanitizeSchemaForGoogle(val[prop]);
				}
				out[key] = sanitized;
			} else if (key === 'items' && val !== null && typeof val === 'object') {
				out[key] = this._sanitizeSchemaForGoogle(val);
			} else {
				out[key] = val;
			}
		}
		return out;
	}

	private _mapRole(role: ChatMessageRole): string {
		switch (role) {
			case ChatMessageRole.System: return 'system';
			case ChatMessageRole.User: return 'user';
			case ChatMessageRole.Assistant: return 'assistant';
			default: return 'user';
		}
	}

	/**
	 * Maps a single IChatMessage to one or more OpenAI API message objects.
	 * Assistant messages with tool_use become { role, content, tool_calls }.
	 * User messages with tool_result parts become a user message (if text) + one "tool" message per result.
	 */
	private _mapMessageToOpenAI(message: IChatMessage): any[] {
		const role = this._mapRole(message.role);

		if (message.role === ChatMessageRole.Assistant) {
			let textContent = '';
			const toolCalls: any[] = [];
			for (const part of message.content) {
				if (part.type === 'text') {
					textContent += part.value;
				} else if (part.type === 'image_url') {
					// Skip images in tool-call path for simplicity; could be extended
				} else if (part.type === 'tool_use' && part.toolCallId && part.name) {
					toolCalls.push({
						id: part.toolCallId,
						type: 'function',
						function: {
							name: part.name,
							arguments: JSON.stringify(part.parameters || {})
						}
					});
				}
			}
			const content = textContent.trim() || null;
			if (toolCalls.length > 0) {
				return [{ role: 'assistant', content, tool_calls: toolCalls }];
			}
			return [{ role, content: content || '' }];
		}

		if (message.role === ChatMessageRole.User) {
			const textParts: string[] = [];
			const imageParts: { type: 'image_url'; image_url: { url: string } }[] = [];
			const toolResults: { toolCallId: string; value: any }[] = [];
			for (const part of message.content) {
				if (part.type === 'text') {
					textParts.push(part.value);
				} else if (part.type === 'image_url') {
					const base64 = encodeBase64(part.value.data);
					imageParts.push({
						type: 'image_url',
						image_url: { url: `data:${part.value.mimeType};base64,${base64}` }
					});
				} else if (part.type === 'tool_result' && part.toolCallId !== undefined) {
					const value = part.value;
					const str = Array.isArray(value) ? value.map((v: any) => v.type === 'text' ? v.value : '').join('') : String(value);
					toolResults.push({ toolCallId: part.toolCallId, value: str });
				}
			}
			const out: any[] = [];
			// User message: use content array when we have images (OpenAI multimodal), else plain text
			if (textParts.length > 0 || imageParts.length > 0) {
				if (imageParts.length > 0) {
					const contentParts: any[] = [];
					if (textParts.length > 0) {
						contentParts.push({ type: 'text', text: textParts.join('\n') });
					}
					contentParts.push(...imageParts);
					out.push({ role: 'user', content: contentParts });
				} else {
					out.push({ role: 'user', content: textParts.join('\n') });
				}
			}
			for (const tr of toolResults) {
				out.push({ role: 'tool', tool_call_id: tr.toolCallId, content: tr.value });
			}
			if (out.length === 0) {
				out.push({ role: 'user', content: '' });
			}
			return out;
		}

		// System or other: text + image only
		const contentParts: any[] = [];
		for (const part of message.content) {
			if (part.type === 'text') {
				contentParts.push({ type: 'text', text: part.value });
			} else if (part.type === 'image_url') {
				const base64 = encodeBase64(part.value.data);
				contentParts.push({
					type: 'image_url',
					image_url: {
						url: `data:${part.value.mimeType};base64,${base64}`
					}
				});
			}
		}
		if (contentParts.length === 1 && contentParts[0].type === 'text') {
			return [{ role, content: contentParts[0].text }];
		}
		return [{ role, content: contentParts }];
	}

	private _mapMessageToAnthropic(message: IChatMessage): any {
		const role = message.role === ChatMessageRole.Assistant ? 'assistant' : 'user';
		const contentParts: any[] = [];

		for (const part of message.content) {
			if (part.type === 'text') {
				contentParts.push({ type: 'text', text: part.value });
			} else if (part.type === 'image_url') {
				// Convert VSBuffer to base64
				const base64 = encodeBase64(part.value.data);
				contentParts.push({
					type: 'image',
					source: {
						type: 'base64',
						media_type: part.value.mimeType,
						data: base64
					}
				});
			} else if (part.type === 'tool_use' && part.toolCallId && part.name) {
				contentParts.push({
					type: 'tool_use',
					id: part.toolCallId,
					name: part.name,
					input: part.parameters || {}
				});
			} else if (part.type === 'tool_result' && part.toolCallId !== undefined) {
				const value = part.value;
				const str = Array.isArray(value)
					? value.map((v: any) => (v.type === 'text' ? v.value : '')).join('')
					: (typeof value === 'string' ? value : JSON.stringify(value ?? ''));
				contentParts.push({
					type: 'tool_result',
					tool_use_id: part.toolCallId,
					content: str
				});
			}
		}

		// If only one text part and no tool_use/tool_result, return as string for simplicity
		if (contentParts.length === 1 && contentParts[0].type === 'text') {
			return { role, content: contentParts[0].text };
		}

		// Empty assistant content is invalid; use empty text block
		if (contentParts.length === 0 && role === 'assistant') {
			return { role, content: [{ type: 'text', text: '' }] };
		}
		if (contentParts.length === 0 && role === 'user') {
			return { role, content: '' };
		}

		return { role, content: contentParts };
	}

	/**
	 * Maps IChatMessage to Google GenerateContent contents item (role + parts).
	 * For user messages with tool_result, toolCallIdToName (from the previous assistant's tool_use) is used to get the function name.
	 */
	private _mapMessageToGoogle(message: IChatMessage, toolCallIdToName: Record<string, string> = {}): { role: string; parts: any[] } | null {
		const role = message.role === ChatMessageRole.Assistant ? 'model' : 'user';
		const parts: any[] = [];

		for (const part of message.content) {
			if (part.type === 'text') {
				parts.push({ text: part.value });
			} else if (part.type === 'image_url') {
				const base64 = encodeBase64(part.value.data);
				parts.push({
					inline_data: {
						mime_type: part.value.mimeType,
						data: base64
					}
				});
			} else if (message.role === ChatMessageRole.Assistant && part.type === 'tool_use' && part.toolCallId && part.name) {
				// Gemini 3 thinking models require thought_signature on functionCall parts when resending history.
				// Use skip dummy when we don't have the real signature (see https://ai.google.dev/gemini-api/docs/thought-signatures).
				const thoughtSig = part.thoughtSignature;
				parts.push({
					functionCall: {
						name: part.name,
						args: part.parameters ?? {}
					},
					thoughtSignature: thoughtSig ?? 'skip_thought_signature_validator'
				});
			} else if (message.role === ChatMessageRole.User && part.type === 'tool_result' && part.toolCallId !== undefined) {
				const name = toolCallIdToName[part.toolCallId];
				if (!name) {
					continue;
				}
				// part.value is array of content parts; take first text or stringify for response
				let responseObj: object;
				if (Array.isArray(part.value) && part.value.length > 0) {
					const first = part.value[0];
					if (first && typeof first === 'object' && 'type' in first && first.type === 'text' && 'value' in first) {
						try {
							responseObj = JSON.parse(first.value as string) as object;
						} catch {
							responseObj = { result: first.value };
						}
					} else {
						responseObj = { result: part.value };
					}
				} else {
					responseObj = { result: part.value ?? {} };
				}
				parts.push({
					functionResponse: {
						name,
						response: responseObj
					}
				});
			}
		}

		return { role, parts };
	}

	private _mapContent(content: IChatMessage['content']): string {
		return content.map(p => p.type === 'text' ? p.value : '').join('');
	}

	async provideTokenCount(modelId: string, message: string | IChatMessage, token: CancellationToken): Promise<number> {
		const text = typeof message === 'string' ? message : this._mapContent(message.content);
		return Math.ceil(text.length / 4);
	}
}
