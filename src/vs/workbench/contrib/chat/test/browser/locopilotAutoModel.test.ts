/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { peekAutoModel, resolveAutoModel, resolveAutoModelPinned } from '../../browser/locopilotModelCatalog.js';
import { ICustomLanguageModel, ICustomLanguageModelsService } from '../../common/customLanguageModelsService.js';

suite('LoCoPilot Auto model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// Two real catalog repos in different RAM tiers: SMALL is an 8GB-tier model, BIG a 16GB-tier one. On a
	// 16GB machine Auto should prefer BIG unless SMALL is warm (the stickiness tie-breaker).
	const SMALL_REPO = 'unsloth/Qwen3.5-2B-MTP-GGUF';
	const BIG_REPO = 'unsloth/Qwen3.5-9B-MTP-GGUF';
	const RAM_16GB = 16;

	function downloadedModel(id: string, repoId: string): ICustomLanguageModel {
		return {
			id,
			name: repoId,
			type: 'local',
			provider: 'huggingface',
			modelName: repoId,
			localPath: `/models/${id}`,
			createdAt: 0
		};
	}

	/** Minimal stand-in for the parts of the service the Auto helpers touch (models + the session pin). */
	function fakeService(models: readonly ICustomLanguageModel[]): ICustomLanguageModelsService & { pin: string | undefined } {
		let pin: string | undefined;
		return {
			get pin() { return pin; },
			getCustomModels: () => [...models],
			getPinnedAutoModelId: () => pin,
			setPinnedAutoModelId: (id: string | undefined) => { pin = id; }
		} as unknown as ICustomLanguageModelsService & { pin: string | undefined };
	}

	const nothingWarm = () => false;
	const warm = (warmId: string) => (id: string) => id === warmId;

	const small = downloadedModel('small-id', SMALL_REPO);
	const big = downloadedModel('big-id', BIG_REPO);

	test('picks the highest RAM tier the machine supports when nothing is running', () => {
		const resolved = resolveAutoModel([small, big], RAM_16GB, nothingWarm);
		assert.strictEqual(resolved?.id, big.id);
	});

	test('a running smaller model wins while it is warm (stickiness, no cold swap)', () => {
		const resolved = resolveAutoModel([small, big], RAM_16GB, warm(small.id));
		assert.strictEqual(resolved?.id, small.id);
	});

	test('peek never writes the pin', () => {
		const service = fakeService([small, big]);
		assert.strictEqual(peekAutoModel(service, RAM_16GB, warm(small.id))?.id, small.id);
		assert.strictEqual(service.pin, undefined, 'rendering the Auto label must not capture the pin');
	});

	test('commit writes the pin', () => {
		const service = fakeService([small, big]);
		assert.strictEqual(resolveAutoModelPinned(service, RAM_16GB, nothingWarm)?.id, big.id);
		assert.strictEqual(service.pin, big.id);
	});

	test('a warm pin is honoured instead of re-resolving', () => {
		const service = fakeService([small, big]);
		service.setPinnedAutoModelId(small.id);
		// Pinned to the small model AND its server is warm: keep it, so the label, the pre-warm and the send
		// all stay on the model already loaded rather than cold-swapping to the bigger one.
		assert.strictEqual(peekAutoModel(service, RAM_16GB, warm(small.id))?.id, small.id);
		assert.strictEqual(resolveAutoModelPinned(service, RAM_16GB, warm(small.id))?.id, small.id);
	});

	test('a COLD pin is discarded and Auto re-resolves (the stop-the-small-model regression)', () => {
		const service = fakeService([small, big]);
		// The state the old code got stuck in: the small model was pinned while it was running, then stopped.
		service.setPinnedAutoModelId(small.id);
		assert.strictEqual(peekAutoModel(service, RAM_16GB, nothingWarm)?.id, big.id, 'label must move off the stopped model');
		assert.strictEqual(resolveAutoModelPinned(service, RAM_16GB, nothingWarm)?.id, big.id, 'send must not start the stopped model');
		assert.strictEqual(service.pin, big.id, 'commit re-pins the freshly resolved model');
	});

	test('peek and commit agree in every warmth state', () => {
		for (const isWarm of [nothingWarm, warm(small.id), warm(big.id)]) {
			for (const initialPin of [undefined, small.id, big.id]) {
				const peeked = fakeService([small, big]);
				const committed = fakeService([small, big]);
				peeked.setPinnedAutoModelId(initialPin);
				committed.setPinnedAutoModelId(initialPin);
				assert.strictEqual(
					peekAutoModel(peeked, RAM_16GB, isWarm)?.id,
					resolveAutoModelPinned(committed, RAM_16GB, isWarm)?.id,
					`label and send diverged (pin=${initialPin})`
				);
			}
		}
	});

	test('a pin to a deleted model is discarded', () => {
		const service = fakeService([small, big]);
		service.setPinnedAutoModelId('removed-id');
		assert.strictEqual(peekAutoModel(service, RAM_16GB, warm('removed-id')), big);
	});

	test('models above the machine RAM tier are never auto-picked', () => {
		assert.strictEqual(resolveAutoModel([small, big], 8, nothingWarm)?.id, small.id);
	});

	test('a RUNNING model above the RAM tier is still picked (never name a model other than the loaded one)', () => {
		// The tier ceiling is an aspiration guard for cold picks; a loaded server has proven it runs here.
		assert.strictEqual(resolveAutoModel([small, big], 8, warm(big.id))?.id, big.id);
	});

	test('unknown RAM (0) does not hide the running model behind the 8GB fallback tier', () => {
		// detectedRamGB reports 0 until startupMetrics resolves; Auto used to drop every running 16/32GB-tier
		// model in that window and display a smaller one instead - the "running X but Auto says Y" report.
		assert.strictEqual(resolveAutoModel([small, big], 0, warm(big.id))?.id, big.id);
		assert.strictEqual(resolveAutoModel([small, big], 0, nothingWarm)?.id, small.id, 'cold picks stay conservative');
	});
});
