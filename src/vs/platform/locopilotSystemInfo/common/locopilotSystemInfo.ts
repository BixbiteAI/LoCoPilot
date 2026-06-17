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
}

export interface ISystemHardwareInfo {
	/** Number of physical CPU cores (performance cores on hybrid CPUs), best-effort. */
	readonly physicalCoreCount: number;
	/** Number of logical CPUs (`os.cpus().length`), i.e. hardware threads. */
	readonly logicalCoreCount: number;
	/** Detected discrete GPUs with their VRAM, best-effort. Empty when none detected/probeable. */
	readonly gpus: IGpuInfo[];
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
}
