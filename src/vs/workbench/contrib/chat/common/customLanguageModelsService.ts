/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { localize } from '../../../../nls.js';

export const ICustomLanguageModelsService = createDecorator<ICustomLanguageModelsService>('customLanguageModelsService');

/**
 * User-facing label for the model list and the Auto / model picker.
 * When `displayName` is set it wins (must be unique). Otherwise Ollama uses `modelName` so URLs are not shown
 * for older entries that stored the base URL in `name`.
 */
export function getCustomModelListLabel(model: ICustomLanguageModel): string {
	const d = model.displayName?.trim();
	if (d) {
		return d;
	}
	if (model.provider === 'ollama') {
		return model.modelName;
	}
	return model.name;
}

/** True when the model can be chosen in chat / agent (picker); excludes downloads in progress and incomplete HF/Ollama installs. */
export function isCustomModelReadyForChat(model: ICustomLanguageModel): boolean {
	if (model.hidden || model.isDownloading) {
		return false;
	}
	if (model.provider === 'huggingface') {
		const p = model.localPath?.trim() ?? '';
		return p.length > 0 && !/^https?:\/\//i.test(p);
	}
	if (model.provider === 'ollama') {
		return model.ollamaPullComplete !== false;
	}
	return true;
}

export function needsDownloadOrPullRetry(model: ICustomLanguageModel): boolean {
	if (model.isDownloading) {
		return false;
	}
	if (model.provider === 'huggingface') {
		const p = model.localPath?.trim() ?? '';
		const hasArtifacts = p.length > 0 && !/^https?:\/\//i.test(p);
		return !hasArtifacts;
	}
	if (model.provider === 'ollama') {
		return model.ollamaPullComplete === false;
	}
	return false;
}

/** Default context window for newly added cloud models (modern safe floor: GPT-4o, Llama 3.1, Mistral). */
export const DEFAULT_CONTEXT_WINDOW_CLOUD = 128000;
/** Default context window for newly added local models. Newer local models (Llama 3.x, Qwen) handle this;
 *  the user must still ensure their llama.cpp/Ollama server is launched with a matching context. */
export const DEFAULT_CONTEXT_WINDOW_LOCAL = 32000;
/** Upper bound for a model's output reservation: the real reply cap most chat models honor. */
const OUTPUT_CAP_CLOUD = 16000;
const OUTPUT_CAP_LOCAL = 4000;
/** Floor so even tiny windows still leave a usable reply length. */
const OUTPUT_FLOOR = 256;

/** Allowed range for the user-entered context window. */
export const MIN_CONTEXT_WINDOW = 1024;
export const MAX_CONTEXT_WINDOW = 2000000;

/**
 * Number of consecutive tool-shaped request failures before native tool calling is auto-disabled
 * for a model. Set above 1 so a single transient error (one bad turn, a 500, a truncated reply)
 * does not permanently demote a tool-capable model; see {@link ICustomLanguageModel.toolFailureStreak}.
 */
export const TOOL_FAILURE_DISABLE_THRESHOLD = 2;

/** Fields that can be auto-derived from HuggingFace/Ollama metadata and that the user may override. */
export type DerivableModelField = 'contextWindow' | 'format' | 'useNativeTools' | 'mtp';
const DERIVABLE_FIELDS: readonly DerivableModelField[] = ['contextWindow', 'format', 'useNativeTools', 'mtp'];

export function defaultContextWindow(isLocal: boolean): number {
	return isLocal ? DEFAULT_CONTEXT_WINDOW_LOCAL : DEFAULT_CONTEXT_WINDOW_CLOUD;
}

/**
 * Derive the token budgets from a single context window.
 * - maxOutputTokens: reply cap = min(provider cap, 25% of the window), never below {@link OUTPUT_FLOOR}.
 *   Output is an (almost) constant absolute cap in practice, not a fixed % of the window, hence the min().
 * - maxInputTokens: reported as the FULL window; the context manager reserves output from it itself
 *   (see contextManager.computeUsableBudget), so do NOT pre-subtract output here or it double-counts.
 */
export function deriveTokenLimits(contextWindow: number, isLocal: boolean): { maxInputTokens: number; maxOutputTokens: number } {
	const cap = isLocal ? OUTPUT_CAP_LOCAL : OUTPUT_CAP_CLOUD;
	const maxOutputTokens = Math.max(OUTPUT_FLOOR, Math.min(cap, Math.floor(contextWindow * 0.25)));
	return { maxInputTokens: contextWindow, maxOutputTokens };
}

export interface ICustomLanguageModel {
	id: string;
	name: string;
	/** Optional unique label; when set, shown in the model picker and lists instead of `name` / `modelName`. */
	displayName?: string;
	type: 'cloud' | 'local';
	provider: string;
	apiKey?: string; // Stored in secret storage
	token?: string; // For local providers like HuggingFace, stored in secret storage
	/** Hugging Face model format (e.g., 'gguf', 'transformers') */
	format?: string;
	/** Whether the model is currently being downloaded */
	isDownloading?: boolean;
	/** Download progress (0-100) */
	downloadProgress?: number;
	/** Local path where the model is stored */
	localPath?: string;
	modelName: string;
	/** For provider `localhost`: value for JSON `model` (OpenAI id as in GET /v1/models). */
	localhostOpenAiModel?: string;
	/**
	 * For provider `huggingface-cloud` (HF Inference Providers router): routing policy suffix.
	 * false/undefined => `:cheapest` (lowest price); true => `:fastest`.
	 */
	hfFastest?: boolean;
	/** Total context window in tokens (user-set). Input/output budgets are derived from this; see {@link deriveTokenLimits}. */
	contextWindow?: number;
	/** @deprecated Legacy field, migrated into {@link contextWindow}. Kept only so old stored entries still parse. */
	maxInputTokens?: number;
	/** @deprecated Legacy field; output is now derived from {@link contextWindow}. */
	maxOutputTokens?: number;
	/** Whether to use native tool calling (true) or system prompt injection (false) for local models */
	useNativeTools?: boolean;
	/**
	 * For local GGUF models run via llama.cpp: enable Multi-Token Prediction speculative decoding
	 * (`--spec-type mtp`). Only valid for models trained with MTP heads; default off.
	 */
	mtp?: boolean;
	createdAt: number;
	hidden?: boolean; // Whether the model is hidden/disabled
	/**
	 * For `ollama`: false until the first successful pull finishes; set to false when a pull is cancelled.
	 * Omitted or undefined means true (legacy entries treated as already pulled).
	 */
	ollamaPullComplete?: boolean;
	/**
	 * Per-field markers set to true when the user explicitly edits a derivable field. Auto-enrichment
	 * ({@link ICustomLanguageModelsService.applyDerivedMetadata}) never overwrites a field marked here,
	 * so a manual edit always wins over HuggingFace/Ollama metadata. See {@link DerivableModelField}.
	 */
	userOverrides?: Partial<Record<DerivableModelField, boolean>>;
	/** True once HF/Ollama metadata enrichment has run for this model (so derived values are no longer the bare defaults). */
	metadataEnriched?: boolean;
	/**
	 * True when the runtime auto-disabled native tool calling after repeated tool-shaped failures
	 * (distinct from the user turning tools off). Surfaced in the UI and cleared if the user re-enables tools.
	 */
	toolsAutoDisabled?: boolean;
	/** Consecutive tool-shaped request failures; reset on a successful tool-using request. Persisted so the next session skips a doomed first attempt. */
	toolFailureStreak?: number;
}

export interface ICustomLanguageModelsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCustomModels: Event<void>;
	getCustomModels(): ICustomLanguageModel[];
	getVisibleCustomModels(): ICustomLanguageModel[];
	/** Custom models that can be used in chat (excludes hidden, in-progress downloads, incomplete HF disk install, cancelled Ollama pull). */
	getChatSelectableCustomModels(): ICustomLanguageModel[];
	getSelectedCustomModelId(): string | undefined;
	setSelectedCustomModelId(id: string | undefined): void;
	addCustomModel(model: Omit<ICustomLanguageModel, 'id' | 'createdAt'>): Promise<ICustomLanguageModel>;
	removeCustomModel(id: string): Promise<void>;
	updateCustomModel(id: string, updates: Partial<Omit<ICustomLanguageModel, 'id' | 'createdAt'>>): Promise<void>;
	hideCustomModel(id: string, hidden: boolean): Promise<void>;
	/**
	 * Apply metadata derived from HuggingFace/Ollama. Only writes fields the user has NOT overridden
	 * (and never re-enables tools that the runtime auto-disabled). Marks the model as enriched.
	 */
	applyDerivedMetadata(id: string, derived: Partial<Pick<ICustomLanguageModel, 'contextWindow' | 'format' | 'useNativeTools'>>): Promise<void>;
	/** Record one tool-shaped request failure; returns the new consecutive-failure streak. */
	recordToolFailure(id: string): Promise<number>;
	/** Reset the tool-failure streak after a successful tool-using request. */
	resetToolFailureStreak(id: string): Promise<void>;
	/** Auto-disable native tool calling after repeated failures (sets toolsAutoDisabled + useNativeTools=false, without marking a user override). */
	autoDisableTools(id: string): Promise<void>;
}

const STORAGE_KEY = 'customLanguageModels';
const STORAGE_KEY_SELECTED = 'customLanguageModelSelected';
const SECRET_PREFIX = 'customLanguageModel:';

export class CustomLanguageModelsService extends Disposable implements ICustomLanguageModelsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeCustomModels = this._register(new Emitter<void>());
	readonly onDidChangeCustomModels = this._onDidChangeCustomModels.event;

	private models: ICustomLanguageModel[] = [];
	private selectedCustomModelId: string | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
	) {
		super();
		this.loadModels();
		this.selectedCustomModelId = this.storageService.get(STORAGE_KEY_SELECTED, StorageScope.APPLICATION, undefined);
	}

	private async loadModels(): Promise<void> {
		const stored = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION, '[]');
		try {
			const parsed = JSON.parse(stored);
			this.models = Array.isArray(parsed) ? parsed : [];
			// Ensure hidden and token limits exist for backward compatibility
			this.models = this.models.map(m => ({
				...m,
				hidden: m.hidden ?? false,
				useNativeTools: m.useNativeTools ?? false,
				mtp: m.mtp ?? false,
				contextWindow: m.contextWindow ?? m.maxInputTokens ?? defaultContextWindow(m.type === 'local'),
				ollamaPullComplete: m.provider === 'ollama' ? (m.ollamaPullComplete ?? true) : m.ollamaPullComplete,
				userOverrides: m.userOverrides ?? {},
				metadataEnriched: m.metadataEnriched ?? false,
				toolsAutoDisabled: m.toolsAutoDisabled ?? false,
				toolFailureStreak: m.toolFailureStreak ?? 0
			}));
			// Load secrets for each model
			for (const model of this.models) {
				if (model.apiKey) {
					const key = this.getSecretKey(model.id, 'apiKey');
					const storedKey = await this.secretStorageService.get(key);
					if (storedKey) {
						model.apiKey = storedKey;
					}
				}
				if (model.token) {
					const key = this.getSecretKey(model.id, 'token');
					const storedToken = await this.secretStorageService.get(key);
					if (storedToken) {
						model.token = storedToken;
					}
				}
			}
		} catch (e) {
			this.models = [];
		}
		const cleared = this._clearSelectedIfUnavailable();
		if (cleared) {
			this._onDidChangeCustomModels.fire();
		}
	}

	private async saveModels(): Promise<void> {
		// Save models without secrets
		const modelsToSave = this.models.map(model => ({
			...model,
			apiKey: model.apiKey ? '***' : undefined,
			token: model.token ? '***' : undefined
		}));
		this.storageService.store(STORAGE_KEY, JSON.stringify(modelsToSave), StorageScope.APPLICATION, StorageTarget.MACHINE);

		// Save secrets separately
		for (const model of this.models) {
			if (model.apiKey) {
				await this.secretStorageService.set(this.getSecretKey(model.id, 'apiKey'), model.apiKey);
			}
			if (model.token) {
				await this.secretStorageService.set(this.getSecretKey(model.id, 'token'), model.token);
			}
		}
	}

	private getSecretKey(modelId: string, type: 'apiKey' | 'token'): string {
		return `${SECRET_PREFIX}${modelId}:${type}`;
	}

	private _clearSelectedIfUnavailable(): boolean {
		const prev = this.selectedCustomModelId;
		if (!prev) {
			return false;
		}
		const model = this.models.find(m => m.id === prev);
		// Keep the selection as long as the model still exists and is visible. A not-yet-downloaded or
		// in-progress download stays selected - chat shows a download prompt for it - so the picker no
		// longer resets to Auto mid-download. Only clear when the model was deleted or hidden.
		if (model && !model.hidden) {
			return false;
		}
		this.selectedCustomModelId = undefined;
		this.storageService.store(STORAGE_KEY_SELECTED, '', StorageScope.APPLICATION, StorageTarget.MACHINE);
		return true;
	}

	private _displayNameCollides(trimmedDisplayName: string, excludeId?: string): boolean {
		const key = trimmedDisplayName.toLowerCase();
		return this.models.some(m => m.id !== excludeId && (m.displayName?.trim().toLowerCase() === key));
	}

	getCustomModels(): ICustomLanguageModel[] {
		return [...this.models];
	}

	getVisibleCustomModels(): ICustomLanguageModel[] {
		return this.models.filter(m => !m.hidden);
	}

	getChatSelectableCustomModels(): ICustomLanguageModel[] {
		return this.models.filter(m => isCustomModelReadyForChat(m));
	}

	getSelectedCustomModelId(): string | undefined {
		return this.selectedCustomModelId;
	}

	setSelectedCustomModelId(id: string | undefined): void {
		if (this.selectedCustomModelId !== id) {
			this.selectedCustomModelId = id;
			this.storageService.store(STORAGE_KEY_SELECTED, id ?? '', StorageScope.APPLICATION, StorageTarget.MACHINE);
			this._onDidChangeCustomModels.fire();
		}
	}

	async addCustomModel(modelData: Omit<ICustomLanguageModel, 'id' | 'createdAt'>): Promise<ICustomLanguageModel> {
		const displayNameTrim = modelData.displayName?.trim();
		if (displayNameTrim && this._displayNameCollides(displayNameTrim, undefined)) {
			throw new Error(localize('customLanguageModels.error.displayNameNotUnique', 'A model with this display name already exists.'));
		}
		const model: ICustomLanguageModel = {
			...modelData,
			displayName: displayNameTrim || undefined,
			contextWindow: modelData.contextWindow ?? defaultContextWindow(modelData.type === 'local'),
			// Optimistic default: most current instruct models support tool calling. Enrichment refines
			// this from a confirmed source (Ollama capabilities), and the runtime auto-disables it for
			// models that repeatedly fail tool calls (see autoDisableTools / TOOL_FAILURE_DISABLE_THRESHOLD).
			useNativeTools: modelData.useNativeTools ?? true,
			mtp: modelData.mtp ?? false,
			userOverrides: modelData.userOverrides ?? {},
			metadataEnriched: modelData.metadataEnriched ?? false,
			toolsAutoDisabled: false,
			toolFailureStreak: 0,
			ollamaPullComplete: modelData.provider === 'ollama'
				? (modelData.ollamaPullComplete !== undefined ? modelData.ollamaPullComplete : false)
				: undefined,
			id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			createdAt: Date.now()
		};

		this.models.push(model);
		await this.saveModels();
		this._onDidChangeCustomModels.fire();
		return model;
	}

	async removeCustomModel(id: string): Promise<void> {
		const index = this.models.findIndex(m => m.id === id);
		if (index >= 0) {
			const model = this.models[index];
			// Remove secrets
			if (model.apiKey) {
				await this.secretStorageService.delete(this.getSecretKey(id, 'apiKey'));
			}
			if (model.token) {
				await this.secretStorageService.delete(this.getSecretKey(id, 'token'));
			}
			this.models.splice(index, 1);
			if (this.selectedCustomModelId === id) {
				this.selectedCustomModelId = undefined;
				this.storageService.store(STORAGE_KEY_SELECTED, '', StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
			await this.saveModels();
			this._onDidChangeCustomModels.fire();
		}
	}

	async updateCustomModel(id: string, updates: Partial<Omit<ICustomLanguageModel, 'id' | 'createdAt'>>): Promise<void> {
		const index = this.models.findIndex(m => m.id === id);
		if (index >= 0) {
			if (updates.displayName !== undefined) {
				const next = updates.displayName?.trim() ?? '';
				if (next && this._displayNameCollides(next, id)) {
					throw new Error(localize('customLanguageModels.error.displayNameNotUnique', 'A model with this display name already exists.'));
				}
			}
			const model = this.models[index];
			// Update secrets if provided
			if (updates.apiKey !== undefined) {
				if (updates.apiKey) {
					await this.secretStorageService.set(this.getSecretKey(id, 'apiKey'), updates.apiKey);
				} else {
					await this.secretStorageService.delete(this.getSecretKey(id, 'apiKey'));
				}
			}
			if (updates.token !== undefined) {
				if (updates.token) {
					await this.secretStorageService.set(this.getSecretKey(id, 'token'), updates.token);
				} else {
					await this.secretStorageService.delete(this.getSecretKey(id, 'token'));
				}
			}
			const merged: ICustomLanguageModel = { ...model, ...updates };
			if (updates.displayName !== undefined) {
				merged.displayName = updates.displayName?.trim() || undefined;
			}
			// This is the user-facing edit path: any derivable field present here is an explicit user
			// choice, so mark it as overridden. applyDerivedMetadata then leaves these fields alone.
			const overrides: Partial<Record<DerivableModelField, boolean>> = { ...(model.userOverrides ?? {}) };
			for (const field of DERIVABLE_FIELDS) {
				if (Object.prototype.hasOwnProperty.call(updates, field)) {
					overrides[field] = true;
				}
			}
			merged.userOverrides = overrides;
			// If the user explicitly re-enabled tools, clear a prior runtime auto-disable and the failure
			// streak so the model gets a fresh chance. Turning tools off by hand is likewise not an auto-disable.
			if (Object.prototype.hasOwnProperty.call(updates, 'useNativeTools')) {
				merged.toolsAutoDisabled = false;
				merged.toolFailureStreak = 0;
			}
			this.models[index] = merged;
			await this.saveModels();
			this._clearSelectedIfUnavailable();
			this._onDidChangeCustomModels.fire();
		}
	}

	async applyDerivedMetadata(id: string, derived: Partial<Pick<ICustomLanguageModel, 'contextWindow' | 'format' | 'useNativeTools'>>): Promise<void> {
		const index = this.models.findIndex(m => m.id === id);
		if (index < 0) {
			return;
		}
		const model = this.models[index];
		const ov = model.userOverrides ?? {};
		const updates: Partial<ICustomLanguageModel> = {};
		if (derived.contextWindow !== undefined && !ov.contextWindow) {
			updates.contextWindow = derived.contextWindow;
		}
		if (derived.format !== undefined && !ov.format) {
			updates.format = derived.format;
		}
		// Never re-enable tools the user turned off or the runtime auto-disabled; only a confirmed source
		// (e.g. Ollama capabilities) flows in here, so it may safely turn tools OFF for unsupported models.
		if (derived.useNativeTools !== undefined && !ov.useNativeTools && !model.toolsAutoDisabled) {
			updates.useNativeTools = derived.useNativeTools;
		}
		this.models[index] = { ...model, ...updates, metadataEnriched: true };
		await this.saveModels();
		this._onDidChangeCustomModels.fire();
	}

	async recordToolFailure(id: string): Promise<number> {
		const index = this.models.findIndex(m => m.id === id);
		if (index < 0) {
			return 0;
		}
		const streak = (this.models[index].toolFailureStreak ?? 0) + 1;
		this.models[index] = { ...this.models[index], toolFailureStreak: streak };
		await this.saveModels();
		return streak;
	}

	async resetToolFailureStreak(id: string): Promise<void> {
		const index = this.models.findIndex(m => m.id === id);
		if (index < 0 || (this.models[index].toolFailureStreak ?? 0) === 0) {
			return;
		}
		this.models[index] = { ...this.models[index], toolFailureStreak: 0 };
		await this.saveModels();
	}

	async autoDisableTools(id: string): Promise<void> {
		const index = this.models.findIndex(m => m.id === id);
		if (index < 0) {
			return;
		}
		this.models[index] = { ...this.models[index], useNativeTools: false, toolsAutoDisabled: true, toolFailureStreak: 0 };
		await this.saveModels();
		this._onDidChangeCustomModels.fire();
	}

	async hideCustomModel(id: string, hidden: boolean): Promise<void> {
		const index = this.models.findIndex(m => m.id === id);
		if (index >= 0) {
			this.models[index] = { ...this.models[index], hidden };
			await this.saveModels();
			// If hiding the selected model, clear selection
			if (hidden && this.selectedCustomModelId === id) {
				this.setSelectedCustomModelId(undefined);
			}
			this._onDidChangeCustomModels.fire();
		}
	}
}
