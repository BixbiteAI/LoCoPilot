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
import { mkdir, stat, lstat, rm, readdir, copyFile, chmod, mkdtemp, readlink, symlink, unlink, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

// Pin the llama.cpp release build. Bump this (and re-run) to update the bundled engine.
// Use a real tag from https://github.com/ggml-org/llama.cpp/releases (e.g. "b6651"), or "latest".
/**
 * SINGLE SOURCE OF TRUTH for the bundled engine version. Bump this one constant to move every platform at
 * once, then rebuild.
 *
 * Why a constant rather than a pin repeated in each caller: the six release workflows and the two mac build
 * scripts each invoke this script SEPARATELY, and `chosenTag` only unifies targets within one invocation. So
 * with `'latest'`, jobs that run hours apart resolve different tags and one release ships mismatched engines
 * across platforms - darwin-arm64 on one build, win32-x64 on another. A pinned tag makes a release state a
 * verifiable fact ("1.4.6 ships llama.cpp b10350") instead of "whatever was newest when CI happened to run".
 *
 * `'latest'` is fine for local experimentation. Pin a real tag for anything you ship.
 * Verify a candidate tag contains the commit you need before pinning it, e.g. for muse-glimmer support:
 *   curl -sS "https://api.github.com/repos/ggml-org/llama.cpp/compare/62bf73d...<tag>" | grep '"status"'
 * A `status` of "ahead" or "identical" means the tag contains it; "behind" means it does not.
 */
const DEFAULT_LLAMA_BUILD = 'latest';

// Env override wins, so CI can pass a tag (or a repo variable) without editing this file.
const LLAMA_BUILD = process.env.LLAMA_BUILD?.trim() || DEFAULT_LLAMA_BUILD;
const REPO = 'ggml-org/llama.cpp';

/** Set LLAMA_FORCE=1 to re-fetch even when the stamped tag already matches (e.g. a corrupt install). */
const LLAMA_FORCE = /^(1|true|yes)$/i.test(process.env.LLAMA_FORCE || '');

/**
 * Records the release tag installed in resources/bin/<target>/, so a later run can tell "already correct"
 * apart from "already something". Without it, existence alone gated the fetch and a persistent working tree
 * could never be upgraded to a newer engine.
 */
const STAMP_FILE = '.llama-build';

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

/** Reads the installed tag, or undefined when the stamp is missing (a pre-stamp install) or unreadable. */
async function readStamp(p) {
	try {
		const tag = (await readFile(p, 'utf8')).trim();
		return tag.length > 0 ? tag : undefined;
	} catch {
		return undefined;
	}
}

async function fetchJson(url) {
	const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'locopilot-build' };
	// Authenticate GitHub API calls when a token is available (e.g. GITHUB_TOKEN in
	// CI). Unauthenticated requests are rate-limited to 60/hour per IP, which shared
	// CI runner IPs blow through quickly and get HTTP 403. A token raises this to
	// 5000/hour. Purely optional; omitted locally, where the rate limit is fine.
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (token) { headers['Authorization'] = `Bearer ${token}`; }
	const res = await fetch(url, { headers });
	if (!res.ok) { throw new Error(`HTTP ${res.status} for ${url}`); }
	return res.json();
}

function isReleaseArchive(name) {
	return name.endsWith('.zip') || name.endsWith('.tar.gz');
}

function findAsset(release, assetMatch) {
	return (release.assets || []).find(a => a.name.includes(assetMatch) && isReleaseArchive(a.name));
}

// How many recent releases to consider when LLAMA_BUILD is "latest" (see resolveAssetUrl).
const RELEASE_SCAN_COUNT = 20;

let releaseListCache;  // recent releases, newest first
let chosenTag;         // tag an earlier target resolved to, so one run ships one llama.cpp build

async function recentReleases() {
	if (!releaseListCache) {
		const list = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=${RELEASE_SCAN_COUNT}`);
		releaseListCache = list.filter(r => !r.draft);
	}
	return releaseListCache;
}

// Resolves the download URL for one platform asset.
//
// llama.cpp publishes a release tag BEFORE its CI has finished uploading the per-platform
// archives, and an upload job sometimes fails outright - e.g. b10297 sits at the tip with
// only cudart-llama-bin-win-cuda-12.4-x64.zip while every neighbouring release has 25
// assets. Resolving "latest" to a single release therefore fails the build for reasons that
// have nothing to do with our code. So for "latest" we scan back through recent releases and
// take the newest one that actually carries the asset this target needs. An explicit
// LLAMA_BUILD tag is still honoured exactly, with no fallback - a pin should stay pinned.
async function resolveAssetUrl(assetMatch) {
	if (LLAMA_BUILD !== 'latest') {
		const release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/tags/${LLAMA_BUILD}`);
		const match = findAsset(release, assetMatch);
		if (!match) {
			const names = (release.assets || []).map(a => a.name).join('\n  ');
			throw new Error(`No asset matching "${assetMatch}" in release ${release.tag_name}. Available:\n  ${names}`);
		}
		return { url: match.browser_download_url, name: match.name, tag: release.tag_name };
	}

	const releases = await recentReleases();
	if (!releases.length) { throw new Error(`No releases found for ${REPO}`); }

	// Prefer the tag an earlier target already settled on, so the CPU and Vulkan engines in one
	// run come from the same llama.cpp build, then fall back to newest-first.
	const preferred = chosenTag && releases.find(r => r.tag_name === chosenTag);
	const ordered = preferred ? [preferred, ...releases.filter(r => r !== preferred)] : releases;

	for (const release of ordered) {
		const match = findAsset(release, assetMatch);
		if (!match) { continue; }
		if (release.tag_name !== releases[0].tag_name) {
			process.stdout.write(`  note: release ${releases[0].tag_name} has no "${assetMatch}" asset yet, using ${release.tag_name}\n`);
		}
		chosenTag = release.tag_name;
		return { url: match.browser_download_url, name: match.name, tag: release.tag_name };
	}

	const scanned = releases.map(r => r.tag_name).join(', ');
	throw new Error(`No asset matching "${assetMatch}" in the last ${releases.length} releases of ${REPO} (${scanned}). Set LLAMA_BUILD to a tag that has it.`);
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
	const stampPath = join(outDir, STAMP_FILE);

	// A present binary is only reusable when it is the build we were ASKED for. The previous check tested
	// existence alone, which made "skip" mean "already something" rather than "already correct": on a
	// persistent working tree (the local mac build scripts - CI runners start clean, so they never saw this)
	// the first fetch pinned the engine forever, and no later tag could ever ship. That is how a build can
	// keep bundling an engine that predates a model's architecture support no matter how often you rebuild.
	if (await exists(existingBin)) {
		const stamped = await readStamp(stampPath);
		if (LLAMA_FORCE) {
			process.stdout.write(`llama-server present for ${target} (tag ${stamped ?? 'unknown'}) but LLAMA_FORCE is set; re-fetching.\n`);
		} else if (LLAMA_BUILD === 'latest') {
			// "latest" is a moving target, so an existing build can never be proven current without asking
			// the API. Resolve it and compare; identical tag means genuinely nothing to do.
			const { tag: latestTag } = await resolveAssetUrl(spec.asset);
			if (stamped === latestTag) {
				process.stdout.write(`llama-server for ${target} is already the latest release (${latestTag}), skipping.\n`);
				return;
			}
			process.stdout.write(`llama-server for ${target} is ${stamped ?? 'an unstamped older build'}; latest is ${latestTag}, re-fetching.\n`);
		} else if (stamped === LLAMA_BUILD) {
			process.stdout.write(`llama-server for ${target} is already ${LLAMA_BUILD}, skipping.\n`);
			return;
		} else {
			process.stdout.write(`llama-server for ${target} is ${stamped ?? 'unstamped'}, want ${LLAMA_BUILD}; re-fetching.\n`);
		}
		// Clear the old install so a shrinking asset can't leave stale libs behind next to the new binary.
		await rm(outDir, { recursive: true, force: true });
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
		// Record WHICH build this is. Written only after the copy is verified, so a failed fetch never leaves
		// a stamp claiming a build that isn't there - an unstamped dir re-fetches, which is the safe default.
		await writeFile(stampPath, `${tag}\n`, 'utf8');
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
