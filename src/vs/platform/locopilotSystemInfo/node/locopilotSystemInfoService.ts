/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { cpus, arch, platform } from 'os';
import { ILogService } from '../../log/common/log.js';
import { IGpuInfo, ISystemHardwareInfo, ILoCoPilotSystemInfoService, GpuVendor } from '../common/locopilotSystemInfo.js';

/** Kill any probe command that runs longer than this. */
const PROBE_TIMEOUT_MS = 4000;

/** Runs a command, capturing stdout. Resolves '' on any error (missing binary, non-zero exit, timeout). */
function tryExec(command: string, args: string[]): Promise<string> {
	return new Promise<string>(resolve => {
		try {
			execFile(command, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
				resolve(err ? '' : (stdout ?? '').toString());
			});
		} catch {
			resolve('');
		}
	});
}

export class LoCoPilotSystemInfoService implements ILoCoPilotSystemInfoService {
	declare readonly _serviceBrand: undefined;

	/** Cached probe result; hardware doesn't change during a session. */
	private _cached: Promise<ISystemHardwareInfo> | undefined;

	constructor(
		@ILogService private readonly logService: ILogService
	) { }

	getHardwareInfo(): Promise<ISystemHardwareInfo> {
		if (!this._cached) {
			this._cached = this._probe().catch(err => {
				this.logService.warn(`[LoCoPilotSystemInfo] hardware probe failed: ${err}`);
				return { physicalCoreCount: 0, logicalCoreCount: cpus().length, gpus: [] };
			});
		}
		return this._cached;
	}

	private async _probe(): Promise<ISystemHardwareInfo> {
		const logicalCoreCount = cpus().length;
		const [physicalCoreCount, gpus] = await Promise.all([
			this._detectPhysicalCores(logicalCoreCount),
			this._detectGpus(),
		]);
		this.logService.info(`[LoCoPilotSystemInfo] cores: ${physicalCoreCount} physical / ${logicalCoreCount} logical; GPUs: ${gpus.map(g => `${g.name} (${Math.round(g.totalVramBytes / 1e9)}GB)`).join(', ') || 'none detected'}`);
		return { physicalCoreCount, logicalCoreCount, gpus };
	}

	/**
	 * Best-effort physical (performance) core count. llama.cpp throughput is usually best with threads set
	 * to physical performance cores, not hyperthreads or efficiency cores. We query the OS where we can and
	 * otherwise fall back to a conservative estimate.
	 */
	private async _detectPhysicalCores(logical: number): Promise<number> {
		const plat = platform();
		try {
			if (plat === 'darwin') {
				// Prefer performance cores on Apple Silicon hybrids; fall back to all physical cores.
				const perf = parseInt((await tryExec('sysctl', ['-n', 'hw.perflevel0.physicalcpu'])).trim(), 10);
				if (Number.isFinite(perf) && perf > 0) {
					return perf;
				}
				const phys = parseInt((await tryExec('sysctl', ['-n', 'hw.physicalcpu'])).trim(), 10);
				if (Number.isFinite(phys) && phys > 0) {
					return phys;
				}
			} else if (plat === 'linux') {
				// Count distinct physical core ids across sockets from /proc/cpuinfo via lscpu's machine output.
				const out = await tryExec('lscpu', ['-p=Core,Socket']);
				if (out) {
					const pairs = new Set<string>();
					for (const line of out.split('\n')) {
						const l = line.trim();
						if (!l || l.startsWith('#')) { continue; }
						pairs.add(l);
					}
					if (pairs.size > 0) {
						return pairs.size;
					}
				}
			} else if (plat === 'win32') {
				// NumberOfCores sums physical cores across CPU packages.
				const out = await tryExec('wmic', ['cpu', 'get', 'NumberOfCores', '/value']);
				if (out) {
					let total = 0;
					for (const m of out.matchAll(/NumberOfCores=(\d+)/g)) {
						total += parseInt(m[1], 10) || 0;
					}
					if (total > 0) {
						return total;
					}
				}
			}
		} catch {
			// fall through to estimate
		}
		// Estimate: assume 2-way SMT on machines with more than 4 logical CPUs, else 1:1.
		return logical > 4 ? Math.max(1, Math.floor(logical / 2)) : logical;
	}

	/** Best-effort GPU/VRAM detection. Currently covers NVIDIA via nvidia-smi and Apple Silicon (unified). */
	private async _detectGpus(): Promise<IGpuInfo[]> {
		const gpus: IGpuInfo[] = [];

		// NVIDIA: nvidia-smi reports exact total/free VRAM per GPU.
		const smi = await tryExec('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits']);
		if (smi) {
			for (const line of smi.split('\n')) {
				const l = line.trim();
				if (!l) { continue; }
				const parts = l.split(',').map(p => p.trim());
				if (parts.length >= 3) {
					const name = parts[0];
					const totalMiB = parseFloat(parts[1]);
					const freeMiB = parseFloat(parts[2]);
					if (Number.isFinite(totalMiB) && totalMiB > 0) {
						gpus.push({
							vendor: 'nvidia',
							name,
							totalVramBytes: Math.round(totalMiB * 1024 * 1024),
							freeVramBytes: Number.isFinite(freeMiB) ? Math.round(freeMiB * 1024 * 1024) : 0,
						});
					}
				}
			}
		}

		// Apple Silicon: GPU shares system (unified) memory, so there is no separate VRAM figure. We record
		// presence with totalVramBytes 0; the runner uses the system-RAM budget for Metal offload sizing.
		if (gpus.length === 0 && platform() === 'darwin' && arch() === 'arm64') {
			gpus.push({ vendor: 'apple', name: 'Apple Silicon GPU', totalVramBytes: 0, freeVramBytes: 0 });
		}

		// AMD/Intel discrete GPUs: sniff the vendor and, where possible, the dedicated VRAM so the runner can
		// size partial/MoE offload for them too (not just NVIDIA).
		if (gpus.length === 0) {
			const other = await this._detectOtherGpu();
			if (other) {
				gpus.push({ vendor: other.vendor, name: other.name ?? `${other.vendor} GPU`, totalVramBytes: other.totalVramBytes, freeVramBytes: 0 });
			}
		}

		return gpus;
	}

	/**
	 * Detects an AMD/Intel GPU on Linux/Windows when nvidia-smi found nothing, including total VRAM when the
	 * platform exposes it (AMD ROCm `rocm-smi`, Linux DRM sysfs, or Windows WMI `AdapterRAM`). VRAM is `0`
	 * when it can't be resolved - the runner then treats the GPU as present-but-unsized.
	 */
	private async _detectOtherGpu(): Promise<{ vendor: GpuVendor; name?: string; totalVramBytes: number } | undefined> {
		const plat = platform();
		try {
			if (plat === 'linux') {
				const out = await tryExec('sh', ['-c', 'lspci 2>/dev/null | grep -i vga']);
				const l = out.toLowerCase();
				let vendor: GpuVendor | undefined;
				if (l.includes('amd') || l.includes('radeon')) { vendor = 'amd'; }
				else if (l.includes('intel')) { vendor = 'intel'; }
				if (!vendor) { return undefined; }
				return { vendor, totalVramBytes: await this._detectLinuxGpuVram(vendor) };
			} else if (plat === 'win32') {
				// Query both Name and AdapterRAM (bytes, 32-bit so capped at ~4GB) per controller.
				const out = await tryExec('wmic', ['path', 'win32_VideoController', 'get', 'Name,AdapterRAM', '/format:list']);
				const lower = out.toLowerCase();
				let vendor: GpuVendor | undefined;
				if (lower.includes('amd') || lower.includes('radeon')) { vendor = 'amd'; }
				else if (lower.includes('nvidia')) { vendor = 'nvidia'; }
				else if (lower.includes('intel')) { vendor = 'intel'; }
				if (!vendor) { return undefined; }
				let vram = 0;
				for (const m of out.matchAll(/AdapterRAM=(\d+)/gi)) {
					vram = Math.max(vram, parseInt(m[1], 10) || 0);
				}
				return { vendor, totalVramBytes: vram };
			}
		} catch {
			// ignore
		}
		return undefined;
	}

	/**
	 * Best-effort dedicated VRAM (bytes) for an AMD/Intel GPU on Linux. Tries AMD's `rocm-smi` first, then the
	 * generic DRM sysfs `mem_info_vram_total` node. Returns 0 when neither is available (integrated GPUs, or
	 * no permission), which the runner reads as "size unknown".
	 */
	private async _detectLinuxGpuVram(vendor: GpuVendor): Promise<number> {
		if (vendor === 'amd') {
			const smi = await tryExec('rocm-smi', ['--showmeminfo', 'vram', '--csv']);
			// Look for the largest integer that plausibly represents a VRAM byte count.
			let best = 0;
			for (const m of smi.matchAll(/(\d{9,})/g)) {
				best = Math.max(best, parseInt(m[1], 10) || 0);
			}
			if (best > 0) { return best; }
		}
		// Generic DRM sysfs node (AMD/Intel): value is in bytes.
		const sysfs = await tryExec('sh', ['-c', 'cat /sys/class/drm/card*/device/mem_info_vram_total 2>/dev/null | sort -rn | head -1']);
		const bytes = parseInt(sysfs.trim(), 10);
		return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
	}
}
