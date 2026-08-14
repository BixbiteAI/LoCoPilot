/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ALL_CURATED_PICKER_IDS, CURATED_ROLE_LABEL, ICatalogModel, LOCOPILOT_DEFAULT_CATALOG,
	catalogDefaultHidden, curatedPickerCatalogIds, curatedPickerRows, getRecommendedRepoId,
} from '../../browser/locopilotModelCatalog.js';

suite('LoCoPilot curated model picker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const byId = new Map<string, ICatalogModel>(LOCOPILOT_DEFAULT_CATALOG.map(e => [e.catalogId, e]));
	const TIERS = [8, 16, 32, 64];
	const PLATFORMS: readonly boolean[] = [false, true];

	function rowsFor(ramGB: number, apple: boolean) {
		return curatedPickerRows(ramGB, apple).map(r => ({ role: r.role, entry: byId.get(r.catalogId), id: r.catalogId }));
	}

	test('every curated id resolves to a real catalog entry', () => {
		for (const id of ALL_CURATED_PICKER_IDS) {
			assert.ok(byId.has(id), `curated id "${id}" is not in LOCOPILOT_DEFAULT_CATALOG`);
		}
	});

	test('every curated row actually runs on the tier that lists it', () => {
		// The whole point of the RAM-aware picker: an 8 GB laptop must never be offered a 45 GB model. Before
		// this table, seeding gated only on Apple Silicon and shipped the same 20 rows to every machine.
		for (const ram of TIERS) {
			for (const apple of PLATFORMS) {
				for (const { entry, id } of rowsFor(ram, apple)) {
					assert.ok(entry, `${id} missing`);
					assert.ok(entry.minRamGB <= ram, `${entry.displayName} needs ${entry.minRamGB}GB but is listed on the ${ram}GB tier`);
				}
			}
		}
	});

	test('no tier lists the same model twice, in any packaging', () => {
		// "One row per model": Qwen3.6 27B used to appear three times (plain GGUF / MTP GGUF / MLX). Twin
		// builds differ only by an "(MTP)" / "(MLX)" / "(base)" suffix, so comparing stripped names catches a
		// regression that comparing catalogIds would miss.
		const baseName = (e: ICatalogModel) => e.displayName.replace(/\s*\((MTP|MLX|base)\)\s*$/, '').trim();
		for (const ram of TIERS) {
			for (const apple of PLATFORMS) {
				const names = rowsFor(ram, apple).map(r => baseName(r.entry!));
				assert.strictEqual(new Set(names).size, names.length,
					`${ram}GB/${apple ? 'apple' : 'other'} lists a model twice: ${names.join(', ')}`);
			}
		}
	});

	test('each tier fills each role at most once and stays short', () => {
		for (const ram of TIERS) {
			for (const apple of PLATFORMS) {
				const rows = rowsFor(ram, apple);
				const roles = rows.map(r => r.role);
				assert.strictEqual(new Set(roles).size, roles.length, `${ram}GB repeats a role: ${roles.join(', ')}`);
				// 7 is the ceiling, and only 32 GB reaches it: that tier has the most genuinely distinct models
				// (two ~3B-active MoEs from different vendors, a coder specialist, a multimodal flagship).
				assert.ok(rows.length >= 4 && rows.length <= 7, `${ram}GB has ${rows.length} rows (want 4-7)`);
				for (const role of roles) {
					assert.ok(CURATED_ROLE_LABEL[role], `role "${role}" has no label`);
				}
			}
		}
	});

	test('every tier offers a "best" pick and a sub-1GB quick-try row', () => {
		for (const ram of TIERS) {
			const roles = curatedPickerRows(ram, false).map(r => r.role);
			assert.ok(roles.includes('best'), `${ram}GB has no "best" row`);
			assert.ok(roles.includes('quick-try'), `${ram}GB has no "quick-try" row`);
		}
		// The quick-try row exists so a first-run download finishes in seconds; keep it genuinely tiny.
		const quick = curatedPickerRows(64, false).find(r => r.role === 'quick-try')!;
		assert.ok(byId.get(quick.catalogId)!.approxSizeBytes < 1e9, 'quick-try pick should be under 1GB');
	});

	test('MLX substitution only fires on Apple Silicon, and never below 16GB', () => {
		for (const ram of TIERS) {
			const gguf = curatedPickerRows(ram, false);
			const mlxRows = curatedPickerRows(ram, true).filter(r => byId.get(r.catalogId)!.engine === 'mlx');
			assert.strictEqual(gguf.filter(r => byId.get(r.catalogId)!.engine === 'mlx').length, 0,
				`${ram}GB offers an MLX build off Apple Silicon`);
			// One native-engine row at 16GB+, none at 8GB where there is no room to run two engines.
			assert.strictEqual(mlxRows.length, ram >= 16 ? 1 : 0, `${ram}GB Apple Silicon has ${mlxRows.length} MLX rows`);
		}
	});

	test('curated picks prefer the MTP build wherever the model has one', () => {
		// The MTP GGUF is the same weights plus an embedded draft head llama.cpp ignores when speculation is
		// off, so shipping the plain twin instead would only cost speed on CUDA. Guards against someone
		// "simplifying" the table back to the base repos.
		for (const id of ['qwen36-35b-a3b-mtp-gguf', 'qwen35-9b-mtp-gguf', 'qwen35-0_8b-mtp-gguf']) {
			assert.ok(ALL_CURATED_PICKER_IDS.has(id), `${id} should be curated`);
		}
		// Qwen3.8 27B (which took the 32 GB `best` row from Qwen3.6 27B) is the case this rule has to be
		// checked on the FLAG rather than the repo name: unsloth published no separate `-MTP-GGUF` repo for
		// it, because the head is baked into the ordinary weight files (`qwen35.nextn_predict_layers = 1`).
		// Asserting on the name here would have forced a curator to go looking for a repo that will never exist.
		assert.strictEqual(byId.get('qwen38-27b-gguf')!.mtp, true,
			'the curated Qwen3.8 27B must be seeded with MTP enabled');
		for (const base of ['qwen36-27b-gguf', 'qwen36-35b-a3b-gguf']) {
			assert.ok(!ALL_CURATED_PICKER_IDS.has(base), `${base} is the MTP twin's base build and should stay hidden`);
		}
	});

	test('catalogDefaultHidden is RAM-aware, and safe when RAM is unknown', () => {
		const big = byId.get('qwen3-coder-next-gguf')!;       // 64GB tier
		const small = byId.get('qwen35-0_8b-mtp-gguf')!;      // curated on every tier

		assert.strictEqual(catalogDefaultHidden(big, { ramGB: 8, isAppleSilicon: false }), true,
			'a 45GB model must not be visible on an 8GB machine');
		assert.strictEqual(catalogDefaultHidden(big, { ramGB: 64, isAppleSilicon: false }), false);
		assert.strictEqual(catalogDefaultHidden(small, { ramGB: 8, isAppleSilicon: false }), false);

		// RAM unknown -> union of all tiers, so nothing curated anywhere is wrongly hidden at startup.
		assert.strictEqual(catalogDefaultHidden(big, undefined), false);
		assert.strictEqual(catalogDefaultHidden(big, { ramGB: 0, isAppleSilicon: false }), false);

		// An explicit per-entry override still wins, so the remote catalog can force either state.
		const forced: ICatalogModel = { ...small, defaultHidden: true };
		assert.strictEqual(catalogDefaultHidden(forced, { ramGB: 64, isAppleSilicon: false }), true);
	});

	test('no catalog entry claims a RAM tier its weights cannot fit', () => {
		// Weights must leave room for the editor, the OS and the KV cache. Three entries were at 90-97% of
		// their stated minRamGB, which made "only show models that run" meaningless for exactly the models
		// where it matters most.
		//
		// The threshold is 0.80, not something tighter, because `approxSizeBytes` is the Q4_K_M REFERENCE size
		// and not what a machine at the RAM floor actually downloads - `planGgufDownload` sizes the quant
		// against the real runtime footprint and steps down (Nemotron 3.5 Lightning quotes Q4_K_M 25.3 GB and
		// lands on ~21 GB at UD-Q3_K_XL on a 32 GB box). So this catches entries no step-down can rescue,
		// which is what 90%+ means, rather than second-guessing the download planner.
		for (const e of LOCOPILOT_DEFAULT_CATALOG) {
			const ratio = e.approxSizeBytes / (e.minRamGB * 1024 * 1024 * 1024);
			assert.ok(ratio <= 0.80, `${e.displayName}: weights are ${Math.round(ratio * 100)}% of its ${e.minRamGB}GB minRamGB`);
		}
	});

	test('a curated tier is not dominated by a single vendor', () => {
		for (const ram of TIERS) {
			const rows = rowsFor(ram, false);
			const counts = new Map<string, number>();
			for (const r of rows) {
				counts.set(r.entry!.vendor, (counts.get(r.entry!.vendor) ?? 0) + 1);
			}
			const [topVendor, top] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
			assert.ok(top <= Math.ceil(rows.length / 2),
				`${ram}GB is ${top}/${rows.length} ${topVendor}`);
		}
	});

	test('the curated "best" row is the same model the recommendation ladder badges', () => {
		// Two independent sources of truth for "Best for you" - this table and `curatedRecommendedRepoId` (via
		// getRecommendedRepoId, which the picker and the model-list editor share). When they disagree, the
		// picker renders the badge on one row and the role label on another, so TWO rows say "Best for you".
		// That is exactly what happened at 8 GB before this assertion existed.
		for (const ram of TIERS) {
			const bestRow = curatedPickerRows(ram, false).find(r => r.role === 'best')!;
			const bestEntry = byId.get(bestRow.catalogId)!;
			assert.strictEqual(bestEntry.repoId, getRecommendedRepoId(ram),
				`${ram}GB: curated best is ${bestEntry.repoId} but the ladder badges ${getRecommendedRepoId(ram)}`);
		}
	});

	test('the same model never appears under two different roles on one tier', () => {
		for (const ram of TIERS) {
			for (const apple of PLATFORMS) {
				const ids = [...curatedPickerCatalogIds(ram, apple)];
				assert.strictEqual(ids.length, curatedPickerRows(ram, apple).length,
					`${ram}GB/${apple ? 'apple' : 'other'} repeats a catalogId across roles`);
			}
		}
	});

	test('every catalog entry declares a picker role, and none claims "best"', () => {
		// The role is what a surfaced-from-hidden model shows as its subtitle; without one it falls back to
		// "Local", which says nothing (every catalog model is local). A new entry with no role is the
		// regression this catches. `best` is banned because it is a RECOMMENDATION, not a description - the
		// curated row owns it, and the type already forbids it here, so this guards the remote path's mirror.
		for (const e of LOCOPILOT_DEFAULT_CATALOG) {
			assert.ok(e.role, `${e.catalogId} declares no role, so it would read "Local" when surfaced`);
			assert.notStrictEqual(e.role as string, 'best', `${e.catalogId} must not claim the 'best' role`);
		}
	});

	test('a curated row overrides the entry role, so exactly one row is "Best for you"', () => {
		// Mirrors how modelPickerActionItem resolves subtitles: entry roles first, curated rows written over
		// them. If that order ever inverted, a tier's `best` row would be relabelled by its own entry role and
		// the recommendation would vanish from the picker.
		for (const ram of TIERS) {
			for (const apple of PLATFORMS) {
				const roles = new Map<string, string>();
				for (const e of LOCOPILOT_DEFAULT_CATALOG) {
					if (e.role) { roles.set(e.repoId, e.role); }
				}
				for (const row of curatedPickerRows(ram, apple)) {
					roles.set(byId.get(row.catalogId)!.repoId, row.role);
				}
				const bests = [...roles.values()].filter(r => r === 'best');
				assert.strictEqual(bests.length, 1,
					`${ram}GB/${apple ? 'apple' : 'other'} resolves ${bests.length} "Best for you" rows, expected 1`);
			}
		}
	});
});
