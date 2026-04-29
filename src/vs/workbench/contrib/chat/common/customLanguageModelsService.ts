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
	/** Max input tokens (context window); default 100000 (100K) */
	maxInputTokens?: number;
	/** Max output tokens; default 8000 (8K) */
	maxOutputTokens?: number;
	/** Whether to use native tool calling (true) or system prompt injection (false) for local models */
	useNativeTools?: boolean;
	createdAt: number;
	hidden?: boolean; // Whether the model is hidden/disabled
	/**
	 * For `ollama`: false until the first successful pull finishes; set to false when a pull is cancelled.
	 * Omitted or undefined means true (legacy entries treated as already pulled).
	 */
	ollamaPullComplete?: boolean;
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
				maxInputTokens: m.maxInputTokens ?? 100000,
				maxOutputTokens: m.maxOutputTokens ?? 8000,
				ollamaPullComplete: m.provider === 'ollama' ? (m.ollamaPullComplete ?? true) : m.ollamaPullComplete
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
		const cleared = this._clearSelectedIfNotChatReady();
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

	private _clearSelectedIfNotChatReady(): boolean {
		const prev = this.selectedCustomModelId;
		if (!prev) {
			return false;
		}
		const model = this.models.find(m => m.id === prev);
		if (model && isCustomModelReadyForChat(model)) {
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
			maxInputTokens: modelData.maxInputTokens ?? 100000,
			maxOutputTokens: modelData.maxOutputTokens ?? 8000,
			useNativeTools: modelData.useNativeTools ?? false,
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
			this.models[index] = merged;
			await this.saveModels();
			this._clearSelectedIfNotChatReady();
			this._onDidChangeCustomModels.fire();
		}
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
