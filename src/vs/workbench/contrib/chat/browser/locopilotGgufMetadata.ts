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
/** Safety cap so a malformed/huge header (e.g. a giant tokenizer vocab) can't make us read forever. */
const MAX_HEADER_BYTES = 32 * 1024 * 1024;

/**
 * A forward-only cursor over a GGUF file that reads more bytes on demand. All multi-byte values are
 * little-endian per the GGUF spec.
 */
class GgufCursor {
	private buf: Uint8Array = new Uint8Array(0);
	private view: DataView = new DataView(this.buf.buffer);
	private pos = 0;
	private fileBytesRead = 0;

	constructor(private readonly fileService: IFileService, private readonly uri: URI) { }

	/** Ensures at least `need` more bytes are available past the cursor, reading from disk if necessary. */
	private async ensure(need: number): Promise<void> {
		while (this.pos + need > this.buf.length) {
			if (this.fileBytesRead >= MAX_HEADER_BYTES) {
				throw new Error('gguf: header exceeds scan limit');
			}
			const content = await this.fileService.readFile(this.uri, { position: this.fileBytesRead, length: CHUNK_BYTES });
			const chunk = content.value.buffer;
			if (chunk.length === 0) {
				throw new Error('gguf: unexpected end of file');
			}
			const merged = new Uint8Array(this.buf.length + chunk.length);
			merged.set(this.buf, 0);
			merged.set(chunk, this.buf.length);
			this.buf = merged;
			this.view = new DataView(this.buf.buffer);
			this.fileBytesRead += chunk.length;
		}
	}

	async u32(): Promise<number> {
		await this.ensure(4);
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}

	/** Reads a uint64 as a JS number (safe: layer counts and string lengths are tiny). */
	async u64(): Promise<number> {
		await this.ensure(8);
		const v = this.view.getBigUint64(this.pos, true);
		this.pos += 8;
		return Number(v);
	}

	/** Reads a GGUF string (uint64 length prefix + raw UTF-8 bytes). */
	async str(): Promise<string> {
		const len = await this.u64();
		await this.ensure(len);
		const bytes = this.buf.subarray(this.pos, this.pos + len);
		this.pos += len;
		return new TextDecoder('utf-8').decode(bytes);
	}

	/** Advances the cursor by `n` bytes (pulling them in first), without materialising them. */
	async skip(n: number): Promise<void> {
		await this.ensure(n);
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
			case GgufType.UINT8: v = this.view.getUint8(this.pos); break;
			case GgufType.INT8: v = this.view.getInt8(this.pos); break;
			case GgufType.BOOL: v = this.view.getUint8(this.pos); break;
			case GgufType.UINT16: v = this.view.getUint16(this.pos, true); break;
			case GgufType.INT16: v = this.view.getInt16(this.pos, true); break;
			case GgufType.UINT32: v = this.view.getUint32(this.pos, true); break;
			case GgufType.INT32: v = this.view.getInt32(this.pos, true); break;
			case GgufType.FLOAT32: v = this.view.getFloat32(this.pos, true); break;
			case GgufType.UINT64: v = Number(this.view.getBigUint64(this.pos, true)); break;
			case GgufType.INT64: v = Number(this.view.getBigInt64(this.pos, true)); break;
			case GgufType.FLOAT64: v = this.view.getFloat64(this.pos, true); break;
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
 * Reads the transformer block (layer) count from a GGUF model file, or `undefined` if it can't be
 * determined (not a GGUF file, parse error, or the key is absent). The relevant key is
 * `<architecture>.block_count`, e.g. `llama.block_count`, `qwen2.block_count`.
 */
export async function readGgufLayerCount(fileService: IFileService, filePath: string): Promise<number | undefined> {
	try {
		const uri = URI.file(filePath);
		const cursor = new GgufCursor(fileService, uri);

		const magic = await cursor.u32();
		if (magic !== GGUF_MAGIC) {
			return undefined; // not a GGUF file
		}
		const version = await cursor.u32();
		if (version < 2) {
			return undefined; // v1 used uint32 length prefixes; not worth supporting
		}
		await cursor.u64(); // tensor_count (unused)
		const kvCount = await cursor.u64();

		for (let i = 0; i < kvCount; i++) {
			const key = await cursor.str();
			const valueType = await cursor.u32() as GgufType;
			if (key.endsWith('.block_count')) {
				// Layer counts are stored as UINT32 in practice, but accept any scalar for robustness.
				if (scalarSize(valueType) !== undefined) {
					const n = await cursor.scalar(valueType);
					return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
				}
				return undefined;
			}
			await cursor.skipValue(valueType);
		}
		return undefined; // key not present
	} catch {
		return undefined; // any failure -> caller falls back to full offload
	}
}
