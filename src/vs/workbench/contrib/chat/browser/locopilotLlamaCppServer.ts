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

/**
 * Returns the node-style `<platform>-<arch>` key for the bundled binary directory
 * (e.g. 'darwin-arm64', 'win32-x64', 'linux-x64'). Matches resources/bin/<key>/ produced by
 * scripts/fetch-llama-binaries.mjs and selected per-build in build/gulpfile.vscode.ts.
 */
function getBundledPlatformArch(): string {
	const plat = isWindows ? 'win32' : (isMacintosh ? 'darwin' : 'linux');
	const nodeProcess = (globalThis as { vscode?: { process?: { arch?: string } }; process?: { arch?: string } }).vscode?.process
		?? (typeof (globalThis as { process?: { arch?: string } }).process !== 'undefined' ? (globalThis as { process: { arch?: string } }).process : undefined);
	const arch = nodeProcess?.arch ?? 'x64';
	return `${plat}-${arch}`;
}

/**
 * Which bundled engine variant to resolve:
 *  - 'cpu'    : the always-present, most-compatible CPU build (resources/bin/<platform>-<arch>/).
 *  - 'vulkan' : the optional GPU build (resources/bin/<platform>-<arch>-vulkan/), shipped on
 *               Windows/Linux so machines with a capable GPU can offload without any user setup.
 */
export type BundledEngineVariant = 'cpu' | 'vulkan';

/**
 * Full path to a bundled llama-server binary inside the installed app, or undefined when there is
 * no app root (e.g. web). Existence is not checked here - the caller stats it before use.
 * appRootFsPath: IEnvironmentService.appRoot. The 'vulkan' variant lives in a sibling `-vulkan` dir
 * and is only present when the build fetched/packaged it (see scripts/fetch-llama-binaries.mjs).
 */
export function getBundledLlamaServerPath(appRootFsPath: string | undefined, variant: BundledEngineVariant = 'cpu'): string | undefined {
	if (!appRootFsPath) {
		return undefined;
	}
	const binName = isWindows ? LLAMA_SERVER_BIN_WIN : LLAMA_SERVER_BIN;
	const dirName = variant === 'vulkan' ? `${getBundledPlatformArch()}-vulkan` : getBundledPlatformArch();
	return pathJoin(appRootFsPath, 'resources', 'bin', dirName, binName);
}

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
 * Detects the backends to try for running GGUF models, best first.
 *
 * We cannot probe the GPU from the renderer, so this is driven by what the *binary* in use can
 * actually support, not by what hardware might be present:
 *   - Apple Silicon: the bundled macOS arm64 binary is a Metal build -> Metal.
 *   - Non-Mac with a user-provided build (`hasCustomServer`): that build may be compiled with
 *     CUDA/Vulkan, so it is safe to attempt GPU offload -> CUDA, Vulkan, then CPU.
 *   - Everything else (Intel Mac, and the bundled Windows/Linux binaries, which are CPU-only):
 *     CPU. Forcing `--n-gpu-layers` onto a CPU-only binary breaks startup, so we must not claim a
 *     GPU backend here.
 *
 * @param hasCustomServer true when `locopilot.llamaCpp.serverPath` points at the user's own build.
 */
export function detectLlamaBackend(hasCustomServer = false): LlamaBackend[] {
	const order: LlamaBackend[] = [];
	const isAppleSilicon = isMacintosh && getBundledPlatformArch() === 'darwin-arm64';

	if (isAppleSilicon) {
		// Bundled macOS arm64 binary is a Metal build.
		order.push('metal');
	} else if (hasCustomServer && !isMacintosh) {
		// Non-Mac custom build may be compiled with CUDA/Vulkan; only then is GPU offload safe to try.
		order.push('cuda', 'vulkan');
	}
	// CPU is always the safe fallback and the default for Intel Macs and bundled Windows/Linux binaries.
	order.push('cpu');

	// Keep BACKEND_PRIORITY order; its entries are unique, so this also dedupes.
	return BACKEND_PRIORITY.filter(b => order.includes(b));
}

/**
 * Returns the recommended backend to try first (best performance).
 * @param hasCustomServer true when the user configured their own llama.cpp build path.
 */
export function getRecommendedBackend(hasCustomServer = false): LlamaBackend {
	const ordered = detectLlamaBackend(hasCustomServer);
	return ordered[0] ?? 'cpu';
}

/** VRAM (bytes) at/above which an integrated/unknown GPU is considered worth using over the CPU. */
export const VULKAN_MIN_DEDICATED_VRAM_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB

/** Minimal GPU shape needed to decide the bundled engine variant (subset of IGpuInfo). */
export interface GpuLike {
	vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';
	totalVramBytes: number;
}

/**
 * Decides whether the machine's GPU is capable enough to prefer the bundled **Vulkan** engine over the
 * CPU build (Windows/Linux only - Apple Silicon uses Metal and never reaches this path).
 *
 * The intent is "discrete/decent GPU -> Vulkan, weak integrated GPU -> CPU":
 *  - NVIDIA or AMD -> yes. These are discrete cards (or capable AMD APUs); Vulkan offload clearly wins.
 *  - Intel/unknown -> only when we measured a meaningful dedicated VRAM pool
 *    ({@link VULKAN_MIN_DEDICATED_VRAM_BYTES}+), which weak integrated GPUs don't have. This keeps slow
 *    iGPUs (where Vulkan can be *slower* than CPU) on the CPU build.
 *  - Apple GPUs are ignored here (handled by the Metal path).
 */
export function shouldUseBundledVulkan(gpus: readonly GpuLike[]): boolean {
	return gpus.some(g => {
		if (g.vendor === 'nvidia' || g.vendor === 'amd') {
			return true;
		}
		if (g.vendor === 'intel' || g.vendor === 'unknown') {
			return g.totalVramBytes >= VULKAN_MIN_DEDICATED_VRAM_BYTES;
		}
		return false; // apple -> Metal path, not Vulkan
	});
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
/**
 * KV cache precision. 'auto' lets us pick based on the context window: full-precision f16 for small
 * windows (where the cache is cheap and quality matters most) and 8-bit q8_0 for large windows (where
 * the cache dominates memory and q8_0's quality loss is negligible). f16/q8_0/q4_0 force a fixed type.
 */
export type KvCacheType = 'auto' | 'f16' | 'q8_0' | 'q4_0';

/** Default context window when none is configured. Smaller than before for a smaller, faster KV cache. */
export const DEFAULT_LLAMA_CONTEXT_SIZE = 16384;

/**
 * Context window at/above which 'auto' KV cache switches from f16 to q8_0. Below this the cache is small
 * enough that full precision is the better trade; at/above it the cache dominates memory, so halving it
 * with q8_0 (negligible quality impact) frees room for weights/compute and fits more context on-device.
 */
export const KV_AUTO_QUANT_CONTEXT_THRESHOLD = 32768;

/**
 * Resolves the concrete KV cache type to use. 'auto' chooses q8_0 once the context window reaches
 * {@link KV_AUTO_QUANT_CONTEXT_THRESHOLD}, else f16. A fixed type is returned unchanged.
 */
export function resolveKvCacheType(kvCacheType: KvCacheType, contextSize: number): Exclude<KvCacheType, 'auto'> {
	if (kvCacheType !== 'auto') {
		return kvCacheType;
	}
	return contextSize >= KV_AUTO_QUANT_CONTEXT_THRESHOLD ? 'q8_0' : 'f16';
}

/** Inputs for {@link clampContextSize}; all optional except the requested size. */
export interface ContextClampInputs {
	/** Context the caller wants (from per-model setting or the global default). */
	requestedContext: number;
	/** The model's trained context window from GGUF (`<arch>.context_length`); we never exceed it. */
	modelContextLength?: number;
	/** Bytes of memory the KV cache may use (a slice of the free RAM/VRAM budget). */
	kvBudgetBytes?: number;
	/** Transformer block count, used to size the KV cache. */
	layerCount?: number;
	/**
	 * Bytes per token *per layer* for the KV cache at f16 (k+v). Caller should pass a value derived from the
	 * model's attention geometry (see `kvBytesPerTokenPerLayer` in locopilotGgufMetadata). Defaults to a
	 * conservative 4096 (a typical GQA model: 8 kv-heads x 128 dim x 2 [k+v] x 2 bytes) so an unknown model
	 * still gets clamped rather than over-allocating - erring toward a smaller, safe window.
	 */
	kvBytesPerTokenPerLayer?: number;
}

/** Smallest context we will ever clamp down to, so a tiny budget can't make the model unusable. */
export const MIN_CLAMPED_CONTEXT = 4096;

/**
 * Clamps the requested context window to (a) the model's trained maximum and (b) what the KV-cache memory
 * budget can hold, rounded down to a multiple of 1024 and floored at {@link MIN_CLAMPED_CONTEXT}. Returns
 * the requested size unchanged when no constraint applies or inputs are missing. This stops a long-context
 * model from allocating a huge KV cache and OOM-ing / paging on a low-memory machine.
 */
export function clampContextSize(inputs: ContextClampInputs): number {
	let ctx = Math.floor(inputs.requestedContext > 0 ? inputs.requestedContext : DEFAULT_LLAMA_CONTEXT_SIZE);
	if (inputs.modelContextLength && inputs.modelContextLength > 0) {
		ctx = Math.min(ctx, inputs.modelContextLength);
	}
	if (inputs.kvBudgetBytes && inputs.kvBudgetBytes > 0 && inputs.layerCount && inputs.layerCount > 0) {
		const perTokenPerLayer = inputs.kvBytesPerTokenPerLayer && inputs.kvBytesPerTokenPerLayer > 0
			? inputs.kvBytesPerTokenPerLayer
			: 4096; // f16 k+v for a typical GQA model (8 kv-heads x 128 dim x 2); conservative when unknown.
		const maxTokens = Math.floor(inputs.kvBudgetBytes / (perTokenPerLayer * inputs.layerCount));
		if (maxTokens > 0) {
			ctx = Math.min(ctx, maxTokens);
		}
	}
	// Round down to a 1024 multiple and never go below the floor.
	ctx = Math.floor(ctx / 1024) * 1024;
	return Math.max(MIN_CLAMPED_CONTEXT, ctx);
}

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
	/**
	 * Path to a separate, smaller GGUF draft model for speculative decoding (`--model-draft`). The big
	 * model verifies tokens the small one drafts, giving 1.5-2.5x faster generation when they agree.
	 * Independent of {@link multiTokenPrediction} (which uses an embedded draft head); MTP takes
	 * precedence when both are set. Empty/unset disables it.
	 */
	draftModelPath?: string;
	/** GPU layers to offload for the draft model (`--gpu-layers-draft`). Emitted only when > 0. */
	draftGpuLayers?: number;
	/**
	 * MoE expert-tensor CPU offload (`--n-cpu-moe N`): keep the first N transformer blocks' expert FFN
	 * tensors in system RAM while attention/dense weights stay on the GPU. For Mixture-of-Experts models
	 * (only a few experts are active per token) this lets a large model fit a small GPU at near-full speed.
	 * Emitted only when > 0; meaningless on dense models (they have no expert tensors). See
	 * {@link computeCpuMoeLayers} for the fit heuristic.
	 */
	cpuMoeLayers?: number;
	/**
	 * Prompt-lookup / n-gram speculative decoding (build-specific, OPT-IN, default off). Drafts tokens by
	 * matching n-grams already present in the context - no separate draft model - which is a large win on
	 * highly repetitive generation (code edits). When on, appends {@link promptLookupArgs} verbatim. The
	 * exact flag names vary by llama.cpp build, so the args are configurable and this never turns on by itself.
	 */
	promptLookup?: boolean;
	/** Flags appended when {@link promptLookup} is on. Build-specific; defaults to `--spec-type ngram-cache`. */
	promptLookupArgs?: string;
	/**
	 * Directory for persisting per-slot KV cache to disk (`--slot-save-path`). Lets the server restore a
	 * previously-processed prompt prefix (e.g. the agent system prompt) across restarts instead of
	 * re-prefilling it, so the first turn after a relaunch is fast. Emitted only when non-empty.
	 */
	slotSavePath?: string;
	/**
	 * Number of parallel request slots (`--parallel`). >1 lets the server handle several requests at once
	 * (e.g. chat + inline completions) by splitting the KV cache into that many slots. Emitted only when > 0.
	 */
	parallelSlots?: number;
	/**
	 * Continuous batching (`-cb`): interleave decoding of concurrent requests for higher throughput when
	 * `parallelSlots` > 1. Recent llama.cpp builds enable this by default; emitted only when explicitly on.
	 */
	continuousBatching?: boolean;
	/** CPU threads for generation (`--threads`). Emitted only when > 0; otherwise llama.cpp auto-detects. */
	threads?: number;
	/** Logical batch size (`--batch-size`). Emitted only when > 0; default build value is 2048. */
	batchSize?: number;
	/** Physical batch size (`--ubatch-size`). Emitted only when > 0; default build value is 512. */
	ubatchSize?: number;
	/** Extra raw args appended verbatim (power users / build-specific flags). */
	extraArgs?: string;
}

/** Inputs for {@link computeGpuLayers}; all byte counts are absolute, layerCount is the model's blocks. */
export interface GpuLayerInputs {
	backend: LlamaBackend;
	/** On-disk weight size in bytes. */
	modelBytes: number;
	/** Transformer block count from GGUF metadata, or undefined when unknown. */
	layerCount: number | undefined;
	/** Total dedicated VRAM in bytes for discrete GPUs (CUDA/Vulkan); 0/undefined when unknown. */
	vramBytes?: number;
	/** Total system RAM in bytes (used for Metal unified memory); 0/undefined when unknown. */
	systemRamBytes?: number;
	/** Fraction of VRAM/RAM the model may use before we offload only part of it. Defaults to 0.9. */
	budgetFraction?: number;
}

/**
 * Decides how many layers to offload to the GPU (`--n-gpu-layers`):
 *  - `undefined` -> caller should use the default (full offload, 999, for GPU backends) - the model fits,
 *    or we lack the data to size a partial split, so don't second-guess llama.cpp.
 *  - a number    -> offload exactly that many layers; the rest run on CPU. Used when the model is bigger
 *    than the GPU budget so a full offload would OOM the GPU.
 *
 * Only discrete-GPU backends (CUDA/Vulkan) with a known VRAM figure get a partial split: there, VRAM is a
 * hard, separate limit. Metal (Apple Silicon) shares unified memory with the CPU, so splitting layers does
 * not save memory - full offload is best and the runner's RAM budget/eviction handles pressure instead.
 */
export function computeGpuLayers(inputs: GpuLayerInputs): number | undefined {
	const { backend, modelBytes, layerCount } = inputs;
	if (backend === 'cpu') {
		return undefined; // CPU backend forces 0 layers in the arg builder anyway.
	}
	if (backend !== 'cuda' && backend !== 'vulkan') {
		return undefined; // Metal/unknown: full offload (unified memory; partial split doesn't help).
	}
	const vram = inputs.vramBytes ?? 0;
	if (vram <= 0 || !layerCount || layerCount <= 0 || modelBytes <= 0) {
		return undefined; // not enough info -> let the caller use full offload.
	}
	const fraction = inputs.budgetFraction && inputs.budgetFraction > 0 ? inputs.budgetFraction : 0.9;
	const budget = vram * fraction;
	if (modelBytes <= budget) {
		return undefined; // whole model fits in VRAM -> full offload.
	}
	const perLayerBytes = modelBytes / layerCount;
	if (perLayerBytes <= 0) {
		return undefined;
	}
	const fit = Math.floor(budget / perLayerBytes);
	// Clamp to [0, layerCount]. 0 means nothing fits -> run on CPU (caller may keep it on CPU).
	return Math.max(0, Math.min(layerCount, fit));
}

/** Inputs for {@link computeCpuMoeLayers}. Byte counts are absolute; layerCount is the model's blocks. */
export interface CpuMoeInputs {
	backend: LlamaBackend;
	/** On-disk weight size in bytes. */
	modelBytes: number;
	/** Transformer block count from GGUF metadata, or undefined when unknown. */
	layerCount: number | undefined;
	/** Number of routed experts (`<arch>.expert_count`); MoE only. <= 1 / undefined means "not MoE". */
	expertCount: number | undefined;
	/** Dedicated VRAM in bytes for discrete GPUs (CUDA/Vulkan), or total RAM for Metal unified memory. */
	memoryBudgetBytes: number | undefined;
	/** Fraction of the budget the model may use before we start offloading experts. Defaults to 0.9. */
	budgetFraction?: number;
}

/**
 * Decides how many transformer blocks should have their expert (FFN) tensors offloaded to CPU
 * (`--n-cpu-moe N`) so a Mixture-of-Experts model fits the available GPU/Metal memory budget:
 *  - `undefined` -> don't pass the flag (not MoE, model already fits, or we lack the data to size it).
 *  - a number N  -> offload the experts of N blocks to CPU; the rest (attention + remaining experts)
 *    stay on the GPU. Because only a few experts are active per token, this keeps decode near GPU speed
 *    while the bulk of the weights live in cheap system RAM.
 *
 * The expert tensors dominate a MoE model's size, so we approximate the over-budget amount as a number
 * of *whole blocks* to move to CPU (slightly conservative, which is the safe direction for fitting).
 * Applies to CUDA/Vulkan (VRAM-limited) and Metal (unified-memory-limited) alike; CPU backend never needs it.
 */
export function computeCpuMoeLayers(inputs: CpuMoeInputs): number | undefined {
	const { backend, modelBytes, layerCount, expertCount, memoryBudgetBytes } = inputs;
	if (backend === 'cpu') {
		return undefined; // everything is already on CPU
	}
	if (!expertCount || expertCount <= 1) {
		return undefined; // dense model -> no expert tensors to offload
	}
	if (!layerCount || layerCount <= 0 || modelBytes <= 0 || !memoryBudgetBytes || memoryBudgetBytes <= 0) {
		return undefined; // not enough info -> let full offload / partial GPU-layer logic handle it
	}
	const fraction = inputs.budgetFraction && inputs.budgetFraction > 0 ? inputs.budgetFraction : 0.9;
	const budget = memoryBudgetBytes * fraction;
	if (modelBytes <= budget) {
		return undefined; // fits as-is -> no expert offload needed
	}
	const overBytes = modelBytes - budget;
	const perLayerBytes = modelBytes / layerCount;
	if (perLayerBytes <= 0) {
		return undefined;
	}
	// Move enough whole blocks' experts to CPU to cover the overflow (round up to be safe).
	const layersToOffload = Math.ceil(overBytes / perLayerBytes);
	return Math.max(1, Math.min(layerCount, layersToOffload));
}

/**
 * Builds the llama.cpp server command and args for the given model path and backend.
 * serverPath: optional path from settings (locopilot.llamaCpp.serverPath). Empty = use binary from PATH.
 * tuning: optional performance settings; all have safe, self-falling-back defaults.
 * User can install via: https://github.com/ggerganov/llama.cpp or pip install llama-cpp-python (server).
 */
export function getLlamaCppServerCommand(modelPath: string, backend: LlamaBackend, serverPath?: string, port: number = LOCOPILOT_LLAMA_SERVER_PORT, tuning: LlamaServerTuning = {}): { command: string; args: string[] } {
	const contextSize = tuning.contextSize && tuning.contextSize > 0 ? Math.floor(tuning.contextSize) : DEFAULT_LLAMA_CONTEXT_SIZE;
	// 'auto' resolves to f16 for small windows and q8_0 for large ones (see resolveKvCacheType).
	const kvCacheType = resolveKvCacheType(tuning.kvCacheType ?? 'auto', contextSize);

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

	// GPU offload:
	//  - CPU backend       -> explicit 0 (forcing the flag onto a CPU-only binary would break startup).
	//  - explicit override -> use exactly that many layers (from tuning / computeGpuLayers partial split).
	//  - GPU, no override   -> omit the flag entirely so llama.cpp auto-fits to free device memory. On
	//    Apple Silicon (Metal, unified memory) the whole model still fits, so this auto-offloads everything;
	//    on a discrete GPU it offloads as many layers as fit instead of OOM-ing on a forced full offload.
	//    Omitting also silences llama.cpp's "n_gpu_layers already set by user to 999, abort" fit warning.
	if (backend === 'cpu') {
		args.push('--n-gpu-layers', '0');
	} else if (tuning.gpuLayers !== undefined) {
		args.push('--n-gpu-layers', String(tuning.gpuLayers));
	}

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
	} else if (tuning.draftModelPath && tuning.draftModelPath.trim()) {
		// Speculative decoding with a SEPARATE small draft model: the small model proposes tokens and the
		// big model verifies them in one batch, so when they agree we generate several tokens per big-model
		// pass. Only used when MTP (embedded draft head) is off, since both drive --model-draft.
		args.push('--model-draft', tuning.draftModelPath.trim());
		if (tuning.draftGpuLayers !== undefined && tuning.draftGpuLayers > 0) {
			args.push('--gpu-layers-draft', String(Math.floor(tuning.draftGpuLayers)));
		}
	}

	// MoE expert offload: keep N blocks' expert FFN tensors in system RAM while attention stays on the GPU.
	// Only meaningful for Mixture-of-Experts models; the runner sizes this from GGUF expert_count + memory.
	if (tuning.cpuMoeLayers && tuning.cpuMoeLayers > 0) {
		args.push('--n-cpu-moe', String(Math.floor(tuning.cpuMoeLayers)));
	}

	// Prompt-lookup / n-gram speculative decoding (build-specific, opt-in). No separate model; drafts from
	// the context itself. Flags are configurable because their names differ across llama.cpp builds.
	if (tuning.promptLookup) {
		const lookupArgs = (tuning.promptLookupArgs && tuning.promptLookupArgs.trim()) ? tuning.promptLookupArgs.trim() : '--spec-type ngram-cache';
		args.push(...lookupArgs.split(/\s+/));
	}

	// Persist per-slot KV cache to disk so a previously-processed prompt prefix survives restarts.
	if (tuning.slotSavePath && tuning.slotSavePath.trim()) {
		args.push('--slot-save-path', tuning.slotSavePath.trim());
	}

	// Parallel request slots + continuous batching: serve concurrent requests (e.g. chat alongside inline
	// completions) by splitting the KV cache into N slots and interleaving their decode steps.
	// We emit `--parallel` for any explicit value >= 1 (including 1). This matters: without the flag,
	// llama.cpp's own "auto" picks 4 slots and splits the KV cache four ways, which can overflow the
	// context on long prompts. `0` means "let llama.cpp auto-detect" (no flag). Continuous batching only
	// helps with more than one slot.
	if (tuning.parallelSlots && tuning.parallelSlots >= 1) {
		const slots = Math.floor(tuning.parallelSlots);
		args.push('--parallel', String(slots));
		if (slots > 1 && tuning.continuousBatching) {
			args.push('-cb');
		}
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
