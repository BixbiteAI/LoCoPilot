/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IEmbeddingComputeService = createDecorator<IEmbeddingComputeService>('locopilotEmbeddingCompute');

export interface IEmbeddingResult {
	/** One vector per input text (empty array entry if an input failed). */
	vectors: number[][];
	/** Vector dimensionality (e.g. 384 for bge-small). */
	dimension: number;
	/** Model id that produced the vectors (recorded in the index manifest). */
	model: string;
}

/**
 * Computes text embeddings entirely on the user's machine using a bundled ONNX model
 * (onnxruntime-node) - no external server, no user install, identical behaviour whether the
 * chat model is local or cloud. Runs in the shared (utility) process so heavy inference never
 * blocks the UI or the main process. Proxied to the renderer over IPC.
 *
 * If the native runtime or the bundled model is unavailable, isAvailable() returns false and the
 * retrieval layer falls back to other backends (Ollama / configured endpoint) or disables
 * semantic search gracefully.
 */
export interface IEmbeddingComputeService {
	readonly _serviceBrand: undefined;

	/** Whether the bundled embedder is ready (native runtime loaded + model present). */
	isAvailable(): Promise<boolean>;

	/** The embedding model id, or undefined if unavailable. */
	getModelId(): Promise<string | undefined>;

	/**
	 * Embed a batch of texts.
	 * @param isQuery when true, applies the model's query convention (e.g. bge query instruction);
	 *   when false, embeds as documents/passages.
	 */
	embed(texts: string[], isQuery: boolean, token: CancellationToken): Promise<IEmbeddingResult>;
}
