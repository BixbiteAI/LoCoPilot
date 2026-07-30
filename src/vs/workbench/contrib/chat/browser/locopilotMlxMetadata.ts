/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import type { IGgufModelInfo } from './locopilotGgufMetadata.js';

/**
 * Reads an MLX model directory's attention geometry from its Hugging Face `config.json`, in the SAME shape the
 * GGUF header reader produces.
 *
 * MLX weights ship as safetensors plus a `config.json` rather than a self-describing GGUF header, so before
 * this the MLX launch path had no geometry at all and fell back to a flat 128 KiB-per-token KV guess - which is
 * off by several-fold in both directions (a modern GQA 4B is nearer 24 KiB/token; a large MHA model far more).
 * Returning the same interface lets MLX reuse the entire llama.cpp planner - the context clamp, the pre-flight
 * fit gate and the resident-cost estimator - instead of maintaining a second, cruder set of estimates.
 *
 * Every field is optional in practice: a config that omits a key simply leaves that field undefined and the
 * callers keep their conservative defaults. Never throws - an unreadable/absent config returns empty info.
 */
export async function readMlxModelInfo(fileService: IFileService, modelDirPath: string, onError?: (e: unknown) => void): Promise<IGgufModelInfo> {
	const empty: IGgufModelInfo = {
		layerCount: undefined, expertCount: undefined, contextLength: undefined, kvHeadCount: undefined,
		headCount: undefined, embeddingLength: undefined, keyLength: undefined, valueLength: undefined,
		slidingWindow: undefined,
	};
	try {
		const configUri = joinPath(URI.file(modelDirPath), 'config.json');
		if (!(await fileService.exists(configUri))) {
			return empty;
		}
		const content = await fileService.readFile(configUri);
		const raw = JSON.parse(bufferToString(content.value));
		// Multimodal checkpoints (Gemma 3/4, Qwen-VL, ...) nest the language model's geometry; the top level then
		// only carries vision + wiring keys. Prefer the nested block whenever it is the one holding the layers.
		const cfg = pickTextConfig(raw);
		const headCount = num(cfg.num_attention_heads);
		const embeddingLength = num(cfg.hidden_size);
		// head_dim is explicit on newer configs (and is NOT always hidden_size / heads - Gemma 3 and Llama 3.2
		// both ship a head_dim that contradicts the derived value, which would misprice the KV cache).
		const headDim = num(cfg.head_dim)
			?? (embeddingLength && headCount ? Math.floor(embeddingLength / headCount) : undefined);
		return {
			layerCount: num(cfg.num_hidden_layers) ?? num(cfg.n_layers) ?? num(cfg.num_layers),
			// MoE configs disagree on the key; any of them being > 1 means routed experts.
			expertCount: num(cfg.num_local_experts) ?? num(cfg.num_experts) ?? num(cfg.n_routed_experts) ?? num(cfg.moe_num_experts),
			contextLength: num(cfg.max_position_embeddings) ?? num(cfg.max_sequence_length),
			// Absent num_key_value_heads means MHA, where the KV head count equals the query head count.
			kvHeadCount: num(cfg.num_key_value_heads) ?? headCount,
			headCount,
			embeddingLength,
			keyLength: num(cfg.head_dim) ?? headDim,
			valueLength: num(cfg.v_head_dim) ?? num(cfg.head_dim) ?? headDim,
			// `sliding_window` is only a real SWA window when the config doesn't also disable it outright
			// (some configs carry the key with sliding-window attention switched off for every layer).
			slidingWindow: cfg.use_sliding_window === false ? undefined : num(cfg.sliding_window),
		};
	} catch (e) {
		onError?.(e);
		return empty;
	}
}

/**
 * The block of a HF config holding the LANGUAGE model's geometry. Multimodal configs nest it under
 * `text_config` (or `llm_config`); plain text models keep it at the top level. Chosen by which block actually
 * declares transformer layers, so a config that nests only vision settings is left alone.
 */
function pickTextConfig(raw: Record<string, unknown> | undefined): Record<string, unknown> {
	for (const key of ['text_config', 'llm_config', 'language_config']) {
		const nested = raw?.[key] as Record<string, unknown> | undefined;
		if (nested && typeof nested === 'object' && num(nested.num_hidden_layers)) {
			return nested;
		}
	}
	return raw ?? {};
}

/** A finite positive number from a JSON field, else undefined (configs use null/strings inconsistently). */
function num(value: unknown): number | undefined {
	const n = typeof value === 'string' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

function bufferToString(buffer: VSBuffer): string {
	return buffer.toString();
}
