/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseDarwinAvailableBytes, parseDarwinPowerSource, parseLspciVga, parseWindowsPhysicalCores, parseWindowsPowerSource, parseWindowsVideoController } from '../../node/locopilotSystemInfoService.js';

suite('LoCoPilot system info service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const GiB = 1024 ** 3;

	test('macOS kernel free percentage corrects a pessimistic vm_stat sum', () => {
		const vmStat = [
			'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
			'Pages free: 4096.',
			'Pages inactive: 245760.',
			'Pages speculative: 4096.',
			'Pages purgeable: 8192.',
		].join('\n');
		const pressure = 'System-wide memory free percentage: 54%';

		assert.strictEqual(
			parseDarwinAvailableBytes(16 * GiB, 64 * 1024 ** 2, vmStat, pressure),
			Math.floor(16 * GiB * 0.54)
		);
	});

	test('macOS falls back to reclaimable vm_stat queues', () => {
		const vmStat = [
			'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
			'Pages free: 1024.',
			'Pages inactive: 2048.',
			'Pages speculative: 512.',
			'Pages purgeable: 256.',
		].join('\n');

		assert.strictEqual(
			parseDarwinAvailableBytes(16 * GiB, 32 * 1024 ** 2, vmStat, ''),
			(1024 + 2048 + 512 + 256) * 16384
		);
	});

	// The CIM and legacy `wmic` branches are deliberately shaped to emit the same `Key=Value` lines, so each
	// parser is exercised against BOTH transcripts - a divergence here is what silently broke core detection
	// on Windows 11 24H2, where `wmic` is disabled by default.

	test('physical cores parse identically from CIM and wmic output', () => {
		// `wmic cpu get NumberOfCores /value` pads with blank lines and CRLF.
		const wmic = '\r\n\r\nNumberOfCores=8\r\n\r\n\r\n';
		// Get-CimInstance | ForEach-Object emits one bare line per package.
		const cim = 'NumberOfCores=8\r\n';

		assert.strictEqual(parseWindowsPhysicalCores(wmic), 8);
		assert.strictEqual(parseWindowsPhysicalCores(cim), 8);
	});

	test('physical cores sum across CPU packages', () => {
		assert.strictEqual(parseWindowsPhysicalCores('NumberOfCores=16\r\nNumberOfCores=16\r\n'), 32);
	});

	test('physical cores report 0 when the probe produced nothing', () => {
		// Both an empty result and a header-only one must fall through to the caller's estimate, not to NaN.
		assert.strictEqual(parseWindowsPhysicalCores(''), 0);
		assert.strictEqual(parseWindowsPhysicalCores('NumberOfCores\r\n'), 0);
	});

	test('GPU vendor and VRAM parse identically from CIM and wmic output', () => {
		const wmic = '\r\nAdapterRAM=4293918720\r\nName=NVIDIA GeForce RTX 4090\r\n\r\n';
		const cim = 'Name=NVIDIA GeForce RTX 4090\r\nAdapterRAM=4293918720\r\n';
		// AdapterRAM is a 32-bit field that caps near 4 GiB; the driver's QWORD carries the real 24 GiB.
		const registry = '    HardwareInformation.qwMemorySize    REG_QWORD    0x600000000\r\n';

		for (const out of [wmic, cim]) {
			assert.deepStrictEqual(
				parseWindowsVideoController(out, registry),
				{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', totalVramBytes: 24 * GiB, isIntegrated: false }
			);
		}
	});

	test('GPU VRAM falls back to AdapterRAM when the registry QWORD is absent', () => {
		assert.deepStrictEqual(
			parseWindowsVideoController('Name=AMD Radeon RX 7600\r\nAdapterRAM=8589934592\r\n', ''),
			{ vendor: 'amd', name: 'AMD Radeon RX 7600', totalVramBytes: 8 * GiB, isIntegrated: false }
		);
	});

	test('GPU parse picks the largest adapter across multiple controllers', () => {
		// Laptops enumerate the iGPU alongside the discrete card; the discrete one must win.
		const out = [
			'Name=Intel(R) UHD Graphics',
			'AdapterRAM=1073741824',
			'Name=NVIDIA GeForce RTX 4060 Laptop GPU',
			'AdapterRAM=4293918720',
		].join('\r\n');

		// 'amd'/'radeon' and 'nvidia' are checked before 'intel', so the discrete vendor wins the label too -
		// and the NAME kept must be the discrete adapter's, not the iGPU's listed above it.
		assert.deepStrictEqual(
			parseWindowsVideoController(out, ''),
			{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4060 Laptop GPU', totalVramBytes: 4293918720, isIntegrated: false }
		);
	});

	test('GPU parse yields undefined when no known vendor is present', () => {
		assert.strictEqual(parseWindowsVideoController('', ''), undefined);
		assert.strictEqual(parseWindowsVideoController('Name=Microsoft Basic Display Adapter\r\n', ''), undefined);
	});

	test('an Intel iGPU is flagged integrated; a discrete Arc card is not', () => {
		// A Core Ultra iGPU reports a small system-RAM carve-out as "dedicated" VRAM - not a second pool.
		assert.deepStrictEqual(
			parseWindowsVideoController('Name=Intel(R) Arc(TM) Graphics\r\nAdapterRAM=134217728\r\n', ''),
			{ vendor: 'intel', name: 'Intel(R) Arc(TM) Graphics', totalVramBytes: 128 * 1024 * 1024, isIntegrated: true }
		);
		// A discrete Arc card owns its 16 GiB and must keep being budgeted against it, exactly as before.
		assert.deepStrictEqual(
			parseWindowsVideoController('Name=Intel(R) Arc(TM) A770 Graphics\r\nAdapterRAM=17179869184\r\n', ''),
			{ vendor: 'intel', name: 'Intel(R) Arc(TM) A770 Graphics', totalVramBytes: 16 * GiB, isIntegrated: false }
		);
	});

	test('lspci parse keeps the device description as the adapter name', () => {
		assert.deepStrictEqual(
			parseLspciVga('00:02.0 VGA compatible controller: Intel Corporation Meteor Lake-P [Intel Arc Graphics] (rev 08)'),
			{ vendor: 'intel', name: 'Intel Corporation Meteor Lake-P [Intel Arc Graphics] (rev 08)' }
		);
		// AMD is resolved before Intel, matching the previous whole-blob precedence on hybrid machines.
		assert.deepStrictEqual(
			parseLspciVga([
				'00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 620',
				'01:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 33 [Radeon RX 7600]',
			].join('\n')),
			{ vendor: 'amd', name: 'Advanced Micro Devices, Inc. [AMD/ATI] Navi 33 [Radeon RX 7600]' }
		);
		assert.strictEqual(parseLspciVga(''), undefined);
	});

	test('macOS power source reads the pmset drawing-from line', () => {
		// Real `pmset -g batt` output: the battery detail line follows the verdict line, and on a charged
		// laptop it mentions the battery even though the machine is on mains - so the verdict must win.
		assert.strictEqual(parseDarwinPowerSource([
			`Now drawing from 'AC Power'`,
			' -InternalBattery-0 (id=22806627)\t100%; charged; 0:00 remaining present: true',
		].join('\n')), 'ac');
		assert.strictEqual(parseDarwinPowerSource([
			`Now drawing from 'Battery Power'`,
			' -InternalBattery-0 (id=22806627)\t83%; discharging; 4:12 remaining present: true',
		].join('\n')), 'battery');
		// A Mac with no battery at all still prints the AC verdict.
		assert.strictEqual(parseDarwinPowerSource(`Now drawing from 'AC Power'`), 'ac');
		// A failed probe must not be read as either state.
		assert.strictEqual(parseDarwinPowerSource(''), 'unknown');
	});

	test('Windows power source distinguishes a desktop from a failed probe', () => {
		// BatteryStatus 1 = discharging; 2 = on AC.
		assert.strictEqual(parseWindowsPowerSource('BatteryCount=1\nBatteryStatus=1', true), 'battery');
		assert.strictEqual(parseWindowsPowerSource('BatteryCount=1\nBatteryStatus=2', true), 'ac');
		// Charging/fully-charged codes still mean mains power.
		assert.strictEqual(parseWindowsPowerSource('BatteryCount=1\nBatteryStatus=6', true), 'ac');
		// Any discharging battery wins on a multi-battery machine.
		assert.strictEqual(parseWindowsPowerSource('BatteryCount=2\nBatteryStatus=2\nBatteryStatus=1', true), 'battery');
		// A desktop has no Win32_Battery instance: the query ran and found nothing, which is 'ac'.
		assert.strictEqual(parseWindowsPowerSource('BatteryCount=0', true), 'ac');
		// The same empty output when the query never ran must NOT be read as 'ac'.
		assert.strictEqual(parseWindowsPowerSource('', false), 'unknown');
	});
});
