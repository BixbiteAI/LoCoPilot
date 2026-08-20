/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { cpus, arch, platform, totalmem, freemem } from 'os';
import { readdir, readFile } from 'fs/promises';
import { ILogService } from '../../log/common/log.js';
import { IGpuInfo, ISystemHardwareInfo, ILoCoPilotSystemInfoService, GpuVendor, IMemoryStatus, MemoryPressureLevel, PowerSource, ThermalPressureLevel } from '../common/locopilotSystemInfo.js';

/** Kill any probe command that runs longer than this. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * PowerShell needs a longer leash than a plain binary: a cold `powershell.exe` start is ~300-700ms on an idle
 * machine and can reach several seconds behind on-access antivirus scanning. Timing out here would drop us back
 * to the same silent fallbacks this probe exists to avoid, and the cost is paid once (the result is cached).
 */
const POWERSHELL_PROBE_TIMEOUT_MS = 8000;

/**
 * How long a power-source answer stays fresh. Short enough that unplugging is picked up before the next
 * model launch (the only consumer), long enough that the several calls a single launch makes cost one
 * subprocess rather than several. Deliberately NOT session-cached like the hardware probe: the whole point
 * is that this value changes while the app runs.
 */
const POWER_SOURCE_TTL_MS = 15_000;

/** Runs a command, capturing stdout. Resolves '' on any error (missing binary, non-zero exit, timeout). */
function tryExec(command: string, args: string[], timeoutMs: number = PROBE_TIMEOUT_MS): Promise<string> {
	return new Promise<string>(resolve => {
		try {
			execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
				resolve(err ? '' : (stdout ?? '').toString());
			});
		} catch {
			resolve('');
		}
	});
}

/**
 * Queries Windows management data via CIM, falling back to the legacy `wmic` invocation.
 *
 * `wmic` is deprecated and ships DISABLED BY DEFAULT (as a Feature-on-Demand) from Windows 11 24H2 and Server
 * 2025 onward: the process fails to start, `tryExec` yields '', and every probe built on it silently degrades
 * to its estimate path on current Windows. `Get-CimInstance` is the supported replacement and is present on
 * every Windows since 8 (PowerShell 3.0+).
 *
 * `wmic` is still tried second for locked-down images that strip PowerShell but keep it. That costs nothing on
 * machines where the binary is simply absent - the spawn fails immediately rather than waiting out a timeout.
 *
 * Both branches are asked to emit the same `Key=Value` line format so callers parse a single shape.
 */
async function queryWindowsCim(cimCommand: string, wmicArgs: string[]): Promise<string> {
	const out = await tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command', cimCommand], POWERSHELL_PROBE_TIMEOUT_MS);
	if (out.trim()) {
		return out;
	}
	return tryExec('wmic', wmicArgs);
}

/**
 * Reads the power source out of `pmset -g batt`, whose first line is one of:
 *   `Now drawing from 'AC Power'` / `Now drawing from 'Battery Power'`
 * A Mac with no battery (Studio, Mini, Pro) prints the AC line too, which is the answer we want anyway.
 * Empty/unrecognised output means the probe failed, and 'unknown' keeps the caller on its current behaviour
 * rather than throttling a workstation on a bad parse.
 */
export function parseDarwinPowerSource(pmsetOut: string): PowerSource {
	const l = pmsetOut.toLowerCase();
	if (l.includes('ac power')) { return 'ac'; }
	if (l.includes('battery power')) { return 'battery'; }
	return 'unknown';
}

/**
 * Resolves the power source from Win32_Battery `BatteryStatus` values, where 1 means "discharging" (i.e. the
 * machine is running off the battery) and 2 means "on AC". Any other code (3-11: charging, fully charged and
 * on mains, etc.) still implies mains power.
 *
 * A desktop has NO Win32_Battery instance at all, so empty output is the normal, correct 'ac' answer - not a
 * failure. That is why this parser takes the exit-shaped `queried` flag separately: only a probe that failed
 * to RUN yields 'unknown'.
 */
export function parseWindowsPowerSource(out: string, queried: boolean): PowerSource {
	if (!queried) { return 'unknown'; }
	const codes = [...out.matchAll(/BatteryStatus=(\d+)/gi)].map(m => parseInt(m[1], 10));
	if (codes.length === 0) {
		return 'ac'; // no battery device -> desktop/VM -> mains
	}
	return codes.some(c => c === 1) ? 'battery' : 'ac';
}

/** Sums `NumberOfCores=N` lines (one per CPU package) into a physical core count. 0 when none are present. */
export function parseWindowsPhysicalCores(out: string): number {
	let total = 0;
	for (const m of out.matchAll(/NumberOfCores=(\d+)/gi)) {
		total += parseInt(m[1], 10) || 0;
	}
	return total;
}

/**
 * Dedicated VRAM (bytes) at/above which an adapter is taken to have a memory pool of its OWN rather than a
 * carve-out of system RAM. Deliberately the same 4 GiB line the engine picker uses to decide an integrated
 * GPU is worth offloading to, so an adapter that is budgeted as discrete is exactly one that already was.
 */
const DISCRETE_VRAM_HINT_BYTES = 4 * 1024 * 1024 * 1024;

/** Vendor implied by an adapter's product name, or undefined when it names no vendor we know. */
function gpuVendorFromName(name: string): GpuVendor | undefined {
	const l = name.toLowerCase();
	if (l.includes('amd') || l.includes('radeon')) { return 'amd'; }
	if (l.includes('nvidia') || l.includes('geforce') || l.includes('quadro')) { return 'nvidia'; }
	if (l.includes('intel')) { return 'intel'; }
	return undefined;
}

/**
 * Whether an adapter shares system memory instead of owning a VRAM pool. Only Intel is classified here (by
 * the {@link DISCRETE_VRAM_HINT_BYTES} line): AMD APUs are deliberately left reporting `false`, which is what
 * they do today - reclassifying them would change how every existing AMD machine is budgeted, and that needs
 * its own hardware verification. Apple is set at its own detection site.
 */
function isIntegratedGpu(vendor: GpuVendor, totalVramBytes: number): boolean {
	return vendor === 'intel' && totalVramBytes < DISCRETE_VRAM_HINT_BYTES;
}

/**
 * Resolves the GPU vendor and product name from `lspci | grep -i vga` output. A line reads
 * `00:02.0 VGA compatible controller: Intel Corporation Meteor Lake-P [Intel Arc Graphics] (rev 08)`, so the
 * device description is what follows the first colon-space; the PCI address's own colons have no space.
 * Vendor priority (AMD, then Intel) and the deliberate absence of NVIDIA both match the previous behaviour -
 * NVIDIA cards are enumerated by `nvidia-smi` before this path is reached.
 */
export function parseLspciVga(out: string): { vendor: GpuVendor; name?: string } | undefined {
	const devices = out.split('\n')
		.map(line => line.split(/:\s/).slice(1).join(': ').trim())
		.filter(Boolean);
	for (const candidate of ['amd', 'intel'] as const) {
		const match = devices.find(d => gpuVendorFromName(d) === candidate);
		if (match) {
			return { vendor: candidate, name: match };
		}
	}
	// Vendor named outside the device description (or an unparseable line): fall back to the whole blob.
	const l = out.toLowerCase();
	if (l.includes('amd') || l.includes('radeon')) { return { vendor: 'amd' }; }
	if (l.includes('intel')) { return { vendor: 'intel' }; }
	return undefined;
}

/**
 * Resolves the GPU vendor, product name and dedicated VRAM from `Name=`/`AdapterRAM=` controller lines, plus
 * the display driver's registry QWORD. Returns undefined when no known vendor appears, which the caller reads
 * as "no discrete GPU detected".
 *
 * The vendor is resolved per ADAPTER rather than from the whole blob so the name we keep belongs to the
 * adapter we picked - the engine picker reads that name to tell a modern Arc/Xe iGPU (worth Vulkan) from a
 * legacy UHD one (not). Vendor priority is unchanged: AMD, then NVIDIA, then Intel.
 */
export function parseWindowsVideoController(controllerOut: string, registryOut: string): { vendor: GpuVendor; name?: string; totalVramBytes: number; isIntegrated: boolean } | undefined {
	const names = [...controllerOut.matchAll(/^\s*Name=(.*)$/gim)].map(m => m[1].trim()).filter(Boolean);
	let vendor: GpuVendor | undefined;
	let name: string | undefined;
	for (const candidate of ['amd', 'nvidia', 'intel'] as const) {
		const match = names.find(n => gpuVendorFromName(n) === candidate);
		if (match) {
			vendor = candidate;
			name = match;
			break;
		}
	}
	if (!vendor) {
		// No adapter NAME identified a vendor: fall back to the whole blob, as before, so drivers that report
		// the vendor only in another field still resolve (we just have no name to gate on).
		const lower = controllerOut.toLowerCase();
		if (lower.includes('amd') || lower.includes('radeon')) { vendor = 'amd'; }
		else if (lower.includes('nvidia')) { vendor = 'nvidia'; }
		else if (lower.includes('intel')) { vendor = 'intel'; }
	}
	if (!vendor) {
		return undefined;
	}

	let vram = 0;
	for (const m of controllerOut.matchAll(/AdapterRAM=(\d+)/gi)) {
		vram = Math.max(vram, parseInt(m[1], 10) || 0);
	}
	// Win32_VideoController.AdapterRAM is a 32-bit field and wraps/caps around 4 GiB. Prefer the display
	// driver's QWORD registry value when present so 8/12/16/24 GiB cards are sized correctly.
	for (const m of registryOut.matchAll(/HardwareInformation\.qwMemorySize\s+REG_QWORD\s+0x([0-9a-f]+)/gi)) {
		const bytes = Number.parseInt(m[1], 16);
		if (Number.isSafeInteger(bytes) && bytes > 0) {
			vram = Math.max(vram, bytes);
		}
	}
	return { vendor, name, totalVramBytes: vram, isIntegrated: isIntegratedGpu(vendor, vram) };
}

/**
 * Commit-charge thresholds for {@link windowsCommitPressure}. Windows keeps servicing allocations right up
 * to the commit limit and pays for it by trimming working sets to disk, so the interesting signal is how
 * close committed bytes are to that limit - not how much physical RAM is momentarily free. 80% is where a
 * machine starts trading working set for commit; past 90% it is paging to stay alive.
 */
const WINDOWS_COMMIT_WARN_RATIO = 0.80;
const WINDOWS_COMMIT_CRITICAL_RATIO = 0.90;

/**
 * Derives a kernel-grade memory verdict for Windows from `process.getSystemMemoryInfo()`.
 *
 * IMPORTANT - what those fields actually are on Windows. Chromium fills them from
 * `GlobalMemoryStatusEx`, and despite the names `swapTotal`/`swapFree` are NOT the pagefile: they are
 * `ullTotalPageFile` and `ullAvailPageFile`, i.e. the COMMIT LIMIT and the commit still available.
 * Verified on a 16 GB machine with a 40 GB pagefile:
 *
 *   swapTotal 58092164 KiB === Win32_OperatingSystem.TotalVirtualMemorySize (commit limit)
 *   swapFree  37535152 KiB === Win32_OperatingSystem.FreeVirtualMemory      (commit available)
 *
 * So the ratio below is `Committed Bytes / Commit Limit` - the same figure Task Manager shows as
 * "Committed" and perfmon exposes as `\Memory\% Committed Bytes In Use`. It is the right question to ask
 * on Windows, which keeps servicing allocations up to the commit limit and pays for it by pushing working
 * sets to disk: how much physical RAM is momentarily free says very little on its own.
 *
 * `swapUsedBytes` is deliberately left at -1. The honest pagefile figure is `Win32_PageFileUsage`, which
 * costs a subprocess the 5-second watchdog cannot afford, and the tempting substitute (committed minus
 * resident) is not it - on the machine above that arithmetic gives 8.5 GB against a real pagefile usage of
 * 1.7 GB, because commit counts committed-but-never-touched pages. Callers must treat -1 as "no signal"
 * and corroborate pressure some other way rather than acting on a number this cannot measure.
 *
 * Returns 'unknown' on nonsense input so a bad read can never manufacture a verdict.
 */
export function windowsCommitPressure(totalKb: number, freeKb: number, commitLimitKb: number, commitAvailableKb: number): { pressure: MemoryPressureLevel; swapUsedBytes: number } {
	const total = Number.isFinite(totalKb) && totalKb > 0 ? totalKb : 0;
	// The commit limit is physical RAM plus the pagefile, so it can never be below total; anything else
	// means we are not looking at the Windows shape of these fields and must not guess.
	const limit = Number.isFinite(commitLimitKb) && commitLimitKb >= total ? commitLimitKb : 0;
	if (total === 0 || limit === 0) {
		return { pressure: 'unknown', swapUsedBytes: -1 };
	}
	const available = Number.isFinite(commitAvailableKb) && commitAvailableKb >= 0
		? Math.min(commitAvailableKb, limit)
		: 0;

	const ratio = (limit - available) / limit;
	const pressure: MemoryPressureLevel = ratio >= WINDOWS_COMMIT_CRITICAL_RATIO
		? 'critical'
		: (ratio >= WINDOWS_COMMIT_WARN_RATIO ? 'warn' : 'normal');
	return { pressure, swapUsedBytes: -1 };
}

/**
 * Electron's `process.getSystemMemoryInfo()`, or undefined where it is unavailable (plain Node, or an
 * Electron version/context that does not expose it). Feature-detected rather than imported so this file
 * stays a `node/` layer module with no Electron dependency, and so a missing API degrades to the previous
 * behaviour instead of throwing.
 */
function trySystemMemoryInfo(): { total: number; free: number; swapTotal: number; swapFree: number } | undefined {
	try {
		const fn = (process as unknown as { getSystemMemoryInfo?: () => { total: number; free: number; swapTotal?: number; swapFree?: number } }).getSystemMemoryInfo;
		if (typeof fn !== 'function') {
			return undefined;
		}
		const info = fn.call(process);
		if (!info || !Number.isFinite(info.total)) {
			return undefined;
		}
		return { total: info.total, free: info.free, swapTotal: info.swapTotal ?? 0, swapFree: info.swapFree ?? 0 };
	} catch {
		return undefined;
	}
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

/**
 * Resolves the memory macOS can make available without pressure. `vm_stat` exposes only individual page
 * queues and undercounts compressed/reclaimable memory on a busy machine; `memory_pressure -Q` reports the
 * kernel's aggregate free percentage and therefore wins when present.
 */
export function parseDarwinAvailableBytes(totalBytes: number, fallbackBytes: number, vmStatOut: string, memoryPressureOut: string): number {
	let availableBytes = fallbackBytes;
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

	const availablePercentMatch = memoryPressureOut.match(/System-wide memory free percentage:\s*([\d.]+)%/i);
	if (availablePercentMatch) {
		const availablePercent = parseFloat(availablePercentMatch[1]);
		if (Number.isFinite(availablePercent) && availablePercent >= 0 && availablePercent <= 100) {
			availableBytes = Math.max(availableBytes, Math.floor(totalBytes * availablePercent / 100));
		}
	}
	return Math.max(0, Math.min(totalBytes, availableBytes));
}

export class LoCoPilotSystemInfoService implements ILoCoPilotSystemInfoService {
	declare readonly _serviceBrand: undefined;

	/** Cached probe result; hardware doesn't change during a session. */
	private _cached: Promise<ISystemHardwareInfo> | undefined;

	/** Last power-source answer and when it was taken, for the {@link POWER_SOURCE_TTL_MS} cache. */
	private _powerSource: { value: PowerSource; at: number } | undefined;
	/** In-flight power probe, so concurrent callers share one subprocess instead of racing several. */
	private _powerSourceInFlight: Promise<PowerSource> | undefined;

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
			if (plat === 'win32') {
				return this._windowsMemoryStatus();
			}
		} catch (err) {
			this.logService.warn(`[LoCoPilotSystemInfo] memory status probe failed: ${err}`);
		}
		// Any other platform, or a probe that threw: os.freemem() is the best figure we have and every
		// derived signal degrades to 'unknown'/-1, which callers must treat as "do not act on this".
		return { totalBytes: totalmem(), availableBytes: freemem(), pressure: 'unknown', swapUsedBytes: -1, thermalPressure: 'unknown' };
	}

	/**
	 * macOS: `os.freemem()` counts only truly-free pages and is wildly pessimistic. `memory_pressure -Q`
	 * exposes the kernel's own system-wide free percentage, including memory it can reclaim without entering
	 * pressure; use that as the primary availability figure. Keep the `vm_stat` free+inactive+speculative+
	 * purgeable sum as a fallback because `memory_pressure` is absent in some restricted environments.
	 * Pressure comes from the kernel's memorystatus level, swap from `vm.swapusage`.
	 */
	private async _darwinMemoryStatus(): Promise<IMemoryStatus> {
		const [vmStatOut, availableOut, pressureOut, swapOut, thermalOut] = await Promise.all([
			tryExec('vm_stat', []),
			tryExec('memory_pressure', ['-Q']),
			tryExec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
			tryExec('sysctl', ['-n', 'vm.swapusage']),
			tryExec('sysctl', ['-n', 'kern.thermalpressurelevel']),
		]);

		const totalBytes = totalmem();
		const availableBytes = parseDarwinAvailableBytes(totalBytes, freemem(), vmStatOut, availableOut);

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

		// kern.thermalpressurelevel: 0 nominal, 1 fair, 2 serious, 3 critical (mirrors NSProcessInfoThermalState).
		// The sysctl is absent on some Macs/older versions -> empty output -> 'unknown'.
		let thermalPressure: ThermalPressureLevel = 'unknown';
		const thermalTrimmed = thermalOut.trim();
		if (thermalTrimmed !== '') {
			const t = parseInt(thermalTrimmed, 10);
			if (t <= 0) { thermalPressure = 'nominal'; }
			else if (t === 1) { thermalPressure = 'fair'; }
			else if (t === 2) { thermalPressure = 'serious'; }
			else if (t >= 3) { thermalPressure = 'critical'; }
		}

		return { totalBytes, availableBytes, pressure, swapUsedBytes, thermalPressure };
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

		// Linux exposes no simple, universally-available thermal-pressure scalar; leave 'unknown' for now.
		return { totalBytes, availableBytes, pressure, swapUsedBytes, thermalPressure: 'unknown' };
	}

	/**
	 * Windows: `os.freemem()` is `GlobalMemoryStatusEx.ullAvailPhys`, which already counts the reclaimable
	 * standby list - so it is the right "available" figure and stays the primary number here.
	 *
	 * What it could never express is WHY memory is tight, and Windows was the only platform handing the
	 * runner no pressure verdict and no swap figure at all. Both are available for free from
	 * `process.getSystemMemoryInfo()` (one `GlobalMemoryStatusEx` call - no subprocess, which matters
	 * because the runner's watchdog samples this every 5 seconds), so derive them here via
	 * {@link windowsCommitPressure} and give Windows the same two-signal footing macOS and Linux have.
	 */
	private _windowsMemoryStatus(): IMemoryStatus {
		const totalBytes = totalmem();
		const availableBytes = freemem();
		const info = trySystemMemoryInfo();
		if (!info) {
			// No Electron process API here: keep exactly the old behaviour rather than guessing.
			return { totalBytes, availableBytes, pressure: 'unknown', swapUsedBytes: -1, thermalPressure: 'unknown' };
		}
		// info.swapTotal/swapFree are the commit LIMIT and commit AVAILABLE on Windows - see windowsCommitPressure.
		const { pressure, swapUsedBytes } = windowsCommitPressure(info.total, info.free, info.swapTotal, info.swapFree);
		// Windows exposes no simple thermal scalar (the WMI thermal-zone classes are absent on most
		// consumer machines), so that stays 'unknown' - callers already treat it as "no signal".
		return { totalBytes, availableBytes, pressure, swapUsedBytes, thermalPressure: 'unknown' };
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

	async getPowerSource(): Promise<PowerSource> {
		const now = Date.now();
		if (this._powerSource && now - this._powerSource.at < POWER_SOURCE_TTL_MS) {
			return this._powerSource.value;
		}
		if (!this._powerSourceInFlight) {
			this._powerSourceInFlight = this._probePowerSource()
				.catch(err => {
					this.logService.warn(`[LoCoPilotSystemInfo] power-source probe failed: ${err}`);
					return 'unknown' as PowerSource;
				})
				.then(value => {
					// Only remember an answer we actually got. Caching 'unknown' would pin a transient probe
					// failure for the whole TTL, and 'unknown' is the one value callers act on by doing nothing.
					if (value !== 'unknown') {
						this._powerSource = { value, at: Date.now() };
					}
					this._powerSourceInFlight = undefined;
					return value;
				});
		}
		return this._powerSourceInFlight;
	}

	private async _probePowerSource(): Promise<PowerSource> {
		const plat = platform();
		if (plat === 'darwin') {
			return parseDarwinPowerSource(await tryExec('pmset', ['-g', 'batt']));
		}
		if (plat === 'win32') {
			// The sentinel line matters: on a desktop Win32_Battery legitimately returns NOTHING, which is
			// indistinguishable from "PowerShell never ran" unless the query prints something unconditionally.
			// `BatteryCount=` proves the probe executed, so an empty battery list can be read as 'ac' (desktop)
			// instead of being lumped in with a failed probe.
			const out = await queryWindowsCim(
				'$b = @(Get-CimInstance Win32_Battery); "BatteryCount=" + $b.Count; $b | ForEach-Object { "BatteryStatus=" + $_.BatteryStatus }',
				['path', 'Win32_Battery', 'get', 'BatteryStatus', '/format:value']);
			return parseWindowsPowerSource(out, /^BatteryCount=/mi.test(out) || /BatteryStatus=/i.test(out));
		}
		if (plat === 'linux') {
			return this._linuxPowerSource();
		}
		return 'unknown';
	}

	/**
	 * Linux: /sys/class/power_supply holds one directory per supply. A `Mains` supply's `online` file is the
	 * authoritative answer (1 = plugged in); only when no mains device is exposed do we fall back to reading a
	 * battery's own `status`. A machine with neither (most desktops, containers, VMs) exposes an empty or
	 * missing directory, which is 'ac' - there is no battery to run down.
	 */
	private async _linuxPowerSource(): Promise<PowerSource> {
		const root = '/sys/class/power_supply';
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch {
			return 'ac'; // no power-supply class at all -> nothing that can run on battery
		}
		const read = async (p: string): Promise<string> => {
			try {
				return (await readFile(p, 'utf8')).trim();
			} catch {
				return '';
			}
		};
		let sawMains = false;
		let batteryStatus = '';
		for (const name of entries) {
			const type = await read(`${root}/${name}/type`);
			if (type === 'Mains') {
				sawMains = true;
				if (await read(`${root}/${name}/online`) === '1') {
					return 'ac';
				}
			} else if (type === 'Battery' && !batteryStatus) {
				batteryStatus = await read(`${root}/${name}/status`);
			}
		}
		if (sawMains) {
			return 'battery'; // mains present and every one of them offline
		}
		if (batteryStatus) {
			return batteryStatus === 'Discharging' ? 'battery' : 'ac';
		}
		return 'ac';
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
				// NumberOfCores sums physical cores across CPU packages. The CIM branch is shaped to emit the
				// same `NumberOfCores=N` lines that `wmic ... /value` does, so one parser serves both.
				const out = await queryWindowsCim(
					`Get-CimInstance -ClassName Win32_Processor | ForEach-Object { 'NumberOfCores=' + $_.NumberOfCores }`,
					['cpu', 'get', 'NumberOfCores', '/value']);
				const total = parseWindowsPhysicalCores(out);
				if (total > 0) {
					return total;
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
							isIntegrated: false, // anything nvidia-smi enumerates owns its VRAM
						});
					}
				}
			}
		}

		// Apple Silicon: GPU shares system (unified) memory, so there is no separate VRAM figure. We record
		// presence with totalVramBytes 0; the runner uses the system-RAM budget for Metal offload sizing.
		if (gpus.length === 0 && platform() === 'darwin' && arch() === 'arm64') {
			gpus.push({ vendor: 'apple', name: 'Apple Silicon GPU', totalVramBytes: 0, freeVramBytes: 0, isIntegrated: true });
		}

		// AMD/Intel discrete GPUs: sniff the vendor and, where possible, the dedicated VRAM so the runner can
		// size partial/MoE offload for them too (not just NVIDIA).
		if (gpus.length === 0) {
			const other = await this._detectOtherGpu();
			if (other) {
				gpus.push({ vendor: other.vendor, name: other.name ?? `${other.vendor} GPU`, totalVramBytes: other.totalVramBytes, freeVramBytes: 0, isIntegrated: other.isIntegrated });
			}
		}

		return gpus;
	}

	/**
	 * Detects an AMD/Intel GPU on Linux/Windows when nvidia-smi found nothing, including total VRAM when the
	 * platform exposes it (AMD ROCm `rocm-smi`, Linux DRM sysfs, or Windows WMI `AdapterRAM`). VRAM is `0`
	 * when it can't be resolved - the runner then treats the GPU as present-but-unsized.
	 */
	private async _detectOtherGpu(): Promise<{ vendor: GpuVendor; name?: string; totalVramBytes: number; isIntegrated: boolean } | undefined> {
		const plat = platform();
		try {
			if (plat === 'linux') {
				const out = await tryExec('sh', ['-c', 'lspci 2>/dev/null | grep -i vga']);
				const parsed = parseLspciVga(out);
				if (!parsed) { return undefined; }
				const totalVramBytes = await this._detectLinuxGpuVram(parsed.vendor);
				return { ...parsed, totalVramBytes, isIntegrated: isIntegratedGpu(parsed.vendor, totalVramBytes) };
			} else if (plat === 'win32') {
				// Query both Name and AdapterRAM (bytes, 32-bit so capped at ~4GB) per controller. The CIM branch
				// is shaped to emit the same `Name=`/`AdapterRAM=` lines that `wmic ... /format:list` does.
				const out = await queryWindowsCim(
					`Get-CimInstance -ClassName Win32_VideoController | ForEach-Object { 'Name=' + $_.Name; 'AdapterRAM=' + $_.AdapterRAM }`,
					['path', 'win32_VideoController', 'get', 'Name,AdapterRAM', '/format:list']);
				const registry = await tryExec('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Video', '/s', '/v', 'HardwareInformation.qwMemorySize']);
				return parseWindowsVideoController(out, registry);
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
