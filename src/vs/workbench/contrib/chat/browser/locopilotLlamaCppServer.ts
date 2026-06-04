/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { join as pathJoin } from '../../../../base/common/path.js';

export type LlamaBackend = 'cuda' | 'metal' | 'vulkan' | 'cpu';

/** Binary name for llama.cpp server on non-Windows. */
const LLAMA_SERVER_BIN = 'llama-server';
/** Binary name for llama.cpp server on Windows. */
const LLAMA_SERVER_BIN_WIN = 'llama-server.exe';

/** Subpath under user home for conventional llama.cpp build (build/bin or build/bin/llama-server). */
const LLAMA_CPP_REL_BIN = ['llama.cpp', 'build', 'bin'];

/** Priority order for backends: first available is used. */
const BACKEND_PRIORITY: LlamaBackend[] = ['cuda', 'metal', 'vulkan', 'cpu'];

/**
 * Returns conventional paths to try for the llama-server binary (when user has not set a path).
 * First entry: full path to binary. Second entry: directory containing the binary.
 * Uses userHomeFsPath (e.g. from pathService.userHome() then .fsPath).
 */
export function getDefaultLlamaServerPaths(userHomeFsPath: string): string[] {
	const binName = isWindows ? LLAMA_SERVER_BIN_WIN : LLAMA_SERVER_BIN;
	const dirPath = pathJoin(userHomeFsPath, ...LLAMA_CPP_REL_BIN);
	const binaryPath = pathJoin(dirPath, binName);

	const paths = [binaryPath, dirPath];

	if (isMacintosh) {
		paths.push('/opt/homebrew/bin/' + binName); // Apple Silicon Homebrew
		paths.push('/usr/local/bin/' + binName);    // Intel Mac Homebrew
		paths.push('/opt/local/bin/' + binName);    // MacPorts
	} else if (!isWindows) {
		paths.push('/usr/local/bin/' + binName);    // Linux common
		paths.push('/usr/bin/' + binName);          // Linux system
	}

	return paths;
}

/**
 * Detects the best available backend for running GGUF models.
 * Order: GPU (CUDA) > Apple Metal > Vulkan > CPU.
 * In renderer we use heuristics (e.g. macOS => Metal); for full detection a native/main process would be needed.
 */
export function detectLlamaBackend(): LlamaBackend[] {
	const order: LlamaBackend[] = [];
	if (isMacintosh) {
		// Apple Silicon or Intel Mac: Metal is the preferred GPU backend
		order.push('metal');
	}
	// CUDA is typical on Linux/Windows with NVIDIA GPU (we cannot detect from renderer; user may have it)
	order.push('cuda');
	order.push('vulkan');
	order.push('cpu');
	// Dedupe and preserve priority
	return BACKEND_PRIORITY.filter(b => order.includes(b));
}

/**
 * Returns the recommended backend to try first (best performance).
 */
export function getRecommendedBackend(): LlamaBackend {
	const ordered = detectLlamaBackend();
	return ordered[0] ?? 'cpu';
}

/**
 * Resolves the llama-server command from an optional configured path.
 * serverPath: empty = use binary from PATH; otherwise full path to binary or directory containing it.
 * Works on Mac, Windows, and Linux regardless of where llama.cpp is installed.
 */
export function resolveLlamaServerCommand(serverPath: string | undefined): string {
	const raw = (serverPath ?? '').trim();
	if (!raw) {
		return isWindows ? LLAMA_SERVER_BIN_WIN : LLAMA_SERVER_BIN;
	}
	const binName = isWindows ? LLAMA_SERVER_BIN_WIN : LLAMA_SERVER_BIN;
	if (raw.endsWith(binName) || raw.endsWith(LLAMA_SERVER_BIN)) {
		return raw;
	}
	return pathJoin(raw, binName);
}

export type FlashAttentionMode = 'auto' | 'on' | 'off';
export type KvCacheType = 'f16' | 'q8_0' | 'q4_0';

/** Default context window when none is configured. Smaller than before for a smaller, faster KV cache. */
export const DEFAULT_LLAMA_CONTEXT_SIZE = 16384;

/**
 * Performance tuning options for the llama.cpp server.
 * All optional; every value is chosen so that an unsupported system falls back gracefully
 * (llama.cpp warns and continues) rather than failing to start.
 */
export interface LlamaServerTuning {
	/** Context window (`-c`). Defaults to DEFAULT_LLAMA_CONTEXT_SIZE. */
	contextSize?: number;
	/** Flash Attention mode (`-fa`). 'auto' enables where supported and falls back otherwise. */
	flashAttention?: FlashAttentionMode;
	/** KV cache quantization (`--cache-type-k/v`). 'f16' = no quantization (always safe). */
	kvCacheType?: KvCacheType;
	/**
	 * Multi-Token Prediction / NextN speculative decoding. Only valid for MTP-trained models on a
	 * recent llama.cpp build (~b9180+). When on, points `--model-draft` at the same GGUF (the MTP
	 * head is embedded) and appends `mtpArgs`. Off by default; the exact flags are build-specific.
	 */
	multiTokenPrediction?: boolean;
	/** Flags appended after `--model-draft` when MTP is on. Build-specific; defaults to `--spec-type nextn`. */
	mtpArgs?: string;
	/** Lock weights in RAM (`--mlock`). Can fail without privileges/RAM, so opt-in. */
	mlock?: boolean;
	/** GPU layers override; when unset, GPU backends offload all layers (999) and CPU uses 0. */
	gpuLayers?: number;
	/**
	 * Min chunk size to reuse from the KV cache via shifting (`--cache-reuse`). Lets repeated prompt
	 * prefixes (e.g. the system prompt in agent loops) skip reprocessing. Defaults to 256; 0 disables.
	 */
	cacheReuse?: number;
	/** CPU threads for generation (`--threads`). Emitted only when > 0; otherwise llama.cpp auto-detects. */
	threads?: number;
	/** Logical batch size (`--batch-size`). Emitted only when > 0; default build value is 2048. */
	batchSize?: number;
	/** Physical batch size (`--ubatch-size`). Emitted only when > 0; default build value is 512. */
	ubatchSize?: number;
	/** Extra raw args appended verbatim (power users / build-specific flags). */
	extraArgs?: string;
}

/**
 * Builds the llama.cpp server command and args for the given model path and backend.
 * serverPath: optional path from settings (locopilot.llamaCpp.serverPath). Empty = use binary from PATH.
 * tuning: optional performance settings; all have safe, self-falling-back defaults.
 * User can install via: https://github.com/ggerganov/llama.cpp or pip install llama-cpp-python (server).
 */
export function getLlamaCppServerCommand(modelPath: string, backend: LlamaBackend, serverPath?: string, port: number = LOCOPILOT_LLAMA_SERVER_PORT, tuning: LlamaServerTuning = {}): { command: string; args: string[] } {
	const contextSize = tuning.contextSize && tuning.contextSize > 0 ? Math.floor(tuning.contextSize) : DEFAULT_LLAMA_CONTEXT_SIZE;
	const kvCacheType: KvCacheType = tuning.kvCacheType ?? 'f16';

	// V-cache quantization requires Flash Attention. If the user quantizes the KV cache but disabled FA,
	// promote 'off' -> 'auto' so the server never errors out on an unsupported combination.
	let flashAttention: FlashAttentionMode = tuning.flashAttention ?? 'auto';
	if (kvCacheType !== 'f16' && flashAttention === 'off') {
		flashAttention = 'auto';
	}

	const args: string[] = [
		'-m', modelPath,
		'-c', String(contextSize),
		'--host', '127.0.0.1',
		'--port', port.toString(),
		// Flash Attention: 'auto' enables it where supported and falls back to standard attention otherwise.
		'-fa', flashAttention,
	];

	// GPU offload: CPU backend forces 0; GPU backends offload everything (or an explicit override).
	const gpuLayers = backend === 'cpu' ? 0 : (tuning.gpuLayers !== undefined ? tuning.gpuLayers : 999);
	args.push('--n-gpu-layers', String(gpuLayers));

	// KV cache quantization shrinks the cache (more context on-GPU, faster). f16 = default (no flag needed).
	if (kvCacheType !== 'f16') {
		args.push('--cache-type-k', kvCacheType, '--cache-type-v', kvCacheType);
	}

	// Multi-Token Prediction / NextN speculative decoding. OPT-IN and default off: only models trained
	// with MTP/NextN heads (e.g. Qwen3.5/3.6, DeepSeek V3/R1, Gemma 4) on a recent llama.cpp build
	// (~b9180+) support this. The draft head is embedded in the same GGUF, so --model-draft points at
	// the same file. The spec-type flag name is build-specific, so it is configurable via mtpArgs.
	if (tuning.multiTokenPrediction) {
		args.push('--model-draft', modelPath);
		const mtpArgs = (tuning.mtpArgs && tuning.mtpArgs.trim()) ? tuning.mtpArgs.trim() : '--spec-type draft-mtp';
		args.push(...mtpArgs.split(/\s+/));
	}

	// Reuse cached KV for matching prompt prefixes (via KV shifting). Big win for agent loops that
	// resend the same system prompt every turn. Default 256; set to 0 to disable.
	const cacheReuse = tuning.cacheReuse !== undefined ? tuning.cacheReuse : 256;
	if (cacheReuse > 0) {
		args.push('--cache-reuse', String(Math.floor(cacheReuse)));
	}

	// Optional CPU/batch tuning. Emit only when set; the build's auto/default values are otherwise good.
	if (tuning.threads && tuning.threads > 0) {
		args.push('--threads', String(Math.floor(tuning.threads)));
	}
	if (tuning.batchSize && tuning.batchSize > 0) {
		args.push('--batch-size', String(Math.floor(tuning.batchSize)));
	}
	if (tuning.ubatchSize && tuning.ubatchSize > 0) {
		args.push('--ubatch-size', String(Math.floor(tuning.ubatchSize)));
	}

	// Lock weights into RAM to avoid paging. Opt-in because it can fail without privileges or enough memory.
	if (tuning.mlock) {
		args.push('--mlock');
	}

	// Power-user escape hatch: append any extra build-specific flags verbatim.
	if (tuning.extraArgs && tuning.extraArgs.trim()) {
		args.push(...tuning.extraArgs.trim().split(/\s+/));
	}

	const command = resolveLlamaServerCommand(serverPath);
	return { command, args };
}

/**
 * Default port for the local llama server (OpenAI-compatible endpoint).
 */
export const LOCOPILOT_LLAMA_SERVER_PORT = 38452;

export function getLlamaServerBaseUrl(port: number = LOCOPILOT_LLAMA_SERVER_PORT): string {
	return `http://127.0.0.1:${port}/v1`;
}

/** Health endpoint for readiness polling (llama-server exposes GET /health). */
export function getLlamaServerHealthUrl(port: number = LOCOPILOT_LLAMA_SERVER_PORT): string {
	return `http://127.0.0.1:${port}/health`;
}
