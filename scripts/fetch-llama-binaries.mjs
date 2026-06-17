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
import { mkdir, stat, lstat, rm, readdir, copyFile, chmod, mkdtemp, readlink, symlink, unlink } from 'node:fs/promises';
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
// asset names so it survives the embedded build number (e.g. "llama-b9624-bin-macos-x64.tar.gz").
// Default backend choices: Metal (mac), CPU on Windows/Linux (most compatible; a CPU build always runs).
// On Windows/Linux we ALSO fetch an optional Vulkan (GPU) build into resources/bin/<target>-vulkan/; the
// runner uses it automatically when it detects a capable GPU and falls back to the CPU build otherwise.
const TARGETS = {
	'darwin-arm64': { asset: 'bin-macos-arm64', bin: 'llama-server' },
	'darwin-x64': { asset: 'bin-macos-x64', bin: 'llama-server' },
	'win32-x64': { asset: 'bin-win-cpu-x64', bin: 'llama-server.exe' },
	'win32-arm64': { asset: 'bin-win-cpu-arm64', bin: 'llama-server.exe' },
	'linux-x64': { asset: 'bin-ubuntu-x64', bin: 'llama-server' },
	// Linux arm64 has no official prebuilt asset at time of writing; build it yourself and drop the
	// binary + libs into resources/bin/linux-arm64/ manually, or add a tag below once available.

	// Optional GPU (Vulkan) builds, fetched into resources/bin/<platform>-<arch>-vulkan/. Vulkan is the
	// universal GPU backend (NVIDIA/AMD/Intel) and is self-contained (needs only the user's GPU driver -
	// no CUDA runtime DLLs to bundle). The runner picks the Vulkan binary at runtime when it detects a
	// capable GPU, and falls back to the CPU build otherwise. macOS uses Metal (the CPU/base build), so
	// there is no Vulkan variant there.
	'win32-x64-vulkan': { asset: 'bin-win-vulkan-x64', bin: 'llama-server.exe' },
	'linux-x64-vulkan': { asset: 'bin-ubuntu-vulkan-x64', bin: 'llama-server' },
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

function isReleaseArchive(name) {
	return name.endsWith('.zip') || name.endsWith('.tar.gz');
}

async function resolveAssetUrl(assetMatch) {
	const relUrl = LLAMA_BUILD === 'latest'
		? `https://api.github.com/repos/${REPO}/releases/latest`
		: `https://api.github.com/repos/${REPO}/releases/tags/${LLAMA_BUILD}`;
	const release = await fetchJson(relUrl);
	const assets = release.assets || [];
	const match = assets.find(a => a.name.includes(assetMatch) && isReleaseArchive(a.name));
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

function extract(archivePath, destDir) {
	const lower = archivePath.toLowerCase();
	if (lower.endsWith('.tar.gz')) {
		const r = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
		if (r.status !== 0) { throw new Error('tar failed (is `tar` installed?)'); }
	} else if (process.platform === 'win32') {
		const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`], { stdio: 'inherit' });
		if (r.status !== 0) { throw new Error('Expand-Archive failed'); }
	} else {
		const r = spawnSync('unzip', ['-o', '-q', archivePath, '-d', destDir], { stdio: 'inherit' });
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

function looksLikeRuntimeFile(name) {
	const lower = name.toLowerCase();
	return lower.endsWith('.dylib') || lower.endsWith('.so') || lower.includes('.so.') || lower.endsWith('.dll');
}

async function copyDirFlat(srcDir, destDir) {
	// Copy the binary and the runtime libraries that sit alongside it (*.dylib/.so/.dll), flattening
	// into resources/bin/<target>/ so the loader finds them next to llama-server.
	//
	// CRITICAL: the macOS/Linux tarballs ship VERSIONED libs plus the major-version SYMLINKS the
	// loader actually links against (e.g. libllama.0.dylib -> libllama.0.0.9623.dylib; the binary's
	// LC_LOAD_DYLIB references @rpath/libllama.0.dylib). If we drop those symlinks the dynamic linker
	// fails with "Library not loaded: @rpath/libllama.0.dylib" and llama-server exits instantly - it
	// never binds the port, so LoCoPilot polls /health forever (ERR_CONNECTION_REFUSED). So we must
	// preserve symlinks, not skip them. We copy real files first, then recreate the links.
	const entries = await readdir(srcDir, { withFileTypes: true });
	const symlinks = [];
	for (const e of entries) {
		const isBin = e.name === 'llama-server' || e.name === 'llama-server.exe';
		const isLib = looksLikeRuntimeFile(e.name);
		if (!isLib && !isBin) { continue; }

		// Symlinks (the major-version aliases) are recreated after the real files are in place.
		if (e.isSymbolicLink()) {
			symlinks.push(e.name);
			continue;
		}
		if (!e.isFile()) { continue; }

		const dest = join(destDir, e.name);
		await copyFile(join(srcDir, e.name), dest);
		if (isBin && process.platform !== 'win32') { await chmod(dest, 0o755); }
		if (isBin) { process.stdout.write(`  binary: ${e.name}\n`); }
	}

	// Recreate the version-alias symlinks (relative, so they stay valid wherever the folder ships).
	for (const name of symlinks) {
		const linkTarget = await readlink(join(srcDir, name));
		const dest = join(destDir, name);
		try { await unlink(dest); } catch { /* not there yet */ }
		await symlink(linkTarget, dest);
		process.stdout.write(`  symlink: ${name} -> ${linkTarget}\n`);
	}
}

// Fetches and installs a single target (e.g. "win32-x64" or "win32-x64-vulkan") into resources/bin/<target>/.
async function fetchTarget(target) {
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
		const archivePath = join(work, name);
		await download(url, archivePath);
		const extractDir = join(work, 'extracted');
		await mkdir(extractDir, { recursive: true });
		extract(archivePath, extractDir);

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

async function main() {
	const target = process.argv[2] || currentTarget();
	await fetchTarget(target);

	// When fetching a base target that has an optional GPU (Vulkan) variant, fetch that too so the
	// packaged app can offload to a GPU with zero setup. Best-effort: a missing/renamed Vulkan asset
	// must not fail the (required) base build. Skip when the caller already asked for a "-vulkan" target.
	if (!target.endsWith('-vulkan') && TARGETS[`${target}-vulkan`]) {
		try {
			await fetchTarget(`${target}-vulkan`);
		} catch (err) {
			process.stdout.write(`\n[warning] Optional Vulkan engine for ${target} was not fetched: ${err.message}\n`);
			process.stdout.write(`The app will still ship the CPU engine. Re-run with LLAMA_BUILD set to a tag that has the Vulkan asset to retry.\n`);
		}
	}
}

main().catch(err => { console.error(err); process.exit(1); });
