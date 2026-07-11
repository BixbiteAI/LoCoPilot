/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { cpus, arch, platform, totalmem, freemem } from 'os';
import { readFile } from 'fs/promises';
import { ILogService } from '../../log/common/log.js';
import { IGpuInfo, ISystemHardwareInfo, ILoCoPilotSystemInfoService, GpuVendor, IMemoryStatus, MemoryPressureLevel } from '../common/locopilotSystemInfo.js';

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

/** Runs a command for its side effect. Resolves true only when it exited 0. */
function tryExecOk(command: string, args: string[]): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		try {
			execFile(command, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, err => resolve(!err));
		} catch {
			resolve(false);
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
		const [physicalCoreCount, gpus, metalWiredLimitBytes] = await Promise.all([
			this._detectPhysicalCores(logicalCoreCount),
			this._detectGpus(),
			this._detectMetalWiredLimit(),
		]);
		this.logService.info(`[LoCoPilotSystemInfo] cores: ${physicalCoreCount} physical / ${logicalCoreCount} logical; GPUs: ${gpus.map(g => `${g.name} (${Math.round(g.totalVramBytes / 1e9)}GB)`).join(', ') || 'none detected'}${metalWiredLimitBytes > 0 ? `; iogpu.wired_limit ${Math.round(metalWiredLimitBytes / 1e9)}GB` : ''}`);
		return { physicalCoreCount, logicalCoreCount, gpus, metalWiredLimitBytes };
	}

	/**
	 * Apple Silicon: the user-configured GPU wired-memory ceiling (`iogpu.wired_limit_mb`, MiB). 0 means
	 * "not set" (macOS then applies its built-in ~66-75% default) or not applicable on this platform.
	 */
	private async _detectMetalWiredLimit(): Promise<number> {
		if (platform() !== 'darwin' || arch() !== 'arm64') {
			return 0;
		}
		const out = (await tryExec('sysctl', ['-n', 'iogpu.wired_limit_mb'])).trim();
		const mib = parseInt(out, 10);
		return Number.isFinite(mib) && mib > 0 ? mib * 1024 * 1024 : 0;
	}

	async getMemoryStatus(): Promise<IMemoryStatus> {
		const plat = platform();
		try {
			if (plat === 'darwin') {
				return await this._darwinMemoryStatus();
			}
			if (plat === 'linux') {
				return await this._linuxMemoryStatus();
			}
		} catch (err) {
			this.logService.warn(`[LoCoPilotSystemInfo] memory status probe failed: ${err}`);
		}
		// Windows (and any fallback): os.freemem() is GlobalMemoryStatusEx.ullAvailPhys, which already
		// includes reclaimable standby-list memory - i.e. the "available" figure we want.
		return { totalBytes: totalmem(), availableBytes: freemem(), pressure: 'unknown', swapUsedBytes: -1 };
	}

	/**
	 * macOS: `os.freemem()` counts only truly-free pages and is wildly pessimistic (most RAM sits in
	 * reclaimable file cache), so available memory is computed from `vm_stat` page counts instead:
	 * free + inactive + speculative + purgeable - a close analogue of what Activity Monitor and Ollama's
	 * host_statistics64 path treat as reclaimable. Pressure comes from the kernel's own memorystatus level
	 * (the signal macOS itself uses to fire low-memory warnings), swap from `vm.swapusage`.
	 */
	private async _darwinMemoryStatus(): Promise<IMemoryStatus> {
		const [vmStatOut, pressureOut, swapOut] = await Promise.all([
			tryExec('vm_stat', []),
			tryExec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
			tryExec('sysctl', ['-n', 'vm.swapusage']),
		]);

		const totalBytes = totalmem();
		let availableBytes = freemem(); // worst-case fallback when vm_stat is unavailable

		if (vmStatOut) {
			const pageSizeMatch = vmStatOut.match(/page size of (\d+) bytes/);
			const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;
			const count = (label: string): number => {
				const m = vmStatOut.match(new RegExp(`${label}:\\s+(\\d+)`, 'i'));
				return m ? parseInt(m[1], 10) : 0;
			};
			const reclaimablePages = count('Pages free')
				+ count('Pages inactive')
				+ count('Pages speculative')
				+ count('Pages purgeable');
			if (reclaimablePages > 0) {
				availableBytes = reclaimablePages * pageSize;
			}
		}

		// kern.memorystatus_vm_pressure_level: 1 = normal, 2 = warn, 4 = critical.
		let pressure: MemoryPressureLevel = 'unknown';
		const level = parseInt(pressureOut.trim(), 10);
		if (level === 1) { pressure = 'normal'; }
		else if (level === 2) { pressure = 'warn'; }
		else if (level >= 4) { pressure = 'critical'; }

		// vm.swapusage: "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)"
		let swapUsedBytes = -1;
		const swapMatch = swapOut.match(/used\s*=\s*([\d.]+)([KMGT])/i);
		if (swapMatch) {
			const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[swapMatch[2].toUpperCase() as 'K' | 'M' | 'G' | 'T'] ?? 1024 ** 2;
			swapUsedBytes = Math.round(parseFloat(swapMatch[1]) * mult);
		}

		return { totalBytes, availableBytes, pressure, swapUsedBytes };
	}

	/**
	 * Linux: `MemAvailable` from /proc/meminfo is the kernel's own estimate of memory available without
	 * swapping (free + reclaimable cache) - exactly the figure `os.freemem()` (raw MemFree) misses.
	 * Pressure comes from the PSI memory file when the kernel exposes it.
	 */
	private async _linuxMemoryStatus(): Promise<IMemoryStatus> {
		const totalBytes = totalmem();
		let availableBytes = freemem();
		let swapUsedBytes = -1;
		try {
			const meminfo = await readFile('/proc/meminfo', 'utf8');
			const kib = (label: string): number => {
				const m = meminfo.match(new RegExp(`^${label}:\\s+(\\d+) kB`, 'm'));
				return m ? parseInt(m[1], 10) : -1;
			};
			const availKib = kib('MemAvailable');
			if (availKib > 0) {
				availableBytes = availKib * 1024;
			}
			const swapTotal = kib('SwapTotal');
			const swapFree = kib('SwapFree');
			if (swapTotal >= 0 && swapFree >= 0) {
				swapUsedBytes = Math.max(0, (swapTotal - swapFree) * 1024);
			}
		} catch {
			// keep fallbacks
		}

		// PSI: /proc/pressure/memory "some avg10=1.23 ..." - avg10 is the % of time in the last 10s that
		// at least one task stalled on memory. >10% = meaningful pressure, >40% = the machine is struggling.
		let pressure: MemoryPressureLevel = 'unknown';
		try {
			const psi = await readFile('/proc/pressure/memory', 'utf8');
			const m = psi.match(/some avg10=([\d.]+)/);
			if (m) {
				const avg10 = parseFloat(m[1]);
				pressure = avg10 >= 40 ? 'critical' : (avg10 >= 10 ? 'warn' : 'normal');
			}
		} catch {
			// PSI not exposed (older kernel / not mounted) -> unknown
		}

		return { totalBytes, availableBytes, pressure, swapUsedBytes };
	}

	async deprioritizeProcess(pid: number): Promise<boolean> {
		if (!Number.isInteger(pid) || pid <= 1) {
			return false;
		}
		const plat = platform();
		try {
			if (plat === 'darwin' || plat === 'linux') {
				// The pid we get may be a shell wrapping the real server (MLX launches via `sh -c python -m
				// mlx_lm.server ...`), so apply to the pid AND its direct children. Children forked later
				// inherit the parent's (already lowered) niceness, so one level is enough in practice.
				const pids = [pid, ...await this._childPids(pid)];
				let ok = false;
				for (const p of pids) {
					if (plat === 'darwin') {
						// `taskpolicy -c utility` moves the process to the utility QoS clamp: macOS then prefers
						// efficiency cores for it under contention (keeps the UI fluid and runs cooler) while it
						// can still use performance cores when the machine is idle. renice as an orthogonal nudge.
						ok = await tryExecOk('taskpolicy', ['-c', 'utility', '-p', String(p)]) || ok;
						await tryExecOk('renice', ['-n', '5', '-p', String(p)]);
					} else {
						ok = await tryExecOk('renice', ['-n', '5', '-p', String(p)]) || ok;
					}
				}
				return ok;
			}
			if (plat === 'win32') {
				// BelowNormal keeps the desktop responsive while the server still gets all spare cycles.
				return await tryExecOk('powershell', ['-NoProfile', '-NonInteractive', '-Command',
					`(Get-Process -Id ${pid}).PriorityClass = 'BelowNormal'`]);
			}
		} catch {
			// fall through
		}
		return false;
	}

	/** Direct child PIDs of `pid` (darwin/linux, via pgrep). Empty on error or when there are none. */
	private async _childPids(pid: number): Promise<number[]> {
		const out = await tryExec('pgrep', ['-P', String(pid)]);
		return out.split('\n')
			.map(l => parseInt(l.trim(), 10))
			.filter(n => Number.isInteger(n) && n > 1);
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
