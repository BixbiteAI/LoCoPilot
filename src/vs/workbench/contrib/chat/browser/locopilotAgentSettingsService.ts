/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AGENT_SYSTEM_PROMPT_GENERAL, AGENT_SYSTEM_PROMPT_TOOLS_AND_INTERNAL, ASK_MODE_SYSTEM_PROMPT, INITIAL_USER_GENERAL_SYSTEM_PROMPT, TOOLS_PROMPT_WITHOUT_EDIT } from './agents/agentPrompts.js';

export const ILoCoPilotAgentSettingsService = createDecorator<ILoCoPilotAgentSettingsService>('locopilotAgentSettingsService');

/** @deprecated Migrate to useCoding flags; retained for one-time storage migration only. */
const LEGACY_STORED_FULL_BUILTIN_GENERAL_MARKER = '\uE000LOCOPILOT_FULL_BUILTIN_GENERAL\uE001';

const STORAGE_KEY_ASK_PROMPT = 'locopilot.agentSettings.askModeSystemPrompt';
const STORAGE_KEY_AGENT_PROMPT = 'locopilot.agentSettings.agentModeSystemPrompt';
const STORAGE_KEY_ASK_USE_CODING_SYSTEM_PROMPT = 'locopilot.agentSettings.askUseCodingSystemPrompt';
const STORAGE_KEY_AGENT_USE_CODING_SYSTEM_PROMPT = 'locopilot.agentSettings.agentUseCodingSystemPrompt';
const STORAGE_KEY_MAX_ITERATIONS = 'locopilot.agentSettings.maxIterationsPerRequest';
const STORAGE_KEY_AUTO_RUN_SANDBOX = 'locopilot.agentSettings.autoRunCommandsInSandbox';

export const DEFAULT_MAX_ITERATIONS = 25;

export interface ILoCoPilotAgentSettingsService {
	readonly _serviceBrand: undefined;

	getAskModeSystemPrompt(): string;
	getAgentModeSystemPrompt(): string;
	getAskUseCodingSystemPrompt(): boolean;
	getAgentUseCodingSystemPrompt(): boolean;
	getFullAskModeSystemPrompt(): string;
	getFullAgentModeSystemPrompt(): string;
	getMaxIterationsPerRequest(): number;
	getAutoRunCommandsInSandbox(): boolean;

	setAskModeSystemPrompt(value: string): void;
	setAgentModeSystemPrompt(value: string): void;
	setAskUseCodingSystemPrompt(value: boolean): void;
	setAgentUseCodingSystemPrompt(value: boolean): void;
	setMaxIterationsPerRequest(value: number): void;
	setAutoRunCommandsInSandbox(value: boolean): void;
}

export class LoCoPilotAgentSettingsService implements ILoCoPilotAgentSettingsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		this.migrateLegacyStorageIfNeeded();
	}

	/** Migrates obsolete marker-only storage to-toggle + cleared prompt fields. Idempotent per session. */
	private migrateLegacyStorageIfNeeded(): void {
		const askRaw = this.storageService.get(STORAGE_KEY_ASK_PROMPT, StorageScope.APPLICATION);
		if (askRaw === LEGACY_STORED_FULL_BUILTIN_GENERAL_MARKER) {
			this.storageService.store(STORAGE_KEY_ASK_USE_CODING_SYSTEM_PROMPT, String(true), StorageScope.APPLICATION, StorageTarget.USER);
			this.storageService.store(STORAGE_KEY_ASK_PROMPT, '', StorageScope.APPLICATION, StorageTarget.USER);
		}
		const agentRaw = this.storageService.get(STORAGE_KEY_AGENT_PROMPT, StorageScope.APPLICATION);
		if (agentRaw === LEGACY_STORED_FULL_BUILTIN_GENERAL_MARKER) {
			this.storageService.store(STORAGE_KEY_AGENT_USE_CODING_SYSTEM_PROMPT, String(true), StorageScope.APPLICATION, StorageTarget.USER);
			this.storageService.store(STORAGE_KEY_AGENT_PROMPT, '', StorageScope.APPLICATION, StorageTarget.USER);
		}
	}

	getAskUseCodingSystemPrompt(): boolean {
		return this.storageService.getBoolean(STORAGE_KEY_ASK_USE_CODING_SYSTEM_PROMPT, StorageScope.APPLICATION, false);
	}

	getAgentUseCodingSystemPrompt(): boolean {
		return this.storageService.getBoolean(STORAGE_KEY_AGENT_USE_CODING_SYSTEM_PROMPT, StorageScope.APPLICATION, false);
	}

	setAskUseCodingSystemPrompt(value: boolean): void {
		this.storageService.store(STORAGE_KEY_ASK_USE_CODING_SYSTEM_PROMPT, String(value), StorageScope.APPLICATION, StorageTarget.USER);
	}

	setAgentUseCodingSystemPrompt(value: boolean): void {
		this.storageService.store(STORAGE_KEY_AGENT_USE_CODING_SYSTEM_PROMPT, String(value), StorageScope.APPLICATION, StorageTarget.USER);
	}

	/** User-editable general fragment when Ask "coding system prompt" is off. */
	getAskModeSystemPrompt(): string {
		const stored = this.storageService.get(STORAGE_KEY_ASK_PROMPT, StorageScope.APPLICATION);
		return stored ?? '';
	}

	/** User-editable general fragment when Agent "coding system prompt" is off. */
	getAgentModeSystemPrompt(): string {
		const stored = this.storageService.get(STORAGE_KEY_AGENT_PROMPT, StorageScope.APPLICATION);
		return stored ?? '';
	}

	/** Ask mode LLM payload: built-in Ask prompt + tools when toggled on; else optional custom + fallback line + tools. */
	getFullAskModeSystemPrompt(): string {
		if (this.getAskUseCodingSystemPrompt()) {
			return ASK_MODE_SYSTEM_PROMPT + TOOLS_PROMPT_WITHOUT_EDIT;
		}
		const user = this.getAskModeSystemPrompt().trim();
		const general = user.length ? user : INITIAL_USER_GENERAL_SYSTEM_PROMPT;
		return general + TOOLS_PROMPT_WITHOUT_EDIT;
	}

	getFullAgentModeSystemPrompt(): string {
		if (this.getAgentUseCodingSystemPrompt()) {
			return AGENT_SYSTEM_PROMPT_GENERAL + AGENT_SYSTEM_PROMPT_TOOLS_AND_INTERNAL;
		}
		const user = this.getAgentModeSystemPrompt().trim();
		const general = user.length ? user : INITIAL_USER_GENERAL_SYSTEM_PROMPT;
		return general + AGENT_SYSTEM_PROMPT_TOOLS_AND_INTERNAL;
	}

	getMaxIterationsPerRequest(): number {
		const stored = this.storageService.get(STORAGE_KEY_MAX_ITERATIONS, StorageScope.APPLICATION);
		if (stored === undefined || stored === '') {
			this.storageService.store(STORAGE_KEY_MAX_ITERATIONS, String(DEFAULT_MAX_ITERATIONS), StorageScope.APPLICATION, StorageTarget.USER);
			return DEFAULT_MAX_ITERATIONS;
		}
		const n = parseInt(stored, 10);
		return isNaN(n) || n < 10 ? DEFAULT_MAX_ITERATIONS : Math.min(500, Math.max(10, n));
	}

	setAskModeSystemPrompt(value: string): void {
		this.storageService.store(STORAGE_KEY_ASK_PROMPT, value, StorageScope.APPLICATION, StorageTarget.USER);
	}

	setAgentModeSystemPrompt(value: string): void {
		this.storageService.store(STORAGE_KEY_AGENT_PROMPT, value, StorageScope.APPLICATION, StorageTarget.USER);
	}

	setMaxIterationsPerRequest(value: number): void {
		const clamped = Math.min(500, Math.max(10, value));
		this.storageService.store(STORAGE_KEY_MAX_ITERATIONS, String(clamped), StorageScope.APPLICATION, StorageTarget.USER);
	}

	getAutoRunCommandsInSandbox(): boolean {
		return this.storageService.getBoolean(STORAGE_KEY_AUTO_RUN_SANDBOX, StorageScope.APPLICATION, false);
	}

	setAutoRunCommandsInSandbox(value: boolean): void {
		this.storageService.store(STORAGE_KEY_AUTO_RUN_SANDBOX, String(value), StorageScope.APPLICATION, StorageTarget.USER);
	}
}
