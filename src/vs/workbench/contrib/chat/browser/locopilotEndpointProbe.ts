/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { DEFAULT_CONTEXT_WINDOW_LOCAL } from '../common/customLanguageModelsService.js';

/**
 * Probing an OpenAI-compatible endpoint the user configured themselves (provider id `localhost`, shown as
 * "Custom Endpoint").
 *
 * LoCoPilot does not launch these servers, so unlike the managed llama.cpp/MLX path there is no
 * `getLaunchedContextWindow()` to ask - which historically meant the context window was whatever the user
 * typed, defaulting to 32K. When the endpoint actually runs with a smaller window (`llama-server -c 8192`),
 * the agent budgets 32K, packs the prompt to fit, and the server silently truncates from the LEFT - dropping
 * the system prompt and tool definitions first. The model then misbehaves with no error anywhere. Asking the
 * server is the only way to avoid that, so we ask.
 */

/**
 * Context window assumed only when the server won't say and the user hasn't either.
 *
 * Deliberately the same number every other local provider defaults to
 * ({@link DEFAULT_CONTEXT_WINDOW_LOCAL}), so a custom endpoint behaves like the rest of LoCoPilot instead of
 * being quietly special-cased. The confirm dialog on the Add form still states the number and the risk, since
 * a value above what the server actually runs with makes it truncate the prompt from the left rather than
 * report an error.
 */
export const ENDPOINT_FALLBACK_CONTEXT_WINDOW = DEFAULT_CONTEXT_WINDOW_LOCAL;

/** Per-request budget. Probes are interactive (a button, or an add-form blur), so they must fail fast. */
const PROBE_TIMEOUT_MS = 4000;

export interface IEndpointProbeResult {
	/** True when the endpoint answered at all (any HTTP status, including 401). */
	reachable: boolean;
	/** True when the endpoint answered but rejected our credentials. */
	unauthorized: boolean;
	/** Model ids the endpoint advertises via GET /v1/models, in the order reported. Empty when unavailable. */
	modelIds: string[];
	/** Context length in tokens, when the endpoint reports one. Undefined means "it wouldn't say". */
	contextWindow?: number;
	/** Human-readable reason the probe failed, for display next to the URL field. Undefined on success. */
	error?: string;
}

/**
 * Turns a chat-completions URL into the API root the discovery endpoints hang off.
 *
 * Users paste the full completions URL (that is what the request needs), but `/models` and llama.cpp's
 * `/props` are siblings of `/chat/completions`, so we strip that suffix. Handles both `/v1/chat/completions`
 * and the `/chat/completions` form some servers expose without the version prefix.
 */
export function endpointApiRoot(chatCompletionsUrl: string): string {
	const trimmed = chatCompletionsUrl.trim().replace(/\/+$/, '');
	return trimmed.replace(/\/chat\/completions$/i, '');
}

/** The server root (scheme://host:port), for endpoints whose extras sit above the /v1 prefix. */
function endpointServerRoot(chatCompletionsUrl: string): string | undefined {
	try {
		const u = new URL(chatCompletionsUrl.trim());
		return `${u.protocol}//${u.host}`;
	} catch {
		return undefined;
	}
}

/**
 * Pulls a context length out of whatever shape the server used.
 *
 * There is no agreed field for this, so we check the ones the common servers actually emit:
 *  - llama.cpp `GET /props` -> `default_generation_settings.n_ctx` (the REAL clamped window it booted with)
 *  - vLLM / SGLang `GET /v1/models` -> `data[].max_model_len`
 *  - LM Studio / others -> `data[].context_length` or a loaded-model `max_context_length`
 */
function readContextLength(payload: unknown): number | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const obj = payload as Record<string, unknown>;
	const nested = (key: string): Record<string, unknown> | undefined => {
		const v = obj[key];
		return v && typeof v === 'object' ? v as Record<string, unknown> : undefined;
	};
	const candidates: unknown[] = [
		nested('default_generation_settings')?.['n_ctx'],
		obj['n_ctx'],
		obj['max_model_len'],
		obj['context_length'],
		obj['max_context_length'],
		nested('config')?.['max_model_len'],
		nested('config')?.['context_length'],
	];
	for (const c of candidates) {
		const n = typeof c === 'string' ? Number(c) : c;
		// Guard against a server reporting 0/-1 for "unset", and against absurd values that would make the
		// agent pack a prompt no server could hold.
		if (typeof n === 'number' && Number.isFinite(n) && n >= 512 && n <= 10_000_000) {
			return Math.floor(n);
		}
	}
	return undefined;
}

export class LoCoPilotEndpointProbe {

	constructor(private readonly requestService: IRequestService) { }

	/** GETs `url` with a short deadline, returning the status and parsed JSON body (when it is JSON). */
	private async _getJson(url: string, apiKey: string | undefined): Promise<{ status: number; json?: unknown; error?: string }> {
		const cts = new CancellationTokenSource();
		const timer = setTimeout(() => cts.cancel(), PROBE_TIMEOUT_MS);
		try {
			const headers: Record<string, string> = { 'Accept': 'application/json' };
			if (apiKey) {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}
			const res = await this.requestService.request({ type: 'GET', url, headers }, cts.token);
			const status = res.res.statusCode ?? 0;
			const body = (await streamToBuffer(res.stream)).toString();
			try {
				return { status, json: JSON.parse(body) };
			} catch {
				return { status };
			}
		} catch (e) {
			return { status: 0, error: e instanceof Error ? e.message : String(e) };
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
	}

	/**
	 * Asks a custom endpoint what it is running: which model ids it serves and how big its context window is.
	 *
	 * Best-effort by design - plenty of OpenAI-compatible servers implement only `/chat/completions`. A probe
	 * that comes back empty is not an error the user must resolve; it just means they fill the fields in by
	 * hand. What we must NOT do is silently invent a context window, so `contextWindow` stays undefined rather
	 * than falling back to a guess here (the caller decides, and asks the user).
	 */
	async probe(chatCompletionsUrl: string, apiKey?: string): Promise<IEndpointProbeResult> {
		const result: IEndpointProbeResult = { reachable: false, unauthorized: false, modelIds: [] };
		const url = chatCompletionsUrl.trim();
		if (!/^https?:\/\//i.test(url)) {
			result.error = 'Enter a full URL starting with http:// or https://';
			return result;
		}

		const apiRoot = endpointApiRoot(url);
		const serverRoot = endpointServerRoot(url);

		// 1. GET {apiRoot}/models - the OpenAI-standard discovery endpoint. Widely implemented, and on
		//    vLLM/SGLang it also carries the context length.
		const models = await this._getJson(`${apiRoot}/models`, apiKey);
		if (models.status === 401 || models.status === 403) {
			result.reachable = true;
			result.unauthorized = true;
			result.error = apiKey
				? 'The endpoint rejected this API key.'
				: 'The endpoint requires an API key.';
			return result;
		}
		if (models.status === 200 && models.json) {
			result.reachable = true;
			const data = (models.json as Record<string, unknown>)['data'];
			if (Array.isArray(data)) {
				for (const entry of data) {
					const id = (entry as Record<string, unknown> | undefined)?.['id'];
					if (typeof id === 'string' && id.trim()) {
						result.modelIds.push(id.trim());
					}
					if (result.contextWindow === undefined) {
						result.contextWindow = readContextLength(entry);
					}
				}
			}
		}

		// 2. GET {serverRoot}/props - llama.cpp only, but it is the single most common server behind this
		//    provider and the only source that reports the window it ACTUALLY booted with (after its own
		//    clamping), which is exactly the number that matters. Prefer it over anything from /models.
		if (serverRoot) {
			const props = await this._getJson(`${serverRoot}/props`, apiKey);
			// llama-server with `--api-key` leaves GET /v1/models PUBLIC but gates /props (and
			// /chat/completions) behind the key - verified against llama.cpp b3ce5ced. So a bad or missing key
			// gets past the check above and only shows up here. Without this branch the user is told "connected,
			// but it didn't report a context window", when the real problem is the key - and their first message
			// would then fail with a 401 they were given no warning about.
			if (props.status === 401 || props.status === 403) {
				result.reachable = true;
				result.unauthorized = true;
				result.error = apiKey
					? 'The endpoint rejected this API key.'
					: 'The endpoint requires an API key.';
				return result;
			}
			if (props.status === 200 && props.json) {
				result.reachable = true;
				const n = readContextLength(props.json);
				if (n !== undefined) {
					result.contextWindow = n;
				}
			}
		}

		if (!result.reachable) {
			result.error = models.error
				? `Could not reach the endpoint: ${models.error}`
				: 'Could not reach the endpoint. Check the URL, that the server is running, and that it is bound to a reachable address.';
		}
		return result;
	}
}
