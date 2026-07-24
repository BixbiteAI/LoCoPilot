/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseDarwinAvailableBytes } from '../../node/locopilotSystemInfoService.js';

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
});
