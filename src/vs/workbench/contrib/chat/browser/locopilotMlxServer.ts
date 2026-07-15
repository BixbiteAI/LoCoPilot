/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { join as pathJoin } from '../../../../base/common/path.js';

/** Start from a different default than llama.cpp to reduce accidental port overlap. */
export const LOCOPILOT_MLX_SERVER_PORT = 38462;

/**
 * Relative location of the bundled, self-contained Python runtime (python-build-standalone with
 * mlx-lm pre-installed) inside the installed app. Only shipped in the macOS arm64 package - MLX is
 * Apple Silicon only. Produced by scripts/fetch-mlx-runtime.mjs and packaged in build/gulpfile.vscode.ts.
 */
const BUNDLED_MLX_REL = ['resources', 'mlx', 'darwin-arm64', 'python', 'bin', 'python3'];

/**
 * Full path to the bundled MLX Python interpreter, or undefined when there is no app root (web) or
 * this is not an Apple Silicon Mac. Existence is not checked here - the caller stats it before use.
 * appRootFsPath: IEnvironmentService.appRoot (INativeEnvironmentService).
 */
export function getBundledMlxPython(appRootFsPath: string | undefined): string | undefined {
	if (!appRootFsPath || !isAppleSiliconMac()) {
		return undefined;
	}
	return pathJoin(appRootFsPath, ...BUNDLED_MLX_REL);
}

/**
 * Apple Silicon Mac only. MLX inference is not supported on Intel Mac or other OSes.
 */
export function isAppleSiliconMac(): boolean {
	if (!isMacintosh || isWindows) {
		return false;
	}
	const nodeProcess = (globalThis as { vscode?: { process?: { arch?: string } }; process?: { arch?: string } }).vscode?.process
		?? (typeof (globalThis as { process?: { arch?: string } }).process !== 'undefined' ? (globalThis as { process: { arch?: string } }).process : undefined);
	const arch = nodeProcess?.arch;
	return arch === 'arm64';
}

/**
 * Base URL for mlx_lm.server (OpenAI-compatible /v1).
 */
export function getMlxServerBaseUrl(port: number): string {
	return `http://127.0.0.1:${port}/v1`;
}

/**
 * Optional performance tuning for `mlx_lm.server`. All fields are OFF by default and only emitted when set,
 * because their flags are newer than the base command: an older bundled mlx-lm rejects unknown args
 * (argparse "unrecognized arguments" -> immediate exit), which the runner detects to relaunch without them.
 */
/** Floor for the weight-aware MLX prompt (KV) cache, so a big model still keeps a usable cross-request cache. */
export const MLX_MIN_PROMPT_CACHE_BYTES = 512 * 1024 * 1024; // 0.5 GiB
/**
 * Leftover wired budget (after weights + runtime overhead) below which an MLX launch is treated as a TIGHT
 * fit: the runner then shrinks the prefill chunk and the number of held KV caches to keep the peak Metal
 * command buffer under the ceiling. Above it, the server defaults are kept for full prefill speed.
 */
export const MLX_TIGHT_FIT_HEADROOM_BYTES = 6 * 1024 * 1024 * 1024; // 6 GiB

export interface MlxServerTuning {
	/**
	 * Directory of a small same-family MLX model for speculative decoding (`--draft-model`). The draft
	 * proposes tokens the big model verifies in one pass - same 1.5-2x decode win as llama.cpp's
	 * `--model-draft`. Must be tokenizer-compatible with the main model.
	 */
	draftModelDir?: string;
	/** Tokens to draft per step (`--num-draft-tokens`). Emitted only alongside `draftModelDir`; server default 3. */
	numDraftTokens?: number;
	/**
	 * Byte cap for the server's LRU prompt (KV) cache across requests (`--prompt-cache-bytes`). Unbounded by
	 * default upstream, which on a small-RAM machine lets cached KV from previous prompts crowd out the
	 * working set; sized from total RAM by the runner.
	 */
	promptCacheBytes?: number;
	/**
	 * Cap (bytes) for MLX's total Metal allocation (`mx.set_memory_limit`). MLX's own default is ~95% of
	 * unified RAM - far above the wired working-set ceiling (~70-74%) - so a long prompt on a model near
	 * the limit grows the KV cache straight into swap-thrash territory. mlx_lm.server exposes no CLI flag
	 * for this, so when set, the launch runs through a tiny `python -c` bootstrap that applies the limit
	 * before starting the server (see {@link getMlxLmServerCommand}). Soft cap: MLX waits for outstanding
	 * work when it would exceed it, throttling instead of paging. Sized off the Metal wired budget.
	 */
	memoryLimitBytes?: number;
	/**
	 * Cap (bytes) for MLX's freed-buffer reuse cache (`mx.set_cache_limit`), applied by the same bootstrap.
	 * Defaults to the memory limit upstream (effectively unbounded), which lets buffers freed after a big
	 * prefill sit around holding GBs. A modest slice of RAM keeps the reuse win without hoarding.
	 */
	cacheLimitBytes?: number;
	/**
	 * Max requests decoded in parallel (`--decode-concurrency`, server default 32). Each parallel slot needs
	 * its own KV cache + decode scratch, so the default is a large PEAK-memory multiplier - the top cause of
	 * a Metal command-buffer OOM (kIOGPUCommandBufferCallbackErrorOutOfMemory) on a big model. LoCoPilot is a
	 * single-user client (one request at a time), so 1 removes the multiplier with no real throughput loss.
	 */
	decodeConcurrency?: number;
	/** Max prompts prefilled in parallel (`--prompt-concurrency`, server default 8). Same peak-memory concern; 1 for a single-user client. */
	promptConcurrency?: number;
	/**
	 * Prefill chunk size (`--prefill-step-size`, server default 2048). A big prompt is processed in chunks of
	 * this many tokens; the chunk sizes the peak prefill compute buffer (the allocation that OOMs). A smaller
	 * step trades a little prefill speed for a much smaller peak, which is the right trade on a tight machine.
	 */
	prefillStepSize?: number;
	/** Max distinct KV caches held across requests (`--prompt-cache-size`, server default 10). Fewer = less resident KV for a memory-tight big model. */
	promptCacheCount?: number;
}

/**
 * One-line Python bootstrap that applies MLX memory limits, then hands over to `mlx_lm` exactly as
 * `python -m mlx_lm <args>` would. Invoked as: `python -c BOOTSTRAP <memLimit> <cacheLimit> server ...`.
 * `getattr` fallbacks make renamed/missing APIs a silent no-op (the server still starts) instead of a
 * crash, and the source uses single quotes ONLY so the runner's shell quoting (double quotes around an
 * arg with spaces) never needs escaping. Kept deliberately minimal: it hands off to `runpy` IMMEDIATELY so
 * the server's own startup (and its "Starting httpd" log) begins without any heavy pre-imports in front of
 * it. (An earlier revision monkeypatched `stream_generate` to inject KV quantization here, but importing
 * `mlx_lm.server`/`mlx_lm.generate` up front ran silently for seconds before the server logged anything,
 * which read as a stuck/never-starting launch; it was reverted. mlx_lm.server has no `--kv-bits` CLI flag.)
 */
export const MLX_MEMORY_LIMIT_BOOTSTRAP =
	'import mlx.core as mx, runpy, sys; ' +
	'getattr(mx, \'set_memory_limit\', lambda *_: None)(int(sys.argv[1])); ' +
	'getattr(mx, \'set_cache_limit\', lambda *_: None)(int(sys.argv[2])); ' +
	'sys.argv = [\'mlx_lm\'] + sys.argv[3:]; ' +
	'runpy.run_module(\'mlx_lm\', run_name=\'__main__\')';

/**
 * Command to run `mlx_lm.server` for a local model directory (Hugging Face-style MLX weights).
 * pythonCmd: full path or `python3` / `python` from PATH or a venv interpreter.
 * tuning: optional flags (speculative draft, prompt-cache cap); see {@link MlxServerTuning}.
 */
export function getMlxLmServerCommand(modelDir: string, port: number, pythonCmd: string, tuning: MlxServerTuning = {}): { command: string; args: string[] } {
	const cmd = pythonCmd.trim() || 'python3';
	// Fail fast on a blank model path: building `--model ''` makes mlx_lm.server start with no model, which
	// either errors with a cryptic traceback or hangs serving GET /v1/models while every chat request blocks.
	// The caller is expected to validate the path first; this is a defensive guard at the command boundary.
	const dir = modelDir?.trim();
	if (!dir) {
		throw new Error('Cannot start MLX server: model path is empty. The model may not be downloaded yet or its localPath is unset.');
	}
	if (!(port > 0)) {
		throw new Error(`Cannot start MLX server: invalid port "${port}".`);
	}
	// Server args shared by both launch shapes (everything after the `server` subcommand).
	const serverArgs = ['--model', dir, '--host', '127.0.0.1', '--port', String(port)];
	if (tuning.draftModelDir && tuning.draftModelDir.trim()) {
		serverArgs.push('--draft-model', tuning.draftModelDir.trim());
		if (tuning.numDraftTokens && tuning.numDraftTokens > 0) {
			serverArgs.push('--num-draft-tokens', String(Math.floor(tuning.numDraftTokens)));
		}
	}
	if (tuning.promptCacheBytes && tuning.promptCacheBytes > 0) {
		serverArgs.push('--prompt-cache-bytes', String(Math.floor(tuning.promptCacheBytes)));
	}
	if (tuning.promptCacheCount && tuning.promptCacheCount > 0) {
		serverArgs.push('--prompt-cache-size', String(Math.floor(tuning.promptCacheCount)));
	}
	// Peak-memory guards: cap parallel decode/prefill (a single-user client never batches) and shrink the
	// prefill chunk, so the transient Metal command buffer stays well under the wired ceiling on a big model.
	if (tuning.decodeConcurrency && tuning.decodeConcurrency > 0) {
		serverArgs.push('--decode-concurrency', String(Math.floor(tuning.decodeConcurrency)));
	}
	if (tuning.promptConcurrency && tuning.promptConcurrency > 0) {
		serverArgs.push('--prompt-concurrency', String(Math.floor(tuning.promptConcurrency)));
	}
	if (tuning.prefillStepSize && tuning.prefillStepSize > 0) {
		serverArgs.push('--prefill-step-size', String(Math.floor(tuning.prefillStepSize)));
	}

	// With a memory/cache limit, launch through the bootstrap (mlx_lm.server has no CLI flag for these);
	// otherwise keep the plain `-m mlx_lm server` form, safe for any mlx-lm/mlx version.
	if ((tuning.memoryLimitBytes && tuning.memoryLimitBytes > 0) || (tuning.cacheLimitBytes && tuning.cacheLimitBytes > 0)) {
		const memLimit = tuning.memoryLimitBytes && tuning.memoryLimitBytes > 0 ? Math.floor(tuning.memoryLimitBytes) : 0;
		const cacheLimit = tuning.cacheLimitBytes && tuning.cacheLimitBytes > 0 ? Math.floor(tuning.cacheLimitBytes) : 0;
		// 0 = leave that limit at the MLX default (the bootstrap's set-call with 0 would break allocation,
		// so substitute the other limit's "no-op" by passing the default-preserving sentinel via max()).
		const memArg = memLimit > 0 ? memLimit : Number.MAX_SAFE_INTEGER;
		const cacheArg = cacheLimit > 0 ? cacheLimit : Number.MAX_SAFE_INTEGER;
		return { command: cmd, args: ['-c', MLX_MEMORY_LIMIT_BOOTSTRAP, String(memArg), String(cacheArg), 'server', ...serverArgs] };
	}
	return { command: cmd, args: ['-m', 'mlx_lm', 'server', ...serverArgs] };
}

/**
 * Whether to use mlx-lm HTTP server for this Hugging Face entry (vs llama.cpp + GGUF).
 * hasGguf: a .gguf file is present at localPath (file or under directory).
 */
export function shouldUseMlxServerForHfModel(
	model: { format?: string; modelName: string },
	hasGguf: boolean,
	canRunMlx: boolean
): boolean {
	if (!canRunMlx || hasGguf) {
		return false;
	}
	const fmt = (model.format || '').toLowerCase().trim();
	if (fmt.includes('gguf')) {
		return false;
	}
	if (fmt.includes('mlx')) {
		return true;
	}
	const id = model.modelName.toLowerCase();
	if (id.includes('-mlx') || id.includes('/mlx') || id.endsWith('mlx') || id.includes('mlx-')) {
		return true;
	}
	return false;
}

/**
 * True if the Hugging Face model entry is meant to be MLX (by format or repo name), before runtime checks.
 */
export function hfModelLooksLikeMlx(model: { format?: string; modelName: string }, hasGguf: boolean): boolean {
	if (hasGguf) {
		return false;
	}
	const fmt = (model.format || '').toLowerCase().trim();
	if (fmt.includes('gguf')) {
		return false;
	}
	if (fmt.includes('mlx')) {
		return true;
	}
	const id = model.modelName.toLowerCase();
	if (id.includes('-mlx') || id.includes('/mlx') || id.endsWith('mlx') || id.includes('mlx-')) {
		return true;
	}
	return false;
}
