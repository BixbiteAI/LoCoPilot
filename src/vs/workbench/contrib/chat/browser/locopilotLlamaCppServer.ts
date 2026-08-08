/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { join as pathJoin } from '../../../../base/common/path.js';
import type { PowerSource, ThermalPressureLevel } from '../../../../platform/locopilotSystemInfo/common/locopilotSystemInfo.js';

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
	/** Adapter product name, when the probe could read it. Absent shapes simply skip the name-based gate. */
	name?: string;
}

/**
 * Intel graphics generations where Vulkan offload is worth taking over the CPU build: the Xe line (Tiger Lake
 * "Iris Xe" and later) and everything branded Arc, which covers both the discrete A/B-series cards and the
 * integrated Arc GPU in Core Ultra parts. Deliberately does NOT match the older HD/UHD/Iris Plus iGPUs, whose
 * execution-unit counts are low enough that Vulkan can be slower than running on the CPU.
 */
const INTEL_VULKAN_CAPABLE_NAME = /\barc\b|\biris xe\b|\bxe graphics\b/;

/**
 * Whether an adapter name identifies an Intel GPU worth using Vulkan on. Trademark markers are stripped first
 * because Windows reports names like `Intel(R) Iris(R) Xe Graphics`, where the `(R)` splits the "Iris Xe"
 * that Linux's `lspci` reports contiguously.
 */
export function isVulkanCapableIntelGpuName(name: string | undefined): boolean {
	if (!name) {
		return false;
	}
	const normalized = name.toLowerCase().replace(/\((?:r|tm)\)|[\u00AE\u2122]/g, ' ').replace(/\s+/g, ' ');
	return INTEL_VULKAN_CAPABLE_NAME.test(normalized);
}

/**
 * Decides whether the machine's GPU is capable enough to prefer the bundled **Vulkan** engine over the
 * CPU build (Windows/Linux only - Apple Silicon uses Metal and never reaches this path).
 *
 * The intent is "discrete/decent GPU -> Vulkan, weak integrated GPU -> CPU":
 *  - NVIDIA or AMD -> yes. These are discrete cards (or capable AMD APUs); Vulkan offload clearly wins.
 *  - Intel/unknown -> when we measured a meaningful dedicated VRAM pool
 *    ({@link VULKAN_MIN_DEDICATED_VRAM_BYTES}+), OR when the adapter NAME identifies a modern Intel GPU
 *    ({@link isVulkanCapableIntelGpuName}). The VRAM test alone permanently excluded every Intel integrated
 *    GPU however capable, because an iGPU borrows system memory and so reports no dedicated pool at all - a
 *    brand-new Core Ultra laptop was pinned to the CPU build for the same reason a 2016 UHD one was. The name
 *    check is purely additive: anything that qualified on VRAM still qualifies, and an Intel GPU we cannot
 *    name still falls back to the VRAM rule (i.e. stays on CPU), so this can only widen, never narrow.
 *  - Apple GPUs are ignored here (handled by the Metal path).
 */
export function shouldUseBundledVulkan(gpus: readonly GpuLike[]): boolean {
	return gpus.some(g => {
		if (g.vendor === 'nvidia' || g.vendor === 'amd') {
			return true;
		}
		if (g.vendor === 'intel' || g.vendor === 'unknown') {
			return g.totalVramBytes >= VULKAN_MIN_DEDICATED_VRAM_BYTES || isVulkanCapableIntelGpuName(g.name);
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

/** A concrete KV precision (no 'auto'), as accepted by `--cache-type-k` / `--cache-type-v`. */
export type KvCacheElemType = Exclude<KvCacheType, 'auto'>;

/**
 * The K and V halves of the KV cache, quantized INDEPENDENTLY. llama.cpp takes `--cache-type-k` and
 * `--cache-type-v` separately, and the two halves do not degrade equally: 4-bit K costs very little accuracy
 * while 4-bit V is where most of the quality loss of a "q4 KV cache" actually comes from. Keeping V at q8_0
 * while dropping K to q4_0 therefore buys ~75% of the memory saving of a symmetric q4 cache for a fraction of
 * the quality cost - which is exactly the trade we want when the budget can't reach the comfort context at q8.
 */
export interface KvCachePlan {
	k: KvCacheElemType;
	v: KvCacheElemType;
}

/**
 * The automatic KV precision ladder, best quality first. Each rung is strictly cheaper per token than the one
 * above it, so {@link selectAutomaticKvCache} can walk it and stop at the first rung that reaches the context
 * we're aiming for. The asymmetric q4/q8 rung sits between the two symmetric ones and is the reason a
 * memory-tight machine no longer has to jump straight from q8 to a full 4-bit cache.
 *
 * Bytes per element: f16/f16 = 2.0, q8/q8 = 1.0625, q4/q8 = 0.8125, q4/q4 = 0.5625.
 */
export const KV_CACHE_TIERS: readonly KvCachePlan[] = [
	{ k: 'f16', v: 'f16' },
	{ k: 'q8_0', v: 'q8_0' },
	{ k: 'q4_0', v: 'q8_0' },
	{ k: 'q4_0', v: 'q4_0' },
];

/** Stable short id for a KV plan ('q8_0', 'q4_0-q8_0', ...). Used for logging and the slot-cache file key. */
export function kvPlanId(plan: KvCachePlan): string {
	return plan.k === plan.v ? plan.k : `${plan.k}-${plan.v}`;
}

/** Average bytes-per-element across the K and V halves - what the cache actually costs per token. */
export function kvPlanBytesPerElem(plan: KvCachePlan): number {
	return (kvCacheBytesPerElem(plan.k) + kvCacheBytesPerElem(plan.v)) / 2;
}

/** A symmetric plan (both halves at the same precision), for a user-pinned fixed KV type. */
export function symmetricKvPlan(type: KvCacheElemType): KvCachePlan {
	return { k: type, v: type };
}

/**
 * Which halves of the KV cache the engine can actually quantize FOR A GIVEN MODEL. llama.cpp implements a
 * quantized V cache only inside the Flash Attention kernel, so `--cache-type-v q8_0` makes context creation
 * FATAL whenever FA is unavailable:
 *
 *   W sched_reserve: layer 3 is assigned to device MTL0 but the Flash Attention tensor is assigned to device CPU
 *   W sched_reserve: Flash Attention was auto, set to disabled
 *   E llama_init_from_model: failed to initialize the context: quantized V cache was requested, but this
 *     requires Flash Attention
 *
 * The K half has a dequantizing path outside FA, so a quantized K keeps working when FA is off - the two
 * halves are NOT interchangeable here, which is exactly why the ladder tracks them separately.
 *
 * Whether FA can be placed on the GPU is not knowable before launch: it depends on the model architecture AND
 * on the offload plan we hand it (a model whose tensors all sit on Metal gets FA; the same architecture with
 * experts overridden to CPU can lose it). So this is discovered from a failed launch and remembered PER MODEL -
 * never as a session-wide or build-wide switch, which would needlessly downgrade every other model.
 */
export interface KvQuantCapability {
	/** false once the engine rejected a quantized K cache for this model. */
	k: boolean;
	/** false once the engine rejected a quantized V cache for this model (the common case: no Flash Attention). */
	v: boolean;
}

/** Default assumption for a model we have never seen fail: both halves quantizable. */
export const KV_QUANT_FULLY_SUPPORTED: KvQuantCapability = Object.freeze({ k: true, v: true });

/**
 * Coerces a KV plan to something the engine can actually create for this model, by pinning any half it has
 * rejected back to f16. Quantizing the OTHER half is still worth doing - dropping only V from q8_0 to f16 keeps
 * roughly half of the cache saving instead of falling all the way back to a full-precision cache.
 */
export function applyKvQuantCapability(plan: KvCachePlan, capability: KvQuantCapability | undefined): KvCachePlan {
	if (!capability || (capability.k && capability.v)) {
		return plan;
	}
	return {
		k: capability.k ? plan.k : 'f16',
		v: capability.v ? plan.v : 'f16',
	};
}

/**
 * The precision ladder restricted to what this model's engine can create: every rung has its rejected halves
 * pinned to f16, and the duplicates that then collapse into each other are dropped (with V unquantizable,
 * q4/q8 and q4/q4 both become q4/f16). The result keeps the ladder's two invariants - ordered best-quality
 * first, and strictly cheaper per token as you descend - so callers can walk it exactly as before.
 */
export function kvCacheTiersFor(capability: KvQuantCapability | undefined, tiers: readonly KvCachePlan[] = KV_CACHE_TIERS): readonly KvCachePlan[] {
	if (!capability || (capability.k && capability.v)) {
		return tiers;
	}
	const seen = new Set<string>();
	return tiers.map(tier => applyKvQuantCapability(tier, capability)).filter(tier => {
		const id = kvPlanId(tier);
		if (seen.has(id)) {
			return false;
		}
		seen.add(id);
		return true;
	});
}

/**
 * Detects the "engine refused this KV quantization" startup failure in a llama-server log tail and reports
 * WHICH half it refused. Returns undefined for any other failure, so callers can fall through to their other
 * crash handlers. Matched loosely (the sentence has been reworded across llama.cpp releases) but still anchored
 * on all three of "quantized", the half, and "flash attention", so it can't swallow unrelated errors.
 */
export function detectRejectedKvQuantHalf(output: string): 'k' | 'v' | undefined {
	const match = /quantized\s+([KV])\s+cache[^\n]*?requires[^\n]*?flash\s*attention/i.exec(output);
	if (!match) {
		return undefined;
	}
	return match[1].toLowerCase() === 'k' ? 'k' : 'v';
}

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
 * VRAM (bytes) held back on a discrete GPU for the display/compositor and the driver's own allocations. Unlike
 * system RAM there is no swap behind VRAM: an allocation past the limit fails outright and the server dies with
 * a CUDA/Vulkan out-of-memory error rather than degrading, so the reserve is an absolute floor rather than a
 * fraction. 768 MiB covers a desktop compositor plus driver context on both vendors.
 */
export const VRAM_DRIVER_RESERVE_BYTES = 768 * 1024 * 1024;

/**
 * Usable VRAM (bytes) for inference on a discrete GPU: what is FREE right now, less the driver/display reserve,
 * and never more than the card physically has. Sizing off free rather than total is what makes the budget
 * account for other GPU consumers (a browser, a game, another model, a compositor on a shared card) - charging
 * the full card when half of it is already committed is exactly how a launch passes the gate and then dies at
 * the first large allocation. Falls back to total when the free figure is unknown (0), which is the old,
 * more permissive behavior. Returns 0 when nothing usable is left.
 */
export function discreteVramBudgetBytes(totalVramBytes: number, freeVramBytes?: number): number {
	if (!(totalVramBytes > 0)) {
		return 0;
	}
	const available = freeVramBytes && freeVramBytes > 0 ? Math.min(freeVramBytes, totalVramBytes) : totalVramBytes;
	return Math.max(0, Math.floor(available - VRAM_DRIVER_RESERVE_BYTES));
}

/**
 * Splits a llama.cpp launch's footprint across the TWO pools a discrete-GPU run actually draws on, because they
 * fail differently and cannot be summed: VRAM holds the offloaded weights, the whole KV cache and the compute
 * buffers, and overflowing it is a hard OOM; host RAM holds the CPU-resident weight remainder and the engine's
 * host-side allocations, and overflowing that only pages. Summing the two pools into one "usable" number (the
 * old gate) admitted a launch whose KV could never fit the card, because the machine's spare system RAM covered
 * the difference on paper.
 *
 * `gpuWeightBytes` is the weight portion that will actually reside in VRAM after the offload plan; the caller
 * derives it from `--n-gpu-layers` / the MoE expert split.
 */
export function splitDiscreteGpuFootprint(inputs: {
	weightBytes: number;
	gpuWeightBytes: number;
	kvBytes: number;
	/** Total engine overhead; the GPU share (driver context + compute graphs) is charged to VRAM. */
	overheadBytes: number;
	/** Extra co-resident weights (draft model, vision projector) - they load wherever the main weights do. */
	extraResidentBytes: number;
	/** Fraction of `overheadBytes` charged to VRAM rather than host RAM. */
	gpuOverheadFraction?: number;
}): { vramRequiredBytes: number; hostRequiredBytes: number } {
	const gpuWeights = Math.max(0, Math.min(inputs.gpuWeightBytes, inputs.weightBytes));
	const hostWeights = Math.max(0, inputs.weightBytes - gpuWeights);
	const gpuShare = Math.min(1, Math.max(0, inputs.gpuOverheadFraction ?? DISCRETE_GPU_OVERHEAD_FRACTION));
	const overhead = Math.max(0, inputs.overheadBytes);
	// Extras follow the main weights: fully offloaded -> VRAM, partially offloaded -> the same proportion.
	const offloadRatio = inputs.weightBytes > 0 ? gpuWeights / inputs.weightBytes : 1;
	const extras = Math.max(0, inputs.extraResidentBytes);
	return {
		// The KV cache lives entirely on the device that runs attention - it is never split.
		vramRequiredBytes: gpuWeights + Math.max(0, inputs.kvBytes) + overhead * gpuShare + extras * offloadRatio,
		hostRequiredBytes: hostWeights + overhead * (1 - gpuShare) + extras * (1 - offloadRatio),
	};
}

/**
 * Share of the engine's runtime overhead that lands in VRAM on a discrete GPU (compute graphs, driver context,
 * scratch buffers) rather than host RAM (tokenizer, host prompt cache, bookkeeping). Most of the growth terms in
 * {@link runtimeOverheadBytesForTuning} are compute buffers, so the majority is charged to the device.
 */
export const DISCRETE_GPU_OVERHEAD_FRACTION = 0.75;

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

/** The concrete profiles a launch can run under, once `auto` has been resolved. */
export type ResolvedPerformanceProfile = 'performance' | 'balanced' | 'quiet';

/**
 * Resolves the `auto` performance profile from the machine's live power and thermal state. Engine-agnostic:
 * both the llama.cpp and the MLX launch planners run their tuning through it.
 *
 * Precedence is deliberate. Thermal outranks power because a machine that is ALREADY throttling has a problem
 * that being plugged in does not fix - and adding a full-tilt inference load there is what ends with the
 * memory/thermal watchdog stopping a server outright. Everything else, including every 'unknown', resolves to
 * `performance`: a probe that failed must leave behaviour exactly as it was rather than quietly throttling a
 * workstation on missing data.
 */
export function resolveAutoPerformanceProfile(power: PowerSource, thermal: ThermalPressureLevel): ResolvedPerformanceProfile {
	if (thermal === 'serious' || thermal === 'critical') {
		return 'quiet';
	}
	return power === 'battery' ? 'balanced' : 'performance';
}

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
 * Smallest context we will accept in exchange for turning `--swa-full` on. Below this a sliding-window model
 * is not usable for agent work (a system prompt alone can be ~7K), so we keep the larger windowed context and
 * pay the per-turn re-prefill instead. This is a FLOOR on the result, not a target: when the budget allows more
 * we keep more, capped by the context the caller already asked for.
 */
export const MIN_FULL_SWA_CONTEXT = 16384;

/**
 * Context the `--swa-full` KV re-plan aims for before it stops spending precision. Deliberately HIGHER than
 * the general {@link TARGET_MIN_CONTEXT} comfort floor, because swa-full is the one regime where the normal
 * "stop at the floor" rule gives the wrong answer: it pins a FULL-size cache on every sliding-window layer, so
 * KV becomes several times more expensive than the windowed sizing the clamp used, and the window collapses to
 * barely above the floor. In that regime context is the scarce resource and the next rung down is nearly free,
 * so it is worth buying more of it. (Measured on gemma-4-E4B on a 16 GB M3: the floor-based rule stopped at f16
 * / ~34K; aiming here reaches ~56K at q8_0 for the same footprint.)
 */
export const SWA_FULL_REPLAN_TARGET_CONTEXT = 65536;

/**
 * The lowest KV rung the `--swa-full` re-plan may descend to. Capped at near-lossless q8_0 ON PURPOSE: the
 * entire justification for spending precision to buy context here is that q8_0's quality delta is too small to
 * measure, and that argument does NOT extend to the 4-bit rungs. If q8_0 still can't reach the target we keep
 * the shorter window rather than quietly trading real quality for length nobody asked for - the general ladder
 * in {@link selectAutomaticKvCache} remains the only place 4-bit is reached, and only to rescue the floor.
 */
export const SWA_FULL_REPLAN_MAX_TIER: KvCachePlan = { k: 'q8_0', v: 'q8_0' };

/**
 * Largest context whose FULL-size SWA KV cache still fits the memory budget - the inverse of
 * {@link swaFullKvHeadroomBytes}. The old gate asked "does --swa-full fit at the context we already picked?"
 * and gave up when it didn't, which silently left cross-turn prompt-cache reuse off on every sliding-window
 * model (measured: a 7.4K-token turn re-prefilling in 33s instead of resuming in 62ms). Trading context for
 * reuse is almost always the right call for chat/agent work, so instead we solve for the context that DOES
 * fit and clamp to it.
 *
 * Returns 0 when nothing usable fits, or when the per-token cost is unknown - callers keep the windowed cache.
 * The result is rounded down to a 1024 multiple and never exceeds `requestedContext`.
 */
export function maxContextForFullSwa(inputs: {
	budgetBytes: number;
	residentWeightBytes: number;
	/** KV bytes per token across ALL layers with --swa-full on (every layer holds the full context). */
	fullSwaBytesPerToken: number;
	requestedContext: number;
	promptCacheReserveBytes: number;
	overheadBytes?: number;
	graphMarginFraction?: number;
}): number {
	if (!(inputs.fullSwaBytesPerToken > 0) || !(inputs.budgetBytes > 0) || !(inputs.requestedContext > 0)) {
		return 0;
	}
	// Headroom with a zero-size KV cache: everything the budget must hold regardless of context.
	const available = swaFullKvHeadroomBytes({
		budgetBytes: inputs.budgetBytes,
		residentWeightBytes: inputs.residentWeightBytes,
		fullSwaKvBytes: 0,
		promptCacheReserveBytes: inputs.promptCacheReserveBytes,
		overheadBytes: inputs.overheadBytes,
		graphMarginFraction: inputs.graphMarginFraction,
	});
	if (available <= 0) {
		return 0;
	}
	const maxTokens = Math.floor(available / inputs.fullSwaBytesPerToken);
	const ctx = Math.floor(Math.min(maxTokens, inputs.requestedContext) / 1024) * 1024;
	return Math.max(0, ctx);
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

/**
 * Resolves the K/V plan for a launch that did NOT go through {@link selectAutomaticKvCache} (no memory budget
 * known, or a user-pinned fixed type). A pinned type is honoured symmetrically - the asymmetric q4/q8 rung is
 * an automatic choice only, so "I set q4_0" keeps meaning exactly q4_0 on both halves.
 */
export function resolveKvCachePlan(kvCacheType: KvCacheType, contextSize: number): KvCachePlan {
	return symmetricKvPlan(resolveKvCacheType(kvCacheType, contextSize));
}

/** Inputs for {@link clampContextSize}; all optional except the requested size. */
export interface ContextClampInputs {
	/** Context the caller wants (from per-model setting or the global default). */
	requestedContext: number;
	/** The model's trained context window from GGUF (`<arch>.context_length`); we never exceed it. */
	modelContextLength?: number;
	/**
	 * Bytes of memory the KV cache may use (a slice of the free RAM/VRAM budget). `undefined` = unknown, skip
	 * the memory clamp entirely. `0` is NOT the same as unknown - it means the weights plus runtime overhead
	 * already consumed the whole budget, and clamps the window to the floor.
	 */
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
	/**
	 * Overrides the usability floor ({@link MIN_CLAMPED_CONTEXT}) this clamp refuses to go below. Only the
	 * post-OOM degradation ladder passes this ({@link ABSOLUTE_MIN_CONTEXT}): the machine has already proven it
	 * cannot hold the planned window, so the ladder's smaller cap must survive the clamp instead of being
	 * silently raised back to the floor - which would relaunch straight into the same OOM.
	 */
	minContext?: number;
}

/**
 * Smallest context the PLANNER will ever clamp down to. This is a usability floor, not a memory one: this
 * agent's system prompt plus tool schemas alone run ~7-10K tokens, so a window below ~16K cannot hold a system
 * prompt, a file, and a couple of tool round-trips - the model launches "successfully" and then fails every
 * multi-turn task, which is worse than a model that tells you it's a tight fit. So we always ask for at least
 * this much (the runtime memory watchdog is the backstop if the machine genuinely can't sustain it) rather than
 * silently handing back a 5K window.
 *
 * A model whose own trained window is smaller than this is capped by its own window instead - the floor never
 * inflates a context past what the model was trained for (see {@link clampContextSize}).
 */
export const MIN_CLAMPED_CONTEXT = 16384;

/**
 * Absolute smallest context anything may run at - used ONLY by the post-OOM degradation ladder, where the
 * machine has already proven at runtime that it cannot hold the planned window and the choice is between a
 * cramped model and no model. The planner never targets this; {@link MIN_CLAMPED_CONTEXT} is its floor.
 */
export const ABSOLUTE_MIN_CONTEXT = 4096;

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
 * The FIXED (context-independent) resident cost of the embedded MTP draft head, as a fraction of the model
 * weights, with a floor and a ceiling.
 *
 * MTP's memory has two halves and they are budgeted in different places. The draft context's KV cache scales
 * with `n_ctx` and is charged by the context clamp via {@link MTP_DRAFT_KV_LAYER_EQUIV}; this covers only the
 * other half - the single-layer head's own tensors. Keeping them separate is the point: the previous model
 * charged a flat ~8% of the weights (1.4 GB on a 27B) as if the whole thing were fixed, which both
 * double-counted the KV the clamp had already reserved AND scaled with entirely the wrong variable. Measured
 * reference: llama.cpp reported a 764.82 MiB total MTP context for a ~1.4 GB 2B model at a 183K window - i.e.
 * almost all of that figure was context-scaling KV, not head tensors.
 */
export const MTP_HEAD_WEIGHT_FRACTION = 0.02;
export const MTP_HEAD_MIN_BYTES = Math.round(128 * 1e6);
export const MTP_HEAD_MAX_BYTES = Math.round(512 * 1e6);

/** Fixed resident bytes for the embedded MTP draft head. See {@link MTP_HEAD_WEIGHT_FRACTION}. */
export function mtpHeadResidentBytes(weightBytes: number): number {
	if (!(weightBytes > 0)) {
		return MTP_HEAD_MIN_BYTES;
	}
	return Math.round(Math.min(Math.max(weightBytes * MTP_HEAD_WEIGHT_FRACTION, MTP_HEAD_MIN_BYTES), MTP_HEAD_MAX_BYTES));
}

/**
 * Max context checkpoints per slot (`--ctx-checkpoints`). llama.cpp defaults to 32, and each checkpoint is a
 * HOST-RAM copy of the sliding-window / recurrent state - measured at 149.6 MiB on a 27B with a 46K window, so
 * the default quietly reserves up to ~4.8 GB that none of our memory accounting books. The restore path only
 * looks for the most recent usable checkpoint, so a handful still covers the case that matters (the next agent
 * turn continuing the same prefix) at a fraction of the RAM.
 */
export const LLAMA_CTX_CHECKPOINTS = 4;

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
	// `undefined` means "no budget known" (skip the clamp); ZERO means "the weights and overhead already consumed
	// the entire budget", which must clamp to the floor - NOT skip. Reading 0 as unknown let a model whose weights
	// filled the budget escape with its full trained window, the exact opposite of what an exhausted budget means.
	if (inputs.kvBudgetBytes !== undefined && inputs.kvBudgetBytes >= 0) {
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
	// Round down to a 1024 multiple and never go below the usability floor. The floor is itself capped by the
	// model's own trained window, so an 8K-trained model floors at 8K rather than being pushed past its rope
	// scaling to 16K.
	ctx = Math.floor(ctx / 1024) * 1024;
	// The usability floor exists to stop the MEMORY BUDGET from collapsing the window to something unusable -
	// it is not a minimum we impose on anyone who deliberately asked for less. So it is itself capped by what
	// was asked for and by what the model was trained for: an explicit 8K request stays 8K, an 8K-trained model
	// stays at its window, and only a budget-driven collapse is lifted back up to the floor.
	const requestedFloor = inputs.minContext && inputs.minContext > 0
		? Math.min(MIN_CLAMPED_CONTEXT, Math.floor(inputs.minContext))
		: MIN_CLAMPED_CONTEXT;
	const ceilings = [requestedFloor];
	if (inputs.modelContextLength && inputs.modelContextLength > 0) {
		ceilings.push(inputs.modelContextLength);
	}
	if (inputs.requestedContext > 0) {
		ceilings.push(inputs.requestedContext);
	}
	return Math.max(Math.min(...ceilings), ctx);
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

/**
 * How much longer a cheaper KV rung must make the context before {@link selectAutomaticKvCache} will accept it
 * over a higher-quality one, when NEITHER reaches the comfort floor. 1.05 = "at least 5% more tokens". This is
 * what stops a pointless walk to the bottom of the ladder when the context is pinned by something other than
 * the KV budget (the model's own trained window, the usability floor, or MAX_CLAMPED_CONTEXT) and every rung
 * therefore returns an identical number.
 */
export const KV_TIER_DOWNGRADE_MIN_GAIN = 1.05;

export interface AutomaticKvCacheSelectionInputs extends ContextClampInputs {
	/**
	 * Model-specific f16 KV bytes per token per layer from GGUF attention geometry. Quantized candidates
	 * are derived from this value, ensuring all precisions are compared against exactly the same model.
	 */
	kvBytesPerTokenPerLayerF16?: number;
	/**
	 * Halves this model is allowed to quantize (see {@link KvQuantCapability}). A rejected half is pinned to f16
	 * BEFORE the ladder is priced, so the context clamp sizes the window for the cache the engine will really
	 * allocate - re-planning after a rejection must give back context, not silently over-commit memory.
	 */
	kvQuantCapability?: KvQuantCapability;
}

export interface AutomaticKvCacheSelection {
	/** The K/V precision pair to launch with. */
	kvCachePlan: KvCachePlan;
	contextSize: number;
}

/**
 * Selects automatic KV precision + context from the model's real geometry and memory budget, by walking
 * {@link KV_CACHE_TIERS} best-quality-first and stopping at the first rung that reaches the comfort context.
 *
 * The ladder is quality-ordered, so the rule is simply "spend precision only to buy context you don't have":
 *  - f16 is considered only for genuinely small windows, where the cache is cheap and full precision is free.
 *  - q8_0 is the normal answer: ~half the bytes of f16 at a quality delta too small to measure.
 *  - q4_0 K + q8_0 V is the first fallback - it recovers ~24% more context than q8 while leaving the V half
 *    (where 4-bit actually hurts) intact.
 *  - q4_0 on both halves is last, for machines that still can't reach the floor.
 *
 * A rung is accepted as soon as it clears the {@link TARGET_MIN_CONTEXT} comfort floor at its own fitting
 * context - we never trade quality down just to win length past the floor. When NO rung reaches the floor we
 * return the rung that granted the most context, but only if a cheaper rung actually bought a MATERIALLY longer
 * window ({@link KV_TIER_DOWNGRADE_MIN_GAIN}): swapping precision for a rounding-error's worth of extra tokens
 * is a pure quality loss. Selection happens before launch and stays fixed for the server lifetime, so an active
 * conversation never loses its cache to a precision change mid-session.
 */
export function selectAutomaticKvCache(inputs: AutomaticKvCacheSelectionInputs): AutomaticKvCacheSelection {
	const targetContext = clampContextSize({
		requestedContext: inputs.requestedContext,
		modelContextLength: inputs.modelContextLength,
		minContext: inputs.minContext,
	});
	// The bar a precision must clear to be "good enough": the comfort floor, but never above what the model's
	// own window allows (a 16K-trained model is satisfied by 16K, we don't drop to q4 chasing an impossible 32K).
	const satisfiedAt = Math.min(targetContext, TARGET_MIN_CONTEXT);
	// f16 is only in play for small windows; above the threshold the cache dominates memory and q8_0's quality
	// delta is negligible, so starting at f16 would just cost a rung and land on half the context for nothing.
	const openTiers = targetContext < KV_AUTO_QUANT_CONTEXT_THRESHOLD
		? KV_CACHE_TIERS
		: KV_CACHE_TIERS.filter(tier => !(tier.k === 'f16' && tier.v === 'f16'));
	// Restrict to what the engine can actually create for this model before pricing anything, so the context we
	// clamp to matches the cache that will really be allocated.
	const tiers = kvCacheTiersFor(inputs.kvQuantCapability, openTiers);
	const f16Bytes = inputs.kvBytesPerTokenPerLayerF16 && inputs.kvBytesPerTokenPerLayerF16 > 0
		? inputs.kvBytesPerTokenPerLayerF16
		: (inputs.kvBytesPerTokenPerLayer && inputs.kvBytesPerTokenPerLayer > 0
			? inputs.kvBytesPerTokenPerLayer
			: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16);
	let best: AutomaticKvCacheSelection | undefined;
	for (const kvCachePlan of tiers) {
		const perTokenPerLayer = f16Bytes * kvPlanBytesPerElem(kvCachePlan) / kvCacheBytesPerElem('f16');
		const contextSize = clampContextSize({
			requestedContext: inputs.requestedContext,
			modelContextLength: inputs.modelContextLength,
			kvBudgetBytes: inputs.kvBudgetBytes,
			layerCount: inputs.layerCount,
			kvBytesPerTokenPerLayer: perTokenPerLayer,
			slidingWindow: inputs.slidingWindow,
			swaFullOnAllLayers: inputs.swaFullOnAllLayers,
			minContext: inputs.minContext,
		});
		const candidate = { kvCachePlan, contextSize };
		// Accept the FIRST (highest-quality) precision that clears the comfort floor at its full fitting context -
		// don't drop to a lossier cache just because it would grant even more length past the floor.
		if (contextSize >= satisfiedAt) {
			return candidate;
		}
		// Below the floor: keep the cheaper rung only when it bought a materially longer window. Without this a
		// model pinned at the MIN_CLAMPED_CONTEXT floor (every rung returns the same number) would still walk all
		// the way down to q4/q4 and lose quality for literally zero extra tokens.
		if (!best || contextSize >= best.contextSize * KV_TIER_DOWNGRADE_MIN_GAIN) {
			best = candidate;
		}
	}
	return best ?? {
		kvCachePlan: applyKvQuantCapability(resolveKvCachePlan('auto', targetContext), inputs.kvQuantCapability),
		contextSize: targetContext,
	};
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
	 * Halves this model's engine has been observed to reject (see {@link KvQuantCapability}). Learned from a
	 * failed launch and remembered per model; a rejected half is emitted as f16 instead of failing again.
	 */
	kvQuantCapability?: KvQuantCapability;
	/**
	 * Resolved K/V precision pair, pinned by the launch planner after {@link selectAutomaticKvCache} has sized
	 * the context against the memory budget. When present it WINS over {@link kvCacheType} - the planner already
	 * decided, and re-resolving 'auto' from the (possibly clamped-down) window here would flip the precision the
	 * clamp budgeted for. Absent -> the type is resolved from `kvCacheType` symmetrically.
	 */
	kvCachePlan?: KvCachePlan;
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
	 * Load weights into anonymous memory instead of mapping the GGUF (`--no-mmap`).
	 *
	 * Set by the launch planner whenever tensors are placed on the CPU (`-ot` / `--n-cpu-moe`), which is
	 * exactly the case llama.cpp itself warns about: "tensor overrides to CPU are used with mmap enabled -
	 * consider using --no-mmap for better performance". Those CPU-resident tensors are touched on EVERY token,
	 * so leaving them file-backed turns each decode step into page-cache traffic - measured at ~290 tok/s
	 * prefill and ~25 tok/s decode for a 3B-active MoE on an M1 Max, several times below what the same split
	 * does without mmap.
	 *
	 * Only safe when the whole footprint fits physical RAM: without mmap the weights become anonymous pages
	 * that can only go to swap, whereas mmap'd pages are clean and evictable. The planner therefore gates this
	 * on the fit check rather than setting it unconditionally (see the `-ot` branch in the runner).
	 */
	noMmap?: boolean;
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
	// A plan pinned by the launch planner wins; otherwise 'auto' resolves to f16 for small windows and q8_0 for
	// large ones (see resolveKvCachePlan), and a fixed user type is applied to both halves.
	const plannedKvCachePlan = tuning.kvCachePlan ?? resolveKvCachePlan(tuning.kvCacheType ?? 'auto', contextSize);
	// Drop back to f16 on any half this model's engine has already rejected, so a relaunch after that failure
	// doesn't reproduce it. Only the failing half is given up; the other one keeps its saving.
	let kvCachePlan = applyKvQuantCapability(plannedKvCachePlan, tuning.kvQuantCapability);

	// Flash Attention and the V half of the KV cache are coupled: llama.cpp only implements a quantized V
	// inside the FA kernel, so `--cache-type-v <quant>` without FA is a FATAL context-creation error (the K
	// half has a non-FA path and is unaffected). `-fa auto` is NOT a safe carrier for a quantized V: 'auto'
	// resolves to OFF whenever the FA tensor can't be placed on the accelerator, and the launch then dies -
	// which is why the old "promote off -> auto so it never fails to start" trick did not hold. Two rules:
	//  - The user explicitly disabling FA is honoured, not overridden; we give up the V quantization instead.
	//  - With FA on/auto we still emit the quantized V, because 'auto' DOES resolve to on for most models and
	//    forcing '-fa on' would push attention onto a slow CPU path for the rest. The launch failure on the
	//    models where it resolves off is caught by the caller, recorded in kvQuantCapability, and healed above.
	const flashAttention: FlashAttentionMode = tuning.flashAttention ?? 'auto';
	if (flashAttention === 'off' && kvCachePlan.v !== 'f16') {
		kvCachePlan = { k: kvCachePlan.k, v: 'f16' };
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

	// KV cache quantization shrinks the cache (more context on-GPU, faster). f16 = the server default, so each
	// half only needs a flag when it differs. The halves are emitted independently because the automatic ladder
	// includes an asymmetric rung (4-bit K with an 8-bit V), which is a materially better quality-per-byte point
	// than a symmetric 4-bit cache.
	if (kvCachePlan.k !== 'f16') {
		args.push('--cache-type-k', kvCachePlan.k);
	}
	if (kvCachePlan.v !== 'f16') {
		args.push('--cache-type-v', kvCachePlan.v);
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
		// The draft context allocates its OWN KV at the same n_ctx as the target and does NOT inherit
		// `--cache-type-k/v` - llama.cpp logs `cache_k=f16, cache_v=f16` for the draft even when the target runs
		// q8_0. There is no flag to give the draft a smaller window (checked against b9789's option list), so
		// precision is the only lever on it. q8_0 roughly halves the cost; a marginally worse draft token is
		// rejected by the target's verification rather than emitted, so this trades a little acceptance for
		// memory, never correctness. Skipped when the target itself runs f16 (small window, or a model whose
		// engine refused quantized KV - the draft would refuse it too), and when the user pinned their own flags.
		if (kvCachePlan.k !== 'f16' && !mtpArgs.includes('--spec-draft-type-k')) {
			args.push('--spec-draft-type-k', 'q8_0');
		}
		if (kvCachePlan.v !== 'f16' && !mtpArgs.includes('--spec-draft-type-v')) {
			args.push('--spec-draft-type-v', 'q8_0');
		}
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
	//
	// The server may ignore this. Verified against llama.cpp b9789 (tools/server/server-context.cpp, the two
	// load-time gates at ~L1275/L1287 plus the per-slot re-check at ~L3159): `n_cache_reuse` is zeroed - with a
	// `cache_reuse is not supported ...` warning - when EITHER a multimodal projector is loaded (`--mmproj`) OR
	// `llama_memory_can_shift(ctx_tgt)` is false. That second one is false for:
	//   - M-RoPE / interleaved-M-RoPE architectures (`hparams.n_pos_per_embd() > 1`), which covers the whole
	//     natively-multimodal Qwen3.5/3.6 family - those models can NEVER use cache reuse, vision on or off;
	//   - sliding-window models whose base and SWA caches differ in size, i.e. SWA WITHOUT `--swa-full`
	//     (measured: gemma-4-E4B loses cache reuse by default and keeps it with `--swa-full`).
	// Speculative decoding does NOT gate it: `--spec-type draft-mtp`, `draft-simple` and `ngram-mod` all keep
	// cache reuse (measured on StarCoder2-3B), and the gates read the TARGET context only, never the draft one.
	// So the flag is emitted unconditionally: it is a harmless no-op on models that can't use it, and passing it
	// costs nothing beyond one warning line at load.
	const cacheReuse = tuning.cacheReuse !== undefined ? tuning.cacheReuse : 256;
	if (cacheReuse > 0) {
		args.push('--cache-reuse', String(Math.floor(cacheReuse)));
	}

	// Cap the per-slot context checkpoints so their host-RAM cost is bounded and matches what the memory
	// accounting assumes. See LLAMA_CTX_CHECKPOINTS - the build default of 32 is worth multiple GB on a
	// large-context model and is invisible to every budget we compute.
	args.push('--ctx-checkpoints', String(LLAMA_CTX_CHECKPOINTS));

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

	// Skip the weight mmap. The planner sets this when tensors are placed on the CPU (`-ot` / `--n-cpu-moe`)
	// and the footprint still fits physical RAM: mmap'd CPU tensors are re-faulted on every token, which is
	// the single biggest cost of an expert-offload split. See LlamaServerTuning.noMmap.
	if (tuning.noMmap) {
		args.push('--no-mmap');
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
