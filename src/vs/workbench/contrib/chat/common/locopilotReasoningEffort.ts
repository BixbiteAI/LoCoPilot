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
 * Fraction of the model's output window that each effort level is allowed to spend on thinking.
 * Budgets are computed relative to the window rather than as fixed token counts so the same level
 * scales with the model/task: a small model on a short window gets a tight budget, a large model on
 * a long window gets a generous one. `off`/`max` are sentinels handled in {@link reasoningBudgetTokens}.
 */
const REASONING_EFFORT_FRACTION: Readonly<Record<Exclude<ReasoningEffort, 'off' | 'max'>, number>> = {
	low: 0.15,
	medium: 0.35,
	high: 0.70,
};
/** Floor so a tiny output window can't collapse a thinking budget to near-zero. */
const REASONING_BUDGET_FLOOR = 64;
/** Window assumed when the caller can't supply one (keeps the level meaningful rather than 0). */
const DEFAULT_OUTPUT_WINDOW = 8192;

/**
 * Token budget for providers that take an explicit "thinking budget" (Anthropic `budget_tokens`,
 * Gemini `thinkingConfig.thinkingBudget`, llama.cpp `thinking_budget_tokens`) rather than a level
 * string. Scales with `outputWindow` (the request's max output tokens) - see {@link REASONING_EFFORT_FRACTION}.
 *
 * Sentinel return values:
 *  - `0`  -> thinking disabled (llama.cpp also needs `enable_thinking:false`; cloud providers omit the field).
 *  - `-1` -> unlimited / "max" thinking (llama.cpp default; cloud providers clamp to their own ceiling).
 */
export function reasoningBudgetTokens(effort: ReasoningEffort, outputWindow: number): number {
	if (effort === 'off') { return 0; }
	if (effort === 'max') { return -1; }
	const window = outputWindow > 0 ? outputWindow : DEFAULT_OUTPUT_WINDOW;
	return Math.max(REASONING_BUDGET_FLOOR, Math.round(REASONING_EFFORT_FRACTION[effort] * window));
}

/**
 * The request fields a LOCAL OpenAI-compatible server (llama.cpp, mlx_lm, Ollama) may feed into the model's
 * chat template - as opposed to the thinking-budget fields, which only steer generation.
 *
 * Single source of truth for three callers that must agree byte for byte: the provider (the real turn), the
 * prefix prefill (`/apply-template` on the warm), and the prefix diagnostic. llama.cpp forwards
 * `reasoning_effort` into `chat_template_kwargs` (tools/server/server-common.cpp), and some templates render it
 * at the very top of the system prompt - Qwen3.8 emits "Reasoning effort is set to low..." as its first line
 * (default `xhigh` when the field is absent). A warm rendered without it therefore diverges from every real
 * turn at token ~3, and the whole prefix cache - in-session and on disk - is thrown away. Templates that never
 * read the field render identically with or without it, so passing it everywhere costs them nothing.
 *
 * `max` is sent as `high`: templates that validate the level reject anything outside their own set (Qwen3.8
 * raises "Unexpected reasoning effort max" -> HTTP 500; gpt-oss knows only low/medium/high). The unlimited
 * thinking budget that distinguishes Max is carried by `thinking_budget_tokens: -1`, not by this string.
 */
export interface ILocalReasoningTemplateFields {
	reasoning_effort?: 'low' | 'medium' | 'high';
	chat_template_kwargs?: { enable_thinking: false };
}

export function localReasoningTemplateFields(effort: ReasoningEffort): ILocalReasoningTemplateFields {
	switch (effort) {
		case 'off': return { chat_template_kwargs: { enable_thinking: false } };
		case 'max': return { reasoning_effort: 'high' };
		default: return { reasoning_effort: effort };
	}
}
