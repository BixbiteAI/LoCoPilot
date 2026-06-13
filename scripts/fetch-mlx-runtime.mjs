/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds a self-contained Python runtime with `mlx-lm` pre-installed, into
// resources/mlx/darwin-arm64/python/. LoCoPilot bundles this (macOS Apple Silicon ONLY) so users can
// run local MLX (Hugging Face) models with ZERO setup: no system Python, no `pip install mlx-lm`, and
// no "Python for MLX" path to configure.
//
// MLX is Apple-Silicon only, so this script refuses to run anywhere except darwin/arm64. The gulp
// package step bundles resources/mlx/darwin-arm64/ only in the darwin-arm64 build
// (build/gulpfile.vscode.ts); the runner invokes <appRoot>/resources/mlx/darwin-arm64/python/bin/python3
// (locopilotMlxServer.ts -> getBundledMlxPython).
//
// Run once before packaging the macOS arm64 build (mirrors scripts/fetch-llama-binaries.mjs):
//   node scripts/fetch-mlx-runtime.mjs
//
// The runtime is NOT committed to git (see .gitignore: resources/mlx/). python-build-standalone is
// PSF/BSD-licensed; mlx-lm is MIT (Apple).

import { createWriteStream } from 'node:fs';
import { mkdir, stat, rm, mkdtemp, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

// Pin the python-build-standalone release and CPython version. Bump (and re-run) to update.
// Tags/assets: https://github.com/astral-sh/python-build-standalone/releases
const PBS_TAG = process.env.PBS_TAG || '20250612';
const PY_VERSION = process.env.PY_VERSION || '3.12.11';
// `install_only` is a relocatable, stripped runtime (no build artifacts) - ideal for bundling.
const PBS_ASSET = `cpython-${PY_VERSION}+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz`;
const PBS_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_ASSET}`;

// Package(s) to pre-install into the bundled runtime.
const PIP_PACKAGES = ['mlx-lm'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'resources', 'mlx', 'darwin-arm64');
const pythonDir = join(outDir, 'python');
const pythonBin = join(pythonDir, 'bin', 'python3');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function download(url, dest) {
	process.stdout.write(`  download: ${url}\n`);
	const res = await fetch(url, { headers: { 'User-Agent': 'locopilot-build' }, redirect: 'follow' });
	if (!res.ok) { throw new Error(`HTTP ${res.status} for ${url}`); }
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function run(cmd, args, cwd) {
	const r = spawnSync(cmd, args, { stdio: 'inherit', cwd });
	if (r.status !== 0) { throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`); }
}

async function main() {
	if (process.platform !== 'darwin' || process.arch !== 'arm64') {
		process.stdout.write(`Skipping MLX runtime fetch: MLX is macOS Apple Silicon only (current: ${process.platform}/${process.arch}).\n`);
		process.stdout.write(`Intel Mac (darwin-x64) builds use llama.cpp only - no action needed.\n`);
		return;
	}

	if (await exists(pythonBin)) {
		process.stdout.write(`MLX runtime already present (${pythonBin}), skipping.\n`);
		process.stdout.write(`Delete resources/mlx/darwin-arm64/ to rebuild.\n`);
		return;
	}

	process.stdout.write(`Building MLX runtime (CPython ${PY_VERSION}, python-build-standalone ${PBS_TAG}) ...\n`);
	const work = await mkdtemp(join(tmpdir(), 'locopilot-mlx-'));
	try {
		const tarPath = join(work, PBS_ASSET);
		await download(PBS_URL, tarPath);

		const extractDir = join(work, 'unpacked');
		await mkdir(extractDir, { recursive: true });
		run('tar', ['-xzf', tarPath, '-C', extractDir]);

		// python-build-standalone extracts to a top-level `python/` directory.
		const top = (await readdir(extractDir)).find(n => n === 'python') ?? (await readdir(extractDir))[0];
		const extractedPython = join(extractDir, top);

		await mkdir(outDir, { recursive: true });
		await rm(pythonDir, { recursive: true, force: true });
		await rename(extractedPython, pythonDir);

		if (!(await exists(pythonBin))) {
			throw new Error(`Expected interpreter not found at ${pythonBin}`);
		}

		process.stdout.write(`  pip install ${PIP_PACKAGES.join(' ')} ...\n`);
		run(pythonBin, ['-m', 'pip', 'install', '--upgrade', 'pip']);
		run(pythonBin, ['-m', 'pip', 'install', ...PIP_PACKAGES]);

		// Sanity check: import mlx_lm so a broken install fails the build, not the user's first run.
		run(pythonBin, ['-c', 'import mlx_lm; print("mlx-lm", getattr(mlx_lm, "__version__", "ok"))']);

		process.stdout.write(`\nMLX runtime ready in resources/mlx/darwin-arm64/python/ (CPython ${PY_VERSION} + ${PIP_PACKAGES.join(', ')})\n`);
		process.stdout.write(`NOTE: sign + notarize this runtime with the app on macOS (hardened runtime) or Gatekeeper will block it.\n`);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

main().catch(err => { console.error(err); process.exit(1); });
