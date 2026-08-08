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
	swaFullKvHeadroomBytes,
	maxContextForFullSwa,
	MIN_FULL_SWA_CONTEXT,
	SWA_FULL_GRAPH_MARGIN_FRACTION,
	clampContextSize,
	kvCacheBytesForContext,
	getBundledLlamaServerPath,
	getLlamaCppServerCommand,
	resolveKvCacheType,
	resolveAutoPerformanceProfile,
	resolveKvCachePlan,
	selectAutomaticKvCache,
	kvCacheBytesPerElem,
	kvPlanBytesPerElem,
	kvPlanId,
	symmetricKvPlan,
	KV_CACHE_TIERS,
	ABSOLUTE_MIN_CONTEXT,
	shouldUseBundledVulkan,
	metalOffloadBudgetBytes,
	usableSystemMemoryBytes,
	METAL_WIRED_MEMORY_FRACTION_SMALL,
	METAL_WIRED_MEMORY_FRACTION_MID,
	METAL_WIRED_MEMORY_FRACTION_LARGE,
	METAL_SMALL_RAM_THRESHOLD_BYTES,
	METAL_LARGE_RAM_THRESHOLD_BYTES,
	MAX_CLAMPED_CONTEXT,
	TARGET_MIN_CONTEXT,
	mtpHeadResidentBytes,
	MTP_HEAD_MAX_BYTES,
	MTP_HEAD_MIN_BYTES,
	LLAMA_CTX_CHECKPOINTS,
	SWA_GLOBAL_LAYER_FRACTION,
	USABLE_SYSTEM_MEMORY_FRACTION,
	KV_AUTO_QUANT_CONTEXT_THRESHOLD,
	KV_CLAMP_BUDGET_FRACTION,
	RUNTIME_OVERHEAD_BYTES,
	runtimeOverheadBytesForTuning,
	VULKAN_MIN_DEDICATED_VRAM_BYTES,
	MIN_CLAMPED_CONTEXT,
	DEFAULT_CLAMP_LAYER_COUNT,
	DEFAULT_LLAMA_CONTEXT_SIZE,
	DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16,
	MTP_DRAFT_KV_LAYER_EQUIV,
	type GpuLike,
} from '../../browser/locopilotLlamaCppServer.js';
import { getMlxLmServerCommand, MLX_MEMORY_LIMIT_BOOTSTRAP } from '../../browser/locopilotMlxServer.js';
import { kvLayerCount, recurrentStateBytes, type IGgufModelInfo } from '../../browser/locopilotGgufMetadata.js';

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

		test('the default context window runs a q8_0 KV cache', () => {
			// The threshold is pinned to the default window, so out-of-the-box context is quantized.
			assert.strictEqual(KV_AUTO_QUANT_CONTEXT_THRESHOLD, DEFAULT_LLAMA_CONTEXT_SIZE);
			assert.strictEqual(resolveKvCacheType('auto', DEFAULT_LLAMA_CONTEXT_SIZE), 'q8_0');
		});
	});

	suite('kvCacheBytesPerElem', () => {
		test('includes block scales in f16/q8_0/q4_0 byte costs', () => {
			assert.strictEqual(kvCacheBytesPerElem('f16'), 2);
			assert.strictEqual(kvCacheBytesPerElem('q8_0'), 1.0625);
			assert.strictEqual(kvCacheBytesPerElem('q4_0'), 0.5625);
			assert.ok(kvCacheBytesPerElem('q4_0') < kvCacheBytesPerElem('q8_0'));
		});
	});

	suite('kvPlanBytesPerElem / kvPlanId', () => {
		test('the tier ladder is strictly cheaper per element, best quality first', () => {
			const costs = KV_CACHE_TIERS.map(kvPlanBytesPerElem);
			assert.deepStrictEqual(costs, [2, 1.0625, 0.8125, 0.5625]);
			for (let i = 1; i < costs.length; i++) {
				assert.ok(costs[i] < costs[i - 1], `tier ${i} must be cheaper than tier ${i - 1}`);
			}
		});

		test('the asymmetric rung sits between the two symmetric quantized ones', () => {
			const q8 = kvPlanBytesPerElem({ k: 'q8_0', v: 'q8_0' });
			const mixed = kvPlanBytesPerElem({ k: 'q4_0', v: 'q8_0' });
			const q4 = kvPlanBytesPerElem({ k: 'q4_0', v: 'q4_0' });
			assert.ok(mixed < q8 && mixed > q4);
			// It buys ~31% more context than q8 while keeping the V half (where 4-bit hurts) at 8 bits.
			assert.ok(q8 / mixed > 1.3);
		});

		test('ids are stable and distinguish the asymmetric rung', () => {
			assert.strictEqual(kvPlanId({ k: 'q8_0', v: 'q8_0' }), 'q8_0');
			assert.strictEqual(kvPlanId({ k: 'q4_0', v: 'q8_0' }), 'q4_0-q8_0');
			assert.strictEqual(kvPlanId({ k: 'f16', v: 'f16' }), 'f16');
		});

		test('a user-pinned type stays symmetric - the asymmetric rung is automatic-only', () => {
			assert.deepStrictEqual(resolveKvCachePlan('q4_0', 65536), { k: 'q4_0', v: 'q4_0' });
			assert.deepStrictEqual(symmetricKvPlan('q8_0'), { k: 'q8_0', v: 'q8_0' });
		});
	});

	suite('selectAutomaticKvCache', () => {
		const GB = 1024 * 1024 * 1024;
		const geometry = { layerCount: 32, kvBytesPerTokenPerLayerF16: 4096 };

		test('keeps f16 for a small context when it fits', () => {
			assert.deepStrictEqual(selectAutomaticKvCache({
				requestedContext: 8192,
				modelContextLength: 8192,
				kvBudgetBytes: 2 * GB,
				...geometry,
			}), { kvCachePlan: { k: 'f16', v: 'f16' }, contextSize: 8192 });
		});

		test('prefers near-lossless q8_0 for a normal context when it fits', () => {
			assert.deepStrictEqual(selectAutomaticKvCache({
				requestedContext: 32768,
				kvBudgetBytes: 2.25 * GB,
				...geometry,
			}), { kvCachePlan: { k: 'q8_0', v: 'q8_0' }, contextSize: 32768 });
		});

		test('uses the trained model window when deciding that f16 is sufficient', () => {
			assert.deepStrictEqual(selectAutomaticKvCache({
				requestedContext: 65536,
				modelContextLength: 8192,
				kvBudgetBytes: 2 * GB,
				...geometry,
			}), { kvCachePlan: { k: 'f16', v: 'f16' }, contextSize: 8192 });
		});

		test('keeps q8_0 once it clears the comfort floor, even though a cheaper rung would grant more length', () => {
			// A quantized rung is a floor-REACHING tool, not a maximize-length tool: once q8 is above TARGET_MIN we
			// keep its quality instead of trading down for extra tokens the user didn't ask for.
			const sel = selectAutomaticKvCache({ requestedContext: 131072, kvBudgetBytes: 3 * GB, ...geometry });
			assert.deepStrictEqual(sel.kvCachePlan, { k: 'q8_0', v: 'q8_0' });
			assert.ok(sel.contextSize >= TARGET_MIN_CONTEXT, `q8 context ${sel.contextSize} should clear the ${TARGET_MIN_CONTEXT} floor`);
		});

		test('drops to the asymmetric q4/q8 rung - not straight to 4-bit - when q8_0 misses the comfort floor', () => {
			// Tight budget: q8 lands below TARGET_MIN. The mixed rung reaches the floor, so we stop there and keep
			// the V half at 8 bits instead of quantizing both halves to 4.
			const sel = selectAutomaticKvCache({ requestedContext: 131072, kvBudgetBytes: 2 * GB, ...geometry });
			assert.deepStrictEqual(sel.kvCachePlan, { k: 'q4_0', v: 'q8_0' });
			assert.ok(sel.contextSize >= TARGET_MIN_CONTEXT);
		});

		test('reaches full 4-bit only when the mixed rung still cannot reach the comfort floor', () => {
			const sel = selectAutomaticKvCache({ requestedContext: 131072, kvBudgetBytes: 1.2 * GB, ...geometry });
			assert.deepStrictEqual(sel.kvCachePlan, { k: 'q4_0', v: 'q4_0' });
		});

		test('does not walk down the ladder when a cheaper rung buys no extra context', () => {
			// Budget so small that every rung floors at MIN_CLAMPED_CONTEXT. Downgrading precision would then be a
			// pure quality loss for zero extra tokens, so the highest-quality rung must be kept.
			const sel = selectAutomaticKvCache({ requestedContext: 131072, kvBudgetBytes: 1, ...geometry });
			assert.strictEqual(sel.contextSize, MIN_CLAMPED_CONTEXT);
			assert.deepStrictEqual(sel.kvCachePlan, { k: 'q8_0', v: 'q8_0' });
		});
	});

	suite('runtimeOverheadBytesForTuning', () => {
		test('charges GPU, long-context, large-ubatch, and parallel graph growth', () => {
			const base = runtimeOverheadBytesForTuning({ contextSize: 16384, ubatchSize: 512, parallelSlots: 1 }, 'cpu');
			const heavy = runtimeOverheadBytesForTuning({ contextSize: 131072, ubatchSize: 4096, parallelSlots: 4 }, 'metal');
			assert.strictEqual(base, RUNTIME_OVERHEAD_BYTES);
			assert.ok(heavy > base);
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
			// 32GB sits in the MID band now (24-36GB), not the tight small-machine fraction.
			assert.strictEqual(metalOffloadBudgetBytes(32 * GB), Math.floor(32 * GB * METAL_WIRED_MEMORY_FRACTION_MID));
			// The whole point of the fix: the budget must be strictly less than total RAM.
			assert.ok(metalOffloadBudgetBytes(32 * GB) < 32 * GB);
		});

		test('metalOffloadBudgetBytes is tiered in three bands like Apple\'s default wired ceiling', () => {
			// <18GB (the 8-16GB Macs that page/hang) stay on the tight fraction...
			assert.strictEqual(metalOffloadBudgetBytes(16 * GB), Math.floor(16 * GB * METAL_WIRED_MEMORY_FRACTION_SMALL));
			// ...24-32GB get the MID fraction (recovers the KV budget the flat 0.66 wasted on roomier Macs)...
			assert.strictEqual(metalOffloadBudgetBytes(24 * GB), Math.floor(24 * GB * METAL_WIRED_MEMORY_FRACTION_MID));
			assert.strictEqual(metalOffloadBudgetBytes(METAL_SMALL_RAM_THRESHOLD_BYTES), Math.floor(METAL_SMALL_RAM_THRESHOLD_BYTES * METAL_WIRED_MEMORY_FRACTION_MID));
			// ...and >=36GB get the 75% tier.
			assert.strictEqual(metalOffloadBudgetBytes(64 * GB), Math.floor(64 * GB * METAL_WIRED_MEMORY_FRACTION_LARGE));
			assert.strictEqual(metalOffloadBudgetBytes(METAL_LARGE_RAM_THRESHOLD_BYTES), Math.floor(METAL_LARGE_RAM_THRESHOLD_BYTES * METAL_WIRED_MEMORY_FRACTION_LARGE));
			// The bands are monotonic: a 32GB Mac never gets a smaller budget than under the old flat 0.66.
			assert.ok(metalOffloadBudgetBytes(32 * GB) > Math.floor(32 * GB * METAL_WIRED_MEMORY_FRACTION_SMALL));
		});

		test('metalOffloadBudgetBytes honors an explicit iogpu wired limit, capped below total', () => {
			// User raised the sysctl: their explicit ceiling wins over the fraction heuristic.
			assert.strictEqual(metalOffloadBudgetBytes(64 * GB, 56 * GB), 56 * GB);
			// A wild value can never budget past 90% of physical RAM.
			assert.strictEqual(metalOffloadBudgetBytes(16 * GB, 100 * GB), Math.floor(16 * GB * 0.9));
			// Unset/zero limit -> fraction heuristic as usual.
			assert.strictEqual(metalOffloadBudgetBytes(16 * GB, 0), Math.floor(16 * GB * METAL_WIRED_MEMORY_FRACTION_SMALL));
		});

		test('usableSystemMemoryBytes reserves an absolute OS/editor slice, capped at the fraction', () => {
			// Small machines: the absolute reserve (not the flat 85%) binds, leaving a safer margin for the OS.
			assert.strictEqual(usableSystemMemoryBytes(8 * GB), Math.floor(8 * GB - 2 * GB));   // reserve floored at 2 GB
			assert.strictEqual(usableSystemMemoryBytes(16 * GB), Math.floor(16 * GB - 16 * GB * 0.20)); // 20% reserve
			assert.strictEqual(usableSystemMemoryBytes(32 * GB), Math.floor(32 * GB - 6 * GB)); // reserve capped at 6 GB
			// Large machines: the reserve is capped at 6 GB, so the 85% ceiling is what binds instead.
			assert.strictEqual(usableSystemMemoryBytes(64 * GB), Math.floor(64 * GB * USABLE_SYSTEM_MEMORY_FRACTION));
			// Never exceeds the fraction cap, always below total, and monotonic in the direction of safety.
			assert.ok(usableSystemMemoryBytes(16 * GB) <= Math.floor(16 * GB * USABLE_SYSTEM_MEMORY_FRACTION));
			assert.ok(usableSystemMemoryBytes(16 * GB) < 16 * GB);
		});

		test('zero / unknown total -> 0 (callers skip the budget)', () => {
			assert.strictEqual(metalOffloadBudgetBytes(0), 0);
			assert.strictEqual(usableSystemMemoryBytes(0), 0);
		});
	});

	suite('hybrid (Mamba/attention) KV geometry', () => {
		/** A Nemotron-H-shaped hybrid: 62 blocks of which only 6 are attention blocks. */
		function hybridInfo(overrides: Partial<IGgufModelInfo> = {}): IGgufModelInfo {
			return {
				layerCount: 62,
				attentionLayerCount: 6,
				expertCount: 128,
				contextLength: 1048576,
				kvHeadCount: 8,
				headCount: 40,
				embeddingLength: 5120,
				keyLength: 128,
				valueLength: 128,
				slidingWindow: undefined,
				ssmConvKernel: 4,
				ssmInnerSize: 8192,
				ssmStateSize: 128,
				ssmGroupCount: 8,
				nextnPredictLayers: undefined,
				hasNextnTensors: undefined,
				...overrides,
			};
		}

		/** A conventional dense transformer: every block is an attention block. */
		function denseInfo(): IGgufModelInfo {
			return {
				layerCount: 48, attentionLayerCount: undefined, expertCount: undefined, contextLength: 131072,
				kvHeadCount: 8, headCount: 40, embeddingLength: 5120, keyLength: 128, valueLength: 128,
				slidingWindow: undefined, ssmConvKernel: undefined, ssmInnerSize: undefined,
				ssmStateSize: undefined, ssmGroupCount: undefined,
				nextnPredictLayers: undefined, hasNextnTensors: undefined,
			};
		}

		test('kvLayerCount charges only the attention blocks on a hybrid stack', () => {
			assert.strictEqual(kvLayerCount(hybridInfo()), 6);
		});

		test('kvLayerCount is the full block count on a conventional model', () => {
			assert.strictEqual(kvLayerCount(denseInfo()), 48);
		});

		test('kvLayerCount is undefined when neither count is known, so callers keep their default', () => {
			assert.strictEqual(kvLayerCount({ ...denseInfo(), layerCount: undefined }), undefined);
		});

		test('recurrentStateBytes is zero for a conventional model', () => {
			assert.strictEqual(recurrentStateBytes(denseInfo()), 0);
		});

		test('recurrentStateBytes matches llama.cpp conv + ssm sizing across the recurrent blocks', () => {
			// conv = (d_conv-1) * (d_inner + 2*n_group*d_state); ssm = d_inner * d_state; both f32.
			const conv = (4 - 1) * (8192 + 2 * 8 * 128);
			const ssm = 8192 * 128;
			const expected = (conv + ssm) * 4 * (62 - 6);
			assert.strictEqual(recurrentStateBytes(hybridInfo()), expected);
		});

		test('recurrentStateBytes scales with the slot count', () => {
			assert.strictEqual(recurrentStateBytes(hybridInfo(), 2), recurrentStateBytes(hybridInfo(), 1) * 2);
		});

		test('a hybrid model gets far more context from the same budget than charging every block', () => {
			const perTok = 2048; // q8_0 k+v for 8 kv-heads x 128 dim
			const kvBudgetBytes = 2 * 1024 * 1024 * 1024;
			const asAttentionOnly = clampContextSize({
				requestedContext: 131072,
				kvBudgetBytes,
				layerCount: kvLayerCount(hybridInfo()),
				kvBytesPerTokenPerLayer: perTok,
			});
			const chargingEveryBlock = clampContextSize({
				requestedContext: 131072,
				kvBudgetBytes,
				layerCount: hybridInfo().layerCount,
				kvBytesPerTokenPerLayer: perTok,
			});
			assert.ok(asAttentionOnly > chargingEveryBlock,
				`attention-only sizing should grant more context (${asAttentionOnly} vs ${chargingEveryBlock})`);
			// The old behaviour collapsed straight to the usability floor; the fix clears the comfort floor.
			assert.strictEqual(chargingEveryBlock, MIN_CLAMPED_CONTEXT);
			assert.ok(asAttentionOnly >= TARGET_MIN_CONTEXT);
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

		test('a q8_0 cache grants ~2x the window of f16 for the same budget', () => {
			// The runner sizes perTokenPerLayer at the cache precision (f16=4096, q8_0=2048 via the scaled
			// fallback), so quantizing halves the per-token cost and doubles how much context fits.
			const budget = 2 * 1024 * 1024 * 1024;
			const f16 = clampContextSize({ requestedContext: 262144, kvBudgetBytes: budget, layerCount: 48, kvBytesPerTokenPerLayer: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 });
			const q8 = clampContextSize({ requestedContext: 262144, kvBudgetBytes: budget, layerCount: 48, kvBytesPerTokenPerLayer: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 / 2 });
			assert.strictEqual(f16, 10240);
			assert.strictEqual(q8, 21504); // ~2x the f16 window
		});

		test('MTP surcharge (extra draft-context layers) shrinks the granted context to leave room for the second KV cache', () => {
			// With MTP on, the runner inflates the clamp's layer count by MTP_DRAFT_KV_LAYER_EQUIV so the same
			// budget must also hold the draft context's KV. More layers -> fewer tokens fit -> smaller context,
			// scaled dynamically to the machine's budget (no hard cap). A tiny model with lots of headroom keeps
			// a large context; the surcharge only bites when the KV budget is the binding constraint.
			const budget = 2 * 1024 * 1024 * 1024;
			const noMtp = clampContextSize({ requestedContext: 262144, kvBudgetBytes: budget, layerCount: 24, kvBytesPerTokenPerLayer: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 });
			const withMtp = clampContextSize({ requestedContext: 262144, kvBudgetBytes: budget, layerCount: 24 + MTP_DRAFT_KV_LAYER_EQUIV, kvBytesPerTokenPerLayer: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 });
			assert.ok(withMtp < noMtp, `MTP context (${withMtp}) must be smaller than non-MTP (${noMtp})`);
			assert.strictEqual(MTP_DRAFT_KV_LAYER_EQUIV, 2);
		});

		test('clamps a long-context model even when the GGUF has no layer count', () => {
			// Regression: a non-standard GGUF (e.g. some gemma-4 conversions) can parse without a layer count.
			// The clamp used to be skipped entirely for these, letting a 256K window through and OOM-ing the
			// device. It must now fall back to DEFAULT_CLAMP_LAYER_COUNT and clamp. With the 4096 B/tok default:
			// 2GB / (4096 * 48) = ~10922 -> rounded down to 10240.
			const ctx = clampContextSize({ requestedContext: 262144, kvBudgetBytes: 2 * 1024 * 1024 * 1024 });
			assert.strictEqual(DEFAULT_CLAMP_LAYER_COUNT, 48);
			assert.strictEqual(ctx, 10240);
			assert.ok(ctx < 262144);
		});

		test('never below the floor', () => {
			// ~2000 tokens fit -> rounds to 1024 -> floored up to MIN_CLAMPED_CONTEXT.
			const ctx = clampContextSize({ requestedContext: 32768, kvBudgetBytes: 2000 * 160 * 80, layerCount: 80, kvBytesPerTokenPerLayer: 160 });
			assert.strictEqual(ctx, MIN_CLAMPED_CONTEXT);
		});

		test('the usability floor is 16K, not a token-starved single-digit window', () => {
			// Regression: a tight budget used to hand back a ~5K window, which "starts" but cannot hold this
			// agent's system prompt + tools + a file, so every multi-turn task failed. The floor is now the
			// smallest window that actually works; the runtime watchdog is the backstop if memory runs out.
			assert.strictEqual(MIN_CLAMPED_CONTEXT, 16384);
			assert.strictEqual(ABSOLUTE_MIN_CONTEXT, 4096);
			const ctx = clampContextSize({ requestedContext: 131072, kvBudgetBytes: 5000 * 4096 * 32, layerCount: 32, kvBytesPerTokenPerLayer: 4096 });
			assert.strictEqual(ctx, MIN_CLAMPED_CONTEXT);
		});

		test('a budget too small for even one token still clamps to the floor (not unclamped)', () => {
			// Old behavior skipped the clamp when maxTokens computed to 0, letting a near-full budget
			// escape with the full requested window. Now it clamps and the floor keeps the model usable.
			const ctx = clampContextSize({ requestedContext: 131072, kvBudgetBytes: 1, layerCount: 32, kvBytesPerTokenPerLayer: 4096 });
			assert.strictEqual(ctx, MIN_CLAMPED_CONTEXT);
		});

		test('a ZERO kv budget means exhausted, not unknown', () => {
			// computeKvBudgetBytes returns 0 when the weights + overhead already fill the budget. Reading that as
			// "no budget known" skipped the clamp entirely and let the model escape with its full trained window -
			// the exact opposite of what an exhausted budget means. Only `undefined` may skip the clamp.
			assert.strictEqual(clampContextSize({ requestedContext: 131072, kvBudgetBytes: 0, layerCount: 32, kvBytesPerTokenPerLayer: 4096 }), MIN_CLAMPED_CONTEXT);
			assert.strictEqual(clampContextSize({ requestedContext: 131072, layerCount: 32, kvBytesPerTokenPerLayer: 4096 }), 131072);
		});

		test('the floor never inflates an explicitly smaller request or a smaller trained window', () => {
			// The floor lifts a BUDGET-driven collapse, it is not a minimum imposed on a deliberate choice.
			const explicit = clampContextSize({ requestedContext: 8192, kvBudgetBytes: 1, layerCount: 32, kvBytesPerTokenPerLayer: 4096 });
			assert.strictEqual(explicit, 8192);
			const trained = clampContextSize({ requestedContext: 131072, modelContextLength: 8192, kvBudgetBytes: 1, layerCount: 32, kvBytesPerTokenPerLayer: 4096 });
			assert.strictEqual(trained, 8192);
		});

		test('the OOM ladder may go below the floor via minContext', () => {
			// After a real OOM the machine has proven it cannot hold the planned window, so the ladder's cap must
			// survive the clamp - otherwise the degraded relaunch requests the same window that just died.
			const ctx = clampContextSize({
				requestedContext: ABSOLUTE_MIN_CONTEXT,
				kvBudgetBytes: 1,
				layerCount: 32,
				kvBytesPerTokenPerLayer: 4096,
				minContext: ABSOLUTE_MIN_CONTEXT,
			});
			assert.strictEqual(ctx, ABSOLUTE_MIN_CONTEXT);
		});

		test('sliding-window model gets a MUCH larger context than full-layer sizing for the same budget', () => {
			// Regression: a SWA model (Gemma) was sized as if every layer held the full context, collapsing the
			// window (~8K when far more fits). Windowed sizing charges the SWA layers only `window` tokens, so
			// only the global layers scale with context. Same 2GB budget, 48 layers, f16, window 1024:
			const budget = 2 * 1024 * 1024 * 1024;
			const full = clampContextSize({ requestedContext: 262144, kvBudgetBytes: budget, layerCount: 48, kvBytesPerTokenPerLayer: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 });
			const windowed = clampContextSize({ requestedContext: 262144, kvBudgetBytes: budget, layerCount: 48, kvBytesPerTokenPerLayer: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16, slidingWindow: 1024 });
			assert.strictEqual(full, 10240);
			assert.strictEqual(windowed, 20480); // ~2x with the conservative 0.5 global fraction (far more on 5:1 Gemma)
			assert.ok(windowed > full);
		});

		test('forcing --swa-full on all layers disables windowing (falls back to full-layer sizing)', () => {
			// When swa-full is force-ON, every layer holds the full context, so the windowing must NOT apply -
			// else the clamp would grant a context whose full cache busts the budget.
			const budget = 2 * 1024 * 1024 * 1024;
			const full = clampContextSize({ requestedContext: 262144, kvBudgetBytes: budget, layerCount: 48, kvBytesPerTokenPerLayer: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 });
			const swaFull = clampContextSize({ requestedContext: 262144, kvBudgetBytes: budget, layerCount: 48, kvBytesPerTokenPerLayer: DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16, slidingWindow: 1024, swaFullOnAllLayers: true });
			assert.strictEqual(swaFull, full);
		});

		test('never exceeds the absolute backstop, even with a pathological trained window and spare memory', () => {
			assert.strictEqual(MAX_CLAMPED_CONTEXT, 262144);
			// A model trained to its backstop still gets it (the real ceiling is the model window, this only
			// stops a >256K advertisement).
			assert.strictEqual(clampContextSize({ requestedContext: 262144 }), MAX_CLAMPED_CONTEXT);
			// A 1M-token request with a roomy budget is still bounded by the backstop.
			const ctx = clampContextSize({ requestedContext: 1_000_000, kvBudgetBytes: 400 * 1024 * 1024 * 1024, layerCount: 4, kvBytesPerTokenPerLayer: 128, slidingWindow: 1024 });
			assert.strictEqual(ctx, MAX_CLAMPED_CONTEXT);
		});

		test('emits --n-cpu-moe and --slot-save-path when tuned', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 38452, { cpuMoeLayers: 12, slotSavePath: '/tmp/kv', promptLookup: true });
			assert.strictEqual(argValue(args, '--n-cpu-moe'), '12');
			assert.strictEqual(argValue(args, '--slot-save-path'), '/tmp/kv');
			// The slots endpoint must be enabled too, or the save/restore route 404s.
			assert.ok(args.includes('--slots'));
			assert.ok(args.includes('--spec-type') && args.includes('ngram-cache'));
		});
	});

	suite('kvCacheBytesForContext', () => {
		test('full-attention model charges every layer the full context', () => {
			assert.strictEqual(
				kvCacheBytesForContext({ contextTokens: 8192, layerCount: 48, kvBytesPerTokenPerLayer: 4096 }),
				4096 * 48 * 8192);
		});

		test('sliding-window model charges SWA layers only the window (inverse of the windowed clamp)', () => {
			// window 1024, 48 layers, 0.5 global => 24 global (scale with ctx) + 24 local (pinned to 1024 tokens).
			const globalLayers = Math.ceil(48 * SWA_GLOBAL_LAYER_FRACTION);
			const localLayers = 48 - globalLayers;
			const expected = 4096 * (globalLayers * 8192 + localLayers * 1024);
			const windowed = kvCacheBytesForContext({ contextTokens: 8192, layerCount: 48, kvBytesPerTokenPerLayer: 4096, slidingWindow: 1024 });
			assert.strictEqual(windowed, expected);
			// ...and it's strictly cheaper than sizing every layer full.
			assert.ok(windowed < kvCacheBytesForContext({ contextTokens: 8192, layerCount: 48, kvBytesPerTokenPerLayer: 4096 }));
		});

		test('swa-full on all layers ignores the window (full footprint)', () => {
			assert.strictEqual(
				kvCacheBytesForContext({ contextTokens: 8192, layerCount: 48, kvBytesPerTokenPerLayer: 4096, slidingWindow: 1024, swaFullOnAllLayers: true }),
				kvCacheBytesForContext({ contextTokens: 8192, layerCount: 48, kvBytesPerTokenPerLayer: 4096 }));
		});
	});

	suite('computeKvBudgetBytes', () => {
		const GB = 1024 * 1024 * 1024;

		test('small weights -> full fraction allowance', () => {
			// ~10.6GB budget (16GB Mac wired), 2GB weights: remaining (~7.1GB) > 50% clamp fraction (~5.3GB) -> fraction wins.
			const budget = Math.floor(16 * GB * METAL_WIRED_MEMORY_FRACTION_SMALL);
			assert.strictEqual(computeKvBudgetBytes(budget, 2 * GB), Math.floor(budget * KV_CLAMP_BUDGET_FRACTION));
		});

		test('weights near the budget -> only the true remainder, not the fraction', () => {
			// ~10.6GB budget, 8.5GB weights: remaining = 10.6 - 8.5 - 1.5 = ~0.6GB < ~5.3GB clamp fraction.
			const budget = Math.floor(16 * GB * METAL_WIRED_MEMORY_FRACTION_SMALL);
			const expected = budget - 8.5 * GB - RUNTIME_OVERHEAD_BYTES;
			assert.strictEqual(computeKvBudgetBytes(budget, 8.5 * GB), expected);
			assert.ok(expected < budget * KV_CLAMP_BUDGET_FRACTION);
		});

		test('weights beyond the budget -> 0 (caller floors context at the minimum)', () => {
			assert.strictEqual(computeKvBudgetBytes(10 * GB, 12 * GB), 0);
		});

		test('unknown/zero budget -> 0', () => {
			assert.strictEqual(computeKvBudgetBytes(0, 4 * GB), 0);
		});
	});

	suite('swaFullKvHeadroomBytes', () => {
		const GB = 1024 * 1024 * 1024;

		test('small-weight model with a huge full-SWA KV -> negative headroom (keep windowed SWA)', () => {
			// The real regression: ~25.5GB Metal budget, gemma-4-12B (~7.3GB weights) granted a ~114K context whose
			// full-size SWA KV is ~12.75GB. Weights + full KV + 2GB prompt cache + 1.5GB overhead + 8% graph margin
			// (~2GB) overflows the budget, so --swa-full must NOT be forced.
			const headroom = swaFullKvHeadroomBytes({
				budgetBytes: 25.5 * GB,
				residentWeightBytes: 7.3 * GB,
				fullSwaKvBytes: 12.75 * GB,
				promptCacheReserveBytes: 2 * GB,
			});
			assert.ok(headroom < 0, `expected the full SWA cache NOT to fit, got headroom ${headroom}`);
		});

		test('same model with a modest windowed context -> positive headroom (force it on)', () => {
			// A far smaller full-SWA KV (e.g. a short context) leaves room, so --swa-full is safe to enable.
			const headroom = swaFullKvHeadroomBytes({
				budgetBytes: 25.5 * GB,
				residentWeightBytes: 7.3 * GB,
				fullSwaKvBytes: 3 * GB,
				promptCacheReserveBytes: 2 * GB,
			});
			assert.ok(headroom >= 0, `expected the full SWA cache to fit, got headroom ${headroom}`);
		});

		test('discrete GPU excludes the host prompt cache from the budget', () => {
			// With promptCacheReserve 0 (host RAM, separate from VRAM) the same figures leave more room.
			const withHostCache = swaFullKvHeadroomBytes({ budgetBytes: 16 * GB, residentWeightBytes: 8 * GB, fullSwaKvBytes: 4 * GB, promptCacheReserveBytes: 2 * GB });
			const noHostCache = swaFullKvHeadroomBytes({ budgetBytes: 16 * GB, residentWeightBytes: 8 * GB, fullSwaKvBytes: 4 * GB, promptCacheReserveBytes: 0 });
			assert.strictEqual(noHostCache - withHostCache, 2 * GB);
		});

		test('the graph safety margin scales with the budget', () => {
			// Two otherwise-identical placements differ only by the fraction-of-budget graph margin.
			const base = { residentWeightBytes: 4 * GB, fullSwaKvBytes: 4 * GB, promptCacheReserveBytes: 2 * GB };
			const h = swaFullKvHeadroomBytes({ budgetBytes: 20 * GB, ...base });
			const expected = 20 * GB - 4 * GB - 4 * GB - RUNTIME_OVERHEAD_BYTES - 2 * GB - Math.floor(20 * GB * SWA_FULL_GRAPH_MARGIN_FRACTION);
			assert.strictEqual(h, expected);
		});
	});

	suite('maxContextForFullSwa', () => {
		const GB = 1024 * 1024 * 1024;
		// gemma-4-E4B on an M3: ~11.8GiB Metal budget, weights+overhead ~7.8GiB, and a full-SWA KV that costs
		// ~91KB/token at the context the clamp picked. The old yes/no gate saw 80K tokens (~6.8GB) not fitting
		// and gave up; solving for the context instead should still land well above the floor.
		const base = {
			budgetBytes: 11.84 * GB,
			residentWeightBytes: 6.3 * GB,
			fullSwaBytesPerToken: 91392,
			promptCacheReserveBytes: 0,
		};

		test('trades context down to something that fits instead of giving up', () => {
			const ctx = maxContextForFullSwa({ ...base, requestedContext: 79872 });
			assert.ok(ctx >= MIN_FULL_SWA_CONTEXT, `expected a usable traded context, got ${ctx}`);
			assert.ok(ctx < 79872, `expected the context to be reduced, got ${ctx}`);
			assert.strictEqual(ctx % 1024, 0, 'traded context must stay a 1024 multiple');
		});

		test('never hands back more than was requested', () => {
			// A tiny model on a huge budget could "afford" far more than the caller asked for.
			const ctx = maxContextForFullSwa({ ...base, budgetBytes: 128 * GB, requestedContext: 8192 });
			assert.strictEqual(ctx, 8192);
		});

		test('returns 0 when the weights alone exhaust the budget', () => {
			const ctx = maxContextForFullSwa({ ...base, residentWeightBytes: 11.5 * GB, requestedContext: 32768 });
			assert.strictEqual(ctx, 0);
		});

		test('returns 0 when the per-token cost is unknown', () => {
			const ctx = maxContextForFullSwa({ ...base, fullSwaBytesPerToken: 0, requestedContext: 32768 });
			assert.strictEqual(ctx, 0);
		});

		test('agrees with the headroom gate at the context it returns', () => {
			// The solver's result must actually pass the yes/no gate, otherwise the two disagree at the boundary.
			const ctx = maxContextForFullSwa({ ...base, requestedContext: 79872 });
			const headroom = swaFullKvHeadroomBytes({
				budgetBytes: base.budgetBytes,
				residentWeightBytes: base.residentWeightBytes,
				fullSwaKvBytes: ctx * base.fullSwaBytesPerToken,
				promptCacheReserveBytes: base.promptCacheReserveBytes,
			});
			assert.ok(headroom >= 0, `solver returned ${ctx} but the gate rejects it (headroom ${headroom})`);
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
			assert.strictEqual(shouldUseBundledVulkan([gpu('intel', 0)]), false, 'unnamed iGPU stays on CPU');
			assert.strictEqual(shouldUseBundledVulkan([gpu('unknown', 2)]), false);
			assert.strictEqual(shouldUseBundledVulkan([{ vendor: 'intel', totalVramBytes: VULKAN_MIN_DEDICATED_VRAM_BYTES }]), true);
		});

		test('a modern Intel iGPU qualifies on its NAME despite reporting no dedicated VRAM', () => {
			// The whole point: an iGPU borrows system memory, so it can never clear the VRAM bar however new it is.
			assert.strictEqual(shouldUseBundledVulkan([{ vendor: 'intel', totalVramBytes: 0, name: 'Intel(R) Arc(TM) Graphics' }]), true);
			// Windows splits "Iris Xe" with a trademark marker; Linux reports it contiguously. Both must match.
			assert.strictEqual(shouldUseBundledVulkan([{ vendor: 'intel', totalVramBytes: 0, name: 'Intel(R) Iris(R) Xe Graphics' }]), true);
			assert.strictEqual(shouldUseBundledVulkan([{ vendor: 'intel', totalVramBytes: 0, name: 'Intel Corporation Meteor Lake-P [Intel Arc Graphics]' }]), true);
		});

		test('legacy Intel iGPUs still stay on the CPU build', () => {
			for (const name of ['Intel(R) UHD Graphics 620', 'Intel(R) HD Graphics 530', 'Intel(R) Iris(R) Plus Graphics 640', 'Intel(R) Graphics']) {
				assert.strictEqual(shouldUseBundledVulkan([{ vendor: 'intel', totalVramBytes: 0, name }]), false, name);
			}
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

	suite('getLlamaCppServerCommand: --no-mmap', () => {
		test('emitted when the planner set noMmap alongside an expert-offload split', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {
				contextSize: 16384,
				overrideTensors: ['blk\\.(3[0-9])\\.ffn_.*_exps=CPU'],
				noMmap: true,
			});
			assert.ok(args.includes('--no-mmap'), 'CPU tensor overrides should drop the weight mmap');
		});

		test('emitted for the coarse --n-cpu-moe split too', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {
				contextSize: 16384,
				cpuMoeLayers: 12,
				noMmap: true,
			});
			assert.ok(args.includes('--n-cpu-moe'));
			assert.ok(args.includes('--no-mmap'));
		});

		test('absent when nothing was offloaded to the CPU (the planner leaves noMmap unset)', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { contextSize: 16384 });
			assert.ok(!args.includes('--no-mmap'), 'a fully-resident model must keep mmap');
		});

		test('an explicit false is honoured even with tensors on the CPU', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {
				contextSize: 16384,
				cpuMoeLayers: 12,
				noMmap: false,
			});
			assert.ok(!args.includes('--no-mmap'));
		});
	});

	suite('getLlamaCppServerCommand', () => {
		test('default KV cache is auto: f16 below the auto-quant threshold', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { contextSize: 8192 });
			assert.ok(8192 < KV_AUTO_QUANT_CONTEXT_THRESHOLD);
			assert.strictEqual(args.indexOf('--cache-type-k'), -1, 'f16 should emit no cache-type flags');
			assert.strictEqual(args.indexOf('--cache-type-v'), -1, 'f16 should emit no cache-type flags');
		});

		test('default KV cache is auto: q8_0 at large context', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { contextSize: 65536 });
			assert.strictEqual(argValue(args, '--cache-type-k'), 'q8_0');
			assert.strictEqual(argValue(args, '--cache-type-v'), 'q8_0');
		});

		test('a pinned asymmetric plan emits different K and V precisions', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {
				contextSize: 65536,
				kvCachePlan: { k: 'q4_0', v: 'q8_0' },
			});
			assert.strictEqual(argValue(args, '--cache-type-k'), 'q4_0');
			assert.strictEqual(argValue(args, '--cache-type-v'), 'q8_0');
		});

		test('a pinned plan wins over the settings-derived type', () => {
			// The planner sized the context for this exact plan; re-resolving `kvCacheType` here would flip the
			// precision out from under the clamp that just budgeted for it.
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {
				contextSize: 65536,
				kvCacheType: 'f16',
				kvCachePlan: { k: 'q4_0', v: 'q8_0' },
			});
			assert.strictEqual(argValue(args, '--cache-type-k'), 'q4_0');
			assert.strictEqual(argValue(args, '--cache-type-v'), 'q8_0');
		});

		test('a quantized K half survives flash attention off (only V needs FA)', () => {
			// Only the V half is implemented inside the FA kernel, so a quantized K is fine without it and the
			// user's explicit `-fa off` is honoured rather than silently promoted to 'auto'.
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {
				contextSize: 65536,
				flashAttention: 'off',
				kvCachePlan: { k: 'q4_0', v: 'f16' },
			});
			assert.strictEqual(argValue(args, '-fa'), 'off');
			assert.strictEqual(argValue(args, '--cache-type-k'), 'q4_0');
			assert.strictEqual(args.indexOf('--cache-type-v'), -1, 'an f16 V half needs no flag');
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

		test('MTP loads the embedded head via --spec-type only (no --model-draft second copy)', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { multiTokenPrediction: true });
			assert.strictEqual(args.indexOf('--model-draft'), -1, 'MTP must NOT pass --model-draft (that loads a full second weight copy)');
			assert.strictEqual(argValue(args, '--spec-type'), 'draft-mtp');
		});

		test('MTP takes precedence over a separate draft model (no --model-draft emitted)', () => {
			const { args } = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { multiTokenPrediction: true, draftModelPath: '/draft.gguf' });
			assert.strictEqual(args.indexOf('--model-draft'), -1, 'MTP wins and uses the embedded head, not the separate draft');
			assert.strictEqual(argValue(args, '--spec-type'), 'draft-mtp');
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

		test('peak-memory guards (concurrency / prefill / cache count) emitted when tuned', () => {
			const { args } = getMlxLmServerCommand('/models/qwen', 38462, 'python3', {
				decodeConcurrency: 1,
				promptConcurrency: 1,
				prefillStepSize: 512,
				promptCacheCount: 2,
			});
			assert.strictEqual(argValue(args, '--decode-concurrency'), '1');
			assert.strictEqual(argValue(args, '--prompt-concurrency'), '1');
			assert.strictEqual(argValue(args, '--prefill-step-size'), '512');
			assert.strictEqual(argValue(args, '--prompt-cache-size'), '2');
		});

		test('peak-memory guards omitted when not tuned (safe for older mlx-lm)', () => {
			const { args } = getMlxLmServerCommand('/models/qwen', 38462, 'python3', { promptCacheBytes: 1024 });
			assert.strictEqual(args.indexOf('--decode-concurrency'), -1);
			assert.strictEqual(args.indexOf('--prefill-step-size'), -1);
			assert.strictEqual(args.indexOf('--prompt-cache-size'), -1);
		});
	});

	suite('auto performance profile', () => {
		test('battery selects balanced, mains selects performance', () => {
			assert.strictEqual(resolveAutoPerformanceProfile('battery', 'nominal'), 'balanced');
			assert.strictEqual(resolveAutoPerformanceProfile('ac', 'nominal'), 'performance');
			// A desktop reports 'ac' and must be completely unaffected by the feature.
			assert.strictEqual(resolveAutoPerformanceProfile('ac', 'fair'), 'performance');
		});

		test('thermal pressure outranks the power source', () => {
			// Plugged in but already throttling: being on mains does not make the heat go away, and starting
			// another full-tilt load here is what ends with the watchdog stopping a server.
			assert.strictEqual(resolveAutoPerformanceProfile('ac', 'serious'), 'quiet');
			assert.strictEqual(resolveAutoPerformanceProfile('ac', 'critical'), 'quiet');
			assert.strictEqual(resolveAutoPerformanceProfile('battery', 'critical'), 'quiet');
			// 'fair' is normal warm operation, not throttling - it must NOT trigger a backoff.
			assert.strictEqual(resolveAutoPerformanceProfile('battery', 'fair'), 'balanced');
		});

		test('an unknown probe never throttles - it keeps the previous default', () => {
			assert.strictEqual(resolveAutoPerformanceProfile('unknown', 'unknown'), 'performance');
			assert.strictEqual(resolveAutoPerformanceProfile('unknown', 'nominal'), 'performance');
			// Thermal is macOS-only, so an unknown thermal reading on Windows/Linux must still let the
			// power source decide rather than voiding the whole feature.
			assert.strictEqual(resolveAutoPerformanceProfile('battery', 'unknown'), 'balanced');
			// ...and an unknown power source must not be guessed as battery.
			assert.strictEqual(resolveAutoPerformanceProfile('unknown', 'serious'), 'quiet');
		});
	});

	suite('MTP budgeting', () => {
		const GB = 1e9;
		// Attention geometry back-solved from a real Qwen3.6-27B launch log: a ~5.2 GB q8 KV budget granted
		// 46080 tokens, which lands on 64 layers x ~3350 B/token/layer at f16. Reproducing that number is what
		// makes the "after" figures below trustworthy.
		const L27 = 64, F16_27 = 3350, W27 = 17.2 * GB;
		const metal32 = metalOffloadBudgetBytes(34359738368);

		// Mirrors the launch path: the MTP head is subtracted from the budget BEFORE context is sized, and the
		// draft context's own KV is charged by inflating the layer count.
		function plan(requested: number, weights: number, layers: number, f16: number, budget: number, mtp: boolean) {
			const head = mtp ? mtpHeadResidentBytes(weights) : 0;
			return selectAutomaticKvCache({
				requestedContext: requested,
				modelContextLength: 262144,
				kvBudgetBytes: computeKvBudgetBytes(budget - head, weights, RUNTIME_OVERHEAD_BYTES),
				layerCount: mtp ? layers + MTP_DRAFT_KV_LAYER_EQUIV : layers,
				kvBytesPerTokenPerLayerF16: f16,
			});
		}

		test('reproduces the observed 27B launch (~46K at q8) with MTP off', () => {
			const old = plan(262144, W27, L27, F16_27, metal32, false);
			assert.strictEqual(kvPlanId(old.kvCachePlan), 'q8_0');
			assert.ok(old.contextSize >= 44000 && old.contextSize <= 47000, `got ${old.contextSize}`);
		});

		test('a 27B keeps q8 and clears the comfort floor once MTP is budgeted in', () => {
			// The reserve, NOT any context cap, is what makes room - the request stays at the full window.
			const now = plan(262144, W27, L27, F16_27, metal32, true);
			assert.strictEqual(kvPlanId(now.kvCachePlan), 'q8_0', 'precision is not traded away');
			assert.ok(now.contextSize >= TARGET_MIN_CONTEXT, `got ${now.contextSize}`);
			assert.ok(now.contextSize < plan(262144, W27, L27, F16_27, metal32, false).contextSize,
				'MTP is paid for out of context length, not by disabling MTP');
		});

		test('a roomy machine keeps its full window - the reserve costs it nothing', () => {
			// The regression a fixed planner target WOULD have caused, and the reason there is no such constant:
			// a 27B that fits comfortably must not be held to the window of one squeezed onto 32 GB.
			for (const totalRam of [68719476736, 137438953472]) {
				const roomy = plan(262144, W27, L27, F16_27, metalOffloadBudgetBytes(totalRam), true);
				assert.ok(roomy.contextSize > 200000, `${totalRam / GB}GB gave only ${roomy.contextSize}`);
			}
		});

		test('the reserve only shortens the window on machines that are actually tight', () => {
			const tight = metal32;
			const roomy = metalOffloadBudgetBytes(137438953472);
			assert.ok(plan(262144, W27, L27, F16_27, tight, true).contextSize < plan(262144, W27, L27, F16_27, tight, false).contextSize);
			assert.strictEqual(plan(262144, W27, L27, F16_27, roomy, true).contextSize, plan(262144, W27, L27, F16_27, roomy, false).contextSize);
		});

		test('the head reserve tracks head tensors, not the old 8%-of-weights charge', () => {
			// Must cover more than one transformer block of a 64-layer 27B, and stay far under the 1.37 GB the
			// old formula charged - that gap is exactly what used to push MTP over the budget.
			assert.ok(mtpHeadResidentBytes(W27) > W27 / L27);
			assert.ok(mtpHeadResidentBytes(W27) < 0.08 * W27 / 3);
			assert.strictEqual(mtpHeadResidentBytes(400 * GB), MTP_HEAD_MAX_BYTES);
			assert.strictEqual(mtpHeadResidentBytes(0), MTP_HEAD_MIN_BYTES);
		});

		test('MTP quantizes the draft KV to match the target, and only then', () => {
			const q8 = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { multiTokenPrediction: true, kvCachePlan: symmetricKvPlan('q8_0') }).args;
			assert.strictEqual(argValue(q8, '--spec-draft-type-k'), 'q8_0');
			assert.strictEqual(argValue(q8, '--spec-draft-type-v'), 'q8_0');
			// An f16 target means either a small window or an engine that refused quantized KV; the draft
			// context would refuse it too, so it is left at the build default.
			const f16 = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { multiTokenPrediction: true, kvCachePlan: symmetricKvPlan('f16') }).args;
			assert.ok(!f16.includes('--spec-draft-type-k'));
			const pinned = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { multiTokenPrediction: true, mtpArgs: '--spec-type draft-mtp --spec-draft-type-k f16', kvCachePlan: symmetricKvPlan('q8_0') }).args;
			assert.strictEqual(argValue(pinned, '--spec-draft-type-k'), 'f16');
			const plain = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, { kvCachePlan: symmetricKvPlan('q8_0') }).args;
			assert.ok(!plain.includes('--spec-draft-type-k'));
		});

		test('context checkpoints are capped on every launch', () => {
			const args = getLlamaCppServerCommand('/m.gguf', 'metal', undefined, 1234, {}).args;
			assert.strictEqual(argValue(args, '--ctx-checkpoints'), String(LLAMA_CTX_CHECKPOINTS));
			assert.ok(LLAMA_CTX_CHECKPOINTS < 32, 'must be below the llama.cpp default');
		});
	});

});
