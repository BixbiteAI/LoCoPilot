/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Downloads the bundled embedding model (bge-small-en-v1.5, quantized ONNX + vocab) used by
// LoCoPilot's local semantic code search, into resources/embeddings/<MODEL_ID>/.
// Run once before packaging:  node scripts/fetch-embedding-model.mjs
//
// The model is MIT-licensed (BAAI/bge-small-en-v1.5); ONNX export via Xenova/bge-small-en-v1.5.

import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL_ID = 'bge-small-en-v1.5';
const REPO = 'Xenova/bge-small-en-v1.5';
const FILES = [
	{ remote: `onnx/model_quantized.onnx`, local: 'model.onnx' },
	{ remote: `vocab.txt`, local: 'vocab.txt' },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'resources', 'embeddings', MODEL_ID);

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function download(remote, dest) {
	const url = `https://huggingface.co/${REPO}/resolve/main/${remote}?download=true`;
	process.stdout.write(`  ${remote} -> ${dest}\n`);
	const res = await fetch(url);
	if (!res.ok) { throw new Error(`HTTP ${res.status} for ${url}`); }
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
	await mkdir(outDir, { recursive: true });
	for (const f of FILES) {
		const dest = join(outDir, f.local);
		if (await exists(dest)) { process.stdout.write(`  ${f.local} already present, skipping\n`); continue; }
		await download(f.remote, dest);
	}
	process.stdout.write(`\nEmbedding model ready in ${outDir}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
