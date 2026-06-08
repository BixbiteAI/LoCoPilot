/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Downloads the prebuilt llama.cpp `llama-server` binary (plus the shared libraries it needs) from
// the official ggml-org/llama.cpp GitHub releases, into resources/bin/<platform>-<arch>/.
//
// LoCoPilot bundles this so users can run local GGUF models with ZERO setup: no separate llama.cpp
// install, and no "server path" to configure. The gulp package step ships only the binary that
// matches the build's platform/arch (see build/gulpfile.vscode.ts), and the runner resolves it from
// <appRoot>/resources/bin/<platform>-<arch>/ at runtime (locopilotLlamaCppServer.ts).
//
// Run once per target before packaging (mirrors scripts/fetch-embedding-model.mjs):
//   node scripts/fetch-llama-binaries.mjs                 # current OS/arch
//   node scripts/fetch-llama-binaries.mjs darwin-arm64    # explicit target
//   LLAMA_BUILD=b6651 node scripts/fetch-llama-binaries.mjs win32-x64
//
// The binaries are NOT committed to git (see .gitignore: resources/bin/). They are MIT-licensed
// (ggml-org/llama.cpp). Re-run after bumping LLAMA_BUILD to update the bundled engine.

import { createWriteStream } from 'node:fs';
import { mkdir, stat, rm, readdir, copyFile, chmod, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

// Pin the llama.cpp release build. Bump this (and re-run) to update the bundled engine.
// Use a real tag from https://github.com/ggml-org/llama.cpp/releases (e.g. "b6651"), or "latest".
const LLAMA_BUILD = process.env.LLAMA_BUILD || 'latest';
const REPO = 'ggml-org/llama.cpp';

// Asset selection per <platform>-<arch>. `asset` is matched as a substring against the release's
// asset names so it survives the embedded build number (e.g. "llama-b6651-bin-macos-arm64.zip").
// Default backend choices: Metal (mac), CPU on Windows/Linux (most compatible; GPU offload still
// works via Vulkan/CUDA when the user has it - but a CPU build always runs). Override per your needs.
const TARGETS = {
	'darwin-arm64': { asset: 'bin-macos-arm64', bin: 'llama-server' },
	'darwin-x64': { asset: 'bin-macos-x64', bin: 'llama-server' },
	'win32-x64': { asset: 'bin-win-cpu-x64', bin: 'llama-server.exe' },
	'win32-arm64': { asset: 'bin-win-cpu-arm64', bin: 'llama-server.exe' },
	'linux-x64': { asset: 'bin-ubuntu-x64', bin: 'llama-server' },
	// Linux arm64 has no official prebuilt asset at time of writing; build it yourself and drop the
	// binary + libs into resources/bin/linux-arm64/ manually, or add a tag below once available.
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function currentTarget() {
	const plat = process.platform; // 'darwin' | 'win32' | 'linux'
	const arch = process.arch;     // 'arm64' | 'x64'
	return `${plat}-${arch}`;
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function fetchJson(url) {
	const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'locopilot-build' } });
	if (!res.ok) { throw new Error(`HTTP ${res.status} for ${url}`); }
	return res.json();
}

async function resolveAssetUrl(assetMatch) {
	const relUrl = LLAMA_BUILD === 'latest'
		? `https://api.github.com/repos/${REPO}/releases/latest`
		: `https://api.github.com/repos/${REPO}/releases/tags/${LLAMA_BUILD}`;
	const release = await fetchJson(relUrl);
	const assets = release.assets || [];
	const match = assets.find(a => a.name.includes(assetMatch) && a.name.endsWith('.zip'));
	if (!match) {
		const names = assets.map(a => a.name).join('\n  ');
		throw new Error(`No asset matching "${assetMatch}" in release ${release.tag_name}. Available:\n  ${names}`);
	}
	return { url: match.browser_download_url, name: match.name, tag: release.tag_name };
}

async function download(url, dest) {
	const res = await fetch(url, { headers: { 'User-Agent': 'locopilot-build' }, redirect: 'follow' });
	if (!res.ok) { throw new Error(`HTTP ${res.status} for ${url}`); }
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function extract(zipPath, destDir) {
	if (process.platform === 'win32') {
		const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`], { stdio: 'inherit' });
		if (r.status !== 0) { throw new Error('Expand-Archive failed'); }
	} else {
		const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'inherit' });
		if (r.status !== 0) { throw new Error('unzip failed (is `unzip` installed?)'); }
	}
}

// Recursively find the directory that contains the server binary (release layouts vary: flat, or build/bin/).
async function findBinDir(rootDir, binName) {
	const entries = await readdir(rootDir, { withFileTypes: true });
	if (entries.some(e => e.isFile() && e.name === binName)) { return rootDir; }
	for (const e of entries) {
		if (e.isDirectory()) {
			const found = await findBinDir(join(rootDir, e.name), binName);
			if (found) { return found; }
		}
	}
	return undefined;
}

async function copyDirFlat(srcDir, destDir) {
	// Copy the binary and the runtime libraries that sit alongside it (*.dylib/.so/.dll), flattening
	// into resources/bin/<target>/ so the loader finds them next to llama-server.
	const entries = await readdir(srcDir, { withFileTypes: true });
	for (const e of entries) {
		if (!e.isFile()) { continue; }
		const lower = e.name.toLowerCase();
		const isLib = lower.endsWith('.dylib') || lower.endsWith('.so') || lower.includes('.so.') || lower.endsWith('.dll');
		const isBin = e.name === 'llama-server' || e.name === 'llama-server.exe';
		if (!isLib && !isBin) { continue; }
		const dest = join(destDir, e.name);
		await copyFile(join(srcDir, e.name), dest);
		if (isBin && process.platform !== 'win32') { await chmod(dest, 0o755); }
		if (isBin) { process.stdout.write(`  binary: ${e.name}\n`); }
	}
}

async function main() {
	const target = process.argv[2] || currentTarget();
	const spec = TARGETS[target];
	if (!spec) {
		throw new Error(`No llama.cpp asset mapping for target "${target}". Known targets:\n  ${Object.keys(TARGETS).join('\n  ')}`);
	}

	const outDir = join(root, 'resources', 'bin', target);
	const existingBin = join(outDir, spec.bin);
	if (await exists(existingBin)) {
		process.stdout.write(`llama-server already present for ${target} (${existingBin}), skipping.\n`);
		process.stdout.write(`Delete resources/bin/${target}/ to re-fetch.\n`);
		return;
	}

	process.stdout.write(`Fetching llama.cpp ${LLAMA_BUILD} for ${target} ...\n`);
	const { url, name, tag } = await resolveAssetUrl(spec.asset);
	process.stdout.write(`  release ${tag}: ${name}\n`);

	const work = await mkdtemp(join(tmpdir(), 'locopilot-llama-'));
	try {
		const zipPath = join(work, name);
		await download(url, zipPath);
		const extractDir = join(work, 'unzipped');
		await mkdir(extractDir, { recursive: true });
		extract(zipPath, extractDir);

		const binDir = await findBinDir(extractDir, spec.bin);
		if (!binDir) { throw new Error(`Could not find ${spec.bin} inside ${name}`); }

		await mkdir(outDir, { recursive: true });
		await copyDirFlat(binDir, outDir);

		if (!(await exists(existingBin))) {
			throw new Error(`Copy did not produce ${existingBin}`);
		}
		process.stdout.write(`\nllama.cpp ready for ${target} in resources/bin/${target}/ (tag ${tag})\n`);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

main().catch(err => { console.error(err); process.exit(1); });
