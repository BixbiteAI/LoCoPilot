/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/**
 * Minimal GGUF header reader. GGUF is the on-disk format llama.cpp uses; its header carries typed
 * metadata key/value pairs, one of which (`<arch>.block_count`) is the model's transformer layer count.
 * We need that number to compute how many layers fit in a given amount of GPU memory for *partial*
 * offload (`--n-gpu-layers N`), instead of the all-or-nothing 0/999 we use without it.
 *
 * We only parse the metadata block (never the multi-GB tensor data) and read the file lazily in small
 * chunks, stopping the moment we find `block_count`. Any parse failure returns `undefined`, so callers
 * simply fall back to full offload.
 *
 * Format reference: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

/** GGUF metadata value type tags. */
const enum GgufType {
	UINT8 = 0,
	INT8 = 1,
	UINT16 = 2,
	INT16 = 3,
	UINT32 = 4,
	INT32 = 5,
	FLOAT32 = 6,
	BOOL = 7,
	STRING = 8,
	ARRAY = 9,
	UINT64 = 10,
	INT64 = 11,
	FLOAT64 = 12,
}

/** Byte size of a fixed-width scalar type, or undefined for variable-length (string/array) types. */
function scalarSize(type: GgufType): number | undefined {
	switch (type) {
		case GgufType.UINT8:
		case GgufType.INT8:
		case GgufType.BOOL:
			return 1;
		case GgufType.UINT16:
		case GgufType.INT16:
			return 2;
		case GgufType.UINT32:
		case GgufType.INT32:
		case GgufType.FLOAT32:
			return 4;
		case GgufType.UINT64:
		case GgufType.INT64:
		case GgufType.FLOAT64:
			return 8;
		default:
			return undefined; // STRING / ARRAY are variable-length
	}
}

/** How many bytes we pull from the file per extend; metadata is usually well under one chunk. */
const CHUNK_BYTES = 256 * 1024;
/**
 * Cap on how far into the file we scan. Reaching the tensor-info section (used for per-layer weight
 * accounting) means skipping past the whole tokenizer vocab, which can be tens of MB - so this is larger
 * than the metadata block alone would need. The cursor trims consumed bytes as it goes, so a large cap
 * bounds how far we SEEK, not how much memory we hold. Any file that needs more than this simply falls
 * back to the coarse (uniform) estimates.
 */
const MAX_HEADER_BYTES = 96 * 1024 * 1024;

/**
 * A forward-only cursor over a GGUF file that reads more bytes on demand and trims already-consumed bytes
 * from the front, so it can scan far into the file (past the tokenizer vocab to the tensor-info section)
 * with a bounded, small in-memory window. All multi-byte values are little-endian per the GGUF spec.
 *
 * `pos` is the cursor's ABSOLUTE byte offset in the file; `bufStart` is the absolute offset of `buf[0]`.
 * The valid buffered range is `[bufStart, bufStart + buf.length)`; readers work at `pos - bufStart`.
 */
class GgufCursor {
	private buf: Uint8Array = new Uint8Array(0);
	private view: DataView = new DataView(this.buf.buffer);
	/** Absolute file offset of the cursor. */
	private pos = 0;
	/** Absolute file offset of `buf[0]`. */
	private bufStart = 0;

	constructor(private readonly fileService: IFileService, private readonly uri: URI) { }

	/** Current cursor offset within `buf`. */
	private get off(): number {
		return this.pos - this.bufStart;
	}

	/** Ensures at least `need` bytes are buffered at the cursor, reading from disk (and trimming) as needed. */
	private async ensure(need: number): Promise<void> {
		if (this.pos >= MAX_HEADER_BYTES) {
			throw new Error('gguf: header exceeds scan limit');
		}
		// A skip may have moved the cursor past the buffered window (e.g. jumping over a large vocab array):
		// reset the window to start at the cursor so the next read seeks straight there instead of buffering
		// everything in between.
		if (this.pos < this.bufStart || this.pos > this.bufStart + this.buf.length) {
			this.buf = new Uint8Array(0);
			this.view = new DataView(this.buf.buffer);
			this.bufStart = this.pos;
		}
		// Trim consumed bytes from the front so sequential scanning keeps memory bounded to ~one chunk.
		if (this.off > CHUNK_BYTES && this.buf.length > 0) {
			this.buf = this.buf.slice(this.off);
			this.view = new DataView(this.buf.buffer);
			this.bufStart = this.pos;
		}
		while (this.off + need > this.buf.length) {
			const readAt = this.bufStart + this.buf.length;
			const content = await this.fileService.readFile(this.uri, { position: readAt, length: CHUNK_BYTES });
			const chunk = content.value.buffer;
			if (chunk.length === 0) {
				throw new Error('gguf: unexpected end of file');
			}
			const merged = new Uint8Array(this.buf.length + chunk.length);
			merged.set(this.buf, 0);
			merged.set(chunk, this.buf.length);
			this.buf = merged;
			this.view = new DataView(this.buf.buffer);
		}
	}

	async u32(): Promise<number> {
		await this.ensure(4);
		const v = this.view.getUint32(this.off, true);
		this.pos += 4;
		return v;
	}

	/** Reads a uint64 as a JS number (safe: layer counts and string lengths are tiny). */
	async u64(): Promise<number> {
		await this.ensure(8);
		const v = this.view.getBigUint64(this.off, true);
		this.pos += 8;
		return Number(v);
	}

	/** Reads a GGUF string (uint64 length prefix + raw UTF-8 bytes). */
	async str(): Promise<string> {
		const len = await this.u64();
		await this.ensure(len);
		const bytes = this.buf.subarray(this.off, this.off + len);
		this.pos += len;
		return new TextDecoder('utf-8').decode(bytes);
	}

	/** Advances the cursor by `n` bytes without materialising them (the next read seeks to the new position). */
	async skip(n: number): Promise<void> {
		// No ensure() here: skipping doesn't need the bytes buffered. Advancing `pos` past the window makes
		// the next ensure() reset/seek, so we never buffer (or trim through) a huge skipped region.
		this.pos += n;
	}

	/** Reads a single scalar value of the given fixed-width type as a number. */
	async scalar(type: GgufType): Promise<number> {
		const size = scalarSize(type);
		if (size === undefined) {
			throw new Error(`gguf: not a scalar type ${type}`);
		}
		await this.ensure(size);
		let v: number;
		switch (type) {
			case GgufType.UINT8: v = this.view.getUint8(this.off); break;
			case GgufType.INT8: v = this.view.getInt8(this.off); break;
			case GgufType.BOOL: v = this.view.getUint8(this.off); break;
			case GgufType.UINT16: v = this.view.getUint16(this.off, true); break;
			case GgufType.INT16: v = this.view.getInt16(this.off, true); break;
			case GgufType.UINT32: v = this.view.getUint32(this.off, true); break;
			case GgufType.INT32: v = this.view.getInt32(this.off, true); break;
			case GgufType.FLOAT32: v = this.view.getFloat32(this.off, true); break;
			case GgufType.UINT64: v = Number(this.view.getBigUint64(this.off, true)); break;
			case GgufType.INT64: v = Number(this.view.getBigInt64(this.off, true)); break;
			case GgufType.FLOAT64: v = this.view.getFloat64(this.off, true); break;
			default: throw new Error(`gguf: not a scalar type ${type}`);
		}
		this.pos += size;
		return v;
	}

	/** Skips over a metadata value of the given type without decoding it (used for keys we don't need). */
	async skipValue(type: GgufType): Promise<void> {
		const size = scalarSize(type);
		if (size !== undefined) {
			await this.skip(size);
			return;
		}
		if (type === GgufType.STRING) {
			const len = await this.u64();
			await this.skip(len);
			return;
		}
		if (type === GgufType.ARRAY) {
			const elemType = await this.u32() as GgufType;
			const count = await this.u64();
			const elemSize = scalarSize(elemType);
			if (elemSize !== undefined) {
				await this.skip(elemSize * count);
				return;
			}
			if (elemType === GgufType.STRING) {
				for (let i = 0; i < count; i++) {
					const len = await this.u64();
					await this.skip(len);
				}
				return;
			}
			throw new Error(`gguf: nested array element type ${elemType} unsupported`);
		}
		throw new Error(`gguf: unknown value type ${type}`);
	}
}

/**
 * Byte cost of a ggml tensor type as `[blockSize, typeSizeBytes]`: a block of `blockSize` weight elements
 * occupies `typeSizeBytes` on disk. Bytes for a tensor = `elementCount / blockSize * typeSizeBytes`.
 * Values track ggml's `type_traits` (block_size / type_size). Types we don't recognise return undefined,
 * which makes the per-layer parse bail to the uniform estimate rather than mis-size a model.
 */
function ggmlTypeBlock(type: number): readonly [number, number] | undefined {
	switch (type) {
		case 0: return [1, 4];       // F32
		case 1: return [1, 2];       // F16
		case 2: return [32, 18];     // Q4_0
		case 3: return [32, 20];     // Q4_1
		case 6: return [32, 22];     // Q5_0
		case 7: return [32, 24];     // Q5_1
		case 8: return [32, 34];     // Q8_0
		case 9: return [32, 36];     // Q8_1
		case 10: return [256, 84];   // Q2_K
		case 11: return [256, 110];  // Q3_K
		case 12: return [256, 144];  // Q4_K
		case 13: return [256, 176];  // Q5_K
		case 14: return [256, 210];  // Q6_K
		case 15: return [256, 292];  // Q8_K
		case 16: return [256, 66];   // IQ2_XXS
		case 17: return [256, 74];   // IQ2_XS
		case 18: return [256, 98];   // IQ3_XXS
		case 19: return [256, 50];   // IQ1_S
		case 20: return [32, 18];    // IQ4_NL
		case 21: return [256, 110];  // IQ3_S
		case 22: return [256, 82];   // IQ2_S
		case 23: return [256, 136];  // IQ4_XS
		case 24: return [1, 1];      // I8
		case 25: return [1, 2];      // I16
		case 26: return [1, 4];      // I32
		case 27: return [1, 8];      // I64
		case 28: return [1, 8];      // F64
		case 29: return [256, 56];   // IQ1_M
		case 30: return [1, 2];      // BF16
		default: return undefined;
	}
}

/** Extracts the transformer block (layer) index from a tensor name like `blk.12.ffn_gate.weight`, or -1. */
function tensorLayerIndex(name: string): number {
	const m = /(?:^|\.)blk\.(\d+)\./.exec(name);
	return m ? Number(m[1]) : -1;
}

/** True for a routed-expert FFN tensor (the bulk of a MoE model's weights): `...ffn_*_exps.*`. */
function isExpertTensorName(name: string): boolean {
	return /ffn_(gate|up|down)_exps/.test(name);
}

/**
 * Reads the transformer block (layer) count from a GGUF model file, or `undefined` if it can't be
 * determined (not a GGUF file, parse error, or the key is absent). The relevant key is
 * `<architecture>.block_count`, e.g. `llama.block_count`, `qwen2.block_count`.
 *
 * Thin wrapper over {@link readGgufModelInfo} kept for existing callers that only need the layer count.
 */
export async function readGgufLayerCount(fileService: IFileService, filePath: string): Promise<number | undefined> {
	return (await readGgufModelInfo(fileService, filePath)).layerCount;
}

/**
 * Architecture-level facts we extract from a GGUF header in a single pass. All fields are optional:
 * any that can't be determined (older header, missing key, parse error) come back `undefined` and the
 * caller falls back to llama.cpp's own defaults.
 */
export interface IGgufModelInfo {
	/** `<arch>.block_count` - transformer layer count, for partial GPU offload (`--n-gpu-layers`). */
	readonly layerCount: number | undefined;
	/**
	 * `<arch>.expert_count` - number of routed experts. Present and > 0 only for Mixture-of-Experts
	 * models (e.g. Qwen3 A3B, Gemma MoE). Drives the decision to offload expert tensors to CPU
	 * (`--n-cpu-moe`), which lets a large MoE model run on a small GPU at near-full speed.
	 */
	readonly expertCount: number | undefined;
	/** `<arch>.context_length` - the model's trained context window, used to cap our `-c` to RAM budget. */
	readonly contextLength: number | undefined;
	/**
	 * `<arch>.attention.head_count_kv` - number of *key/value* attention heads (GQA). Equals the query
	 * head count for MHA models. Drives the KV-cache-per-token estimate (see {@link kvBytesPerTokenPerLayer}).
	 */
	readonly kvHeadCount: number | undefined;
	/** `<arch>.attention.head_count` - number of *query* heads; fallback to derive head dim from embedding. */
	readonly headCount: number | undefined;
	/** `<arch>.embedding_length` - model hidden size; used to derive head dim when key/value lengths absent. */
	readonly embeddingLength: number | undefined;
	/** `<arch>.attention.key_length` - per-head key dimension; preferred head dim for the KV estimate. */
	readonly keyLength: number | undefined;
	/** `<arch>.attention.value_length` - per-head value dimension; preferred head dim for the KV estimate. */
	readonly valueLength: number | undefined;
	/**
	 * `<arch>.attention.sliding_window` - the SWA window size in tokens. Present and > 0 only for models
	 * that use Sliding-Window Attention (Gemma 2/3, some others). For these, llama.cpp keeps only a
	 * window-sized KV cache for the SWA layers by default, which invalidates prompt-cache checkpoints and
	 * forces a full prompt re-process every turn - the `--swa-full` flag trades memory to keep the full KV
	 * and restore cross-turn reuse. See {@link isSwaModelInfo}.
	 */
	readonly slidingWindow: number | undefined;
	/**
	 * Weight bytes of each transformer block, indexed by block number (from the GGUF tensor-info section).
	 * Undefined when the tensor section couldn't be parsed (older reader path, unknown quant type, scan cap).
	 * This is the "per-layer memory accounting" that lets the offload logic size a partial split from each
	 * layer's REAL cost instead of `totalBytes / layerCount` - which matters on models with uneven layers
	 * (e.g. dense-then-MoE stacks like DeepSeek, whose first blocks are far smaller than the MoE blocks).
	 */
	readonly perLayerWeightBytes?: readonly number[];
	/**
	 * The routed-expert (`ffn_*_exps`) portion of each block's weight bytes, indexed by block number. This is
	 * the slice that `--n-cpu-moe` / an `-ot` expert override actually moves to CPU, so the MoE offload planner
	 * sizes the split from these rather than the whole-layer bytes. Undefined alongside {@link perLayerWeightBytes}.
	 */
	readonly perLayerExpertBytes?: readonly number[];
	/**
	 * Weight bytes NOT attached to any transformer block - token embeddings, the output head, final norm.
	 * These stay resident regardless of the layer split, so the offload planner counts them as fixed cost on
	 * the target device. Undefined alongside {@link perLayerWeightBytes}.
	 */
	readonly nonLayerWeightBytes?: number;
}

/**
 * Estimates the KV-cache bytes consumed per token *per transformer layer* at the given bytes-per-element
 * (2 for f16, ~1 for q8_0), from the model's attention geometry. Returns `undefined` when the geometry
 * can't be determined, so the caller keeps its conservative default.
 *
 * KV per token per layer = (kvHeads * keyDim + kvHeads * valueDim) * bytesPerElem. The key/value lengths
 * come straight from GGUF when present; otherwise we derive a square head dim as embedding / headCount.
 */
export function kvBytesPerTokenPerLayer(info: IGgufModelInfo, bytesPerElem: number = 2): number | undefined {
	const kvHeads = info.kvHeadCount && info.kvHeadCount > 0
		? info.kvHeadCount
		: (info.headCount && info.headCount > 0 ? info.headCount : undefined);
	if (!kvHeads) {
		return undefined;
	}
	let keyDim = info.keyLength && info.keyLength > 0 ? info.keyLength : undefined;
	let valueDim = info.valueLength && info.valueLength > 0 ? info.valueLength : undefined;
	if ((!keyDim || !valueDim) && info.embeddingLength && info.headCount && info.headCount > 0) {
		const headDim = Math.floor(info.embeddingLength / info.headCount);
		keyDim = keyDim ?? headDim;
		valueDim = valueDim ?? headDim;
	}
	if (!keyDim || !valueDim) {
		return undefined;
	}
	return (kvHeads * keyDim + kvHeads * valueDim) * bytesPerElem;
}

/** True when the GGUF metadata indicates a Mixture-of-Experts model (has routed experts). */
export function isMoeModelInfo(info: IGgufModelInfo): boolean {
	return (info.expertCount ?? 0) > 0;
}

/**
 * True when the GGUF metadata indicates a Sliding-Window Attention model (Gemma 2/3, etc.). These need
 * `--swa-full` to keep a reusable prompt cache across turns (see {@link IGgufModelInfo.slidingWindow}).
 */
export function isSwaModelInfo(info: IGgufModelInfo): boolean {
	return (info.slidingWindow ?? 0) > 0;
}

/**
 * Single-pass GGUF header read returning {@link IGgufModelInfo}. Stops as soon as all three keys are
 * found (or the metadata block ends). Only the header is read - never the multi-GB tensor data.
 */
export async function readGgufModelInfo(fileService: IFileService, filePath: string, onError?: (e: unknown) => void): Promise<IGgufModelInfo> {
	let layerCount: number | undefined;
	let expertCount: number | undefined;
	let contextLength: number | undefined;
	let kvHeadCount: number | undefined;
	let headCount: number | undefined;
	let embeddingLength: number | undefined;
	let keyLength: number | undefined;
	let valueLength: number | undefined;
	let slidingWindow: number | undefined;
	let perLayerWeightBytes: number[] | undefined;
	let perLayerExpertBytes: number[] | undefined;
	let nonLayerWeightBytes: number | undefined;
	try {
		const uri = URI.file(filePath);
		const cursor = new GgufCursor(fileService, uri);

		const magic = await cursor.u32();
		if (magic !== GGUF_MAGIC) {
			return { layerCount, expertCount, contextLength, kvHeadCount, headCount, embeddingLength, keyLength, valueLength, slidingWindow }; // not a GGUF file
		}
		const version = await cursor.u32();
		if (version < 2) {
			return { layerCount, expertCount, contextLength, kvHeadCount, headCount, embeddingLength, keyLength, valueLength, slidingWindow }; // v1 used uint32 length prefixes; not supported
		}
		const tensorCount = await cursor.u64(); // tensor infos follow the KV block; drive per-layer accounting
		const kvCount = await cursor.u64();

		for (let i = 0; i < kvCount; i++) {
			const key = await cursor.str();
			const valueType = await cursor.u32() as GgufType;
			// We no longer early-exit at the first `tokenizer.` key: reaching the tensor-info section (for
			// per-layer weight accounting) requires consuming every KV pair first, so we skip the tokenizer's
			// (potentially multi-MB) arrays via skipValue rather than breaking out. The cursor trims consumed
			// bytes as it scans, so passing the vocab stays memory-bounded. All arch keys - including the
			// order-late `attention.sliding_window` - are still captured below on the way through.
			// Scalar numeric keys we care about; everything else is skipped without decoding.
			const isScalar = scalarSize(valueType) !== undefined;
			if (isScalar && key.endsWith('.block_count')) {
				const n = await cursor.scalar(valueType);
				layerCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
			} else if (isScalar && key.endsWith('.expert_count')) {
				const n = await cursor.scalar(valueType);
				expertCount = Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
			} else if (isScalar && key.endsWith('.context_length')) {
				const n = await cursor.scalar(valueType);
				contextLength = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
			} else if (isScalar && key.endsWith('.attention.head_count_kv')) {
				const n = await cursor.scalar(valueType);
				kvHeadCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
			} else if (isScalar && key.endsWith('.attention.head_count')) {
				const n = await cursor.scalar(valueType);
				headCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
			} else if (isScalar && key.endsWith('.embedding_length')) {
				const n = await cursor.scalar(valueType);
				embeddingLength = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
			} else if (isScalar && key.endsWith('.attention.key_length')) {
				const n = await cursor.scalar(valueType);
				keyLength = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
			} else if (isScalar && key.endsWith('.attention.value_length')) {
				const n = await cursor.scalar(valueType);
				valueLength = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
			} else if (isScalar && key.endsWith('.attention.sliding_window')) {
				const n = await cursor.scalar(valueType);
				slidingWindow = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
			} else {
				await cursor.skipValue(valueType);
			}
			// No core-key early-out: `attention.sliding_window` (the SWA signal) is emitted AFTER the core sizing
			// keys, so we run through every KV pair. This also leaves the cursor positioned exactly at the
			// tensor-info section, which we parse next for per-layer weight accounting.
		}

		// Per-layer weight accounting from the tensor-info section (immediately after the KV block). Each entry
		// is: name(string), n_dims(u32), dims(n_dims x u64), ggml type(u32), offset(u64). We sum each tensor's
		// on-disk bytes into its transformer block (or the non-layer bucket), so the offload planner can size a
		// partial split from real per-layer costs. Best-effort and self-contained: any unknown quant type or
		// parse hiccup abandons ONLY the per-layer arrays (KV-derived fields above are already set) and leaves
		// the caller on the coarse uniform estimate.
		try {
			if (tensorCount > 0 && tensorCount < 1_000_000) {
				const layerTotals = new Map<number, number>();
				const layerExperts = new Map<number, number>();
				let nonLayer = 0;
				let maxLayer = -1;
				let usable = true;
				for (let t = 0; t < tensorCount; t++) {
					const name = await cursor.str();
					const nDims = await cursor.u32();
					if (nDims > 8) { usable = false; break; } // malformed; bail to uniform
					let elements = 1;
					for (let d = 0; d < nDims; d++) {
						elements *= await cursor.u64();
					}
					const type = await cursor.u32();
					await cursor.u64(); // tensor data offset (unused for sizing)
					const block = ggmlTypeBlock(type);
					if (!block) { usable = false; break; } // unknown quant -> can't size reliably
					const [blockSize, typeSize] = block;
					const bytes = Math.floor(elements / blockSize) * typeSize;
					const layer = tensorLayerIndex(name);
					if (layer >= 0) {
						layerTotals.set(layer, (layerTotals.get(layer) ?? 0) + bytes);
						if (isExpertTensorName(name)) {
							layerExperts.set(layer, (layerExperts.get(layer) ?? 0) + bytes);
						}
						if (layer > maxLayer) { maxLayer = layer; }
					} else {
						nonLayer += bytes;
					}
				}
				if (usable && maxLayer >= 0) {
					const total: number[] = new Array(maxLayer + 1).fill(0);
					const experts: number[] = new Array(maxLayer + 1).fill(0);
					for (const [layer, bytes] of layerTotals) { total[layer] = bytes; }
					for (const [layer, bytes] of layerExperts) { experts[layer] = bytes; }
					perLayerWeightBytes = total;
					perLayerExpertBytes = experts;
					nonLayerWeightBytes = nonLayer;
				}
			}
		} catch {
			// leave the per-layer fields undefined; the coarse estimate covers this model.
		}
	} catch (e) {
		// any failure -> return whatever we gathered (callers treat undefined as "use defaults").
		// Surface it to the optional hook so a silently-truncated parse (e.g. a key we can't skip landing
		// before attention.sliding_window, which then misses SWA detection) is diagnosable instead of hidden.
		onError?.(e);
	}
	return { layerCount, expertCount, contextLength, kvHeadCount, headCount, embeddingLength, keyLength, valueLength, slidingWindow, perLayerWeightBytes, perLayerExpertBytes, nonLayerWeightBytes };
}
