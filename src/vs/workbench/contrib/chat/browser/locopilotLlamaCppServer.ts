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
export function getBundledPlatformArch(): string {
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
 * Context window at/above which 'auto' KV cache switches from f16 to q8_0. Set to the default window so the
 * out-of-the-box context (and anything larger) runs a q8_0 KV cache: q8_0 is ~half the bytes of f16 with
 * negligible quality impact, which both cuts the memory footprint AND lets the context clamp grant roughly
 * twice the window for the same budget. Only genuinely small windows (below the default) stay f16, where the
 * cache is cheap and full precision is the better trade.
 */
export const KV_AUTO_QUANT_CONTEXT_THRESHOLD = DEFAULT_LLAMA_CONTEXT_SIZE;

/**
 * Bytes-per-element the KV cache uses at a given precision, for sizing the context clamp so it matches what
 * the runtime will actually allocate. f16 = 2 bytes; q8_0 = 1.0625; q4_0 ~0.5625 (4.5 bits with
 * its block scale). Using the real q4_0 size is what lets the clamp grant the extra window q4_0 buys.
 */
export function kvCacheBytesPerElem(kvCacheType: Exclude<KvCacheType, 'auto'>): number {
	switch (kvCacheType) {
		case 'q4_0':
			// 4-bit quants stored in blocks of 32 with a 16-bit scale: (32*4 + 16) / 32 = 4.5 bits = 0.5625 bytes/
			// elem. Sizing it as 1 (the old value, shared with q8_0) made the clamp think q4_0 was no smaller than
			// q8_0, so it granted NO extra context - defeating the point of using q4_0 for a longer window.
			return 0.5625;
		case 'q8_0':
			// 8-bit quants stored in blocks of 32 with a 16-bit scale: (32*8 + 16) / 32 = 8.5 bits.
			// Counting only the payload byte underestimates a long KV cache by 6.25%, enough to consume the
			// final safety margin on memory-tight devices.
			return 1.0625;
		case 'f16':
		default:
			return 2;
	}
}

/**
 * Fractions of Apple-Silicon unified memory the GPU may WIRE for inference. macOS caps a Metal app's
 * working set at `recommendedMaxWorkingSetSize`; trying to wire more forces the OS to page weights to SSD,
 * which thrashes the machine (freeze, sustained 100% GPU, heat, thermal shutdown). Apple's actual default
 * ceiling is TIERED and rises with RAM. It is calibrated in THREE bands rather than two: the tight 0.66 is
 * needed only on the memory-starved 8-16 GB Macs that actually hang (the OS+editor hold a large ABSOLUTE
 * share of so little RAM); a 24-32 GB Mac has plenty of absolute headroom and its measured working-set
 * ceiling runs ~75-78% (an M1 Max 32 GB reports ~25 GB / 78%), so the old flat 0.66 there left ~2-3 GB of
 * usable KV budget on the table and needlessly crushed context. The MID band (0.70) recovers most of that
 * while staying safely under the measured ceiling on machines whose ceiling sits lower. Sized off fractions
 * of TOTAL RAM - never raw total, which ignores both this ceiling and the RAM the OS + editor already hold.
 */
export const METAL_WIRED_MEMORY_FRACTION_SMALL = 0.66;
export const METAL_WIRED_MEMORY_FRACTION_MID = 0.70;
export const METAL_WIRED_MEMORY_FRACTION_LARGE = 0.75;
/** RAM below which the tight small-machine fraction applies (protects the 8-16 GB Macs that page/hang). */
export const METAL_SMALL_RAM_THRESHOLD_BYTES = 18 * 1024 * 1024 * 1024;
/** RAM size at/above which macOS applies the larger default wired-memory fraction. */
export const METAL_LARGE_RAM_THRESHOLD_BYTES = 36 * 1024 * 1024 * 1024;

/**
 * Upper bound on the fraction of TOTAL system RAM treated as usable for inference (weights + KV) when
 * deciding whether a model fits the machine AT ALL (the pre-flight gate). Leaves headroom for the OS +
 * editor. Based on total rather than currently-free RAM on purpose: macOS reports much of its RAM as
 * non-free (file cache / purgeable) even when it is reclaimable, so a free-based gate would block models
 * that actually run. This is only the CEILING - {@link usableSystemMemoryBytes} also subtracts an absolute
 * OS/editor reserve, which binds tighter on small machines (see below).
 */
export const USABLE_SYSTEM_MEMORY_FRACTION = 0.85;

/**
 * Absolute RAM (bytes) held back for the OS + editor before a fraction cap even applies. A flat 85% assumed
 * the OS+editor fit in 15% of RAM, which is false on the small machines that actually hang: on a 16 GB
 * Windows/Linux laptop the OS alone is ~4 GB, so 85% (13.6 GB usable) over-budgeted a model into paging.
 * The reserve scales with RAM (bigger machines run heavier editors/toolchains) but is clamped so it neither
 * vanishes on tiny machines nor eats an unreasonable slice of large ones. The 0.85 cap still wins on big
 * machines where the clamped reserve would leave more than 85% usable.
 */
export const SYSTEM_MEMORY_RESERVE_FRACTION = 0.20;
export const SYSTEM_MEMORY_RESERVE_MIN_BYTES = 2 * 1024 * 1024 * 1024;  // never reserve less than 2 GB
export const SYSTEM_MEMORY_RESERVE_MAX_BYTES = 6 * 1024 * 1024 * 1024;  // never reserve more than 6 GB

/**
 * Fraction of the memory budget reserved for the KV cache when deciding WEIGHT OFFLOAD: the weight-offload
 * budget is `budget * (1 - KV_BUDGET_FRACTION)`, so a model close to the device limit offloads experts/layers
 * to CPU instead of wiring the full weights PLUS a large KV past the limit. This is deliberately conservative
 * (reserve 25% for KV) because misjudging it OOMs the device at decode. It is NOT the context-clamp cap - see
 * {@link KV_CLAMP_BUDGET_FRACTION}, which is decoupled so a small model can use its spare room for context
 * without also making a big model offload more weights than necessary.
 */
export const KV_BUDGET_FRACTION = 0.25;

/**
 * Upper bound on the KV cache as a fraction of the memory budget, used ONLY by the context clamp
 * ({@link computeKvBudgetBytes}). Higher than {@link KV_BUDGET_FRACTION} on purpose: the clamp's real safety
 * bound is the weight-aware `remaining` term (budget - resident weights - runtime overhead), which already
 * guarantees weights + KV + overhead stay inside the wired/system ceiling on every backend. This fraction is
 * only a secondary guard against compute-buffer growth at very large contexts, so a low value needlessly
 * throttles a SMALL model that has plenty of spare budget (e.g. clamping a 4B's 128K request to ~28K on a
 * 16 GB Mac when ~2x that fits). 0.5 roughly doubles the context a small/medium model gets while leaving a
 * margin; large models are unaffected because `remaining` binds first once weights fill most of the budget.
 */
export const KV_CLAMP_BUDGET_FRACTION = 0.5;

/**
 * Usable unified-memory budget (bytes) for GPU offload on Apple Silicon (Metal): the wired working-set
 * ceiling. When the user raised the kernel limit themselves (`iogpu.wired_limit_mb`, passed via
 * `wiredLimitBytes`), that explicit ceiling wins (capped at 90% of RAM so a wild sysctl value cannot
 * budget past physical memory); otherwise Apple's tiered default fraction applies. Returns 0 when total
 * is unknown so callers skip the budget.
 */
export function metalOffloadBudgetBytes(totalmemBytes: number, wiredLimitBytes?: number): number {
	if (totalmemBytes <= 0) {
		return 0;
	}
	if (wiredLimitBytes && wiredLimitBytes > 0) {
		return Math.floor(Math.min(wiredLimitBytes, totalmemBytes * 0.9));
	}
	const fraction = totalmemBytes >= METAL_LARGE_RAM_THRESHOLD_BYTES
		? METAL_WIRED_MEMORY_FRACTION_LARGE
		: (totalmemBytes < METAL_SMALL_RAM_THRESHOLD_BYTES
			? METAL_WIRED_MEMORY_FRACTION_SMALL
			: METAL_WIRED_MEMORY_FRACTION_MID);
	return Math.floor(totalmemBytes * fraction);
}

/**
 * Usable system-RAM budget (bytes) for the pre-flight fit check: total RAM left after an absolute OS/editor
 * reserve, capped at {@link USABLE_SYSTEM_MEMORY_FRACTION} of total. On Apple Silicon, offloading experts to
 * "CPU" keeps them in the SAME unified pool, so the weights + KV must fit this budget regardless of offload.
 * The reserve (not a flat fraction) is what keeps small Windows/Linux/CPU machines - where the OS holds a
 * large ABSOLUTE share - from over-budgeting a model into swap. Returns 0 when total is unknown.
 *
 * Examples: 8 GB -> reserve 2 GB -> 6 GB usable (75%); 16 GB -> reserve 3.2 GB -> 12.8 GB (80%);
 * 32 GB -> reserve 6 GB -> 26 GB (81%); 64 GB -> reserve capped 6 GB but the 85% cap binds -> ~54 GB (85%).
 */
export function usableSystemMemoryBytes(totalmemBytes: number): number {
	if (totalmemBytes <= 0) {
		return 0;
	}
	const reserve = Math.min(
		SYSTEM_MEMORY_RESERVE_MAX_BYTES,
		Math.max(SYSTEM_MEMORY_RESERVE_MIN_BYTES, totalmemBytes * SYSTEM_MEMORY_RESERVE_FRACTION)
	);
	const afterReserve = totalmemBytes - reserve;
	const cap = totalmemBytes * USABLE_SYSTEM_MEMORY_FRACTION;
	return Math.max(0, Math.floor(Math.min(afterReserve, cap)));
}

/**
 * Flat allowance (bytes) for the engine's non-weight, non-KV runtime cost: host buffers, compute scratch,
 * tokenizer, CUDA/Metal context. Shared by the pre-flight fit gate and the KV-budget sizing so the two
 * answer "does it fit?" with the same arithmetic.
 */
export const RUNTIME_OVERHEAD_BYTES = Math.round(1.5 * 1024 * 1024 * 1024);

/**
 * Estimates transient runtime/compute allocations that grow beyond the flat base allowance. This is
 * deliberately modest: it charges the knobs that materially grow prefill peaks without taking usable
 * context away for allocations already represented by weights, KV, prompt cache, or draft/projector extras.
 */
export function runtimeOverheadBytesForTuning(tuning: Pick<LlamaServerTuning, 'contextSize' | 'parallelSlots' | 'ubatchSize'>, backend: LlamaBackend): number {
	const MiB = 1024 * 1024;
	const context = Math.max(DEFAULT_LLAMA_CONTEXT_SIZE, tuning.contextSize ?? DEFAULT_LLAMA_CONTEXT_SIZE);
	const slots = Math.max(1, Math.floor(tuning.parallelSlots ?? 1));
	const ubatch = Math.max(512, Math.floor(tuning.ubatchSize ?? 512));
	const gpuDriver = backend === 'cpu' ? 0 : 256 * MiB;
	const contextGraph = Math.ceil(Math.max(0, context - DEFAULT_LLAMA_CONTEXT_SIZE) / 32768) * 128 * MiB;
	const batchGraph = Math.ceil(Math.max(0, ubatch - 512) / 1024) * 256 * MiB;
	const parallelGraph = Math.max(0, slots - 1) * 128 * MiB;
	return RUNTIME_OVERHEAD_BYTES + gpuDriver + contextGraph + batchGraph + parallelGraph;
}

/**
 * KV-cache byte allowance for the context clamp, sized so that weights + KV + runtime overhead stay inside
 * the memory budget: at most {@link KV_CLAMP_BUDGET_FRACTION} of the budget, and never more than what actually
 * remains after the weights that will reside in the same pool. The `remaining` bound is the real safety limit
 * (weights + KV + overhead can never exceed the budget); the fraction is only a secondary guard. Without the
 * `remaining` bound, a model whose weights already fill most of the budget would get a full KV allowance on
 * top - which is exactly how a launch that passed the pre-flight gate could still bust the wired ceiling.
 *
 * `residentWeightBytes` is the weight bytes living in the budget's pool: full weights on Metal/CPU (one
 * unified/system pool), or `min(weights, offload budget)` on a discrete GPU where partial offload caps
 * what lands in VRAM. Returns 0 when nothing is left - callers floor the context at MIN_CLAMPED_CONTEXT,
 * matching the minimum-KV footprint the pre-flight gate already required to fit.
 */
export function computeKvBudgetBytes(budgetBytes: number, residentWeightBytes: number, overheadBytes: number = RUNTIME_OVERHEAD_BYTES): number {
	if (budgetBytes <= 0) {
		return 0;
	}
	const remaining = budgetBytes - Math.max(0, residentWeightBytes) - Math.max(0, overheadBytes);
	return Math.max(0, Math.min(Math.floor(budgetBytes * KV_CLAMP_BUDGET_FRACTION), remaining));
}

/**
 * Safety margin (fraction of the memory budget) held back for the warm-up / compute-graph peak when deciding
 * whether `--swa-full` fits. Neither our KV clamp nor llama.cpp's own `-fit` fully models this transient peak,
 * and it is exactly what tipped a "fits on paper" Gemma launch into a Metal command-buffer OOM.
 */
export const SWA_FULL_GRAPH_MARGIN_FRACTION = 0.08;

/**
 * Headroom (bytes, may be negative) left after placing everything `--swa-full` needs to hold a FULL-size KV
 * cache on every sliding-window layer: the resident weights, that full KV, the host prompt cache, base runtime
 * overhead, and a {@link SWA_FULL_GRAPH_MARGIN_FRACTION} compute-graph margin. `>= 0` means the full cache fits
 * and `--swa-full` is safe to force; `< 0` means keep the far smaller windowed SWA cache instead (the model
 * still runs at the same context, just without cross-turn prompt-cache reuse). `promptCacheReserveBytes` should
 * be 0 on discrete GPUs, where the host prompt cache lives in system RAM, separate from the VRAM the KV occupies.
 */
export function swaFullKvHeadroomBytes(inputs: {
	budgetBytes: number;
	residentWeightBytes: number;
	fullSwaKvBytes: number;
	promptCacheReserveBytes: number;
	overheadBytes?: number;
	graphMarginFraction?: number;
}): number {
	const overhead = inputs.overheadBytes ?? RUNTIME_OVERHEAD_BYTES;
	const graphMargin = Math.floor(Math.max(0, inputs.budgetBytes) * (inputs.graphMarginFraction ?? SWA_FULL_GRAPH_MARGIN_FRACTION));
	return inputs.budgetBytes
		- Math.max(0, inputs.residentWeightBytes)
		- Math.max(0, inputs.fullSwaKvBytes)
		- Math.max(0, overhead)
		- Math.max(0, inputs.promptCacheReserveBytes)
		- graphMargin;
}

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
	/**
	 * SWA (sliding-window attention) window size in tokens (`<arch>.attention.sliding_window`), 0/undefined for
	 * a full-attention model. On a sliding-window model whose `--swa-full` is OFF (the default when the full
	 * cache doesn't fit - see {@link swaFullOnAllLayers}), the SWA layers hold only `slidingWindow` tokens, NOT
	 * the whole context - so charging every layer the full context (the old behavior) over-counted KV several-
	 * fold and collapsed the window (e.g. Gemma clamped to ~8K when ~128K fits). When set, the clamp charges the
	 * SWA layers a fixed `window`-sized cost and lets only the GLOBAL (full-attention) layers scale with context.
	 */
	slidingWindow?: number;
	/**
	 * True when `--swa-full` will be forced on, so EVERY layer holds the full context and the SWA windowing
	 * above must NOT apply. Defaults to false (windowed): the runner's swa-full headroom gate runs AFTER the
	 * clamp and only turns swa-full on when the full cache genuinely fits, so sizing the clamp as windowed is
	 * safe - a larger windowed context simply keeps swa-full off, never past the budget.
	 */
	swaFullOnAllLayers?: boolean;
}

/** Smallest context we will ever clamp down to, so a tiny budget can't make the model unusable. */
export const MIN_CLAMPED_CONTEXT = 4096;

/**
 * Absolute backstop on the context window. The real ceiling is the model's own trained window (or a per-model
 * override) - this only stops a pathological 1M-token advertisement from sizing a context nothing benefits
 * from. Set high (256K) so it almost never binds: a model trained to 128K/256K gets its full window when the
 * device can hold it, and only a >256K advertisement is capped here.
 */
export const MAX_CLAMPED_CONTEXT = 262144;

/**
 * Comfort floor for a coding agent: the context we TRY to reach on every model, because a smaller window is
 * unusable for multi-iteration work (a system prompt alone can be ~7K). It is a TARGET, not a guarantee - when
 * even a q4 KV cache can't fit it on this device, the launch still runs at the largest context that DOES fit
 * (never a hard OOM) and surfaces a plain-language "tight fit" notice. Used to (a) decide when to trade KV
 * precision down to q4 and (b) trigger that notice. Models whose trained window is below this are capped by
 * their own window instead - the floor never inflates a model past what it was trained for.
 */
export const TARGET_MIN_CONTEXT = 32768;

/**
 * Fraction of a sliding-window model's transformer layers assumed to be GLOBAL (full-attention) layers when
 * sizing the windowed KV cache. Only the global layers' KV scales with the context window; the local (SWA)
 * layers are pinned to {@link ContextClampInputs.slidingWindow} tokens. We detect the window size from GGUF
 * but NOT the exact global:local split, so this is deliberately CONSERVATIVE: Gemma 3/4 are 1 global : 5
 * local (~0.17 global) and Gemma 2 alternates 1:1 (0.5 global). Assuming 0.5 over-counts KV for the 5:1
 * models (grants a smaller, safe window) while sizing the 1:1 models correctly, and any model with fewer
 * global layers than assumed only ends up with MORE headroom - never less. Erring high on global layers is
 * the memory-safe direction.
 */
export const SWA_GLOBAL_LAYER_FRACTION = 0.5;

/**
 * Transformer-layer count assumed by the memory clamp when the GGUF metadata doesn't expose `block_count`
 * (e.g. a non-standard / newly-published arch like some `gemma-4` conversions). Without a fallback the
 * clamp used to be SKIPPED entirely for such models, letting a 256K-trained window through unclamped and
 * OOM the device. 48 is the layer count of a ~12B model (Gemma 3 12B); erring on the higher side sizes the
 * KV cache conservatively (fewer tokens fit -> smaller, safer window) when we truly don't know.
 */
export const DEFAULT_CLAMP_LAYER_COUNT = 48;

/**
 * Conservative KV bytes/token/layer at f16 (k+v) for a typical GQA model (8 kv-heads x 128 dim x 2 [k+v] x
 * 2 bytes), used by the context clamp when the GGUF doesn't expose the attention geometry. Callers running a
 * quantized cache scale this by (KV bytes-per-element / 2) so a q8_0 cache is estimated at ~half and the
 * clamp grants proportionally more context.
 */
export const DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 = 4096;

/**
 * When MTP (Multi-Token Prediction) is on, llama.cpp spins up a SEPARATE draft context with its own KV cache
 * that scales with `n_ctx` (the server logs `estimated memory usage of MTP context is <N> MiB`). Empirically
 * that draft context costs roughly one extra transformer layer's worth of KV per token plus a small fixed base,
 * so the context clamp models it by adding this many layers to the model's real layer count. This keeps the
 * clamp's dynamic sizing intact - a big machine still gets a big context, a tight one shrinks just enough to
 * hold BOTH caches - instead of hard-capping MTP context to a constant. Conservative (2) to also absorb the
 * fixed base overhead at the long contexts where it starts to matter.
 */
export const MTP_DRAFT_KV_LAYER_EQUIV = 2;

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
	if (inputs.kvBudgetBytes && inputs.kvBudgetBytes > 0) {
		const perTokenPerLayer = inputs.kvBytesPerTokenPerLayer && inputs.kvBytesPerTokenPerLayer > 0
			? inputs.kvBytesPerTokenPerLayer
			: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16; // conservative f16 estimate when the geometry is unknown.
		// Fall back to a conservative layer count when the GGUF didn't expose one, so a long-context model
		// with unparseable metadata still gets clamped instead of escaping with its full trained window.
		const layerCount = inputs.layerCount && inputs.layerCount > 0 ? inputs.layerCount : DEFAULT_CLAMP_LAYER_COUNT;
		const window = inputs.slidingWindow && inputs.slidingWindow > 0 ? Math.floor(inputs.slidingWindow) : 0;
		let maxTokens: number;
		if (window > 0 && !inputs.swaFullOnAllLayers) {
			// Sliding-window model with windowed (non-swa-full) KV: the SWA layers never hold more than `window`
			// tokens, so their KV is a FIXED cost independent of context; only the global (full-attention) layers
			// grow with the window. Solving `budget = perTok*(global*ctx + local*window)` for ctx is what restores
			// the large windowed context these models actually support (vs. charging all layers the full context).
			const globalLayers = Math.max(1, Math.ceil(layerCount * SWA_GLOBAL_LAYER_FRACTION));
			const localLayers = Math.max(0, layerCount - globalLayers);
			const localFixedBytes = perTokenPerLayer * localLayers * window;
			const budgetForGlobal = inputs.kvBudgetBytes - localFixedBytes;
			maxTokens = budgetForGlobal > 0 ? Math.floor(budgetForGlobal / (perTokenPerLayer * globalLayers)) : 0;
		} else {
			maxTokens = Math.floor(inputs.kvBudgetBytes / (perTokenPerLayer * layerCount));
		}
		// Clamp even when the budget holds ~0 tokens: the MIN_CLAMPED_CONTEXT floor below keeps the model
		// usable, and skipping the clamp here (the old behavior) let a near-full budget escape unclamped.
		ctx = Math.min(ctx, Math.max(0, maxTokens));
	}
	// Never exceed the practical maximum, even when trained length and memory both allow more.
	ctx = Math.min(ctx, MAX_CLAMPED_CONTEXT);
	// Round down to a 1024 multiple and never go below the floor.
	ctx = Math.floor(ctx / 1024) * 1024;
	return Math.max(MIN_CLAMPED_CONTEXT, ctx);
}

/**
 * Forward estimate of the KV-cache bytes a given context will occupy - the inverse of {@link clampContextSize},
 * used by the pre-flight fit gate so both agree on a model's footprint. Sliding-window models (with `--swa-full`
 * off) charge the SWA layers only `min(ctx, window)` tokens and let the global layers scale with context,
 * matching what the windowed clamp granted; without this the fit gate would size a windowed model's KV as if
 * every layer held the full context and wrongly reject the large context the clamp just approved.
 */
export function kvCacheBytesForContext(inputs: {
	contextTokens: number;
	layerCount: number;
	kvBytesPerTokenPerLayer: number;
	slidingWindow?: number;
	swaFullOnAllLayers?: boolean;
}): number {
	const layers = Math.max(1, Math.floor(inputs.layerCount));
	const perTok = Math.max(0, inputs.kvBytesPerTokenPerLayer);
	const ctx = Math.max(0, Math.floor(inputs.contextTokens));
	const window = inputs.slidingWindow && inputs.slidingWindow > 0 ? Math.floor(inputs.slidingWindow) : 0;
	if (window > 0 && !inputs.swaFullOnAllLayers) {
		const globalLayers = Math.max(1, Math.ceil(layers * SWA_GLOBAL_LAYER_FRACTION));
		const localLayers = Math.max(0, layers - globalLayers);
		return perTok * (globalLayers * ctx + localLayers * Math.min(ctx, window));
	}
	return perTok * layers * ctx;
}

export interface AutomaticKvCacheSelectionInputs extends ContextClampInputs {
	/**
	 * Model-specific f16 KV bytes per token per layer from GGUF attention geometry. Quantized candidates
	 * are derived from this value, ensuring all precisions are compared against exactly the same model.
	 */
	kvBytesPerTokenPerLayerF16?: number;
}

export interface AutomaticKvCacheSelection {
	kvCacheType: Exclude<KvCacheType, 'auto'>;
	contextSize: number;
}

/**
 * Selects automatic KV precision from the model's real geometry and memory budget. Small contexts retain
 * f16 when it fits; normal/large contexts prefer near-lossless q8_0; q4_0 is used only when a higher precision
 * can't reach the {@link TARGET_MIN_CONTEXT} comfort floor - i.e. q4 is a floor-REACHING tool, not a maximize-
 * context tool, so a model that already clears the floor at q8 keeps q8's quality rather than trading it for a
 * longer-but-lossier window. Selection happens before launch and remains stable for the server lifetime, so an
 * active conversation never loses its cache to a precision change.
 */
export function selectAutomaticKvCache(inputs: AutomaticKvCacheSelectionInputs): AutomaticKvCacheSelection {
	const targetContext = clampContextSize({
		requestedContext: inputs.requestedContext,
		modelContextLength: inputs.modelContextLength,
	});
	// The bar a precision must clear to be "good enough": the comfort floor, but never above what the model's
	// own window allows (a 16K-trained model is satisfied by 16K, we don't drop to q4 chasing an impossible 32K).
	const satisfiedAt = Math.min(targetContext, TARGET_MIN_CONTEXT);
	const preferred: Exclude<KvCacheType, 'auto'>[] = targetContext < KV_AUTO_QUANT_CONTEXT_THRESHOLD
		? ['f16', 'q8_0', 'q4_0']
		: ['q8_0', 'q4_0'];
	const f16Bytes = inputs.kvBytesPerTokenPerLayerF16 && inputs.kvBytesPerTokenPerLayerF16 > 0
		? inputs.kvBytesPerTokenPerLayerF16
		: (inputs.kvBytesPerTokenPerLayer && inputs.kvBytesPerTokenPerLayer > 0
			? inputs.kvBytesPerTokenPerLayer
			: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16);
	let best: AutomaticKvCacheSelection | undefined;
	for (const kvCacheType of preferred) {
		const perTokenPerLayer = f16Bytes * kvCacheBytesPerElem(kvCacheType) / kvCacheBytesPerElem('f16');
		const contextSize = clampContextSize({
			requestedContext: inputs.requestedContext,
			modelContextLength: inputs.modelContextLength,
			kvBudgetBytes: inputs.kvBudgetBytes,
			layerCount: inputs.layerCount,
			kvBytesPerTokenPerLayer: perTokenPerLayer,
			slidingWindow: inputs.slidingWindow,
			swaFullOnAllLayers: inputs.swaFullOnAllLayers,
		});
		const candidate = { kvCacheType, contextSize };
		// Accept the FIRST (highest-quality) precision that clears the comfort floor at its full fitting context -
		// don't drop to a lossier cache just because it would grant even more length past the floor.
		if (contextSize >= satisfiedAt) {
			return candidate;
		}
		if (!best || contextSize > best.contextSize) {
			best = candidate;
		}
	}
	return best ?? { kvCacheType: resolveKvCacheType('auto', targetContext), contextSize: targetContext };
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
	 * recent llama.cpp build (~b9180+). When on, emits `mtpArgs` ALONE (default `--spec-type draft-mtp`) so
	 * llama.cpp loads the embedded MTP head from the main GGUF as a lightweight draft context - it does NOT
	 * pass `--model-draft` (that would load a second full weight copy). Off by default; flags are build-specific.
	 */
	multiTokenPrediction?: boolean;
	/** Speculative flags emitted when MTP is on (no `--model-draft`). Build-specific; defaults to `--spec-type draft-mtp`. */
	mtpArgs?: string;
	/** Lock weights in RAM (`--mlock`). Can fail without privileges/RAM, so opt-in. */
	mlock?: boolean;
	/**
	 * Keep a FULL-size KV cache for Sliding-Window Attention layers (`--swa-full`). SWA models (Gemma 2/3,
	 * etc.) default to a window-sized KV for those layers, which invalidates the server's prompt-cache
	 * checkpoints and forces a full prompt re-process every turn (slow on long agent prompts). Enabling this
	 * keeps the whole KV so cross-turn prompt reuse works, at the cost of more KV memory - so the runner only
	 * turns it on for SWA models that still fit the memory budget with the full cache. Flag is newer, so old
	 * builds reject it (self-healed like the speculative flags). Off/undefined emits nothing.
	 */
	swaFull?: boolean;
	/** GPU layers override; when unset, GPU backends offload all layers (999) and CPU uses 0. */
	gpuLayers?: number;
	/**
	 * Min chunk size to reuse from the KV cache via shifting (`--cache-reuse`). Lets repeated prompt
	 * prefixes (e.g. the system prompt in agent loops) skip reprocessing. Defaults to 256; 0 disables.
	 */
	cacheReuse?: number;
	/**
	 * Cap (MiB) for the server's host-RAM prompt cache (`--cache-ram`). The build default is 8192 MiB,
	 * which is a large silent claim on an 8-16GB machine - and it was the gap between our footprint
	 * estimate (which books ~2GB for this cache) and what the server could actually hold. The runner
	 * sizes this from total RAM. 0 disables the cache; undefined emits no flag (build default).
	 */
	cacheRamMiB?: number;
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
	 * {@link computeCpuMoeLayers} for the fit heuristic. Ignored when {@link overrideTensors} is set (both
	 * place expert tensors; the finer `-ot` override wins).
	 */
	cpuMoeLayers?: number;
	/**
	 * Fine-grained tensor placement (`--override-tensor` / `-ot`), one entry per flag. Each is a
	 * `<name-regex>=<device>` rule (e.g. `blk\.(3|4|5)\.ffn_.*_exps\.=CPU`) that pins the matching tensors to
	 * a device. This is the tensor-level generalisation of `--n-cpu-moe`: instead of "the top N blocks", it can
	 * offload the experts of EXACTLY the blocks the fit planner chose (sized from per-layer weight bytes), which
	 * squeezes more model onto the same GPU. When non-empty the arg builder emits an `-ot` per entry and skips
	 * `--n-cpu-moe` (they'd both place expert tensors). `-ot` is a long-standing llama.cpp flag; no self-heal needed.
	 */
	overrideTensors?: string[];
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
	/**
	 * Path to a multimodal projector GGUF (`--mmproj`). Required for the server to accept image input on
	 * vision models; without it llama.cpp rejects images. Emitted only when set (i.e. the model ships a
	 * projector and it was downloaded). Independent of the text weights in `-m`.
	 */
	mmprojPath?: string;
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
	/**
	 * Per-block weight bytes from the GGUF tensor section, indexed by block number. When present, the split is
	 * packed from each block's REAL size (largest-index-first, mirroring llama.cpp's own offload order) instead
	 * of the uniform `modelBytes / layerCount`, so an uneven-layer model gets an accurate count. Falls back to
	 * the uniform estimate when absent.
	 */
	perLayerWeightBytes?: readonly number[];
	/**
	 * Weight bytes not attached to any block (embeddings, output head). With `-ngl N`, llama.cpp keeps these on
	 * the GPU too, so they're charged as a fixed cost against the VRAM budget before layers are packed. 0 when
	 * unknown.
	 */
	nonLayerWeightBytes?: number;
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

	// Per-layer packing when real block sizes are known: charge the always-resident non-layer weights first,
	// then pack blocks (largest index first, as llama.cpp offloads) until the VRAM budget is exhausted. This
	// beats the uniform estimate on models whose blocks differ in size.
	const perLayer = inputs.perLayerWeightBytes;
	if (perLayer && perLayer.length > 0 && perLayer.some(b => b > 0)) {
		let remaining = budget - Math.max(0, inputs.nonLayerWeightBytes ?? 0);
		let offloaded = 0;
		for (let layer = perLayer.length - 1; layer >= 0; layer--) {
			const bytes = perLayer[layer] ?? 0;
			if (bytes > remaining) {
				break; // this block (and any lower one, which we haven't reached) won't fit
			}
			remaining -= bytes;
			offloaded++;
		}
		return Math.max(0, Math.min(layerCount, offloaded));
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

/** Inputs for {@link planMoeExpertOffload}: real per-layer sizes plus the memory budget to fit into. */
export interface MoeOffloadPlanInputs {
	backend: LlamaBackend;
	/** On-disk weight size in bytes (from a file stat; the authoritative total). */
	modelBytes: number;
	/** The routed-expert (`ffn_*_exps`) slice of each block's bytes - what an expert offload actually moves. */
	perLayerExpertBytes: readonly number[] | undefined;
	/** Dedicated VRAM (CUDA/Vulkan) or unified-memory budget (Metal) the weights may use, in bytes. */
	memoryBudgetBytes: number | undefined;
	/** Fraction of the budget usable before offloading. Defaults to 0.9. */
	budgetFraction?: number;
}

/**
 * Per-layer MoE offload planner: picks the EXACT set of transformer blocks whose routed-expert tensors to
 * move to CPU so the model fits `memoryBudgetBytes`, using each block's real expert-weight size instead of
 * the uniform `modelBytes / layerCount` estimate that {@link computeCpuMoeLayers} falls back to.
 *
 * Returns the sorted block indices to offload (rendered as an `-ot` rule by {@link buildExpertOffloadOverride}),
 * or `undefined` when it doesn't apply (dense model, already fits, or the per-layer data is missing - in which
 * case the caller uses the coarse `--n-cpu-moe N` path). We offload from the HIGHEST block index downward to
 * mirror llama.cpp's own `--n-cpu-moe` ordering (dense/attention-heavy early blocks stay on the GPU), summing
 * each block's expert bytes until the overflow is covered.
 */
export function planMoeExpertOffload(inputs: MoeOffloadPlanInputs): number[] | undefined {
	const { backend, modelBytes, perLayerExpertBytes, memoryBudgetBytes } = inputs;
	if (backend === 'cpu') {
		return undefined; // everything already on CPU
	}
	if (!perLayerExpertBytes || perLayerExpertBytes.length === 0 || modelBytes <= 0 || !memoryBudgetBytes || memoryBudgetBytes <= 0) {
		return undefined; // no per-layer data -> caller uses the uniform --n-cpu-moe estimate
	}
	const hasExperts = perLayerExpertBytes.some(b => b > 0);
	if (!hasExperts) {
		return undefined; // no routed-expert tensors -> not a MoE model (or dense variant)
	}
	const fraction = inputs.budgetFraction && inputs.budgetFraction > 0 ? inputs.budgetFraction : 0.9;
	const budget = memoryBudgetBytes * fraction;
	if (modelBytes <= budget) {
		return undefined; // fits as-is
	}
	const overBytes = modelBytes - budget;
	const chosen: number[] = [];
	let moved = 0;
	// Highest block first: matches --n-cpu-moe's "top N" convention and keeps the early dense blocks on GPU.
	for (let layer = perLayerExpertBytes.length - 1; layer >= 0 && moved < overBytes; layer--) {
		const expertBytes = perLayerExpertBytes[layer] ?? 0;
		if (expertBytes <= 0) {
			continue; // dense block (no experts) - nothing to move here
		}
		chosen.push(layer);
		moved += expertBytes;
	}
	if (chosen.length === 0) {
		return undefined;
	}
	return chosen.sort((a, b) => a - b);
}

/**
 * Renders a set of transformer-block indices into a llama.cpp `-ot` rule that pins those blocks' routed-expert
 * FFN tensors to the CPU: `blk\.(<i>|<j>|...)\.ffn_(gate|up|down)_exps\.=CPU`. The trailing `\.` after the
 * index group anchors the match so e.g. block `3` never also matches `blk.13.`. Returns undefined for an empty
 * set. One compact rule (single `-ot`) rather than one flag per block keeps the command line small.
 */
export function buildExpertOffloadOverride(layerIndices: readonly number[]): string | undefined {
	const uniqueSorted = Array.from(new Set(layerIndices.filter(n => Number.isInteger(n) && n >= 0))).sort((a, b) => a - b);
	if (uniqueSorted.length === 0) {
		return undefined;
	}
	const group = uniqueSorted.join('|');
	return `blk\\.(${group})\\.ffn_(gate|up|down)_exps\\.=CPU`;
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
		// Use the model's chat template for native tool calling. Required for llama-server to parse
		// tool calls AND to stream `delta.tool_calls` argument fragments incrementally (which powers
		// the live "editing file.ts" card in chat); without it tool-call args buffer to stream end.
		'--jinja',
	];

	// Multimodal projector: enables image input. Only present for vision models whose projector was downloaded.
	if (tuning.mmprojPath && tuning.mmprojPath.trim()) {
		args.push('--mmproj', tuning.mmprojPath.trim());
	}

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
	// (~b9180+) support this. The MTP head is embedded in the main GGUF, so `--spec-type draft-mtp` ALONE
	// loads it as a lightweight single-layer draft context (~100-300 MB) straight from the main model - the
	// server logs `[spec] estimated memory usage of MTP context is <N> MiB`. We deliberately do NOT pass
	// `--model-draft <same.gguf>` here: that routes MTP through the generic separate-draft path, which
	// mmaps and loads a SECOND full copy of the weights (a 27B doubles to ~32 GB and busts the Metal/VRAM
	// budget). The spec-type flag name is build-specific, so it is configurable via mtpArgs.
	if (tuning.multiTokenPrediction) {
		const mtpArgs = (tuning.mtpArgs && tuning.mtpArgs.trim()) ? tuning.mtpArgs.trim() : '--spec-type draft-mtp';
		args.push(...mtpArgs.split(/\s+/));
	} else if (tuning.draftModelPath && tuning.draftModelPath.trim()) {
		// Speculative decoding with a SEPARATE small draft model: the small model proposes tokens and the
		// big model verifies them in one batch, so when they agree we generate several tokens per big-model
		// pass. Only used when MTP (embedded draft head) is off, since both drive --model-draft.
		// `--spec-type draft-simple` is required on current llama.cpp builds, where the spec type defaults
		// to `none` (a bare --model-draft no longer implies speculation). Old builds that predate --spec-type
		// reject the flag and fail to start; the runner detects that crash and relaunches without speculation.
		args.push('--model-draft', tuning.draftModelPath.trim(), '--spec-type', 'draft-simple');
		if (tuning.draftGpuLayers !== undefined && tuning.draftGpuLayers > 0) {
			args.push('--gpu-layers-draft', String(Math.floor(tuning.draftGpuLayers)));
		}
	}

	// Fine-grained tensor placement (`-ot`): the tensor-level generalisation of --n-cpu-moe. When the runner
	// has real per-layer weight sizes it offloads the experts of EXACTLY the chosen blocks via these rules,
	// which fits more model on the same GPU than the coarse "top N blocks". Each entry is one `-ot` flag.
	const overrideTensors = (tuning.overrideTensors ?? []).map(s => s.trim()).filter(s => s.length > 0);
	for (const rule of overrideTensors) {
		args.push('-ot', rule);
	}

	// MoE expert offload: keep N blocks' expert FFN tensors in system RAM while attention stays on the GPU.
	// Only meaningful for Mixture-of-Experts models; the runner sizes this from GGUF expert_count + memory.
	// Skipped when `-ot` rules are present: both place expert tensors, and mixing them double-counts the
	// offload (the -ot rules already move the experts the planner selected).
	if (overrideTensors.length === 0 && tuning.cpuMoeLayers && tuning.cpuMoeLayers > 0) {
		args.push('--n-cpu-moe', String(Math.floor(tuning.cpuMoeLayers)));
	}

	// Prompt-lookup / n-gram speculative decoding (build-specific, opt-in). No separate model; drafts from
	// the context itself. Flags are configurable because their names differ across llama.cpp builds.
	// Skipped whenever a draft-based speculation is active: both emit `--spec-type`, and the server takes
	// exactly one speculation strategy - a duplicated flag would override or reject the draft setup.
	const draftSpecActive = !!tuning.multiTokenPrediction || !!(tuning.draftModelPath && tuning.draftModelPath.trim());
	if (tuning.promptLookup && !draftSpecActive) {
		const lookupArgs = (tuning.promptLookupArgs && tuning.promptLookupArgs.trim()) ? tuning.promptLookupArgs.trim() : '--spec-type ngram-cache';
		args.push(...lookupArgs.split(/\s+/));
	}

	// Persist per-slot KV cache to disk so a previously-processed prompt prefix survives restarts.
	// `--slot-save-path` enables the save capability, but recent llama.cpp builds gate the actual
	// `POST /slots/:id?action=save|restore` route behind the slots endpoint, which is DISABLED by default
	// (a request 404s without it). `--slots` turns that endpoint on so save/restore are reachable.
	if (tuning.slotSavePath && tuning.slotSavePath.trim()) {
		args.push('--slot-save-path', tuning.slotSavePath.trim());
		args.push('--slots');
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

	// Cap the host-RAM prompt cache so its real size matches what the memory accounting books for it
	// (the build default is 8192 MiB). 0 is meaningful (disable); undefined leaves the build default.
	if (tuning.cacheRamMiB !== undefined && tuning.cacheRamMiB >= 0) {
		args.push('--cache-ram', String(Math.floor(tuning.cacheRamMiB)));
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

	// Full-size SWA KV cache: restores cross-turn prompt-cache reuse on Sliding-Window Attention models
	// (Gemma 2/3). The runner only sets this when the model is SWA AND the full cache fits the budget.
	if (tuning.swaFull) {
		args.push('--swa-full');
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

/**
 * Root base URL (no `/v1` prefix). llama.cpp's native endpoints - `/health`, `/slots`,
 * `/slots/:id?action=save|restore` - live at the root; only the OpenAI-compat routes are under `/v1`.
 * Use this for the slot save/restore calls, otherwise they 404 against `/v1/slots/...`.
 */
export function getLlamaServerRootUrl(port: number = LOCOPILOT_LLAMA_SERVER_PORT): string {
	return `http://127.0.0.1:${port}`;
}
