/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEmbeddingComputeService } from '../../../../../platform/embeddings/common/embeddingCompute.js';

/**
 * Local-first embedding provider abstraction.
 *
 * Retrieval embeddings are computed on the user's machine and never leave it (unless the user
 * explicitly opts into a cloud backend). Providers are auto-detected in priority order so the
 * feature "just works" when the user already runs Ollama or llama.cpp.
 *
 * NOTE: A future BundledEmbeddingProvider (in-process ONNX/WASM, e.g. transformers.js running
 * nomic-embed-text) can be dropped in here to give pure-cloud users zero-setup retrieval. The
 * rest of the retrieval stack is agnostic to which provider produced the vectors.
 */
export interface IEmbeddingProvider {
	/** Stable id recorded in the index manifest; a change forces a re-index. */
	readonly id: string;
	/** Embedding model id (e.g. "nomic-embed-text"). Recorded in the manifest. */
	readonly model: string;
	/** Vector dimensionality, known after the first successful embed (or 0 if unknown yet). */
	readonly dimension: number;
	/** Embed a batch of documents (for indexing). Returns one vector per input. */
	embedDocuments(texts: string[], token: CancellationToken): Promise<number[][]>;
	/** Embed a single query (for search). */
	embedQuery(text: string, token: CancellationToken): Promise<number[]>;
}

/** Default embedding model. nomic-embed-text-v1.5: Apache-2.0, code+text, available on Ollama, llama.cpp (GGUF) and ONNX. */
export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** nomic / bge style models expect task prefixes; skipping them noticeably hurts retrieval. */
const QUERY_PREFIX = 'search_query: ';
const DOCUMENT_PREFIX = 'search_document: ';

function cfg<T>(configurationService: IConfigurationService, key: string, fallback: T): T {
	const v = configurationService.getValue(key);
	return (v === undefined || v === null || v === '') ? fallback : v as T;
}

/**
 * Ollama embeddings via POST /api/embed (batch) with a fallback to /api/embeddings (single).
 * No CORS issues: requests are routed through the main process via IRequestService.
 */
class OllamaEmbeddingProvider implements IEmbeddingProvider {
	readonly id: string;
	dimension = 0;
	constructor(
		readonly model: string,
		private readonly baseUrl: string,
		private readonly requestService: IRequestService,
		private readonly logService: ILogService,
	) {
		this.id = `ollama:${model}`;
	}

	private async _post(path: string, body: any, token: CancellationToken): Promise<any> {
		const res = await this.requestService.request({
			type: 'POST',
			url: `${this.baseUrl}${path}`,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify(body),
		}, token);
		const text = await streamToBuffer(res.stream).then(b => b.toString());
		if ((res.res.statusCode ?? 0) >= 400) {
			throw new Error(`Ollama embeddings HTTP ${res.res.statusCode}: ${text.slice(0, 200)}`);
		}
		return JSON.parse(text);
	}

	async embedDocuments(texts: string[], token: CancellationToken): Promise<number[][]> {
		if (texts.length === 0) { return []; }
		const input = texts.map(t => DOCUMENT_PREFIX + t);
		try {
			// Newer Ollama: batch endpoint.
			const json = await this._post('/api/embed', { model: this.model, input }, token);
			const vectors: number[][] = json.embeddings ?? [];
			if (vectors.length && vectors[0]?.length) { this.dimension = vectors[0].length; return vectors; }
		} catch (e) {
			this.logService.trace(`[LoCoPilot Retrieval] Ollama /api/embed unavailable, falling back: ${e}`);
		}
		// Fallback: single-item endpoint, one request per text.
		const out: number[][] = [];
		for (const t of input) {
			if (token.isCancellationRequested) { break; }
			const json = await this._post('/api/embeddings', { model: this.model, prompt: t }, token);
			const v: number[] = json.embedding ?? [];
			if (v.length) { this.dimension = v.length; }
			out.push(v);
		}
		return out;
	}

	async embedQuery(text: string, token: CancellationToken): Promise<number[]> {
		try {
			const json = await this._post('/api/embed', { model: this.model, input: QUERY_PREFIX + text }, token);
			const v = json.embeddings?.[0] ?? json.embedding ?? [];
			if (v.length) { this.dimension = v.length; }
			return v;
		} catch {
			const json = await this._post('/api/embeddings', { model: this.model, prompt: QUERY_PREFIX + text }, token);
			const v = json.embedding ?? [];
			if (v.length) { this.dimension = v.length; }
			return v;
		}
	}
}

/**
 * OpenAI-compatible /v1/embeddings (covers llama.cpp --embedding, LM Studio, vLLM, and cloud
 * OpenAI/HF router when the user opts in by configuring a URL + key).
 */
class OpenAICompatEmbeddingProvider implements IEmbeddingProvider {
	readonly id: string;
	dimension = 0;
	constructor(
		readonly model: string,
		private readonly url: string,
		private readonly apiKey: string | undefined,
		private readonly requestService: IRequestService,
		idPrefix: string,
	) {
		this.id = `${idPrefix}:${model}`;
	}

	private async _embed(input: string[], token: CancellationToken): Promise<number[][]> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.apiKey) { headers['Authorization'] = `Bearer ${this.apiKey}`; }
		const res = await this.requestService.request({
			type: 'POST', url: this.url, headers,
			data: JSON.stringify({ model: this.model, input }),
		}, token);
		const text = await streamToBuffer(res.stream).then(b => b.toString());
		if ((res.res.statusCode ?? 0) >= 400) {
			throw new Error(`Embeddings HTTP ${res.res.statusCode}: ${text.slice(0, 200)}`);
		}
		const json = JSON.parse(text);
		const vectors: number[][] = (json.data ?? []).map((d: any) => d.embedding as number[]);
		if (vectors.length && vectors[0]?.length) { this.dimension = vectors[0].length; }
		return vectors;
	}

	async embedDocuments(texts: string[], token: CancellationToken): Promise<number[][]> {
		if (texts.length === 0) { return []; }
		return this._embed(texts.map(t => DOCUMENT_PREFIX + t), token);
	}

	async embedQuery(text: string, token: CancellationToken): Promise<number[]> {
		const [v] = await this._embed([QUERY_PREFIX + text], token);
		return v ?? [];
	}
}

/**
 * Wraps the bundled in-process embedder (shared-process onnxruntime-node) so semantic search
 * works with zero user setup, identically for local and cloud chat models. This is the default.
 */
class BundledEmbeddingProvider implements IEmbeddingProvider {
	readonly id: string;
	dimension = 0;
	constructor(readonly model: string, private readonly compute: IEmbeddingComputeService) {
		this.id = `bundled:${model}`;
	}
	async embedDocuments(texts: string[], token: CancellationToken): Promise<number[][]> {
		if (texts.length === 0) { return []; }
		const r = await this.compute.embed(texts, false, token);
		if (r.dimension) { this.dimension = r.dimension; }
		return r.vectors;
	}
	async embedQuery(text: string, token: CancellationToken): Promise<number[]> {
		const r = await this.compute.embed([text], true, token);
		if (r.dimension) { this.dimension = r.dimension; }
		return r.vectors[0] ?? [];
	}
}

/**
 * Resolve an embedding provider by auto-detecting available local backends, in priority order:
 *   1. Bundled in-process embedder (default; no install, ships with the app).
 *   2. Explicit user config (locopilot.retrieval.embeddingUrl) - OpenAI-compatible, optional key.
 *   3. Ollama (reuses infra some users already run).
 * Returns undefined when no backend is reachable; the retrieval service then degrades gracefully.
 */
export async function resolveEmbeddingProvider(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	logService: ILogService,
	token: CancellationToken,
	computeService?: IEmbeddingComputeService,
): Promise<IEmbeddingProvider | undefined> {
	const model = cfg(configurationService, 'locopilot.retrieval.embeddingModel', DEFAULT_EMBEDDING_MODEL);

	// 0. Bundled in-process embedder (preferred: zero setup, fully local). Skip only if the user
	// explicitly forced a different backend via config, or if the native runtime/model is missing.
	const forceExternal = !!cfg<string>(configurationService, 'locopilot.retrieval.embeddingUrl', '');
	if (computeService && !forceExternal) {
		try {
			if (await computeService.isAvailable()) {
				const bundledModel = (await computeService.getModelId()) ?? model;
				logService.info(`[LoCoPilot Retrieval] Using bundled in-process embedder (model ${bundledModel}).`);
				return new BundledEmbeddingProvider(bundledModel, computeService);
			}
		} catch (e) {
			logService.trace(`[LoCoPilot Retrieval] Bundled embedder check failed: ${e}`);
		}
	}

	// 1. Explicit OpenAI-compatible endpoint (covers llama.cpp embedding server + cloud opt-in).
	const explicitUrl = cfg<string>(configurationService, 'locopilot.retrieval.embeddingUrl', '');
	if (explicitUrl) {
		const apiKey = cfg<string>(configurationService, 'locopilot.retrieval.embeddingApiKey', '') || undefined;
		logService.info(`[LoCoPilot Retrieval] Using configured embedding endpoint: ${explicitUrl} (model ${model})`);
		return new OpenAICompatEmbeddingProvider(model, explicitUrl, apiKey, requestService, 'openai-compat');
	}

	// 2. Ollama auto-detect.
	const ollamaUrl = cfg<string>(configurationService, 'locopilot.retrieval.ollamaUrl', DEFAULT_OLLAMA_URL);
	try {
		const res = await requestService.request({ type: 'GET', url: `${ollamaUrl}/api/tags` }, token);
		if ((res.res.statusCode ?? 0) < 400) {
			await streamToBuffer(res.stream); // drain
			logService.info(`[LoCoPilot Retrieval] Using Ollama embeddings at ${ollamaUrl} (model ${model}). Pull it with: ollama pull ${model}`);
			return new OllamaEmbeddingProvider(model, ollamaUrl, requestService, logService);
		}
	} catch (e) {
		logService.trace(`[LoCoPilot Retrieval] Ollama not reachable at ${ollamaUrl}: ${e}`);
	}

	logService.info('[LoCoPilot Retrieval] No embedding backend detected. Semantic search disabled; agent will fall back to grep/findFiles.');
	return undefined;
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) { return 0; }
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) { return 0; }
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
