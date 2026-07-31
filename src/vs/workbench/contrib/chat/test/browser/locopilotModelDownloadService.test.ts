/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	pickBestGgufForBudget,
	estimateGgufRuntimeFootprintBytes,
	quantQualityScore,
	isGgufFormatRequest,
	modelParamsBillionsFromName,
	estimateLayerCountFromModelName,
	MAX_AUTO_GGUF_QUANT,
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

		test('sizes against a COMFORT run (32K @ q8 KV), not merely a loadable one', () => {
			// The weight quant is permanent while the context is re-negotiated every launch, so a quant that only
			// leaves room for a cramped window is the wrong trade: the quantization gap between Q6 and Q8 is a
			// fraction of a percent, the context gap decides whether the file being edited fits at all.
			const layerCount = 36;
			const comfort = estimateGgufRuntimeFootprintBytes(6.3 * GB, layerCount, 'comfort');
			const floor = estimateGgufRuntimeFootprintBytes(6.3 * GB, layerCount, 'floor');
			assert.ok(comfort > floor, 'the comfort tier must reserve more than the floor tier');
			// A budget that fits Q6_K only at the floor tier must NOT be spent on Q8_0.
			const budget = floor + 0.1 * GB;
			assert.strictEqual(pickBestGgufForBudget(repo7b, budget, { layerCount }), 'model-Q6_K.gguf');
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
