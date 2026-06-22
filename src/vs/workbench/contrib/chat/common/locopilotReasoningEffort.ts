/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * User-selectable "thinking effort" for chat requests, mirroring the reasoning-effort knob exposed by
 * OpenAI/Anthropic/Gemini and by local OpenAI-compatible servers (llama.cpp, mlx_lm, Ollama).
 *
 * The selection is a single global value chosen from the chat input toolbar (next to the model picker)
 * and read back by the LoCoPilot language model provider when it builds each request body. Each provider
 * translates the level differently - see {@link reasoningBudgetTokens} for the budget-based providers.
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export const REASONING_EFFORT_STORAGE_KEY = 'locopilot.reasoning.effort';
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';
// Display order in the picker: highest effort first.
export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = ['max', 'high', 'medium', 'low', 'off'];

export function reasoningEffortLabel(effort: ReasoningEffort): string {
	switch (effort) {
		case 'off': return 'Off';
		case 'low': return 'Low';
		case 'medium': return 'Medium';
		case 'high': return 'High';
		case 'max': return 'Max';
	}
}

export function getReasoningEffort(storageService: IStorageService): ReasoningEffort {
	const v = storageService.get(REASONING_EFFORT_STORAGE_KEY, StorageScope.APPLICATION, DEFAULT_REASONING_EFFORT);
	return (REASONING_EFFORT_VALUES as readonly string[]).includes(v) ? v as ReasoningEffort : DEFAULT_REASONING_EFFORT;
}

export function setReasoningEffort(storageService: IStorageService, effort: ReasoningEffort): void {
	storageService.store(REASONING_EFFORT_STORAGE_KEY, effort, StorageScope.APPLICATION, StorageTarget.USER);
}

/**
 * Token budget for providers that take an explicit "thinking budget" (Anthropic `budget_tokens`,
 * Gemini `thinkingConfig.thinkingBudget`, llama.cpp `reasoning_budget`) rather than a level string.
 *
 * Sentinel values:
 *  - `0`  -> thinking disabled (llama.cpp accepts this directly; cloud providers omit the field).
 *  - `-1` -> unlimited / "max" thinking (llama.cpp default; cloud providers clamp to their own ceiling).
 */
export function reasoningBudgetTokens(effort: ReasoningEffort): number {
	switch (effort) {
		case 'off': return 0;
		case 'low': return 2048;
		case 'medium': return 8192;
		case 'high': return 16384;
		case 'max': return -1;
	}
}
