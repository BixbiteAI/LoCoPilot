/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Real generation stats reported by a local server (llama.cpp / mlx_lm) for the request currently
 * streaming into the chat panel. Unlike the word-count estimate used for remote providers, these
 * are exact counts and a measured rate coming straight from the server's own timers, so the timer
 * bar can show true "tokens" and "tokens/sec" rather than an approximation.
 */
export interface ILoCoPilotServerStats {
	/** usage.prompt_tokens of the latest call - exact prompt (input) token count. */
	promptTokens?: number;
	/** Generated tokens across the whole turn (sum of every call's timings.predicted_n / usage.completion_tokens). */
	completionTokens?: number;
	/** timings.predicted_per_second of the latest call - measured generation throughput in tokens/sec. */
	tokensPerSecond?: number;
	/** usage.prompt_tokens_details.cached_tokens of the latest call - prompt tokens reused from the server's KV cache. */
	cachedTokens?: number;
}

/** Per-call fields the provider reports as the SSE stream progresses. */
export interface ILoCoPilotServerStatsUpdate {
	promptTokens?: number;
	/** This call's running/final generated token count (timings.predicted_n or usage.completion_tokens). */
	completionTokens?: number;
	tokensPerSecond?: number;
	cachedTokens?: number;
}

export const ILoCoPilotLiveStatsService = createDecorator<ILoCoPilotLiveStatsService>('locopilotLiveStatsService');

export interface ILoCoPilotLiveStatsService {
	readonly _serviceBrand: undefined;
	/** Clear all stats at the start of a new user turn so the timer bar never shows a previous turn's numbers. */
	reset(): void;
	/**
	 * Mark the start of a new model call within the current turn. The previous call's generated tokens are
	 * committed to the turn total, and the per-call live figures are cleared. Call this before streaming a
	 * request whose server reports real stats (local llama.cpp / mlx_lm).
	 */
	beginCall(): void;
	/** Merge in the latest server-reported stats for the in-progress call as they arrive on the SSE stream. */
	update(stats: ILoCoPilotServerStatsUpdate): void;
	/** The current turn's server stats, or undefined when the active provider isn't reporting any (e.g. remote). */
	get(): ILoCoPilotServerStats | undefined;
}

export class LoCoPilotLiveStatsService extends Disposable implements ILoCoPilotLiveStatsService {
	declare readonly _serviceBrand: undefined;

	/** Whether any local call this turn has reported real stats; gates `get()` so remote turns return undefined. */
	private _active = false;
	/** Generated tokens from calls that already finished this turn. */
	private _committedCompletion = 0;
	/** The in-progress call's latest figures. */
	private _curCompletion: number | undefined;
	private _curPrompt: number | undefined;
	private _curRate: number | undefined;
	private _curCached: number | undefined;

	reset(): void {
		this._active = false;
		this._committedCompletion = 0;
		this._curCompletion = undefined;
		this._curPrompt = undefined;
		this._curRate = undefined;
		this._curCached = undefined;
	}

	beginCall(): void {
		this._active = true;
		this._committedCompletion += this._curCompletion ?? 0;
		this._curCompletion = undefined;
		// Keep the previous call's prompt/rate/cached visible until the new call reports its own.
	}

	update(stats: ILoCoPilotServerStatsUpdate): void {
		this._active = true;
		if (typeof stats.completionTokens === 'number') { this._curCompletion = stats.completionTokens; }
		if (typeof stats.promptTokens === 'number') { this._curPrompt = stats.promptTokens; }
		if (typeof stats.tokensPerSecond === 'number') { this._curRate = stats.tokensPerSecond; }
		if (typeof stats.cachedTokens === 'number') { this._curCached = stats.cachedTokens; }
	}

	get(): ILoCoPilotServerStats | undefined {
		if (!this._active) {
			return undefined;
		}
		return {
			promptTokens: this._curPrompt,
			completionTokens: this._committedCompletion + (this._curCompletion ?? 0),
			tokensPerSecond: this._curRate,
			cachedTokens: this._curCached,
		};
	}
}
