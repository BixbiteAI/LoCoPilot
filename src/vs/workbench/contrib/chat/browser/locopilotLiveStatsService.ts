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
	/**
	 * True when the figures are client-derived rather than server-authoritative: the server gave us no
	 * `usage`/`timings` block (e.g. an mlx_lm build that doesn't emit them), so the count was tallied from
	 * the SSE stream (~one token per delta) and the rate computed from wall-clock time. The UI shows these
	 * with a "~" prefix to signal they're approximate.
	 */
	estimated?: boolean;
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
	/**
	 * Tally one generated token seen on the SSE stream (local servers stream ~one token per delta). This is
	 * the fallback for servers that don't report `usage`/`timings` (e.g. some mlx_lm builds): it lets the
	 * timer bar still show a token count and a wall-clock-measured tokens/sec. Ignored for the count/rate
	 * whenever the server does report real numbers - those always win.
	 */
	recordClientToken(): void;
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

	/** Whether the server has reported a real token count this turn (gates use of the client-side tally). */
	private _sawServerCount = false;
	/** Client-side token tally (SSE deltas) from calls that already finished this turn. */
	private _committedClient = 0;
	/** The in-progress call's client-side token tally. */
	private _curClient = 0;
	/** Wall-clock start of generation for the in-progress call (set on its first streamed token). */
	private _curGenStart: number | undefined;
	/** Wall-clock time the server's completion count last advanced; used to detect a stalled server. */
	private _serverCountChangedAt: number | undefined;

	/** How long the server count may stand still before we treat it as stalled (tool-call streaming phase). */
	private static readonly SERVER_STALL_MS = 1000;

	reset(): void {
		this._active = false;
		this._committedCompletion = 0;
		this._curCompletion = undefined;
		this._curPrompt = undefined;
		this._curRate = undefined;
		this._curCached = undefined;
		this._sawServerCount = false;
		this._committedClient = 0;
		this._curClient = 0;
		this._curGenStart = undefined;
		this._serverCountChangedAt = undefined;
	}

	beginCall(): void {
		this._active = true;
		this._committedCompletion += this._curCompletion ?? 0;
		this._committedClient += this._curClient;
		this._curCompletion = undefined;
		this._curClient = 0;
		this._curGenStart = undefined;
		this._serverCountChangedAt = undefined;
		// Keep the previous call's prompt/rate/cached visible until the new call reports its own.
	}

	update(stats: ILoCoPilotServerStatsUpdate): void {
		this._active = true;
		if (typeof stats.completionTokens === 'number') {
			if (stats.completionTokens !== this._curCompletion) { this._serverCountChangedAt = Date.now(); }
			this._curCompletion = stats.completionTokens;
			this._sawServerCount = true;
		}
		if (typeof stats.promptTokens === 'number') { this._curPrompt = stats.promptTokens; }
		if (typeof stats.tokensPerSecond === 'number') { this._curRate = stats.tokensPerSecond; }
		if (typeof stats.cachedTokens === 'number') { this._curCached = stats.cachedTokens; }
	}

	recordClientToken(): void {
		this._active = true;
		// Time generation from the first token (not the call start) so the rate excludes the prompt-eval
		// wait and reflects true decode throughput - matching what llama.cpp's predicted_per_second reports.
		if (this._curGenStart === undefined) { this._curGenStart = Date.now(); }
		this._curClient++;
	}

	get(): ILoCoPilotServerStats | undefined {
		if (!this._active) {
			return undefined;
		}
		// Prefer the server's authoritative count; otherwise use the SSE-stream tally.
		const serverCompletion = this._sawServerCount ? this._committedCompletion + (this._curCompletion ?? 0) : undefined;
		const clientCompletion = this._committedClient + this._curClient;
		// A stalled server means its count hasn't advanced for a while even though tokens are still streaming -
		// the signature of the tool-call phase, where llama.cpp drops its per-chunk `timings`. We only trust the
		// client tally over the server count in that window; during normal generation the server updates
		// constantly (never "stalled"), so its exact count/rate are always used and the ~1-per-delta client
		// drift is ignored.
		const serverStalled = this._sawServerCount
			&& this._serverCountChangedAt !== undefined
			&& (Date.now() - this._serverCountChangedAt) > LoCoPilotLiveStatsService.SERVER_STALL_MS;
		const clientAhead = serverStalled && serverCompletion !== undefined && clientCompletion > serverCompletion;
		// When the server stalls mid-turn, keep the count moving with the client tally so it never freezes;
		// the server figure wins again as soon as it catches up at the final chunk.
		const completionTokens = (serverCompletion !== undefined && !clientAhead) ? serverCompletion : Math.max(serverCompletion ?? 0, clientCompletion);

		// Rate: the server's measured tokens/sec when given (llama.cpp); otherwise compute it from this call's
		// tokens over the elapsed generation time (mlx_lm and other servers that emit no `timings`, or the
		// tool-call phase where the server goes quiet).
		let tokensPerSecond = clientAhead ? undefined : this._curRate;
		let estimated = !this._sawServerCount || clientAhead;
		if (typeof tokensPerSecond !== 'number') {
			estimated = true;
			const curTokens = (this._sawServerCount && !clientAhead) ? (this._curCompletion ?? 0) : this._curClient;
			const elapsedSec = this._curGenStart !== undefined ? (Date.now() - this._curGenStart) / 1000 : 0;
			if (curTokens > 1 && elapsedSec > 0.05) {
				tokensPerSecond = Math.round(curTokens / elapsedSec);
			} else {
				tokensPerSecond = undefined;
			}
		}

		return {
			promptTokens: this._curPrompt,
			completionTokens,
			tokensPerSecond,
			cachedTokens: this._curCached,
			estimated,
		};
	}
}
