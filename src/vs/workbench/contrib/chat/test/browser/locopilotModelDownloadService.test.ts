/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	pickBestGgufForBudget,
	planGgufDownload,
	groupGgufCandidates,
	estimateGgufRuntimeFootprintBytes,
	quantQualityScore,
	quantNameFromPath,
	isGgufFormatRequest,
	modelParamsBillionsFromName,
	estimateLayerCountFromModelName,
	MAX_AUTO_GGUF_QUANT,
	GOOD_QUANT_FLOOR,
	HARD_QUANT_FLOOR,
	isMtpGgufPath,
} from '../../browser/locopilotModelDownloadService.js';

const GB = 1024 * 1024 * 1024;

suite('LoCoPilot model download - hardware-aware quant selection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// A typical HF GGUF repo for a ~7B model, one file per quant, realistic sizes.
	const repo7b = [
		{ path: 'model-Q4_K_M.gguf', size: 4.7 * GB },
		{ path: 'model-Q5_K_M.gguf', size: 5.4 * GB },
		{ path: 'model-Q6_K.gguf', size: 6.3 * GB },
		{ path: 'model-Q8_0.gguf', size: 8.1 * GB },
		{ path: 'model-f16.gguf', size: 15.2 * GB },
		{ path: 'mmproj-model-f16.gguf', size: 0.6 * GB },
	];

	suite('quantQualityScore', () => {
		test('orders quants by quality, F16 > Q8 > Q6 > Q4 > Q2', () => {
			assert.ok(quantQualityScore('m-F16.gguf') > quantQualityScore('m-Q8_0.gguf'));
			assert.ok(quantQualityScore('m-Q8_0.gguf') > quantQualityScore('m-Q6_K.gguf'));
			assert.ok(quantQualityScore('m-Q6_K.gguf') > quantQualityScore('m-Q4_K_M.gguf'));
			assert.ok(quantQualityScore('m-Q4_K_M.gguf') > quantQualityScore('m-Q2_K.gguf'));
		});

		test('modern K_L / K_XL variants outrank the plain K_M of the same class', () => {
			assert.ok(quantQualityScore('m-Q4_K_XL.gguf') > quantQualityScore('m-Q4_K_L.gguf'));
			assert.ok(quantQualityScore('m-Q4_K_L.gguf') > quantQualityScore('m-Q4_K_M.gguf'));
		});

		test('Unsloth dynamic (UD-) prefix scores off the core quant name', () => {
			assert.strictEqual(quantQualityScore('m-UD-Q4_K_XL.gguf'), quantQualityScore('m-Q4_K_XL.gguf'));
		});

		test('unrecognised quant scores lowest', () => {
			assert.strictEqual(quantQualityScore('m-weird.gguf'), 0);
		});
	});

	suite('isMtpGgufPath / MTP draft heads are never picked as the model', () => {
		// Real layout of a Gemma 4 repo (both the regular and the QAT builds ship these).
		const gemma4Qat = [
			{ path: 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf', size: 6.26 * GB },
			{ path: 'MTP/mtp-gemma-4-12B-it-Q8_0.gguf', size: 0.43 * GB },
			{ path: 'MTP/mtp-gemma-4-12B-it-BF16.gguf', size: 0.8 * GB },
			{ path: 'MTP/mtp-gemma-4-12B-it-Q4_0.gguf', size: 0.24 * GB },
			{ path: 'mtp-gemma-4-12B-it.gguf', size: 0.24 * GB },
			{ path: 'mmproj-F16.gguf', size: 0.16 * GB },
		];

		test('recognises MTP heads in a subfolder and at the repo root', () => {
			assert.ok(isMtpGgufPath('MTP/mtp-gemma-4-12B-it-Q8_0.gguf'));
			assert.ok(isMtpGgufPath('mtp-gemma-4-12B-it.gguf'));
			assert.ok(isMtpGgufPath('mtp_llama.gguf'));
		});

		test('does NOT treat a real weight file as an MTP head just because MTP is in its name', () => {
			// Regression guard: six catalog entries download from `-MTP-GGUF` repos whose weights are named
			// like this. Excluding these would break every one of them.
			assert.ok(!isMtpGgufPath('Qwen3.5-9B-Q4_K_M.gguf'));
			assert.ok(!isMtpGgufPath('Qwen3.5-9B-MTP-Q4_K_M.gguf'));
			assert.ok(!isMtpGgufPath('some-mtp-model-Q4_K_M.gguf'));
		});

		test('picks the real weights even though a Q8_0 MTP head scores higher and fits easily', () => {
			// The bug this guards: MTP heads are published as Q8_0/BF16, so they top the quality order, and at
			// a few hundred MB they fit any budget - the picker chose a 0.43GB draft head over the model.
			// 11GB is the Metal budget of a 16GB Mac, where this actually happened.
			const pick = pickBestGgufForBudget(gemma4Qat, 11 * GB, { layerCount: 48 });
			assert.strictEqual(pick, 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf');
		});

		test('still avoids MTP heads when nothing fits and it falls back to the smallest weight file', () => {
			// Tiny budget -> the "nothing fits" path returns the smallest *weight*, which must not be a head.
			const pick = pickBestGgufForBudget(gemma4Qat, 1 * GB, { layerCount: 48 });
			assert.strictEqual(pick, 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf');
			assert.ok(!isMtpGgufPath(pick!));
		});
	});

	suite('estimateGgufRuntimeFootprintBytes', () => {
		test('adds KV + overhead on top of the weight bytes (footprint > weights)', () => {
			const weights = 4.7 * GB;
			assert.ok(estimateGgufRuntimeFootprintBytes(weights) > weights + GB);
		});

		test('is monotonic in weight size', () => {
			assert.ok(estimateGgufRuntimeFootprintBytes(8 * GB) > estimateGgufRuntimeFootprintBytes(4 * GB));
		});
	});

	suite('pickBestGgufForBudget', () => {
		test('upgrades to Q8_0 on a large machine (two-way, not downgrade-only)', () => {
			// 64GB usable budget: everything up to Q8 fits its full footprint; F16 is above the auto-cap.
			const pick = pickBestGgufForBudget(repo7b, 54 * GB);
			assert.strictEqual(pick, 'model-Q8_0.gguf');
		});

		test('never auto-selects above the Q8_0 cap even when F16 fits', () => {
			// Budget large enough for F16's footprint, but the cap keeps the pick at Q8_0.
			const pick = pickBestGgufForBudget(repo7b, 200 * GB);
			assert.strictEqual(quantQualityScore(pick!), quantQualityScore(MAX_AUTO_GGUF_QUANT));
			assert.strictEqual(pick, 'model-Q8_0.gguf');
		});

		test('picks a mid quant that fits the FULL footprint, not the biggest that fits weights-only', () => {
			// ~10.56GB metal budget (16GB Mac, 0.66 wired fraction). Q8 weights (8.1GB) fit alone, but the full
			// comfort footprint overflows, so the highest quant whose footprint DOES fit is chosen instead.
			// layerCount is passed the way the real caller does (from the model name), so every quant of this 7B
			// is charged the same KV instead of the larger files being penalised by their own size bucket.
			const budget = 10.56 * GB;
			const layerCount = 36; // ~7B
			const pick = pickBestGgufForBudget(repo7b, budget, { layerCount })!;
			const size = repo7b.find(f => f.path === pick)!.size;
			assert.ok(estimateGgufRuntimeFootprintBytes(size, layerCount) <= budget, `${pick} footprint must fit`);
			assert.strictEqual(pick, 'model-Q6_K.gguf');
			assert.ok(estimateGgufRuntimeFootprintBytes(8.1 * GB, layerCount) > budget, 'Q8 footprint must NOT fit this budget');
		});

		test('inside the full-quality band, prefers the COMFORT window over extra bits', () => {
			// Q4_K_M and Q6_K are both full-quality (>= GOOD_QUANT_FLOOR) and the gap between them is a fraction
			// of a percent of perplexity - so when the budget affords Q4_K_M at the 32K comfort window but Q6_K
			// only at the 16K floor, the window is worth more than the bits.
			const layerCount = 36;
			const comfort = estimateGgufRuntimeFootprintBytes(6.3 * GB, layerCount, 'comfort');
			const floor = estimateGgufRuntimeFootprintBytes(6.3 * GB, layerCount, 'floor');
			assert.ok(comfort > floor, 'the comfort tier must reserve more than the floor tier');
			const budget = floor + 0.1 * GB;
			assert.ok(estimateGgufRuntimeFootprintBytes(6.3 * GB, layerCount, 'comfort') > budget, 'Q6_K must not fit comfort');
			const plan = planGgufDownload(repo7b, budget, { layerCount })!;
			assert.strictEqual(plan.path, 'model-Q4_K_M.gguf');
			assert.strictEqual(plan.tier, 'comfort');
			assert.strictEqual(plan.verdict, 'good');
		});

		test('falls back to the floor tier before falling back to the smallest file', () => {
			// Nothing clears comfort here, but Q4_K_M clears the floor - so we keep that quality rather than
			// dropping to the smallest file in the repo.
			const layerCount = 36;
			const budget = estimateGgufRuntimeFootprintBytes(4.7 * GB, layerCount, 'floor') + 0.05 * GB;
			assert.ok(estimateGgufRuntimeFootprintBytes(4.7 * GB, layerCount, 'comfort') > budget, 'comfort must NOT fit');
			assert.strictEqual(pickBestGgufForBudget(repo7b, budget, { layerCount }), 'model-Q4_K_M.gguf');
		});

		test('downgrades on a tight machine', () => {
			// ~5.28GB metal budget (8GB Mac, 0.66 wired fraction): nothing fits its full footprint -> smallest
			// weight file so the model at least runs, and never the mmproj projector.
			const pick = pickBestGgufForBudget(repo7b, 5.28 * GB);
			assert.strictEqual(pick, 'model-Q4_K_M.gguf');
		});

		test('never returns an mmproj projector as the main weights', () => {
			const pick = pickBestGgufForBudget(repo7b, 1 * GB); // tiny budget -> smallest fallback
			assert.notStrictEqual(pick, 'mmproj-model-f16.gguf');
		});

		test('noUpgradeAbove keeps a user-pinned quant and never upgrades it', () => {
			// Big budget, but the user pinned Q4_K_M: keep it (return undefined-equivalent = the same pick).
			const pick = pickBestGgufForBudget(repo7b, 54 * GB, { noUpgradeAbove: 'model-Q4_K_M.gguf' });
			assert.strictEqual(pick, 'model-Q4_K_M.gguf');
		});

		test('noUpgradeAbove still downgrades a pinned quant that does not fit', () => {
			const bigOnly = [
				{ path: 'model-Q8_0.gguf', size: 8.1 * GB },
				{ path: 'model-Q4_K_M.gguf', size: 4.7 * GB },
				{ path: 'model-Q2_K.gguf', size: 2.9 * GB },
			];
			// User pinned Q8 but only ~5GB usable: fall back to the smallest so it runs.
			const pick = pickBestGgufForBudget(bigOnly, 5 * GB, { noUpgradeAbove: 'model-Q8_0.gguf' });
			assert.strictEqual(pick, 'model-Q2_K.gguf');
		});

		test('falls back to an above-cap file when the repo ships ONLY F16', () => {
			const f16Only = [{ path: 'model-f16.gguf', size: 15.2 * GB }];
			assert.strictEqual(pickBestGgufForBudget(f16Only, 54 * GB), 'model-f16.gguf');
		});

		test('returns undefined when sizes are unknown (caller uses the static picker)', () => {
			const noSizes = [{ path: 'model-Q4_K_M.gguf' }, { path: 'model-Q8_0.gguf' }];
			assert.strictEqual(pickBestGgufForBudget(noSizes, 54 * GB), undefined);
		});
	});

	suite('modelParamsBillionsFromName (MoE-aware)', () => {
		test('parses dense sizes', () => {
			assert.strictEqual(modelParamsBillionsFromName('Qwen3 4B'), 4);
			assert.strictEqual(modelParamsBillionsFromName('unsloth/gemma-4-12b-it-GGUF'), 12);
			assert.strictEqual(modelParamsBillionsFromName('Qwen3.5 0.8B (MTP)'), 0.8);
		});

		test('MoE: takes TOTAL, ignores the active A<n>B tag', () => {
			assert.strictEqual(modelParamsBillionsFromName('Qwen3.6 35B-A3B MoE'), 35);
			assert.strictEqual(modelParamsBillionsFromName('Qwen3 Coder 30B-A3B'), 30);
			assert.strictEqual(modelParamsBillionsFromName('Gemma 4 26B-A4B'), 26);
			assert.strictEqual(modelParamsBillionsFromName('LFM2.5 8B-A1B'), 8);
		});

		test('Gemma effective E<n>B and version numbers do not confuse it', () => {
			assert.strictEqual(modelParamsBillionsFromName('Gemma 4 E2B'), 2);
			assert.strictEqual(modelParamsBillionsFromName('Granite 4.1 8B'), 8); // 4.1 is a version, not a size
		});

		test('undefined when no size token (safe file-size fallback)', () => {
			assert.strictEqual(modelParamsBillionsFromName('Phi-4 mini'), undefined);
		});
	});

	suite('layer-count / KV is quant-INDEPENDENT when the name is known', () => {
		test('same model name -> same layer count regardless of file size', () => {
			const layers = estimateLayerCountFromModelName('Qwen3 4B');
			assert.ok(layers && layers > 0);
			// Footprint difference between two quants of the SAME model is exactly their weight-size difference.
			const q4 = estimateGgufRuntimeFootprintBytes(2.5 * GB, layers);
			const q8 = estimateGgufRuntimeFootprintBytes(4.3 * GB, layers);
			assert.strictEqual(Math.round((q8 - q4) / GB * 100) / 100, Math.round((4.3 - 2.5) * 100) / 100);
		});

		test('MoE depth is charged by params, not by the big file size', () => {
			// A 30B-A3B MoE: 30B -> 64 layers, NOT the ~68 the 18GB file size would bucket to.
			assert.strictEqual(estimateLayerCountFromModelName('Qwen3 Coder 30B-A3B'), 64);
		});

		test('picker upgrades to Q8 for a 4B model on a mid machine once KV is quant-independent', () => {
			const repo4b = [
				{ path: 'm-Q4_K_M.gguf', size: 2.5 * GB },
				{ path: 'm-Q6_K.gguf', size: 3.3 * GB },
				{ path: 'm-Q8_0.gguf', size: 4.3 * GB },
			];
			const layers = estimateLayerCountFromModelName('Qwen3 4B');
			const pick = pickBestGgufForBudget(repo4b, 10 * GB, { layerCount: layers });
			assert.strictEqual(pick, 'm-Q8_0.gguf');
		});
	});

	suite('quality bands: weights are permanent, context is not', () => {
		// Typical bytes-per-parameter for each quant, so a repo can be generated at any model size. These are the
		// real-world ratios (a 32B Q4_K_M is ~20 GB, a 32B Q8_0 is ~35 GB), which is what makes the machine/model
		// combinations below the ones users actually hit.
		const BYTES_PER_B: Record<string, number> = {
			Q2_K: 0.40e9, IQ3_M: 0.47e9, Q3_K_M: 0.51e9, IQ4_XS: 0.56e9, Q4_K_S: 0.585e9,
			Q4_K_M: 0.62e9, Q5_K_M: 0.73e9, Q6_K: 0.85e9, Q8_0: 1.09e9, F16: 2.05e9,
		};
		const repoFor = (paramsB: number) => Object.entries(BYTES_PER_B).map(([quant, perB]) => ({ path: `m-${quant}.gguf`, size: perB * paramsB }));
		/** Metal wired budget of an Apple Silicon machine with `totalGB` of unified memory. */
		const macBudget = (totalGB: number) => {
			const total = totalGB * GB;
			return total * (total >= 36 * GB ? 0.75 : (total < 18 * GB ? 0.66 : 0.70));
		};

		test('a 14B on a 16GB Mac gets a 4-bit quant at 16K, NOT Q2_K at 32K', () => {
			// The regression that motivated the band ordering. The old tier-outermost loop stopped at the first
			// tier with ANY fitting quant, and on this machine only Q2_K cleared the comfort tier - so it took a
			// permanently broken 2-bit model to protect a context window the launch planner re-negotiates anyway.
			const plan = planGgufDownload(repoFor(14), macBudget(16), { layerCount: 48 })!;
			assert.strictEqual(quantNameFromPath(plan.path), 'Q4_K_S');
			assert.strictEqual(plan.tier, 'floor');
			assert.strictEqual(plan.verdict, 'tight');
		});

		test('a 32B on a 32GB Mac gets Q4_K_M at 16K, not Q3_K_M at 32K', () => {
			const plan = planGgufDownload(repoFor(32), macBudget(32), { layerCount: 64 })!;
			assert.strictEqual(quantNameFromPath(plan.path), 'Q4_K_M');
			assert.strictEqual(plan.verdict, 'tight');
		});

		test('below the full-quality band the trade REVERSES - context wins again', () => {
			// A 49B on a 36GB Mac cannot hold any 4-bit quant. Quality is already lost at this point, so the
			// remaining fraction of a bit is worth less than the wider window: take the best >= HARD floor quant.
			const plan = planGgufDownload(repoFor(49), macBudget(36), { layerCount: 80 })!;
			assert.strictEqual(quantNameFromPath(plan.path), 'Q3_K_M');
			assert.strictEqual(plan.verdict, 'tight');
		});

		test('a hopeless combination is reported as poor rather than silently downloaded', () => {
			// 32B on a 16GB Mac: nothing fits, so the caller must put the tradeoff to the user instead of
			// quietly fetching ~13 GB of Q2_K that will swap-thrash at launch.
			const plan = planGgufDownload(repoFor(32), macBudget(16), { layerCount: 64 })!;
			assert.strictEqual(plan.verdict, 'poor');
			assert.strictEqual(plan.tier, 'overflow');
		});

		test('capable machines are unaffected - still full quality at the comfort window', () => {
			for (const [totalGB, paramsB, layers, expected] of [[64, 70, 80, 'Q4_K_M'], [64, 32, 64, 'Q8_0'], [128, 70, 80, 'Q8_0']] as const) {
				const plan = planGgufDownload(repoFor(paramsB), macBudget(totalGB), { layerCount: layers })!;
				assert.strictEqual(quantNameFromPath(plan.path), expected, `${paramsB}B on a ${totalGB}GB Mac`);
				assert.strictEqual(plan.verdict, 'good', `${paramsB}B on a ${totalGB}GB Mac must not be flagged`);
			}
		});

		test('the bands are ordered and both sit inside the auto cap', () => {
			assert.ok(quantQualityScore(MAX_AUTO_GGUF_QUANT) > quantQualityScore(GOOD_QUANT_FLOOR));
			assert.ok(quantQualityScore(GOOD_QUANT_FLOOR) > quantQualityScore(HARD_QUANT_FLOOR));
		});
	});

	suite('split (sharded) GGUFs are one selectable unit', () => {
		// How HuggingFace publishes any quant over ~45 GB - 70B at Q8_0, the big MoEs, most large Unsloth builds.
		const shardedRepo = [
			{ path: 'Q4_K_M/model-00001-of-00002.gguf', size: 21 * GB },
			{ path: 'Q4_K_M/model-00002-of-00002.gguf', size: 21 * GB },
			{ path: 'model-Q2_K.gguf', size: 14 * GB },
		];

		test('sums the shards instead of sizing each one independently', () => {
			const q4 = groupGgufCandidates(shardedRepo).find(c => c.key.includes('Q4_K_M'))!;
			assert.strictEqual(q4.paths.length, 2);
			assert.strictEqual(q4.size, 42 * GB);
			assert.ok(q4.sharded);
		});

		test('a split quant too big for the machine is rejected as a WHOLE', () => {
			// The old bug: each 21 GB shard looked like an independent model, so a 30 GB budget "fitted" a 42 GB
			// model - and then only shard 1 was downloaded, leaving weights llama.cpp cannot load.
			const plan = planGgufDownload(shardedRepo, 30 * GB, { layerCount: 80 })!;
			assert.ok(!plan.paths.some(p => p.includes('00001')), 'must not select an unfittable split model');
		});

		test('a split quant that fits returns EVERY shard, first shard leading', () => {
			const plan = planGgufDownload(shardedRepo, 60 * GB, { layerCount: 80 })!;
			assert.strictEqual(plan.paths.length, 2);
			assert.strictEqual(plan.sizeBytes, 42 * GB);
			assert.ok(plan.sharded);
			// llama.cpp is handed `-m <first shard>` and finds the rest beside it, so shard order matters.
			assert.strictEqual(plan.path, 'Q4_K_M/model-00001-of-00002.gguf');
		});

		test('shard order is normalised regardless of listing order', () => {
			const outOfOrder = [
				{ path: 'm-00003-of-00003.gguf', size: 5 * GB },
				{ path: 'm-00001-of-00003.gguf', size: 5 * GB },
				{ path: 'm-00002-of-00003.gguf', size: 5 * GB },
			];
			assert.deepStrictEqual(groupGgufCandidates(outOfOrder)[0].paths, [
				'm-00001-of-00003.gguf', 'm-00002-of-00003.gguf', 'm-00003-of-00003.gguf',
			]);
		});

		test('a group with an unsized shard is not selectable (never under-count a split model)', () => {
			const partial = [{ path: 'm-00001-of-00002.gguf', size: 5 * GB }, { path: 'm-00002-of-00002.gguf' }];
			assert.strictEqual(planGgufDownload(partial, 60 * GB), undefined);
		});
	});

	suite('quant naming and ranking', () => {
		test('IQ4_XS outranks the legacy Q4_0 it replaced', () => {
			// IQ4_XS is both SMALLER and better than Q4_0; ranking it below made the picker prefer a bigger,
			// worse file on any repo shipping both.
			assert.ok(quantQualityScore('m-IQ4_XS.gguf') > quantQualityScore('m-Q4_0.gguf'));
			assert.ok(quantQualityScore('m-IQ4_NL.gguf') > quantQualityScore('m-Q4_1.gguf'));
		});

		test('quantNameFromPath extracts the token from a decorated, sharded filename', () => {
			assert.strictEqual(quantNameFromPath('a/b/model-UD-Q4_K_XL-00001-of-00002.gguf'), 'Q4_K_XL');
			assert.strictEqual(quantNameFromPath('m-weird.gguf'), undefined);
		});
	});

	suite('isGgufFormatRequest', () => {
		test('true for generic gguf and specific quant names', () => {
			assert.strictEqual(isGgufFormatRequest('gguf'), true);
			assert.strictEqual(isGgufFormatRequest('Q4_K_M'), true);
			assert.strictEqual(isGgufFormatRequest('Q8_0'), true);
		});

		test('false for empty / non-gguf formats', () => {
			assert.strictEqual(isGgufFormatRequest(''), false);
			assert.strictEqual(isGgufFormatRequest('mlx'), false);
			assert.strictEqual(isGgufFormatRequest('safetensors'), false);
		});
	});
});
