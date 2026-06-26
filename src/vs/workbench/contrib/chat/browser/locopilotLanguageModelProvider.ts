/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any, curly */
/* eslint-disable local/code-no-in-operator */

import { AsyncIterableSource, timeout } from '../../../../base/common/async.js';
import { encodeBase64, streamToBuffer } from '../../../../base/common/buffer.js';
import { createMarkdownCommandLink } from '../../../../base/common/htmlContent.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { listenStream } from '../../../../base/common/stream.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration, ChatAgentLocation } from '../common/constants.js';
import { getDefaultPickerRepoId } from './locopilotModelCatalog.js';
import { ITimerService } from '../../../services/timer/browser/timerService.js';
import { ILoCoPilotFileLog } from './locopilotFileLog.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { getReasoningEffort, reasoningBudgetTokens, ReasoningEffort } from '../common/locopilotReasoningEffort.js';
import { ICustomLanguageModelsService, ICustomLanguageModel, getCustomModelListLabel, deriveTokenLimits, defaultContextWindow, TOOL_FAILURE_DISABLE_THRESHOLD, customModelSupportsVision } from '../common/customLanguageModelsService.js';
import { IChatMessage, ILanguageModelChatInfoOptions, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatResponse, ILanguageModelsService, IChatResponsePart, ChatMessageRole } from '../common/languageModels.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { LOCOPILOT_SETTINGS_SECTION_LIST_MODELS } from './chatManagement/locopilotSettingsEditorInput.js';

import { ILoCoPilotLocalModelRunner } from './locopilotLocalModelRunner.js';
import { ILoCoPilotLiveStatsService } from './locopilotLiveStatsService.js';

/** Shape of a single SSE chunk from an OpenAI-compatible `/chat/completions` stream. */
interface IOpenAiStreamChunk {
	choices?: Array<{
		delta?: {
			content?: string;
			reasoning_content?: string;
			reasoning?: string;
			thinking?: string;
			tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string | object } }>;
		};
	}>;
	/** llama.cpp's non-standard per-response timing block (present on each chunk with `timings_per_token`). */
	timings?: {
		predicted_n?: number;
		predicted_per_second?: number;
		prompt_n?: number;
		cache_n?: number;
	};
	/** OpenAI `usage` block, emitted on the final chunk with `stream_options.include_usage`. */
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
	};
}

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
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@ITimerService private readonly timerService: ITimerService,
		@ILoCoPilotLiveStatsService private readonly liveStatsService: ILoCoPilotLiveStatsService,
	) {
		super();
		this._log('[LoCoPilot] Initializing Language Model Provider');

		// Register the 'locopilot' vendor first, otherwise registerLanguageModelProvider will throw
		this.languageModelsService.deltaLanguageModelChatProviderDescriptors([{
			vendor: 'locopilot',
			displayName: 'LoCoPilot',
			configuration: undefined,
			// Adds a "Manage LoCoPilot..." entry in the model picker that opens LoCoPilot Settings (the model
			// list), where users can Show hidden catalog models, download, or manage them.
			managementCommand: 'workbench.action.chat.openLoCoPilotSettings',
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
			const customModels = this.customLanguageModelsService.getChatSelectableCustomModels();
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
	 * Detected system RAM in GB, or 0 if not yet measured. Sourced from the startup metrics the timer service
	 * collects on every platform (no node `os` import needed in this browser layer). `startupMetrics` THROWS
	 * if read before `whenReady()` resolves, so the read is guarded; by the time the picker is shown it is ready.
	 */
	private _detectedRamGB(): number {
		try {
			const totalmem = this.timerService.startupMetrics.totalmem;
			return typeof totalmem === 'number' && totalmem > 0 ? totalmem / (1024 * 1024 * 1024) : 0;
		} catch {
			return 0;
		}
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

	/**
	 * Chat error panel renders this as Markdown. This shows when the model's server isn't ready yet - often
	 * just a slow first launch (weights still loading) rather than a hard failure, and the server keeps coming
	 * up in the background. There is no manual "start" action in the chat panel, so we tell the user to simply
	 * wait a moment and resend; we still link My Models in case they want to inspect the server logs.
	 */
	private _getLocalLlamaServerNotRunningMessage(modelName: string, displayName?: string): string {
		const label = displayName?.trim() || modelName;
		const openModels = createMarkdownCommandLink({
			title: 'My Models',
			id: 'workbench.action.chat.openLoCoPilotSettings',
			arguments: [{ section: LOCOPILOT_SETTINGS_SECTION_LIST_MODELS }],
		});
		return `**${label}** is taking a moment to start. Please wait a few seconds and send your message again. If it keeps happening, open ${openModels} to view its logs.`;
	}

	/**
	 * Shown when the server is up but still loading its weights when the request arrives (the readiness
	 * wait timed out, yet the process is alive and not crashed). This is a transient "wait a moment"
	 * state, not a failure, so we must NOT show the alarming "could not be started" message here - large
	 * models can take a while to load into memory on the first start, after which it works fine.
	 */
	private _getLocalModelStillLoadingMessage(modelName: string, displayName?: string): string {
		const label = displayName?.trim() || modelName;
		return `**${label}** is still loading into memory - large models can take a little while on the first start. Please wait a few seconds and send your message again.`;
	}

	/**
	 * Picks the right message when a local server isn't usable yet: a still-loading server (process alive,
	 * phase 'loading'/'starting') gets the friendly "wait a moment" message; only a genuinely
	 * crashed/unstarted server gets the "could not be started" message. This keeps the user from seeing a
	 * scary failure when the model simply hasn't finished loading.
	 */
	private _getLocalServerUnavailableMessage(model: ICustomLanguageModel): string {
		const phase = this.localModelRunner.getServerPhase(model.id);
		if (phase === 'loading' || phase === 'starting') {
			return this._getLocalModelStillLoadingMessage(model.modelName, model.displayName);
		}
		return this._getLocalLlamaServerNotRunningMessage(model.modelName, model.displayName);
	}

	/**
	 * Many OpenAI-compatible local servers use `reasoning_content`; some (e.g. mlx_lm, Ollama) use `reasoning` or `thinking` in `delta` during SSE.
	 */
	private _reasoningTextFromOpenAiDelta(delta: { reasoning_content?: string; reasoning?: string; thinking?: string } | undefined): string | undefined {
		if (!delta) {
			return undefined;
		}
		const t = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
		return typeof t === 'string' && t.length > 0 ? t : undefined;
	}

	/**
	 * Pull real generation stats out of a local-server SSE chunk into the live-stats service so the timer bar
	 * can show exact tokens / tokens-per-second instead of a word-count estimate. `timings` (llama.cpp) rides
	 * on every chunk; `usage` arrives on the final chunk. Both are absent for servers that don't support them,
	 * in which case nothing is recorded and the UI falls back to the estimate.
	 */
	private _ingestServerStats(json: unknown, report: boolean): void {
		if (!report) {
			return;
		}
		const chunk = json as IOpenAiStreamChunk;
		const timings = chunk?.timings;
		const usage = chunk?.usage;
		if (!timings && !usage) {
			return;
		}
		this.liveStatsService.update({
			// usage is authoritative for token counts; timings.predicted_n tracks it live mid-stream.
			completionTokens: usage?.completion_tokens ?? timings?.predicted_n,
			promptTokens: usage?.prompt_tokens ?? timings?.prompt_n,
			tokensPerSecond: typeof timings?.predicted_per_second === 'number'
				? Math.round(timings.predicted_per_second)
				: undefined,
			cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? timings?.cache_n,
		});
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		// Include not-yet-downloaded local models (catalog entries) so they are selectable in the picker;
		// sendChatRequest then shows an in-chat download prompt with config + progress instead of an error.
		// Sort A-Z by label so the model picker is alphabetical and easy to scan.
		const customModels = this.customLanguageModelsService.getVisibleCustomModels()
			.slice()
			.sort((a, b) => getCustomModelListLabel(a).localeCompare(getCustomModelListLabel(b), undefined, { sensitivity: 'base', numeric: true }));
		this._log(`[LoCoPilot Provider] provideLanguageModelChatInfo called, found ${customModels.length} custom models`);
		// Conservative, RAM-aware out-of-box default (one tier below max; floor = Qwen3.5 4B MTP).
		const defaultPickerRepoId = getDefaultPickerRepoId(this._detectedRamGB());
		const result = customModels.map(m => {
			// Input/output budgets are derived from the single user-set context window.
			const isLocal = m.provider === 'huggingface' || m.provider === 'localhost' || m.provider === 'ollama';
			const contextWindow = m.contextWindow ?? defaultContextWindow(isLocal);
			const { maxInputTokens, maxOutputTokens } = deriveTokenLimits(contextWindow, isLocal);

			// First-time users land on the smallest seeded model. VS Code only honors this when nothing is
			// persisted yet; once the user picks any other model their choice is stored and takes precedence.
			const isPickerDefault = m.modelName === defaultPickerRepoId;
			const isDefaultForLocation = isPickerDefault
				? {
					[ChatAgentLocation.Chat]: true,
					[ChatAgentLocation.Terminal]: true,
					[ChatAgentLocation.Notebook]: true,
					[ChatAgentLocation.EditorInline]: true,
				}
				: {};

			return {
				identifier: m.id,
				metadata: {
					extension: new ExtensionIdentifier('locopilot'),
					name: getCustomModelListLabel(m),
					id: m.id,
					vendor: 'locopilot',
					version: '1.0.0',
					family: m.modelName,
					maxInputTokens,
					maxOutputTokens,
					isDefaultForLocation,
					isUserSelectable: true,
					modelPickerCategory: { label: 'Custom Models', order: 100 },
					capabilities: {
						// Gated per-model: a local GGUF without an mmproj projector can't read images. Once the
						// server rejects one we set supportsVision=false (autoDisableVision) and the attach button
						// is disabled for that model on the next turn. Defaults optimistic for cloud/unknown models.
						vision: customModelSupportsVision(m),
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

		this._log(`[LoCoPilot Provider] Found model: ${getCustomModelListLabel(customModel)} (${customModel.provider}), sending request...`);

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

	/**
	 * Heuristic: does this error look like the provider/model rejecting tool calling specifically
	 * (as opposed to a generic network/auth/rate error)? Used to decide whether to count a tool-shaped
	 * failure toward auto-disabling native tools. Kept conservative to avoid demoting capable models.
	 */
	private _isToolUnsupportedError(errMsg: string): boolean {
		const m = errMsg.toLowerCase();
		if (!/tool|function[\s_-]?call|function calling/.test(m)) {
			return false;
		}
		return /not\s*support|unsupported|isn'?t support|does\s*not\s*support|no endpoints?|cannot|not\s*available|not\s*allowed|invalid|400/.test(m);
	}

	/**
	 * True when a streaming request to a *local* server dropped mid-flight in a way that signals the server is
	 * still coming up rather than a real failure. A freshly-launched llama.cpp/mlx server binds its HTTP port
	 * (so the readiness probe's GET /models returns 200) a beat before it can actually serve a generation; the
	 * first chat request then gets its chunked response cut off -> net::ERR_INCOMPLETE_CHUNKED_ENCODING, or a
	 * bare socket reset (ECONNRESET). These are transient and worth a silent re-wait + retry instead of an error.
	 */
	private _isTransientLocalStreamDrop(errMsg: string): boolean {
		return /ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_EMPTY_RESPONSE|ECONNRESET|socket hang up|premature close|terminated|network error/i.test(errMsg);
	}

	/**
	 * True when a request error indicates the server can't accept image input - almost always a local GGUF
	 * loaded without an mmproj projector (llama.cpp: "image input is not supported - hint: ... mmproj"). Kept
	 * narrow so ordinary 500s don't strip a genuinely vision-capable model.
	 */
	private _isVisionUnsupportedError(errMsg: string): boolean {
		const m = errMsg.toLowerCase();
		return /mmproj/.test(m)
			|| /image input is not supported/.test(m)
			|| (/image|vision|multimodal/.test(m) && /not\s*support|unsupported|does\s*not\s*support|cannot|no\s+vision/.test(m));
	}

	/**
	 * Pulls a human-readable message out of a local server's error body. OpenAI-compatible servers (llama.cpp,
	 * mlx_lm) return `{"error":{"message":"…"}}`; falls back to a trimmed snippet of plain-text bodies. Returns
	 * undefined when there's nothing useful, so callers keep the generic status message.
	 */
	private _extractServerErrorMessage(body: string): string | undefined {
		const trimmed = body?.trim();
		if (!trimmed) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(trimmed);
			const msg = parsed?.error?.message ?? parsed?.message ?? (typeof parsed?.error === 'string' ? parsed.error : undefined);
			if (typeof msg === 'string' && msg.trim()) {
				return msg.trim().slice(0, 300);
			}
		} catch {
			// Not JSON; fall through to the raw snippet.
		}
		return trimmed.slice(0, 300);
	}

	/** Whether any message carries an image attachment (so a vision-unsupported error is worth a text-only retry). */
	private _messagesHaveImages(messages: IChatMessage[]): boolean {
		return messages.some(msg => msg.content.some(part => part.type === 'image_url'));
	}

	/**
	 * Returns a copy of `messages` with every image part replaced by a short text placeholder. Used to retry a
	 * turn against a model that can't read images without dead-ending - the model still sees that an image was
	 * attached and can ask the user to describe it.
	 */
	private _stripImageParts(messages: IChatMessage[]): IChatMessage[] {
		return messages.map(msg => {
			if (!msg.content.some(part => part.type === 'image_url')) {
				return msg;
			}
			const content = msg.content.map(part => part.type === 'image_url'
				? { type: 'text' as const, value: '[An image was attached here, but the selected model cannot read images. Ask the user to describe it if needed.]' }
				: part);
			return { ...msg, content };
		});
	}

	/** Dispatch a request to the right per-provider implementation. Shared by the first attempt and the tools-disabled retry. */
	private async _dispatchProvider(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		if (model.provider === 'openai') {
			return await this._callOpenAI(model, messages, options, stream, token);
		} else if (model.provider === 'anthropic') {
			return await this._callAnthropic(model, messages, options, stream, token);
		} else if (model.provider === 'google') {
			return await this._callGoogle(model, messages, options, stream, token);
		} else if (model.provider === 'huggingface-cloud') {
			return await this._callOpenAI(model, messages, options, stream, token, {
				url: 'https://router.huggingface.co/v1/chat/completions',
				modelName: `${model.modelName}:${model.hfFastest ? 'fastest' : 'cheapest'}`,
				providerLabel: 'HuggingFace',
				disableTools: !model.useNativeTools
			});
		} else if (model.provider === 'huggingface') {
			return await this._callLocalModel(model, messages, options, stream, token);
		} else if (model.provider === 'ollama') {
			return await this._callOllamaModel(model, messages, options, stream, token);
		} else if (model.provider === 'localhost') {
			return await this._callLocalhostModel(model, messages, options, stream, token);
		} else {
			throw new Error(`Unsupported provider: ${model.provider}`);
		}
	}

	private async _doSendChatRequest(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		let rejected = false;
		// Tools are effectively requested when the caller passed some AND the model has native tools on.
		const toolsRequested = Array.isArray(options.tools) && options.tools.length > 0 && model.useNativeTools !== false;
		try {
			const result = await this._dispatchProvider(model, messages, options, stream, token);
			// A clean tool-using turn clears any accumulated failure streak.
			if (toolsRequested) {
				void this.customLanguageModelsService.resetToolFailureStreak(model.id);
			}
			return result;
		} catch (e) {
			const errMsg = e && typeof (e as Error).message === 'string' ? (e as Error).message : String(e);
			// Vision-unsupported handling: the request carried an image but the (local) server has no mmproj
			// projector, so it rejected the input. Mark the model text-only (gates attach next turn) and retry
			// this same request with the images replaced by a text placeholder, so the turn isn't dead-ended.
			if (!this._isCanceledError(errMsg) && this._isVisionUnsupportedError(errMsg) && this._messagesHaveImages(messages)) {
				try {
					const wasVision = await this.customLanguageModelsService.autoDisableVision(model.id);
					this._log(`[LoCoPilot Provider] Image input rejected by "${getCustomModelListLabel(model)}"; retrying as text-only. ${errMsg}`);
					if (wasVision) {
						this.notificationService.info(`Image skipped - "${getCustomModelListLabel(model)}" can't read images, so your attachment was sent as a text note. Switch to a vision-capable model to send images.`);
					}
					return await this._dispatchProvider({ ...model, supportsVision: false }, this._stripImageParts(messages), options, stream, token);
				} catch (retryErr) {
					rejected = true;
					const retryMsg = retryErr && typeof (retryErr as Error).message === 'string' ? (retryErr as Error).message : String(retryErr);
					const toThrowRetry = this._isCanceledError(retryMsg) ? new Error(this._getCanceledMessage()) : retryErr;
					this.logService.error(`LoCoPilot provider error (after vision-disabled retry): ${retryErr}`);
					this.locopilotFileLog.log(`LoCoPilot provider error (after vision-disabled retry): ${retryErr}`);
					stream.reject(toThrowRetry);
					throw toThrowRetry;
				}
			}
			// Tool-shaped failure handling: count it, auto-disable past the threshold, and retry this same
			// request once WITHOUT tools so the user is not blocked. Tool-rejection errors are raised before
			// any content streams (e.g. an HTTP 400 at request setup), so retrying into the same stream is safe.
			if (!this._isCanceledError(errMsg) && toolsRequested && this._isToolUnsupportedError(errMsg)) {
				try {
					const streak = await this.customLanguageModelsService.recordToolFailure(model.id);
					this._log(`[LoCoPilot Provider] Tool-call failure #${streak} for ${getCustomModelListLabel(model)}: ${errMsg}`);
					if (streak >= TOOL_FAILURE_DISABLE_THRESHOLD && !model.toolsAutoDisabled) {
						await this.customLanguageModelsService.autoDisableTools(model.id);
						this.notificationService.info(`Disabled native tool calling for "${getCustomModelListLabel(model)}" after repeated failures. You can re-enable it in the model's settings.`);
					}
					const retryOptions = { ...options, tools: undefined };
					return await this._dispatchProvider({ ...model, useNativeTools: false }, messages, retryOptions, stream, token);
				} catch (retryErr) {
					rejected = true;
					const retryMsg = retryErr && typeof (retryErr as Error).message === 'string' ? (retryErr as Error).message : String(retryErr);
					const toThrowRetry = this._isCanceledError(retryMsg) ? new Error(this._getCanceledMessage()) : retryErr;
					this.logService.error(`LoCoPilot provider error (after tools-disabled retry): ${retryErr}`);
					this.locopilotFileLog.log(`LoCoPilot provider error (after tools-disabled retry): ${retryErr}`);
					stream.reject(toThrowRetry);
					throw toThrowRetry;
				}
			}
			rejected = true;
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

	/** Current user-selected reasoning effort (Off/Low/Medium/High) from the chat input picker. */
	private _reasoningEffort(): ReasoningEffort {
		return getReasoningEffort(this.storageService);
	}

	/** Emit a reasoning/"thinking" delta to the stream. Reasoning is always shown when the model produces it. */
	private _emitThinking(stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, value: string): void {
		stream.emitOne({ type: 'thinking', value });
	}

	/**
	 * Regex matching the start of a textual tool call. Smaller / quantized local models frequently emit
	 * tool calls as plain `content` text (Hermes/Qwen XML `<tool_call>…</tool_call>`, `<function=name>` with
	 * `<parameter=…>` blocks, or a raw JSON `{"name":…,"arguments":…}` / `{"tool_calls":[…]}`) instead of the
	 * structured `delta.tool_calls` field. When that happens llama.cpp's `peg-native` parser fails to extract
	 * the call, it leaks into the visible message, and the agent loop dead-ends. We detect the marker mid-stream
	 * to stop printing the raw markup, then recover the call at stream end (see _recoverTextToolCalls).
	 */
	private static readonly _TEXT_TOOLCALL_MARKER = /<\s*tool_call|<\s*function\s*=|<\s*function_call|<\|\s*tool_call|```\s*tool_call|\{\s*"(?:tool_call|tool_calls)"/i;

	/** Returns the index of the first textual tool-call marker in `text`, or -1 if none. */
	private _textToolCallMarkerIndex(text: string): number {
		const m = LoCoPilotLanguageModelProvider._TEXT_TOOLCALL_MARKER.exec(text);
		return m ? m.index : -1;
	}

	/**
	 * Best-effort recovery of tool calls that a local model emitted as plain text instead of structured
	 * `tool_calls`. Handles the three common malformed shapes. `availableToolNames` (when provided) is used only
	 * to *prefer* real tool names - a parsed call whose name doesn't match is still returned, because the agent
	 * running it and getting back an "unknown tool" result keeps the loop alive (the model corrects next turn),
	 * which is far better than silently dropping the call and dead-ending the turn.
	 */
	private _recoverTextToolCalls(text: string, _availableToolNames?: Set<string>): Array<{ name: string; parameters: Record<string, unknown> }> {
		const out: Array<{ name: string; parameters: Record<string, unknown> }> = [];
		const pushParsed = (name: string | undefined, rawArgs: unknown) => {
			if (!name || typeof name !== 'string') { return; }
			const trimmedName = name.trim();
			if (!trimmedName) { return; }
			let parameters: Record<string, unknown> = {};
			if (rawArgs && typeof rawArgs === 'object') {
				parameters = rawArgs as Record<string, unknown>;
			} else if (typeof rawArgs === 'string' && rawArgs.trim()) {
				try { parameters = JSON.parse(rawArgs); } catch { parameters = {}; }
			}
			out.push({ name: trimmedName, parameters });
		};

		// 1) Hermes/Qwen XML: <tool_call> {json} </tool_call> OR <tool_call> <function=NAME> <parameter=KEY>VAL</parameter> … </function> </tool_call>
		const blockRe = /<\s*tool_call\s*>([\s\S]*?)<\s*\/\s*tool_call\s*>/gi;
		let blockMatch: RegExpExecArray | null;
		while ((blockMatch = blockRe.exec(text))) {
			const inner = blockMatch[1].trim();
			if (!this._recoverFromFunctionTag(inner, pushParsed)) {
				// Inner is (hopefully) JSON like {"name":"x","arguments":{…}}
				try {
					const obj = JSON.parse(inner);
					pushParsed(obj.name ?? obj.function?.name, obj.arguments ?? obj.parameters ?? obj.function?.arguments);
				} catch { /* fall through */ }
			}
		}
		if (out.length) { return out; }

		// 2) Bare <function=NAME> … <parameter=KEY>VAL</parameter> … </function> (no surrounding <tool_call>)
		this._recoverFromFunctionTag(text, pushParsed);
		if (out.length) { return out; }

		// 3) Raw JSON object: {"tool_calls":[{"function":{"name":…,"arguments":…}}]} or {"name":…,"arguments":…}
		const jsonStart = text.indexOf('{');
		if (jsonStart >= 0) {
			const candidate = text.slice(jsonStart, text.lastIndexOf('}') + 1);
			try {
				const obj = JSON.parse(candidate);
				const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : (obj.name ? [obj] : []);
				for (const c of calls) {
					pushParsed(c.name ?? c.function?.name, c.arguments ?? c.parameters ?? c.function?.arguments);
				}
			} catch { /* unrecoverable */ }
		}
		return out;
	}

	/** Parses `<function=NAME> <parameter=KEY>VALUE</parameter> … </function>` shapes out of `text`. Returns true if any matched. */
	private _recoverFromFunctionTag(text: string, push: (name: string | undefined, args: unknown) => void): boolean {
		const fnRe = /<\s*function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\s*\/\s*function\s*>/gi;
		let matched = false;
		let fnMatch: RegExpExecArray | null;
		while ((fnMatch = fnRe.exec(text))) {
			matched = true;
			const name = fnMatch[1];
			const body = fnMatch[2];
			const params: Record<string, unknown> = {};
			const paramRe = /<\s*parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
			let p: RegExpExecArray | null;
			while ((p = paramRe.exec(body))) {
				const key = p[1].trim();
				let val: unknown = p[2].trim();
				// Coerce JSON-ish values (numbers, booleans, objects/arrays) so the tool gets proper types.
				try { val = JSON.parse(p[2].trim()); } catch { /* keep string */ }
				params[key] = val;
			}
			push(name, params);
		}
		return matched;
	}

	/** Heuristic: does this OpenAI cloud model name belong to a reasoning-capable family? */
	private _openAiIsReasoningModel(name: string): boolean {
		return /(^|[^a-z])o[134](\b|-)|gpt-5|gpt-oss|reason|think|deepseek-r|qwen3/i.test(name);
	}

	/**
	 * Apply reasoning effort to an OpenAI-style request body via the `reasoning_effort` field.
	 * `local` servers (llama.cpp/mlx/ollama/localhost) tolerate the field and gate thinking on it, so we
	 * always pass the level there; for OpenAI cloud we only attach it to reasoning-capable models so a
	 * non-reasoning model (e.g. gpt-4o) isn't rejected by the default 'low'. `off` omits the field.
	 */
	private _applyOpenAiReasoningEffort(body: any, modelName: string, local: boolean, options?: { [name: string]: unknown }): void {
		// Per-request override (e.g. title generation forces 'off' so it doesn't waste a full chain-of-thought
		// on a 6-word title). Falls back to the user's global picker when no override is given.
		const override = options?.locopilotReasoningEffort as ReasoningEffort | undefined;
		const effort = override ?? this._reasoningEffort();
		// Per-request output cap (e.g. title generation: a few dozen tokens). Tightens max_tokens before the
		// thinking budget is derived from it, so both the budget and the answer stay short.
		const cap = options?.locopilotMaxOutputTokens;
		if (typeof cap === 'number' && cap > 0 && typeof body.max_tokens === 'number') {
			body.max_tokens = Math.min(body.max_tokens, Math.floor(cap));
		}
		if (local) {
			// llama.cpp's thinking budget is honored ONLY via the request field `thinking_budget_tokens`
			// (verified by probing bundled build b9789: a conflicting `thinking_budget_tokens` always wins,
			// while `reasoning_budget_tokens` and `reasoning_budget` are silently ignored). A positive value
			// forces the end-of-thinking tag once that many thinking tokens are produced; -1 is unlimited.
			// NOTE: a budget of 0 does NOT disable thinking here - only `enable_thinking:false` does (below).
			// Budget scales with the request's output window (max_tokens, derived from the context window).
			const window = (typeof body.max_tokens === 'number' && body.max_tokens > 0) ? body.max_tokens : 0;
			const requested = reasoningBudgetTokens(effort, window);
			// Clamp a positive budget so thinking can't eat the whole output window and starve the answer.
			// -1 (max) stays unclamped - llama.cpp caps it to the context itself.
			let budget = requested;
			if (requested > 0 && window > 0) {
				const answerReserve = 512;
				budget = Math.min(requested, Math.max(answerReserve, window - answerReserve));
			}
			// `thinking_budget_tokens` is the only field the bundled build honors; the other two are dead on
			// llama.cpp but accepted by some mlx/ollama forks, so we send all three (unknown fields are ignored).
			body.thinking_budget_tokens = budget;
			body.reasoning_budget_tokens = budget;
			body.reasoning_budget = budget;
			if (effort === 'off') {
				// Servers that gate thinking on a chat-template flag (qwen3 on llama.cpp/ollama) need this too.
				body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), enable_thinking: false };
			} else {
				// mlx_lm / Ollama gate on the level string; harmless to llama.cpp which ignores it.
				body.reasoning_effort = effort;
			}
			return;
		}
		// Cloud OpenAI: only attach to reasoning-capable models so a non-reasoning model isn't rejected,
		// and map our extra levels onto the {low,medium,high} the API accepts ('off' omits, 'max' -> high).
		if (this._openAiIsReasoningModel(modelName)) {
			if (effort === 'off') {
				return;
			}
			body.reasoning_effort = effort === 'max' ? 'high' : effort;
		}
	}

	/** Apply reasoning effort to an Anthropic request body (extended thinking via `budget_tokens`). */
	private _applyAnthropicReasoningEffort(body: any, modelName: string, maxOutputTokens: number): void {
		const effort = this._reasoningEffort();
		// 'off' -> no extended thinking; leave the body untouched (and keep temperature available).
		if (effort === 'off') {
			return;
		}
		// Only Claude 3.7 / 4.x families support extended thinking; skip older models so we don't 400 by default.
		if (!/3-7|3\.7|sonnet-4|opus-4|haiku-4|-4-|-4-\d/i.test(modelName)) {
			return;
		}
		// Anthropic requires budget_tokens >= 1024 and strictly less than max_tokens; temperature must be unset.
		// 'max' (-1) means "as much as the output cap allows", so clamp to maxOutputTokens - 1024.
		const ceiling = Math.max(1024, maxOutputTokens - 1024);
		const requested = reasoningBudgetTokens(effort, maxOutputTokens);
		const budget = requested === -1 ? ceiling : Math.max(1024, Math.min(requested, ceiling));
		body.thinking = { type: 'enabled', budget_tokens: budget };
		delete body.temperature;
	}

	/** Apply reasoning effort to a Gemini request body (`generationConfig.thinkingConfig.thinkingBudget`). */
	private _applyGoogleReasoningEffort(body: any, modelName: string): void {
		const effort = this._reasoningEffort();
		// Thinking budget is a 2.5+/3 feature; older Gemini models reject thinkingConfig.
		if (!/2\.5|2-5|gemini-3|gemini-2\.5/i.test(modelName)) {
			return;
		}
		body.generationConfig = body.generationConfig ?? {};
		// Gemini's thinkingBudget natively accepts our sentinels: 0 disables thinking, -1 is dynamic/unlimited.
		const window = (typeof body.generationConfig.maxOutputTokens === 'number' && body.generationConfig.maxOutputTokens > 0) ? body.generationConfig.maxOutputTokens : 0;
		body.generationConfig.thinkingConfig = { thinkingBudget: reasoningBudgetTokens(effort, window) };
	}

	private async _callOpenAI(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken, opts?: { url?: string; modelName?: string; providerLabel?: string; disableTools?: boolean }): Promise<any> {
		const url = opts?.url ?? 'https://api.openai.com/v1/chat/completions';
		const requestModelName = opts?.modelName ?? model.modelName;
		const providerLabel = opts?.providerLabel ?? 'OpenAI';
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

		const isLocalModel = model.provider === 'huggingface' || model.provider === 'localhost' || model.provider === 'ollama';
		const { maxOutputTokens } = deriveTokenLimits(model.contextWindow ?? defaultContextWindow(isLocalModel), isLocalModel);
		const body: any = {
			model: requestModelName,
			messages: mappedMessages,
			stream: true,
			temperature: 0.3,
			max_tokens: maxOutputTokens
		};
		this._applyOpenAiReasoningEffort(body, requestModelName, isLocalModel, options);

		// Add tools if provided (unless caller disabled them, e.g. HF model without function-calling support)
		if (!opts?.disableTools && options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
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
			// Surface the provider's actual error body (HF router returns useful JSON like
			// {"error":"..."} explaining bad model id, unsupported tools, missing provider, etc.)
			let detail = '';
			try {
				const buf = await streamToBuffer(response.stream);
				detail = buf.toString().trim();
			} catch { /* ignore */ }
			const base = this._getApiErrorMessage(providerLabel, response.res.statusCode ?? 0);
			throw new Error(detail ? `${base}\n\n${providerLabel} response: ${detail.slice(0, 500)}` : base);
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
								const openAiReasoning = this._reasoningTextFromOpenAiDelta(choice?.delta);
								if (openAiReasoning) {
									this._emitThinking(stream, openAiReasoning);
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
		const isLocalModel = model.provider === 'huggingface' || model.provider === 'localhost' || model.provider === 'ollama';
		const { maxOutputTokens } = deriveTokenLimits(model.contextWindow ?? defaultContextWindow(isLocalModel), isLocalModel);
		const body: any = {
			model: model.modelName,
			messages: messages.filter(m => m.role !== ChatMessageRole.System).map(m => this._mapMessageToAnthropic(m)),
			stream: true,
			max_tokens: maxOutputTokens
		};
		this._applyAnthropicReasoningEffort(body, model.modelName, maxOutputTokens);

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
										this._emitThinking(stream, delta.thinking);
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
		const isLocalModel = model.provider === 'huggingface' || model.provider === 'localhost' || model.provider === 'ollama';
		const { maxOutputTokens } = deriveTokenLimits(model.contextWindow ?? defaultContextWindow(isLocalModel), isLocalModel);
		const body: any = {
			contents,
			generationConfig: {
				temperature: 0.3,
				maxOutputTokens
			}
		};
		this._applyGoogleReasoningEffort(body, model.modelName);

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
											this._emitThinking(stream, part.thought);
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

	/**
	 * Streams an SSE POST and invokes onJson for each parsed `data:` line as chunks arrive.
	 *
	 * Uses the request service's streaming API (requestStream), which runs the HTTP request in the
	 * main process and pushes the response body to the renderer chunk-by-chunk over IPC. This gives
	 * true token-by-token streaming while avoiding the renderer CORS / mixed-content restrictions
	 * that block a direct `fetch` to a plaintext `http://localhost` server. Falls back to the
	 * buffered request() path if streaming is unavailable.
	 *
	 * Returns the HTTP status code; throws on network-level errors.
	 */
	private async _fetchSSEStream(
		url: string,
		headers: Record<string, string>,
		bodyJson: string,
		token: CancellationToken,
		onJson: (json: unknown) => void,
		/** When provided, raw response text is accumulated here so the caller can read an error body on a non-200 (SSE responses carry no useful body, but error responses do). */
		errorSink?: { body: string }
	): Promise<number> {
		let buffer = '';
		const consume = (text: string): void => {
			if (errorSink) { errorSink.body += text; }
			buffer += text;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const t = line.trim();
				if (!t.startsWith('data: ')) { continue; }
				const d = t.slice(6);
				if (d === '[DONE]') { continue; }
				try { onJson(JSON.parse(d)); } catch { /* skip malformed */ }
			}
		};

		const reqOptions = { type: 'POST', url, headers, data: bodyJson } as const;

		// Preferred: stream the body chunk-by-chunk via the main process.
		if (typeof this.requestService.requestStream === 'function') {
			const result = await this.requestService.requestStream(reqOptions, chunk => consume(chunk.toString()), token);
			return result.statusCode ?? 0;
		}

		// Fallback: buffered request (whole body delivered at once).
		const response = await this.requestService.request(reqOptions, token);
		await new Promise<void>((resolve, reject) => {
			listenStream(response.stream, {
				onData: chunk => consume(chunk.toString()),
				onError: err => reject(err),
				onEnd: () => resolve()
			}, token);
		});
		return response.res.statusCode ?? 0;
	}


	private async _callLocalModel(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		this._log(`[LoCoPilot Provider] Calling local model: ${model.modelName}`);
		if (!model.localPath) {
			this._log(`[LoCoPilot Provider] Model ${model.modelName} is not downloaded yet.`);
			throw new Error(`The model "${model.modelName}" is not downloaded yet. Add it in LoCoPilot Settings with provider HuggingFace and wait for the download to complete.`);
		}
		let baseUrl = this.localModelRunner.getServerBaseUrl(model.id);
		const autoStart = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLocalAutoStartServer) !== false;
		// A server can be "present but not ready": a pre-warm (or earlier request) launched it and the weights
		// are still loading. Sending now would hit the server mid-load and come back 503 "still loading", so we
		// must treat not-ready exactly like not-started - wait for readiness rather than fire the request.
		const isReady = this.localModelRunner.getServerPhase(model.id) === 'ready';
		if (!isReady && autoStart) {
			// Auto-start-on-use (Ollama-like): launch (or wait for) this model's server until it is ready, so the
			// user can just pick the model and send without a manual step. The wait happens under the chat's normal
			// "Working…" spinner (no separate loading indicator) - the request simply takes a bit longer while the
			// weights load into memory.
			this._log(`[LoCoPilot Provider] Ensuring local server is ready for ${model.modelName}.`);
			baseUrl = await this.localModelRunner.ensureServerForModel(model.id, token);
		} else if (isReady && autoStart) {
			// Already running and ready: route through ensure to refresh the keep-alive idle timer (cheap no-op).
			baseUrl = await this.localModelRunner.ensureServerForModel(model.id, token) ?? baseUrl;
		}
		if (!baseUrl) {
			throw new Error(this._getLocalServerUnavailableMessage(model));
		}
		const url = `${baseUrl}/chat/completions`;
		const mappedMessages = messages.flatMap(m => this._mapMessageToOpenAI(m));
		const isLocalModel = model.provider === 'huggingface' || model.provider === 'localhost' || model.provider === 'ollama';
		const { maxOutputTokens } = deriveTokenLimits(model.contextWindow ?? defaultContextWindow(isLocalModel), isLocalModel);
		// The request's `model` field must match what the local server actually loaded with (its `--model`
		// value), not the catalog/HF repo name. mlx_lm.server is per-request model-aware: a mismatched id
		// makes it try to (re)load a different model, which silently stalls the request forever. llama.cpp
		// ignores the field, so this is safe for both engines. Falls back to the catalog name when the
		// server doesn't expose a served id (e.g. localhost/ollama endpoints we don't manage).
		const servedModelId = this.localModelRunner.getServedModelId(model.id) ?? model.modelName;
		const body: any = {
			model: servedModelId,
			messages: mappedMessages,
			stream: true,
			temperature: 0.3,
			max_tokens: maxOutputTokens,
			// Ask the local server (llama.cpp / mlx_lm) for real token counts and a measured generation rate
			// so the timer bar can show exact "tokens" and "tokens/sec" instead of a word-count estimate.
			// `timings_per_token` makes llama.cpp attach its `timings` block (predicted_n, predicted_per_second)
			// to every SSE chunk; `stream_options.include_usage` guarantees a final OpenAI `usage` block.
			timings_per_token: true,
			stream_options: { include_usage: true }
		};
		this._applyOpenAiReasoningEffort(body, servedModelId, true /* local */, options);
		// Only the foreground panel turn drives the timer bar's token/rate display. Background/auxiliary calls
		// (title generation, context compaction, probes) must not touch the live stats or they leak phantom
		// tokens into the panel before the user's own generation starts.
		const reportStats = options.locopilotForegroundTurn === true;
		// Start a fresh server-stats call for this agent iteration (totals accumulate across the turn).
		if (reportStats) { this.liveStatsService.beginCall(); }

		// Add tools if provided.
		// Fallback logic: if the request is too large for the local context (4096), 
		// we try to send it without tools to reduce the prompt size.
		if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
			// Tool exclusion list for local models
			const excludedTools = [
				'setup_tools_createNewWorkspace',
				'inline_chat_exit',
				'searchExtensions_internal',
				'get_terminal_confirmation',
				'get_terminal_output',
				'await_terminal',
				'terminal_selection',
				'terminal_last_command',
				'create_and_run_task',
				'fetchWebPage_internal',
				// 'readFile',
				// 'listDirectory',
				// 'readLints',
				// 'grep',
				// 'findFiles',
				// 'webSearch',
				// 'modifyFile',
				// 'editFile_internal',
				'manage_todo_list',
				'get_confirmation',
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
			const accumulatedToolCalls: Map<number, { id?: string; name?: string; args: string }> = new Map();
			// Full assistant content seen so far. We buffer it so that if a local model emits a tool call as
			// plain text (instead of structured tool_calls), we can (a) stop printing the raw markup to the UI
			// the moment we spot a marker, and (b) recover the call at stream end. See _recoverTextToolCalls.
			let contentBuffer = '';
			let emittedContentLen = 0;       // how much of contentBuffer we've already streamed to the UI
			let suppressingToolText = false; // once a textual tool-call marker is seen, stop emitting content
			// Small local models often emit the tool call inside the THINKING/reasoning stream rather than
			// content (observed with Qwen3.5 GGUF: every tool-call token arrives as a reasoning delta). Buffer
			// and suppress the thinking channel the same way so we can recover the call from it at stream end.
			let thinkingBuffer = '';
			let emittedThinkLen = 0;
			let suppressingThinkText = false;

			const processChunk = (json: unknown): void => {
				// Real generation stats from the local server. llama.cpp puts a `timings` block on each chunk
				// (with `timings_per_token`); both engines emit an OpenAI `usage` block on the final chunk
				// (with `stream_options.include_usage`). Prefer these exact numbers over the word estimate.
				this._ingestServerStats(json, reportStats);
				const choice = (json as IOpenAiStreamChunk).choices?.[0];
				const localReasoning = this._reasoningTextFromOpenAiDelta(choice?.delta);
				if (localReasoning) {
					this._log(`[LoCoPilot Provider] Reasoning delta: ${localReasoning.substring(0, 200)}${localReasoning.length > 200 ? '...' : ''}`);
					thinkingBuffer += localReasoning;
					if (!suppressingThinkText) {
						const tIdx = this._textToolCallMarkerIndex(thinkingBuffer);
						if (tIdx >= 0) {
							if (tIdx > emittedThinkLen) {
								this._emitThinking(stream, thinkingBuffer.slice(emittedThinkLen, tIdx));
							}
							emittedThinkLen = thinkingBuffer.length;
							suppressingThinkText = true;
						} else {
							this._emitThinking(stream, localReasoning);
							emittedThinkLen = thinkingBuffer.length;
						}
					}
				}
				if (choice?.delta?.content) {
					contentBuffer += choice.delta.content;
					if (!suppressingToolText) {
						const markerIdx = this._textToolCallMarkerIndex(contentBuffer);
						if (markerIdx >= 0) {
							// Emit only the clean text before the marker, then suppress the rest of this turn.
							if (markerIdx > emittedContentLen) {
								stream.emitOne({ type: 'text', value: contentBuffer.slice(emittedContentLen, markerIdx) });
							}
							emittedContentLen = contentBuffer.length;
							suppressingToolText = true;
						} else {
							stream.emitOne({ type: 'text', value: choice.delta.content });
							emittedContentLen = contentBuffer.length;
						}
					}
				}
				if (choice?.delta?.tool_calls) {
					for (const tc of choice.delta.tool_calls) {
						const idx = tc.index ?? 0;
						let acc = accumulatedToolCalls.get(idx);
						if (!acc) { acc = { args: '' }; accumulatedToolCalls.set(idx, acc); }
						if (tc.id) { acc.id = tc.id; }
						if (tc.function?.name) { acc.name = tc.function.name; }
						if (tc.function?.arguments !== undefined) { acc.args += tc.function.arguments; }
					}
				}
			};

			const errorSink = { body: '' };
			let status = 0;
			// A just-started local server can bind its HTTP port (passing the GET /models readiness probe) a
			// moment before it can actually stream a generation, so the very first request gets cut off mid-stream
			// (ERR_INCOMPLETE_CHUNKED_ENCODING / connection reset). While nothing has been emitted to the UI yet,
			// treat that as "still warming up": wait for the server to settle and retry under the same "Working…"
			// spinner instead of surfacing a scary network error. Only retry when the stream is still empty, so we
			// never duplicate already-shown text/tool calls.
			const maxStreamWarmupRetries = 4;
			for (let streamAttempt = 0; ; streamAttempt++) {
				try {
					status = await this._fetchSSEStream(url, headers, JSON.stringify(body), token, processChunk, errorSink);
					break;
				} catch (streamErr: unknown) {
					const dropMsg = streamErr && typeof (streamErr as Error).message === 'string' ? (streamErr as Error).message : String(streamErr);
					const nothingEmittedYet = emittedContentLen === 0 && emittedThinkLen === 0 && accumulatedToolCalls.size === 0;
					const canRetry = this._isTransientLocalStreamDrop(dropMsg)
						&& nothingEmittedYet
						&& streamAttempt < maxStreamWarmupRetries
						&& !token.isCancellationRequested
						&& !this._isCanceledError(dropMsg);
					if (!canRetry) {
						throw streamErr;
					}
					this._log(`[LoCoPilot Provider] Local server dropped the stream while warming up (attempt ${streamAttempt + 1}/${maxStreamWarmupRetries}); re-waiting for readiness and retrying: ${dropMsg}`);
					errorSink.body = '';
					// Re-confirm readiness (re-waits if the server is mid-(re)load) and give it a short, growing
					// backoff to finish spinning up its generation backend before the next attempt.
					await this.localModelRunner.ensureServerForModel(model.id, token);
					await timeout(Math.min(500 * (streamAttempt + 1), 2000));
				}
			}

			// Fallback: If 400 error and tools were provided, retry without tools
			if (status === 400 && body.tools) {
				this._log(`[LoCoPilot Provider] Local model request failed with 400, retrying without tools as fallback...`);
				accumulatedToolCalls.clear();
				errorSink.body = '';
				const fallbackBody = { ...body };
				delete fallbackBody.tools;
				status = await this._fetchSSEStream(url, headers, JSON.stringify(fallbackBody), token, processChunk, errorSink);
			}

			if (status !== 200) {
				// Surface a known server message (e.g. llama.cpp's "image input is not supported / mmproj") so the
				// upstream handler can recognize it and retry text-only; the raw body is never shown to the user.
				const serverDetail = this._extractServerErrorMessage(errorSink.body);
				const msg = status === 404 || status === 502 || status === 503
					? this._getLocalServerUnavailableMessage(model)
					: serverDetail
						? `Local model "${model.modelName}" request failed (${status}): ${serverDetail}`
						: `Local model "${model.modelName}" request failed (${status}).`;
				throw new Error(msg);
			}

			// Emit accumulated tool calls
			for (const idx of Array.from(accumulatedToolCalls.keys()).sort((a, b) => a - b)) {
				const acc = accumulatedToolCalls.get(idx)!;
				if (acc.id && acc.name) {
					try {
						stream.emitOne({ type: 'tool_use', name: acc.name, toolCallId: acc.id, parameters: acc.args ? JSON.parse(acc.args) : {} });
					} catch {
						stream.emitOne({ type: 'tool_use', name: acc.name, toolCallId: acc.id, parameters: {} });
					}
				}
			}

			// Fallback for local models that emit tool calls as plain text instead of structured tool_calls -
			// either in the content stream OR the thinking/reasoning stream. We suppressed the raw markup from
			// the UI during streaming; now try to recover the call (from whichever buffer carried it) so the
			// agent runs it on this turn instead of dead-ending with "no tool calls".
			if (accumulatedToolCalls.size === 0 && (suppressingToolText || suppressingThinkText)) {
				const availableToolNames = new Set<string>(
					(Array.isArray(body.tools) ? body.tools : [])
						.map((t: any) => t?.function?.name || t?.name)
						.filter((n: unknown): n is string => typeof n === 'string')
				);
				const recoverySource = `${contentBuffer}\n${thinkingBuffer}`;
				const recovered = this._recoverTextToolCalls(recoverySource, availableToolNames);
				if (recovered.length > 0) {
					this._log(`[LoCoPilot Provider] Recovered ${recovered.length} text-formatted tool call(s) the model emitted as content/thinking.`);
					for (const call of recovered) {
						stream.emitOne({ type: 'tool_use', name: call.name, toolCallId: `recovered_${generateUuid()}`, parameters: call.parameters });
					}
				} else {
					// Unrecoverable malformed call: don't print the broken markup. Emit a short corrective hint
					// instead so the turn isn't empty and the model fixes its format on the next try.
					this._log(`[LoCoPilot Provider] Suppressed an unparseable text tool call; nudging model to retry.`);
					stream.emitOne({ type: 'text', value: 'It looks like the tool call was not formatted correctly, so it could not be run. Please retry the tool call using the proper structured tool-calling format.' });
				}
			}
		} catch (e: unknown) {
			const errMsg = e && typeof (e as Error).message === 'string' ? (e as Error).message : String(e);
			if (this._isCanceledError(errMsg)) {
				throw new Error(this._getCanceledMessage());
			}
			const isConnectionRefused = /ECONNREFUSED|ERR_CONNECTION_REFUSED|net::ERR_CONNECTION_REFUSED|fetch failed|Failed to fetch/i.test(errMsg);
			const msg = isConnectionRefused
				? this._getLocalServerUnavailableMessage(model)
				: `Local model "${model.modelName}" error: ${errMsg}`;
			throw new Error(msg);
		}
	}

	/**
	 * Calls an Ollama model via OpenAI-compatible `/v1/chat/completions` only (SSE).
	 * Using one path for all requests (with or without tools) matches Ollama's OpenAI wire format for messages and tool calls and avoids native `/api/chat` mismatches.
	 * Reasoning streams as `delta.reasoning_content`, `delta.reasoning`, or `delta.thinking` depending on the server.
	 */
	private async _callOllamaModel(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		// Switching to Ollama: free any running llama.cpp/MLX server so the two local engines don't compete
		// for RAM/CPU. Ollama then manages its own model memory via its daemon (keepAlive setting). This is a
		// cross-engine handoff, so it applies regardless of the (llama/mlx-only) resident-model budget.
		this.localModelRunner.stopManagedServers();
		const baseUrl = (model.localPath || 'http://localhost:11434').replace(/\/$/, '');
		const mappedMessages = messages.flatMap(m => this._mapMessageToOpenAI(m));
		const isLocalModel = model.provider === 'huggingface' || model.provider === 'localhost' || model.provider === 'ollama';
		const { maxOutputTokens } = deriveTokenLimits(model.contextWindow ?? defaultContextWindow(isLocalModel), isLocalModel);

		const excludedTools = [
			'setup_tools_createNewWorkspace',
			'inline_chat_exit',
			'searchExtensions_internal',
			'get_terminal_confirmation',
			'get_terminal_output',
			'await_terminal',
			'terminal_selection',
			'terminal_last_command',
			'create_and_run_task',
			'fetchWebPage_internal',
			'manage_todo_list',
			'get_confirmation',
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

		this._log(`[LoCoPilot Provider] Calling Ollama OpenAI-compatible API: ${model.modelName} at ${baseUrl}/v1/chat/completions`);
		return this._callOllamaOpenAICompat(model, baseUrl, mappedMessages, options, stream, token, maxOutputTokens, filteredTools);
	}

	/**
	 * Ollama `/v1/chat/completions` - OpenAI-compatible SSE (`delta.content`, `delta.reasoning_content`, `delta.tool_calls`).
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
			max_tokens: maxOutputTokens,
		};
		// Ollama: enable thinking on compatible models (qwen3, etc.) per the user's effort setting; 'off' omits it.
		this._applyOpenAiReasoningEffort(body, model.modelName, true /* local */, options);

		if (filteredTools && filteredTools.length > 0 && model.useNativeTools) {
			body.tools = filteredTools;
			this._log(`[LoCoPilot Provider] Ollama OpenAI-compat request: ${filteredTools.length} native tools`);
		}

		const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
		try {
			const accumulatedToolCalls: Map<number, { id?: string; name?: string; args: string }> = new Map();
			let hasEmittedAnything = false;
			// Buffer content so a text-formatted tool call can be suppressed from the UI and recovered at end.
			let contentBuffer = '';
			let emittedContentLen = 0;
			let suppressingToolText = false;
			// See the local-model branch: some models emit the tool call in the thinking stream, so buffer and
			// suppress reasoning too and recover from it at stream end.
			let thinkingBuffer = '';
			let emittedThinkLen = 0;
			let suppressingThinkText = false;

			const status = await this._fetchSSEStream(url, headers, JSON.stringify(body), token, json => {
				const choice = (json as IOpenAiStreamChunk).choices?.[0];
				const delta = choice?.delta;
				if (delta?.content) {
					contentBuffer += delta.content;
					if (!suppressingToolText) {
						const markerIdx = this._textToolCallMarkerIndex(contentBuffer);
						if (markerIdx >= 0) {
							if (markerIdx > emittedContentLen) {
								stream.emitOne({ type: 'text', value: contentBuffer.slice(emittedContentLen, markerIdx) });
								hasEmittedAnything = true;
							}
							emittedContentLen = contentBuffer.length;
							suppressingToolText = true;
						} else {
							stream.emitOne({ type: 'text', value: delta.content });
							emittedContentLen = contentBuffer.length;
							hasEmittedAnything = true;
						}
					}
				}
				const reasoningDelta = this._reasoningTextFromOpenAiDelta(delta);
				if (reasoningDelta) {
					thinkingBuffer += reasoningDelta;
					if (!suppressingThinkText) {
						const tIdx = this._textToolCallMarkerIndex(thinkingBuffer);
						if (tIdx >= 0) {
							if (tIdx > emittedThinkLen) {
								this._emitThinking(stream, thinkingBuffer.slice(emittedThinkLen, tIdx));
							}
							emittedThinkLen = thinkingBuffer.length;
							suppressingThinkText = true;
						} else {
							this._emitThinking(stream, reasoningDelta);
							emittedThinkLen = thinkingBuffer.length;
						}
					}
				}
				if (delta?.tool_calls) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						let acc = accumulatedToolCalls.get(idx);
						if (!acc) { acc = { args: '' }; accumulatedToolCalls.set(idx, acc); }
						if (tc.id) { acc.id = tc.id; }
						if (tc.function?.name) { acc.name = tc.function.name; }
						if (tc.function?.arguments !== undefined) {
							const a = tc.function.arguments;
							acc.args += typeof a === 'string' ? a : JSON.stringify(a);
						}
					}
				}
			});

			if (status !== 200) {
				throw new Error(this._getApiErrorMessage('Ollama', status));
			}

			if (!hasEmittedAnything && accumulatedToolCalls.size === 0 && !options.tools) {
				stream.emitOne({ type: 'text', value: 'The model did not return a response. Please try again or try with another model.' });
			} else if (!hasEmittedAnything && accumulatedToolCalls.size === 0 && options.tools) {
				this._log(`[LoCoPilot Provider] Ollama model returned empty response for tool-calling request. This might trigger a nudge.`);
			}

			for (const idx of Array.from(accumulatedToolCalls.keys()).sort((a, b) => a - b)) {
				const acc = accumulatedToolCalls.get(idx)!;
				if (acc.id && acc.name) {
					try {
						stream.emitOne({ type: 'tool_use', name: acc.name, toolCallId: acc.id, parameters: acc.args ? JSON.parse(acc.args) : {} });
					} catch (_e) {
						stream.emitOne({ type: 'tool_use', name: acc.name, toolCallId: acc.id, parameters: {} });
					}
				}
			}

			// Fallback for local models that emit tool calls as plain text instead of structured tool_calls -
			// either in the content stream OR the thinking/reasoning stream. We suppressed the raw markup from
			// the UI during streaming; now try to recover the call (from whichever buffer carried it) so the
			// agent runs it on this turn instead of dead-ending with "no tool calls".
			if (accumulatedToolCalls.size === 0 && (suppressingToolText || suppressingThinkText)) {
				const availableToolNames = new Set<string>(
					(Array.isArray(body.tools) ? body.tools : [])
						.map((t: any) => t?.function?.name || t?.name)
						.filter((n: unknown): n is string => typeof n === 'string')
				);
				const recoverySource = `${contentBuffer}\n${thinkingBuffer}`;
				const recovered = this._recoverTextToolCalls(recoverySource, availableToolNames);
				if (recovered.length > 0) {
					this._log(`[LoCoPilot Provider] Recovered ${recovered.length} text-formatted tool call(s) the model emitted as content/thinking.`);
					for (const call of recovered) {
						stream.emitOne({ type: 'tool_use', name: call.name, toolCallId: `recovered_${generateUuid()}`, parameters: call.parameters });
					}
				} else {
					// Unrecoverable malformed call: don't print the broken markup. Emit a short corrective hint
					// instead so the turn isn't empty and the model fixes its format on the next try.
					this._log(`[LoCoPilot Provider] Suppressed an unparseable text tool call; nudging model to retry.`);
					stream.emitOne({ type: 'text', value: 'It looks like the tool call was not formatted correctly, so it could not be run. Please retry the tool call using the proper structured tool-calling format.' });
				}
			}
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
	 * Calls a user-configured localhost URL. `model.modelName` is the full endpoint URL; `model.localhostOpenAiModel`
	 * (or `model.name` for legacy) is the OpenAI `model` field in the JSON body.
	 */
	private async _callLocalhostModel(model: ICustomLanguageModel, messages: IChatMessage[], options: { [name: string]: unknown }, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>, token: CancellationToken): Promise<any> {
		const url = model.modelName?.trim();
		if (!url) {
			throw new Error('Localhost URL is not set. Edit this model in LoCoPilot Settings and enter the complete endpoint URL.');
		}
		this._log(`[LoCoPilot Provider] Calling localhost model at: ${url}`);
		const mappedMessages = messages.flatMap(m => this._mapMessageToOpenAI(m));
		const isLocalModel = model.provider === 'huggingface' || model.provider === 'localhost' || model.provider === 'ollama';
		const { maxOutputTokens } = deriveTokenLimits(model.contextWindow ?? defaultContextWindow(isLocalModel), isLocalModel);
		let openAiModel = (model.localhostOpenAiModel ?? '').trim();
		if (!openAiModel) {
			const n = (model.name ?? '').trim();
			// Legacy entries used the URL as `name`; don't send that as the `model` field.
			openAiModel = n && !/^https?:\/\//i.test(n) ? n : 'local';
		}
		const body: any = {
			model: openAiModel,
			messages: mappedMessages,
			stream: true,
			temperature: 0.3,
			max_tokens: maxOutputTokens,
			// Real token counts + measured rate (ignored by servers that don't support them). See _callLocalModel.
			timings_per_token: true,
			stream_options: { include_usage: true }
		};
		this._applyOpenAiReasoningEffort(body, openAiModel, true /* local */, options);
		// Only the foreground panel turn drives the timer bar (see _callLocalModel).
		const reportStats = options.locopilotForegroundTurn === true;
		if (reportStats) { this.liveStatsService.beginCall(); }

		// Add tools if provided
		if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
			// Tool exclusion list for localhost models
			const excludedTools = [
				'setup_tools_createNewWorkspace',
				'inline_chat_exit',
				'searchExtensions_internal',
				'get_terminal_confirmation',
				'get_terminal_output',
				'await_terminal',
				'terminal_selection',
				'terminal_last_command',
				'create_and_run_task',
				'fetchWebPage_internal',
				// 'readFile',
				// 'listDirectory',
				// 'readLints',
				// 'grep',
				// 'findFiles',
				// 'webSearch',
				// 'modifyFile',
				// 'editFile_internal',
				'manage_todo_list',
				'get_confirmation',
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
			const accumulatedToolCalls: Map<number, { id?: string; name?: string; args: string }> = new Map();
			// Full assistant content seen so far. We buffer it so that if a local model emits a tool call as
			// plain text (instead of structured tool_calls), we can (a) stop printing the raw markup to the UI
			// the moment we spot a marker, and (b) recover the call at stream end. See _recoverTextToolCalls.
			let contentBuffer = '';
			let emittedContentLen = 0;       // how much of contentBuffer we've already streamed to the UI
			let suppressingToolText = false; // once a textual tool-call marker is seen, stop emitting content
			// Small local models often emit the tool call inside the THINKING/reasoning stream rather than
			// content (observed with Qwen3.5 GGUF: every tool-call token arrives as a reasoning delta). Buffer
			// and suppress the thinking channel the same way so we can recover the call from it at stream end.
			let thinkingBuffer = '';
			let emittedThinkLen = 0;
			let suppressingThinkText = false;

			const processChunk = (json: unknown): void => {
				// Real generation stats from the local server. llama.cpp puts a `timings` block on each chunk
				// (with `timings_per_token`); both engines emit an OpenAI `usage` block on the final chunk
				// (with `stream_options.include_usage`). Prefer these exact numbers over the word estimate.
				this._ingestServerStats(json, reportStats);
				const choice = (json as IOpenAiStreamChunk).choices?.[0];
				const localReasoning = this._reasoningTextFromOpenAiDelta(choice?.delta);
				if (localReasoning) {
					this._log(`[LoCoPilot Provider] Reasoning delta: ${localReasoning.substring(0, 200)}${localReasoning.length > 200 ? '...' : ''}`);
					thinkingBuffer += localReasoning;
					if (!suppressingThinkText) {
						const tIdx = this._textToolCallMarkerIndex(thinkingBuffer);
						if (tIdx >= 0) {
							if (tIdx > emittedThinkLen) {
								this._emitThinking(stream, thinkingBuffer.slice(emittedThinkLen, tIdx));
							}
							emittedThinkLen = thinkingBuffer.length;
							suppressingThinkText = true;
						} else {
							this._emitThinking(stream, localReasoning);
							emittedThinkLen = thinkingBuffer.length;
						}
					}
				}
				if (choice?.delta?.content) {
					contentBuffer += choice.delta.content;
					if (!suppressingToolText) {
						const markerIdx = this._textToolCallMarkerIndex(contentBuffer);
						if (markerIdx >= 0) {
							// Emit only the clean text before the marker, then suppress the rest of this turn.
							if (markerIdx > emittedContentLen) {
								stream.emitOne({ type: 'text', value: contentBuffer.slice(emittedContentLen, markerIdx) });
							}
							emittedContentLen = contentBuffer.length;
							suppressingToolText = true;
						} else {
							stream.emitOne({ type: 'text', value: choice.delta.content });
							emittedContentLen = contentBuffer.length;
						}
					}
				}
				if (choice?.delta?.tool_calls) {
					for (const tc of choice.delta.tool_calls) {
						const idx = tc.index ?? 0;
						let acc = accumulatedToolCalls.get(idx);
						if (!acc) { acc = { args: '' }; accumulatedToolCalls.set(idx, acc); }
						if (tc.id) { acc.id = tc.id; }
						if (tc.function?.name) { acc.name = tc.function.name; }
						if (tc.function?.arguments !== undefined) { acc.args += tc.function.arguments; }
					}
				}
			};

			const errorSink = { body: '' };
			let status = await this._fetchSSEStream(url, headers, JSON.stringify(body), token, processChunk, errorSink);

			// Fallback: If 400 error and tools were provided, retry without tools
			if (status === 400 && body.tools) {
				this._log(`[LoCoPilot Provider] Localhost model request failed with 400, retrying without tools as fallback...`);
				accumulatedToolCalls.clear();
				errorSink.body = '';
				const fallbackBody = { ...body };
				delete fallbackBody.tools;
				status = await this._fetchSSEStream(url, headers, JSON.stringify(fallbackBody), token, processChunk, errorSink);
			}

			if (status !== 200) {
				// Surface a known server detail (e.g. "image input is not supported / mmproj") so the upstream
				// handler can recognize a vision-unsupported error and retry text-only; raw body is not shown.
				const serverDetail = this._extractServerErrorMessage(errorSink.body);
				const msg = status === 404 || status === 502 || status === 503
					? `Localhost server not responding at ${url}. Check that the server is running and the URL is correct.`
					: serverDetail
						? `Localhost model "${model.name}" request failed (${status}): ${serverDetail}`
						: `Localhost model "${model.name}" request failed (${status}).`;
				throw new Error(msg);
			}

			// Emit accumulated tool calls
			for (const idx of Array.from(accumulatedToolCalls.keys()).sort((a, b) => a - b)) {
				const acc = accumulatedToolCalls.get(idx)!;
				if (acc.id && acc.name) {
					try {
						stream.emitOne({ type: 'tool_use', name: acc.name, toolCallId: acc.id, parameters: acc.args ? JSON.parse(acc.args) : {} });
					} catch {
						stream.emitOne({ type: 'tool_use', name: acc.name, toolCallId: acc.id, parameters: {} });
					}
				}
			}

			// Fallback for local models that emit tool calls as plain text instead of structured tool_calls -
			// either in the content stream OR the thinking/reasoning stream. We suppressed the raw markup from
			// the UI during streaming; now try to recover the call (from whichever buffer carried it) so the
			// agent runs it on this turn instead of dead-ending with "no tool calls".
			if (accumulatedToolCalls.size === 0 && (suppressingToolText || suppressingThinkText)) {
				const availableToolNames = new Set<string>(
					(Array.isArray(body.tools) ? body.tools : [])
						.map((t: any) => t?.function?.name || t?.name)
						.filter((n: unknown): n is string => typeof n === 'string')
				);
				const recoverySource = `${contentBuffer}\n${thinkingBuffer}`;
				const recovered = this._recoverTextToolCalls(recoverySource, availableToolNames);
				if (recovered.length > 0) {
					this._log(`[LoCoPilot Provider] Recovered ${recovered.length} text-formatted tool call(s) the model emitted as content/thinking.`);
					for (const call of recovered) {
						stream.emitOne({ type: 'tool_use', name: call.name, toolCallId: `recovered_${generateUuid()}`, parameters: call.parameters });
					}
				} else {
					// Unrecoverable malformed call: don't print the broken markup. Emit a short corrective hint
					// instead so the turn isn't empty and the model fixes its format on the next try.
					this._log(`[LoCoPilot Provider] Suppressed an unparseable text tool call; nudging model to retry.`);
					stream.emitOne({ type: 'text', value: 'It looks like the tool call was not formatted correctly, so it could not be run. Please retry the tool call using the proper structured tool-calling format.' });
				}
			}
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
