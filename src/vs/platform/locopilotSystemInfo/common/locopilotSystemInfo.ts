/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILoCoPilotSystemInfoService = createDecorator<ILoCoPilotSystemInfoService>('locopilotSystemInfoService');

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';

export interface IGpuInfo {
	readonly vendor: GpuVendor;
	readonly name: string;
	/** Total dedicated VRAM in bytes, or 0 when unknown (e.g. integrated/unified memory). */
	readonly totalVramBytes: number;
	/** Free VRAM in bytes at probe time, or 0 when unknown. */
	readonly freeVramBytes: number;
	/**
	 * True when this adapter has no memory pool of its own and draws on system RAM (Intel/AMD integrated
	 * graphics, Apple unified memory). Whatever such an adapter reports as "dedicated VRAM" is a carve-out of
	 * system RAM, not a second pool that can be budgeted on top of it - so callers sizing an inference budget
	 * must fall back to the system-RAM budget instead of treating the reported figure as a VRAM ceiling.
	 */
	readonly isIntegrated: boolean;
}

export interface ISystemHardwareInfo {
	/** Number of physical CPU cores (performance cores on hybrid CPUs), best-effort. */
	readonly physicalCoreCount: number;
	/** Number of logical CPUs (`os.cpus().length`), i.e. hardware threads. */
	readonly logicalCoreCount: number;
	/** Detected discrete GPUs with their VRAM, best-effort. Empty when none detected/probeable. */
	readonly gpus: IGpuInfo[];
	/**
	 * Apple Silicon only: the user-configured GPU wired-memory limit in bytes (`sysctl iogpu.wired_limit_mb`),
	 * or 0 when unset/unknown/not-macOS. When a user raised this limit (common on high-RAM Macs used for
	 * inference), the Metal offload budget may use it instead of the default fraction heuristic.
	 */
	readonly metalWiredLimitBytes?: number;
}

/**
 * Coarse memory-pressure level. On macOS this mirrors `kern.memorystatus_vm_pressure_level`
 * (1 = normal, 2 = warn, 4 = critical); on Linux it is derived from PSI when available.
 * 'unknown' when the platform gives no signal - callers must then rely on availableBytes alone.
 */
export type MemoryPressureLevel = 'normal' | 'warn' | 'critical' | 'unknown';

/**
 * Coarse thermal-pressure level, mirroring NSProcessInfoThermalState / macOS `kern.thermalpressurelevel`
 * (0 = nominal, 1 = fair, 2 = serious, 3 = critical). Sustained 'serious'/'critical' means the system is
 * actively throttling to shed heat - a distinct failure mode from OOM that memory sampling alone misses,
 * and a reason to stop a heavy inference load before the machine forces a thermal shutdown. 'unknown' on
 * platforms/versions that expose no thermal signal.
 */
export type ThermalPressureLevel = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';

/**
 * A LIVE snapshot of system memory, taken at call time (never cached - unlike the hardware probe).
 *
 * `availableBytes` is the memory the OS could actually give an allocating process WITHOUT swapping:
 * free + reclaimable (file cache / inactive / purgeable) pages. This is deliberately NOT `os.freemem()`,
 * which on macOS counts only truly-free pages (wildly pessimistic - most RAM sits in reclaimable file
 * cache) and on Linux excludes reclaimable cache too. Windows' freemem is already "available".
 */
export interface IMemoryStatus {
	readonly totalBytes: number;
	/** Free + reclaimable memory in bytes; 0 when it could not be determined. */
	readonly availableBytes: number;
	readonly pressure: MemoryPressureLevel;
	/** Bytes of swap currently in use, or -1 when unknown. Rising swap while a model runs = thrashing. */
	readonly swapUsedBytes: number;
	/** System thermal-pressure level (macOS only for now); 'unknown' where unavailable. */
	readonly thermalPressure: ThermalPressureLevel;
}

/**
 * Probes the host machine for CPU core counts and GPU/VRAM, so the local-model runner can size
 * `--threads` and `--n-gpu-layers` to the hardware instead of guessing. The sandboxed renderer cannot
 * read `os.cpus()` or spawn `nvidia-smi`, so this runs in the shared (utility) process and is proxied
 * over IPC, mirroring {@link ILoCoPilotGitService}.
 *
 * All probing is best-effort: fields default to 0/empty rather than throwing, and the result is cached
 * (hardware does not change during a session).
 */
export interface ILoCoPilotSystemInfoService {
	readonly _serviceBrand: undefined;
	getHardwareInfo(): Promise<ISystemHardwareInfo>;
	/**
	 * Live system-memory snapshot (see {@link IMemoryStatus}). Never cached: the local-model runner calls
	 * this before every launch decision and from its runtime watchdog, so it must reflect the machine NOW.
	 * Best-effort: fields degrade to 0/'unknown'/-1 rather than throwing.
	 */
	getMemoryStatus(): Promise<IMemoryStatus>;
	/**
	 * Lowers the scheduling priority of a process (an inference server we spawned) so the OS keeps the UI
	 * responsive - and on Apple Silicon prefers efficiency cores under contention, reducing heat - while the
	 * model still gets full throughput when the machine is otherwise idle. Best-effort: resolves false when
	 * the platform tools are missing or the call fails; never throws.
	 */
	deprioritizeProcess(pid: number): Promise<boolean>;
}
