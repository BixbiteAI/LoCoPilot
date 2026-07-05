/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	computeGpuLayers,
	computeCpuMoeLayers,
	computeKvBudgetBytes,
	clampContextSize,
	getBundledLlamaServerPath,
	getLlamaCppServerCommand,
	resolveKvCacheType,
	shouldUseBundledVulkan,
	metalOffloadBudgetBytes,
	usableSystemMemoryBytes,
	METAL_WIRED_MEMORY_FRACTION,
	USABLE_SYSTEM_MEMORY_FRACTION,
	KV_AUTO_QUANT_CONTEXT_THRESHOLD,
	KV_BUDGET_FRACTION,
	RUNTIME_OVERHEAD_BYTES,
	VULKAN_MIN_DEDICATED_VRAM_BYTES,
	MIN_CLAMPED_CONTEXT,
	type GpuLike,
} from '../../browser/locopilotLlamaCppServer.js';
import { getMlxLmServerCommand, MLX_MEMORY_LIMIT_BOOTSTRAP } from '../../browser/locopilotMlxServer.js';

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

	suite('computeCpuMoeLayers', () => {
		const GB = 1024 * 1024 * 1024;

		test('dense model (no experts) -> undefined', () => {
			assert.strictEqual(computeCpuMoeLayers({ backend: 'cuda', modelBytes: 40 * GB, layerCount: 64, expertCount: undefined, memoryBudgetBytes: 8 * GB }), undefined);
			assert.strictEqual(computeCpuMoeLayers({ backend: 'cuda', modelBytes: 40 * GB, layerCount: 64, expertCount: 1, memoryBudgetBytes: 8 * GB }), undefined);
		});

		test('cpu backend -> undefined (already on CPU)', () => {
			assert.strictEqual(computeCpuMoeLayers({ backend: 'cpu', modelBytes: 40 * GB, layerCount: 64, expertCount: 128, memoryBudgetBytes: 8 * GB }), undefined);
		});

		test('MoE model that fits the budget -> undefined (no offload)', () => {
			assert.strictEqual(computeCpuMoeLayers({ backend: 'metal', modelBytes: 6 * GB, layerCount: 48, expertCount: 128, memoryBudgetBytes: 16 * GB }), undefined);
		});

		test('MoE model over budget -> offload enough whole blocks', () => {
			// 20GB model, 48 layers => ~0.4167GB/layer. 8GB * 0.9 = 7.2GB budget; over by 12.8GB => ceil(30.7) = 31.
			const n = computeCpuMoeLayers({ backend: 'cuda', modelBytes: 20 * GB, layerCount: 48, expertCount: 128, memoryBudgetBytes: 8 * GB });
			assert.strictEqual(n, 31);
		});

		test('result clamped to [1, layerCount]', () => {
			const n = computeCpuMoeLayers({ backend: 'vulkan', modelBytes: 200 * GB, layerCount: 32, expertCount: 64, memoryBudgetBytes: 2 * GB });
			assert.strictEqual(n, 32);
		});
	});

	suite('memory budgets', () => {
		const GB = 1024 * 1024 * 1024;

		test('metalOffloadBudgetBytes is the wired fraction of total, not raw total', () => {
			assert.strictEqual(metalOffloadBudgetBytes(32 * GB), Math.floor(32 * GB * METAL_WIRED_MEMORY_FRACTION));
			// The whole point of the fix: the budget must be strictly less than total RAM.
			assert.ok(metalOffloadBudgetBytes(32 * GB) < 32 * GB);
		});

		test('usableSystemMemoryBytes leaves headroom below total', () => {
			assert.strictEqual(usableSystemMemoryBytes(16 * GB), Math.floor(16 * GB * USABLE_SYSTEM_MEMORY_FRACTION));
			assert.ok(usableSystemMemoryBytes(16 * GB) < 16 * GB);
		});

		test('zero / unknown total -> 0 (callers skip the budget)', () => {
			assert.strictEqual(metalOffloadBudgetBytes(0), 0);
			assert.strictEqual(usableSystemMemoryBytes(0), 0);
		});
	});

	suite('clampContextSize', () => {
		test('no constraints -> requested (rounded to 1024)', () => {
			assert.strictEqual(clampContextSize({ requestedContext: 16384 }), 16384);
		});

		test('caps to the model trained window', () => {
			assert.strictEqual(clampContextSize({ requestedContext: 131072, modelContextLength: 32768 }), 32768);
		});

		test('caps to the KV memory budget (explicit per-token estimate)', () => {
			// Tight: 64MB budget / (160 B/tok/layer * 32 layers) = ~13107 -> rounded down to 12288.
			const ctx = clampContextSize({ requestedContext: 32768, kvBudgetBytes: 64 * 1024 * 1024, layerCount: 32, kvBytesPerTokenPerLayer: 160 });
			assert.strictEqual(ctx, 12288);
		});

		test('default per-token estimate (4096) clamps a long-context model', () => {
			// 2GB KV budget / (4096 B/tok/layer * 36 layers) = ~14563 -> rounded down to 14336.
			const ctx = clampContextSize({ requestedContext: 262144, kvBudgetBytes: 2 * 1024 * 1024 * 1024, layerCount: 36 });
			assert.strictEqual(ctx, 14336);
		});

		test('never below the floor', () => {
			// ~2000 tokens fit -> rounds to 1024 -> floored up to MIN_CLAMPED_CONTEXT.
			const ctx = clampContextSize({ requestedContext: 32768, kvBudgetBytes: 2000 * 160 * 80, layerCount: 80, kvBytesPerTokenPerLayer: 160 });
			assert.strictEqual(ctx, MIN_CLAMPED_CONTEXT);
		});

		test('a budget too small for even one token still clamps to the floor (not unclamped)', () => {
			// Old behavior skipped the clamp when maxTokens computed to 0, letting a near-full budget
			// escape with the full requested window. Now it clamps and the floor keeps the model usable.
			const ctx = clampContextSize({ requestedContext: 131072, kvBudgetBytes: 1, layerCount: 32, kvBytesPerTokenPerLayer: 4096 });
			assert.strictEqual(ctx, MIN_CLAMPED_CONTEXT);
		});

		test('emits --n-cpu-moe and --slot-save-path when tuned', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 38452, { cpuMoeLayers: 12, slotSavePath: '/tmp/kv', promptLookup: true });
			assert.strictEqual(argValue(args, '--n-cpu-moe'), '12');
			assert.strictEqual(argValue(args, '--slot-save-path'), '/tmp/kv');
			assert.ok(args.includes('--spec-type') && args.includes('ngram-cache'));
		});
	});

	suite('computeKvBudgetBytes', () => {
		const GB = 1024 * 1024 * 1024;

		test('small weights -> full fraction allowance', () => {
			// 11.2GB budget (16GB Mac wired), 4GB weights: remaining 5.7GB > 25% fraction (2.8GB) -> fraction wins.
			const budget = Math.floor(16 * GB * METAL_WIRED_MEMORY_FRACTION);
			assert.strictEqual(computeKvBudgetBytes(budget, 4 * GB), Math.floor(budget * KV_BUDGET_FRACTION));
		});

		test('weights near the budget -> only the true remainder, not the fraction', () => {
			// 11.2GB budget, 9GB weights: remaining = 11.2 - 9 - 1.5 = ~0.7GB < 2.8GB fraction.
			const budget = Math.floor(16 * GB * METAL_WIRED_MEMORY_FRACTION);
			const expected = budget - 9 * GB - RUNTIME_OVERHEAD_BYTES;
			assert.strictEqual(computeKvBudgetBytes(budget, 9 * GB), expected);
			assert.ok(expected < budget * KV_BUDGET_FRACTION);
		});

		test('weights beyond the budget -> 0 (caller floors context at the minimum)', () => {
			assert.strictEqual(computeKvBudgetBytes(10 * GB, 12 * GB), 0);
		});

		test('unknown/zero budget -> 0', () => {
			assert.strictEqual(computeKvBudgetBytes(0, 4 * GB), 0);
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

		test('separate draft model also emits --spec-type draft-simple (required on current builds)', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { draftModelPath: '/draft.gguf' });
			assert.strictEqual(argValue(args, '--spec-type'), 'draft-simple');
		});

		test('promptLookup is suppressed while a draft-based speculation is active (single --spec-type)', () => {
			const withDraft = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { draftModelPath: '/draft.gguf', promptLookup: true, promptLookupArgs: '--spec-type ngram-mod' });
			assert.strictEqual(withDraft.args.filter(a => a === '--spec-type').length, 1, 'only the draft spec-type is emitted');
			assert.strictEqual(argValue(withDraft.args, '--spec-type'), 'draft-simple');
			const withMtp = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { multiTokenPrediction: true, promptLookup: true });
			assert.strictEqual(withMtp.args.filter(a => a === '--spec-type').length, 1, 'MTP wins over promptLookup');
		});

		test('MTP takes precedence over a separate draft model', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { multiTokenPrediction: true, draftModelPath: '/draft.gguf' });
			assert.strictEqual(argValue(args, '--model-draft'), '/m.gguf', 'MTP points --model-draft at the main model');
			assert.ok(args.includes('--spec-type'));
		});

		test('swaFull emits --swa-full; unset omits it', () => {
			const on = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { swaFull: true });
			assert.ok(on.args.includes('--swa-full'), 'swaFull:true adds --swa-full');
			const off = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {});
			assert.strictEqual(off.args.indexOf('--swa-full'), -1, 'no swaFull -> no flag (llama.cpp default)');
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

		test('cache-ram cap emitted when set, 0 disables, undefined leaves the build default', () => {
			const capped = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 38452, { cacheRamMiB: 1638 });
			assert.strictEqual(argValue(capped.args, '--cache-ram'), '1638');
			const disabled = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 38452, { cacheRamMiB: 0 });
			assert.strictEqual(argValue(disabled.args, '--cache-ram'), '0');
			const unset = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 38452, {});
			assert.strictEqual(unset.args.indexOf('--cache-ram'), -1);
		});

		test('threads emitted only when > 0', () => {
			const off = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {});
			assert.strictEqual(off.args.indexOf('--threads'), -1);
			const on = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { threads: 8 });
			assert.strictEqual(argValue(on.args, '--threads'), '8');
		});
	});

	suite('getMlxLmServerCommand tuning', () => {
		test('no tuning -> plain command (safe for any mlx-lm version)', () => {
			const { args } = getMlxLmServerCommand('/models/qwen', 38462, 'python3');
			assert.strictEqual(args.indexOf('--draft-model'), -1);
			assert.strictEqual(args.indexOf('--prompt-cache-bytes'), -1);
		});

		test('draft model + num draft tokens + prompt cache cap emitted when tuned', () => {
			const { args } = getMlxLmServerCommand('/models/qwen', 38462, 'python3', {
				draftModelDir: '/models/qwen-draft',
				numDraftTokens: 3,
				promptCacheBytes: 1024,
			});
			assert.strictEqual(argValue(args, '--draft-model'), '/models/qwen-draft');
			assert.strictEqual(argValue(args, '--num-draft-tokens'), '3');
			assert.strictEqual(argValue(args, '--prompt-cache-bytes'), '1024');
		});

		test('num draft tokens only emitted alongside a draft model', () => {
			const { args } = getMlxLmServerCommand('/models/qwen', 38462, 'python3', { numDraftTokens: 3 });
			assert.strictEqual(args.indexOf('--num-draft-tokens'), -1);
		});

		test('memory/cache limits switch to the -c bootstrap with limits as the first two argv entries', () => {
			const { args } = getMlxLmServerCommand('/models/qwen', 38462, 'python3', {
				memoryLimitBytes: 11 * 1024 * 1024 * 1024,
				cacheLimitBytes: 2 * 1024 * 1024 * 1024,
				promptCacheBytes: 1024,
			});
			assert.strictEqual(args[0], '-c');
			assert.strictEqual(args[1], MLX_MEMORY_LIMIT_BOOTSTRAP);
			assert.strictEqual(args[2], String(11 * 1024 * 1024 * 1024));
			assert.strictEqual(args[3], String(2 * 1024 * 1024 * 1024));
			assert.strictEqual(args[4], 'server');
			// Server flags still present after the subcommand, and no -m form in this shape.
			assert.strictEqual(argValue(args, '--prompt-cache-bytes'), '1024');
			assert.strictEqual(args.indexOf('-m'), -1);
			// The bootstrap must stay shell-safe under the runner's double-quote wrapping: single quotes only.
			assert.strictEqual(MLX_MEMORY_LIMIT_BOOTSTRAP.indexOf('"'), -1);
		});

		test('no memory/cache limits -> classic -m mlx_lm server form', () => {
			const { args } = getMlxLmServerCommand('/models/qwen', 38462, 'python3', { promptCacheBytes: 1024 });
			assert.strictEqual(args[0], '-m');
			assert.strictEqual(args[1], 'mlx_lm');
			assert.strictEqual(args[2], 'server');
		});
	});
});
