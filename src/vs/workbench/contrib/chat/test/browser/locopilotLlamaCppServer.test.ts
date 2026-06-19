/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	computeGpuLayers,
	getBundledLlamaServerPath,
	getLlamaCppServerCommand,
	resolveKvCacheType,
	shouldUseBundledVulkan,
	KV_AUTO_QUANT_CONTEXT_THRESHOLD,
	VULKAN_MIN_DEDICATED_VRAM_BYTES,
	type GpuLike,
} from '../../browser/locopilotLlamaCppServer.js';

suite('LoCoPilot llama.cpp server', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Reads the value following `flag` in an args array, or undefined if the flag is absent. */
	function argValue(args: string[], flag: string): string | undefined {
		const i = args.indexOf(flag);
		return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
	}

	suite('resolveKvCacheType', () => {
		test('auto -> f16 below threshold, q8_0 at/above', () => {
			assert.strictEqual(resolveKvCacheType('auto', 8192), 'f16');
			assert.strictEqual(resolveKvCacheType('auto', KV_AUTO_QUANT_CONTEXT_THRESHOLD - 1), 'f16');
			assert.strictEqual(resolveKvCacheType('auto', KV_AUTO_QUANT_CONTEXT_THRESHOLD), 'q8_0');
			assert.strictEqual(resolveKvCacheType('auto', 65536), 'q8_0');
		});

		test('fixed types pass through unchanged', () => {
			assert.strictEqual(resolveKvCacheType('f16', 65536), 'f16');
			assert.strictEqual(resolveKvCacheType('q8_0', 1024), 'q8_0');
			assert.strictEqual(resolveKvCacheType('q4_0', 65536), 'q4_0');
		});
	});

	suite('computeGpuLayers', () => {
		const GB = 1024 * 1024 * 1024;

		test('non-discrete backends return undefined (full offload)', () => {
			assert.strictEqual(computeGpuLayers({ backend: 'metal', modelBytes: 100 * GB, layerCount: 80, systemRamBytes: 16 * GB }), undefined);
			assert.strictEqual(computeGpuLayers({ backend: 'cpu', modelBytes: 4 * GB, layerCount: 32 }), undefined);
		});

		test('model fits in VRAM -> undefined (full offload)', () => {
			assert.strictEqual(computeGpuLayers({ backend: 'cuda', modelBytes: 4 * GB, layerCount: 32, vramBytes: 24 * GB }), undefined);
		});

		test('missing data -> undefined', () => {
			assert.strictEqual(computeGpuLayers({ backend: 'cuda', modelBytes: 40 * GB, layerCount: undefined, vramBytes: 8 * GB }), undefined);
			assert.strictEqual(computeGpuLayers({ backend: 'cuda', modelBytes: 40 * GB, layerCount: 32, vramBytes: 0 }), undefined);
		});

		test('model larger than VRAM -> partial offload, clamped to [0, layerCount]', () => {
			// 40GB model, 64 layers => 0.625GB/layer. 8GB VRAM * 0.9 = 7.2GB budget => 11 layers.
			const n = computeGpuLayers({ backend: 'cuda', modelBytes: 40 * GB, layerCount: 64, vramBytes: 8 * GB });
			assert.strictEqual(n, 11);
		});

		test('tiny VRAM -> 0 layers', () => {
			const n = computeGpuLayers({ backend: 'vulkan', modelBytes: 40 * GB, layerCount: 64, vramBytes: 1 * GB });
			assert.strictEqual(n, 1); // 0.9GB budget / 0.625GB per layer = 1
		});
	});

	suite('shouldUseBundledVulkan', () => {
		const gpu = (vendor: GpuLike['vendor'], vramGB = 0): GpuLike => ({ vendor, totalVramBytes: vramGB * 1024 * 1024 * 1024 });

		test('NVIDIA / AMD always qualify (discrete or capable APU)', () => {
			assert.strictEqual(shouldUseBundledVulkan([gpu('nvidia', 8)]), true);
			assert.strictEqual(shouldUseBundledVulkan([gpu('nvidia', 0)]), true);
			assert.strictEqual(shouldUseBundledVulkan([gpu('amd')]), true);
		});

		test('Intel/unknown qualify only with enough dedicated VRAM', () => {
			assert.strictEqual(shouldUseBundledVulkan([gpu('intel', 0)]), false, 'weak iGPU stays on CPU');
			assert.strictEqual(shouldUseBundledVulkan([gpu('unknown', 2)]), false);
			assert.strictEqual(shouldUseBundledVulkan([{ vendor: 'intel', totalVramBytes: VULKAN_MIN_DEDICATED_VRAM_BYTES }]), true);
		});

		test('Apple GPUs never pick Vulkan (Metal path), empty list is false', () => {
			assert.strictEqual(shouldUseBundledVulkan([gpu('apple')]), false);
			assert.strictEqual(shouldUseBundledVulkan([]), false);
		});

		test('any qualifying GPU in the list is enough', () => {
			assert.strictEqual(shouldUseBundledVulkan([gpu('intel', 0), gpu('nvidia', 6)]), true);
		});
	});

	suite('getBundledLlamaServerPath', () => {
		test('vulkan variant lives in a sibling -vulkan dir', () => {
			const cpu = getBundledLlamaServerPath('/app');
			const vulkan = getBundledLlamaServerPath('/app', 'vulkan');
			assert.ok(cpu && vulkan);
			assert.ok(!cpu!.includes('-vulkan'), 'cpu path has no -vulkan suffix');
			assert.ok(vulkan!.includes('-vulkan'), 'vulkan path has -vulkan suffix');
			// The only difference is the `-vulkan` inserted on the platform-arch directory segment.
			assert.strictEqual(vulkan!.replace('-vulkan', ''), cpu);
		});

		test('undefined app root -> undefined', () => {
			assert.strictEqual(getBundledLlamaServerPath(undefined, 'vulkan'), undefined);
		});
	});

	suite('getLlamaCppServerCommand', () => {
		test('default KV cache is auto: f16 at small context', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { contextSize: 16384 });
			assert.strictEqual(args.indexOf('--cache-type-k'), -1, 'f16 should emit no cache-type flags');
		});

		test('default KV cache is auto: q8_0 at large context', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { contextSize: 65536 });
			assert.strictEqual(argValue(args, '--cache-type-k'), 'q8_0');
			assert.strictEqual(argValue(args, '--cache-type-v'), 'q8_0');
		});

		test('cpu backend forces 0 gpu layers', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'cpu', undefined, 1234, {});
			assert.strictEqual(argValue(args, '--n-gpu-layers'), '0');
		});

		test('explicit partial gpu layers honored', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'cuda', undefined, 1234, { gpuLayers: 11 });
			assert.strictEqual(argValue(args, '--n-gpu-layers'), '11');
		});

		test('gpu backend without override omits --n-gpu-layers (lets llama.cpp auto-fit)', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {});
			assert.strictEqual(args.indexOf('--n-gpu-layers'), -1, 'no flag -> llama.cpp auto-fits / full offload on Metal');
		});

		test('separate draft model adds --model-draft (when MTP off)', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { draftModelPath: '/draft.gguf', draftGpuLayers: 99 });
			assert.strictEqual(argValue(args, '--model-draft'), '/draft.gguf');
			assert.strictEqual(argValue(args, '--gpu-layers-draft'), '99');
		});

		test('MTP takes precedence over a separate draft model', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { multiTokenPrediction: true, draftModelPath: '/draft.gguf' });
			assert.strictEqual(argValue(args, '--model-draft'), '/m.gguf', 'MTP points --model-draft at the main model');
			assert.ok(args.includes('--spec-type'));
		});

		test('parallel slots add --parallel and -cb', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { parallelSlots: 4, continuousBatching: true });
			assert.strictEqual(argValue(args, '--parallel'), '4');
			assert.ok(args.includes('-cb'));
		});

		test('parallelSlots = 1 emits --parallel 1 but no -cb', () => {
			// Explicit single slot must pass --parallel 1; otherwise llama.cpp auto-picks several slots
			// and splits the KV cache, which can overflow context on long prompts. -cb only helps with > 1.
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { parallelSlots: 1, continuousBatching: true });
			assert.strictEqual(argValue(args, '--parallel'), '1');
			assert.strictEqual(args.indexOf('-cb'), -1);
		});

		test('parallelSlots = 0 emits nothing (llama.cpp auto)', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { parallelSlots: 0, continuousBatching: true });
			assert.strictEqual(args.indexOf('--parallel'), -1);
			assert.strictEqual(args.indexOf('-cb'), -1);
		});

		test('threads emitted only when > 0', () => {
			const off = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {});
			assert.strictEqual(off.args.indexOf('--threads'), -1);
			const on = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { threads: 8 });
			assert.strictEqual(argValue(on.args, '--threads'), '8');
		});
	});
});
