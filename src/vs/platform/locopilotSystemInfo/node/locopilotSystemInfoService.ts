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

		// Generic vendor sniff (no VRAM) on non-NVIDIA discrete GPUs, so the runner at least knows one exists.
		if (gpus.length === 0) {
			const vendor = await this._detectOtherGpuVendor();
			if (vendor) {
				gpus.push({ vendor, name: `${vendor} GPU`, totalVramBytes: 0, freeVramBytes: 0 });
			}
		}

		return gpus;
	}

	/** Sniffs for an AMD/Intel GPU on Linux/Windows when nvidia-smi found nothing. Name/VRAM not resolved. */
	private async _detectOtherGpuVendor(): Promise<GpuVendor | undefined> {
		const plat = platform();
		try {
			if (plat === 'linux') {
				const out = await tryExec('sh', ['-c', 'lspci 2>/dev/null | grep -i vga']);
				const l = out.toLowerCase();
				if (l.includes('amd') || l.includes('radeon')) { return 'amd'; }
				if (l.includes('intel')) { return 'intel'; }
			} else if (plat === 'win32') {
				const out = (await tryExec('wmic', ['path', 'win32_VideoController', 'get', 'Name', '/value'])).toLowerCase();
				if (out.includes('amd') || out.includes('radeon')) { return 'amd'; }
				if (out.includes('nvidia')) { return 'nvidia'; }
				if (out.includes('intel')) { return 'intel'; }
			}
		} catch {
			// ignore
		}
		return undefined;
	}
}
