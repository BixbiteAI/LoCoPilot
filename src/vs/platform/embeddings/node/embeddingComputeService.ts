/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-import-patterns */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { promises as fs } from 'fs';
import * as path from 'path';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { ILogService } from '../../log/common/log.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { IEmbeddingComputeService, IEmbeddingResult } from '../common/embeddingCompute.js';
import { WordPieceTokenizer } from './wordpieceTokenizer.js';

/**
 * Default bundled model. bge-small-en-v1.5: MIT, 384-dim, ~30MB quantized, strong code+text
 * retrieval, BERT WordPiece tokenizer. Shipped under resources/embeddings/<MODEL_ID>/.
 */
const MODEL_ID = 'bge-small-en-v1.5';
/** bge recommends a query instruction for retrieval; documents get no prefix. */
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

interface IOrtLike {
	InferenceSession: { create(p: string, opts?: any): Promise<IOrtSession> };
	Tensor: new (type: string, data: any, dims: number[]) => any;
}
interface IOrtSession {
	inputNames: string[];
	outputNames: string[];
	run(feeds: Record<string, any>): Promise<Record<string, { data: Float32Array | any; dims: number[] }>>;
}

export class EmbeddingComputeService implements IEmbeddingComputeService {
	declare readonly _serviceBrand: undefined;

	private _ort: IOrtLike | undefined;
	private _session: IOrtSession | undefined;
	private _tokenizer: WordPieceTokenizer | undefined;
	private _dimension = 0;
	private _initPromise: Promise<boolean> | undefined;
	private _failed = false;

	constructor(
		@ILogService private readonly logService: ILogService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	) { }

	private _modelDir(): string {
		// Shipped in the installer under <appRoot>/resources/embeddings/<MODEL_ID>/.
		return path.join(this.environmentService.appRoot, 'resources', 'embeddings', MODEL_ID);
	}

	private async _ensureInit(): Promise<boolean> {
		if (this._failed) { return false; }
		if (this._session && this._tokenizer) { return true; }
		if (!this._initPromise) { this._initPromise = this._init(); }
		return this._initPromise;
	}

	private async _init(): Promise<boolean> {
		try {
			const dir = this._modelDir();
			const modelPath = path.join(dir, 'model.onnx');
			const vocabPath = path.join(dir, 'vocab.txt');

			// Verify assets exist before loading the native runtime.
			await fs.access(modelPath);
			const vocabText = await fs.readFile(vocabPath, 'utf8');
			this._tokenizer = new WordPieceTokenizer(vocabText);

			// Lazy-load the native runtime; absence must not crash the process.
			// @ts-ignore optional native dependency, resolved at runtime in the packaged app
			this._ort = await import('onnxruntime-node') as unknown as IOrtLike;
			this._session = await this._ort.InferenceSession.create(modelPath, { graphOptimizationLevel: 'all' });

			this.logService.info(`[LoCoPilot Embeddings] Bundled embedder ready: ${MODEL_ID} (inputs: ${this._session.inputNames.join(',')})`);
			return true;
		} catch (e) {
			this._failed = true;
			this.logService.info(`[LoCoPilot Embeddings] Bundled embedder unavailable (${e instanceof Error ? e.message : e}). Falling back to other backends.`);
			return false;
		}
	}

	async isAvailable(): Promise<boolean> {
		return this._ensureInit();
	}

	async getModelId(): Promise<string | undefined> {
		return (await this._ensureInit()) ? MODEL_ID : undefined;
	}

	async embed(texts: string[], isQuery: boolean, token: CancellationToken): Promise<IEmbeddingResult> {
		if (!texts.length) { return { vectors: [], dimension: this._dimension, model: MODEL_ID }; }
		if (!(await this._ensureInit()) || !this._session || !this._ort || !this._tokenizer) {
			return { vectors: [], dimension: 0, model: MODEL_ID };
		}

		const prepared = isQuery ? texts.map(t => QUERY_INSTRUCTION + t) : texts;
		const { inputIds, attentionMask, maxLen } = this._tokenizer.encodeBatch(prepared);
		const batch = inputIds.length;

		const flatIds = BigInt64Array.from(inputIds.flat().map(n => BigInt(n)));
		const flatMask = BigInt64Array.from(attentionMask.flat().map(n => BigInt(n)));
		const dims = [batch, maxLen];

		const feeds: Record<string, any> = {};
		const Tensor = this._ort.Tensor;
		if (this._session.inputNames.includes('input_ids')) { feeds['input_ids'] = new Tensor('int64', flatIds, dims); }
		if (this._session.inputNames.includes('attention_mask')) { feeds['attention_mask'] = new Tensor('int64', flatMask, dims); }
		if (this._session.inputNames.includes('token_type_ids')) {
			feeds['token_type_ids'] = new Tensor('int64', new BigInt64Array(batch * maxLen).fill(0n), dims);
		}

		if (token.isCancellationRequested) { return { vectors: [], dimension: 0, model: MODEL_ID }; }

		const results = await this._session.run(feeds);

		// Prefer a direct sentence embedding output if the model provides one; else CLS-pool.
		const vectors = this._extractVectors(results, batch, maxLen);
		if (vectors.length && vectors[0]?.length) { this._dimension = vectors[0].length; }
		return { vectors, dimension: this._dimension, model: MODEL_ID };
	}

	private _extractVectors(results: Record<string, { data: any; dims: number[] }>, batch: number, seqLen: number): number[][] {
		const direct = results['sentence_embedding'] ?? results['pooler_output'];
		if (direct && direct.dims.length === 2) {
			const dim = direct.dims[1];
			const data = direct.data as Float32Array;
			const out: number[][] = [];
			for (let b = 0; b < batch; b++) { out.push(l2normalize(Array.from(data.slice(b * dim, (b + 1) * dim)))); }
			return out;
		}
		// last_hidden_state: [batch, seq, hidden] -> take CLS token (index 0) per bge convention.
		const hidden = results['last_hidden_state'] ?? results['token_embeddings'] ?? Object.values(results)[0];
		if (!hidden) { return []; }
		const dimH = hidden.dims[2];
		const data = hidden.data as Float32Array;
		const out: number[][] = [];
		for (let b = 0; b < batch; b++) {
			const base = b * seqLen * dimH; // CLS at seq position 0
			out.push(l2normalize(Array.from(data.slice(base, base + dimH))));
		}
		return out;
	}
}

function l2normalize(v: number[]): number[] {
	let norm = 0;
	for (const x of v) { norm += x * x; }
	norm = Math.sqrt(norm);
	if (norm === 0) { return v; }
	return v.map(x => x / norm);
}
