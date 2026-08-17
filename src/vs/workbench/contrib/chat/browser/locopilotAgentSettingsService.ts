/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AGENT_SYSTEM_PROMPT_GENERAL, AGENT_SYSTEM_PROMPT_TOOLS_AND_INTERNAL, ASK_MODE_SYSTEM_PROMPT, INITIAL_USER_GENERAL_SYSTEM_PROMPT, PLAN_MODE_SYSTEM_PROMPT, TOOLS_PROMPT_WITHOUT_EDIT } from './agents/agentPrompts.js';

export const ILoCoPilotAgentSettingsService = createDecorator<ILoCoPilotAgentSettingsService>('locopilotAgentSettingsService');

/** @deprecated Migrate to useCoding flags; retained for one-time storage migration only. */
const LEGACY_STORED_FULL_BUILTIN_GENERAL_MARKER = '\uE000LOCOPILOT_FULL_BUILTIN_GENERAL\uE001';

const STORAGE_KEY_ASK_PROMPT = 'locopilot.agentSettings.askModeSystemPrompt';
const STORAGE_KEY_AGENT_PROMPT = 'locopilot.agentSettings.agentModeSystemPrompt';
const STORAGE_KEY_PLAN_PROMPT = 'locopilot.agentSettings.planModeSystemPrompt';
const STORAGE_KEY_ASK_USE_CODING_SYSTEM_PROMPT = 'locopilot.agentSettings.askUseCodingSystemPrompt';
const STORAGE_KEY_AGENT_USE_CODING_SYSTEM_PROMPT = 'locopilot.agentSettings.agentUseCodingSystemPrompt';
const STORAGE_KEY_PLAN_USE_CODING_SYSTEM_PROMPT = 'locopilot.agentSettings.planUseCodingSystemPrompt';
const STORAGE_KEY_MAX_ITERATIONS = 'locopilot.agentSettings.maxIterationsPerRequest';
const STORAGE_KEY_AUTO_RUN_SANDBOX = 'locopilot.agentSettings.autoRunCommandsInSandbox';
const STORAGE_KEY_AUTO_CONTINUE_ITERATIONS = 'locopilot.agentSettings.autoContinueAtMaxIterations';

export const DEFAULT_MAX_ITERATIONS = 50;
/**
 * Lowest value the "Max iterations per request" field accepts. Anything smaller is below what real
 * work needs, and the agent would spend the turn asking to continue. Drop it temporarily to exercise
 * the max-iteration continuation prompt in a couple of steps.
 */
export const MIN_MAX_ITERATIONS = 10;

export interface ILoCoPilotAgentSettingsService {
	readonly _serviceBrand: undefined;

	getAskModeSystemPrompt(): string;
	getAgentModeSystemPrompt(): string;
	getPlanModeSystemPrompt(): string;
	getAskUseCodingSystemPrompt(): boolean;
	getAgentUseCodingSystemPrompt(): boolean;
	getPlanUseCodingSystemPrompt(): boolean;
	getFullAskModeSystemPrompt(): string;
	getFullAgentModeSystemPrompt(): string;
	getFullPlanModeSystemPrompt(): string;
	getMaxIterationsPerRequest(): number;
	getAutoRunCommandsInSandbox(): boolean;
	getAutoContinueAtMaxIterations(): boolean;

	setAskModeSystemPrompt(value: string): void;
	setAgentModeSystemPrompt(value: string): void;
	setPlanModeSystemPrompt(value: string): void;
	setAskUseCodingSystemPrompt(value: boolean): void;
	setAgentUseCodingSystemPrompt(value: boolean): void;
	setPlanUseCodingSystemPrompt(value: boolean): void;
	setMaxIterationsPerRequest(value: number): void;
	setAutoRunCommandsInSandbox(value: boolean): void;
	setAutoContinueAtMaxIterations(value: boolean): void;
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
		return this.storageService.getBoolean(STORAGE_KEY_ASK_USE_CODING_SYSTEM_PROMPT, StorageScope.APPLICATION, true);
	}

	getAgentUseCodingSystemPrompt(): boolean {
		return this.storageService.getBoolean(STORAGE_KEY_AGENT_USE_CODING_SYSTEM_PROMPT, StorageScope.APPLICATION, true);
	}

	setAskUseCodingSystemPrompt(value: boolean): void {
		this.storageService.store(STORAGE_KEY_ASK_USE_CODING_SYSTEM_PROMPT, String(value), StorageScope.APPLICATION, StorageTarget.USER);
	}

	setAgentUseCodingSystemPrompt(value: boolean): void {
		this.storageService.store(STORAGE_KEY_AGENT_USE_CODING_SYSTEM_PROMPT, String(value), StorageScope.APPLICATION, StorageTarget.USER);
	}

	getPlanUseCodingSystemPrompt(): boolean {
		return this.storageService.getBoolean(STORAGE_KEY_PLAN_USE_CODING_SYSTEM_PROMPT, StorageScope.APPLICATION, true);
	}

	setPlanUseCodingSystemPrompt(value: boolean): void {
		this.storageService.store(STORAGE_KEY_PLAN_USE_CODING_SYSTEM_PROMPT, String(value), StorageScope.APPLICATION, StorageTarget.USER);
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

	/** User-editable general fragment when Plan "coding system prompt" is off. */
	getPlanModeSystemPrompt(): string {
		const stored = this.storageService.get(STORAGE_KEY_PLAN_PROMPT, StorageScope.APPLICATION);
		return stored ?? '';
	}

	/** Plan mode LLM payload: built-in Plan prompt + read-only tools when toggled on; else optional custom + fallback + read-only tools. */
	getFullPlanModeSystemPrompt(): string {
		if (this.getPlanUseCodingSystemPrompt()) {
			return PLAN_MODE_SYSTEM_PROMPT + TOOLS_PROMPT_WITHOUT_EDIT;
		}
		const user = this.getPlanModeSystemPrompt().trim();
		const general = user.length ? user : INITIAL_USER_GENERAL_SYSTEM_PROMPT;
		return general + TOOLS_PROMPT_WITHOUT_EDIT;
	}

	getMaxIterationsPerRequest(): number {
		const stored = this.storageService.get(STORAGE_KEY_MAX_ITERATIONS, StorageScope.APPLICATION);
		if (stored === undefined || stored === '') {
			this.storageService.store(STORAGE_KEY_MAX_ITERATIONS, String(DEFAULT_MAX_ITERATIONS), StorageScope.APPLICATION, StorageTarget.USER);
			return DEFAULT_MAX_ITERATIONS;
		}
		const n = parseInt(stored, 10);
		return isNaN(n) || n < MIN_MAX_ITERATIONS ? DEFAULT_MAX_ITERATIONS : Math.min(500, Math.max(MIN_MAX_ITERATIONS, n));
	}

	setAskModeSystemPrompt(value: string): void {
		this.storageService.store(STORAGE_KEY_ASK_PROMPT, value, StorageScope.APPLICATION, StorageTarget.USER);
	}

	setAgentModeSystemPrompt(value: string): void {
		this.storageService.store(STORAGE_KEY_AGENT_PROMPT, value, StorageScope.APPLICATION, StorageTarget.USER);
	}

	setPlanModeSystemPrompt(value: string): void {
		this.storageService.store(STORAGE_KEY_PLAN_PROMPT, value, StorageScope.APPLICATION, StorageTarget.USER);
	}

	setMaxIterationsPerRequest(value: number): void {
		const clamped = Math.min(500, Math.max(MIN_MAX_ITERATIONS, value));
		this.storageService.store(STORAGE_KEY_MAX_ITERATIONS, String(clamped), StorageScope.APPLICATION, StorageTarget.USER);
	}

	getAutoRunCommandsInSandbox(): boolean {
		return this.storageService.getBoolean(STORAGE_KEY_AUTO_RUN_SANDBOX, StorageScope.APPLICATION, false);
	}

	setAutoRunCommandsInSandbox(value: boolean): void {
		this.storageService.store(STORAGE_KEY_AUTO_RUN_SANDBOX, String(value), StorageScope.APPLICATION, StorageTarget.USER);
	}

	/**
	 * When on, hitting "Max iterations per request" silently grants the agent another full budget
	 * instead of asking the user whether to keep going. Off by default: the ask is the only thing
	 * standing between a stuck model and an unbounded tool loop.
	 */
	getAutoContinueAtMaxIterations(): boolean {
		return this.storageService.getBoolean(STORAGE_KEY_AUTO_CONTINUE_ITERATIONS, StorageScope.APPLICATION, false);
	}

	setAutoContinueAtMaxIterations(value: boolean): void {
		this.storageService.store(STORAGE_KEY_AUTO_CONTINUE_ITERATIONS, String(value), StorageScope.APPLICATION, StorageTarget.USER);
	}
}
