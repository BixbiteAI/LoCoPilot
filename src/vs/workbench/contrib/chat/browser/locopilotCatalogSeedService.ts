/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { LOCOPILOT_SETTINGS_SECTION_LIST_MODELS } from './chatManagement/locopilotSettingsEditorInput.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ICustomLanguageModelsService, LOCOPILOT_AUTO_MODEL_ID } from '../common/customLanguageModelsService.js';
import { isAppleSiliconMac } from './locopilotMlxServer.js';
import { LOCOPILOT_DEFAULT_CATALOG, catalogModelToSeed, catalogDefaultHidden, findCatalogEntry, ICatalogModel, CatalogEngine } from './locopilotModelCatalog.js';
import { ITimerService } from '../../../services/timer/browser/timerService.js';

/**
 * Optional remote catalog URL. When set, the seeding service fetches an updated catalog (a JSON array of
 * {@link ICatalogModel}) at launch so new models can be offered WITHOUT shipping a new app build. The fetch
 * is strictly best-effort: any failure (offline, timeout, bad JSON) silently falls back to the bundled
 * catalog, so offline users keep working and lose nothing. Point this at your hosted models.json to enable.
 *
 * Precedence: `product.json` -> `locopilotCatalogUrl` wins; this constant is the fallback. Setting it in
 * product.json means you can change the URL per build without touching source.
 */
const REMOTE_CATALOG_URL = '';

/** How long to wait for the remote catalog before giving up and using the bundled one. */
const REMOTE_FETCH_TIMEOUT_MS = 5000;

/**
 * How often to re-run the seed after the initial one, so a catalog published while the app is OPEN is picked
 * up without a restart. Matches the update-feed check's cadence. Re-seeding is idempotent - `seededIds` makes
 * a tick with nothing new a pure no-op, and the "new models" toast only fires for entries that actually seeded.
 */
const RESEED_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Seeds the built-in model catalog into the install so the model list and chat picker are never empty.
 *
 * Behaviour:
 *  - Tracks which catalog entries have already been seeded (by `catalogId`) instead of a single "done" flag.
 *    So: every NEW entry - whether added in an app update (bundled) or fetched from the remote catalog -
 *    gets seeded once, while entries the user later DELETES never come back (their id stays recorded).
 *  - Each entry becomes a regular `huggingface` / `local` model with no `localPath`, i.e. it shows in
 *    "My Models" with a Download button + progress and is downloaded on demand. Nothing is fetched here.
 *  - MLX entries (Apple-Silicon-only) are skipped when not on an Apple Silicon Mac.
 *  - Remote fetch is best-effort and never blocks: offline users just use the bundled catalog.
 */
export class LoCoPilotCatalogSeedContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'locopilot.catalogSeedService';

	/** Persisted list of catalogIds we have already seeded (so deletes stick and new entries get added). */
	private static readonly SEEDED_IDS_KEY = 'locopilot.catalog.seededIds';

	/** One-time flag: re-apply default hidden/visible state to already-seeded catalog models. */
	// v3: the default visible set became RAM-aware (see `curatedPickerRows`), so every install has to re-snap
	// once. Bumping the key is what makes that happen; v2 installs were seeded from a single machine-independent
	// list that handed 8 GB laptops 45 GB models.
	private static readonly VISIBILITY_MIGRATION_KEY = 'locopilot.catalog.visibilityMigration.v3';

	/**
	 * Set once the first seed pass completes, so periodic re-seeds can never be mistaken for a fresh install.
	 * Without it, an install whose first pass seeded nothing (empty bundled catalog + failed remote fetch) would
	 * still read `seededIds.size === 0` on the next tick and re-apply the first-run picker default.
	 */
	private _firstRunHandled = false;

	/** Guards against a slow pass overlapping the next interval tick and double-seeding the same entry. */
	private _seeding = false;

	constructor(
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@IStorageService private readonly storageService: IStorageService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IProductService private readonly productService: IProductService,
		@ITimerService private readonly timerService: ITimerService,
	) {
		super();
		// Seed immediately - a fresh install must not show an empty model list while a timer counts down.
		void this._seed();
		// Then keep checking, so a catalog uploaded while this window is open arrives without a restart.
		const reseed = this._register(new IntervalTimer());
		reseed.cancelAndSet(() => void this._seed(), RESEED_INTERVAL_MS);
	}

	/** Resolved remote catalog URL: product.json field overrides the in-code constant. */
	private get _remoteCatalogUrl(): string {
		return (this.productService.locopilotCatalogUrl || REMOTE_CATALOG_URL || '').trim();
	}

	private _getSeededIds(): Set<string> {
		try {
			const raw = this.storageService.get(LoCoPilotCatalogSeedContribution.SEEDED_IDS_KEY, StorageScope.APPLICATION, '[]');
			const parsed = JSON.parse(raw);
			return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
		} catch {
			return new Set();
		}
	}

	private _storeSeededIds(ids: Set<string>): void {
		this.storageService.store(LoCoPilotCatalogSeedContribution.SEEDED_IDS_KEY, JSON.stringify([...ids]), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/**
	 * Hardware facts the curated visible-set depends on. `totalmem` comes from the startup metrics, which are
	 * populated well before this contribution runs; a 0 here (metrics not ready) makes `catalogDefaultHidden`
	 * fall back to the union of every tier rather than guess one.
	 */
	private _hardware(): { ramGB: number; isAppleSilicon: boolean } {
		let ramGB = 0;
		try {
			const totalmem = this.timerService.startupMetrics.totalmem;
			if (typeof totalmem === 'number' && totalmem > 0) {
				ramGB = totalmem / (1024 * 1024 * 1024);
			}
		} catch {
			// startup metrics not resolved yet - treated as "RAM unknown" above.
		}
		return { ramGB, isAppleSilicon: isAppleSiliconMac() };
	}

	private async _seed(): Promise<void> {
		if (this._seeding) {
			return; // a pass is still in flight (slow network); let it finish rather than racing it.
		}
		this._seeding = true;
		try {
			await this._seedOnce();
		} finally {
			this._seeding = false;
		}
	}

	private async _seedOnce(): Promise<void> {
		const seededIds = this._getSeededIds();
		const hardware = this._hardware();
		const appleSilicon = hardware.isAppleSilicon;

		// Bundled catalog is the always-available baseline; remote entries are merged on top (best-effort).
		const byId = new Map<string, ICatalogModel>();
		for (const e of LOCOPILOT_DEFAULT_CATALOG) {
			byId.set(e.catalogId, e);
		}
		const remote = await this._fetchRemoteCatalog();
		const remoteIds = new Set<string>();
		for (const e of remote) {
			byId.set(e.catalogId, e); // remote wins / appends so versions can be bumped without a build
			remoteIds.add(e.catalogId);
		}

		// First-ever run seeds the whole bundled catalog at once - that is install setup, not "news", so we
		// suppress the toast then. After that, any newly seeded entry that came from the REMOTE catalog is a
		// genuine "new model added over the air" event worth surfacing.
		// Only the FIRST pass of this window can be a first run; later ticks are always incremental updates.
		const isFirstRun = !this._firstRunHandled && seededIds.size === 0;
		this._firstRunHandled = true;
		const newlyFromRemote: string[] = [];

		const existing = this.customLanguageModelsService.getCustomModels();
		const alreadyHas = (entry: ICatalogModel): boolean => existing.some(m =>
			m.provider === 'huggingface'
			&& m.modelName === entry.repoId
			&& (m.format ?? '').toLowerCase() === entry.format.toLowerCase());

		let seeded = 0;
		for (const entry of byId.values()) {
			if (seededIds.has(entry.catalogId)) {
				continue; // already offered once (even if the user deleted it) - don't re-add.
			}
			if (entry.requiresAppleSilicon && !appleSilicon) {
				seededIds.add(entry.catalogId); // record so we don't reconsider it every launch.
				continue;
			}
			if (alreadyHas(entry)) {
				seededIds.add(entry.catalogId);
				continue;
			}
			try {
				await this.customLanguageModelsService.addCustomModel(catalogModelToSeed(entry, hardware));
				seeded++;
				if (remoteIds.has(entry.catalogId)) {
					newlyFromRemote.push(entry.displayName);
				}
			} catch (e) {
				// A clashing display name or transient storage error must not abort the whole seed.
				this.logService.warn(`[LoCoPilot Catalog] Failed to seed "${entry.displayName}": ${e}`);
			}
			seededIds.add(entry.catalogId);
		}

		this._storeSeededIds(seededIds);
		// Unconditional, including `seeded === 0`. Gating this on `seeded > 0` meant a launch that fetched a stale
		// catalog logged NOTHING, which is exactly the state that is impossible to tell apart from the seeder not
		// running at all - the counts below are what make "the upload didn't reach this machine" greppable.
		this.logService.info(`[LoCoPilot Catalog] Seeded ${seeded} new model(s); ${byId.size} candidate(s) considered, ${remote.length} from remote, ${seededIds.size} recorded (Apple Silicon: ${appleSilicon}).`);

		// Fresh installs default the chat picker to "Auto" (which resolves to the best downloaded model, or
		// shows the starter download card when nothing is downloaded yet). Strictly first-run only - existing
		// installs (seededIds already populated) and any explicit user selection are never touched.
		if (isFirstRun && !this.customLanguageModelsService.getSelectedCustomModelId()) {
			this.customLanguageModelsService.setSelectedCustomModelId(LOCOPILOT_AUTO_MODEL_ID);
			this.logService.info('[LoCoPilot Catalog] First run: defaulting chat model selection to Auto.');
		}

		if (!isFirstRun && newlyFromRemote.length > 0) {
			this._notifyNewModels(newlyFromRemote);
		}

		await this._migrateVisibilityOnce();
	}

	/**
	 * Surface over-the-air model additions. Fires only for entries pulled from the remote catalog on a
	 * non-first run, so users learn about new models the same way Cursor surfaces updates: a dismissible
	 * toast with a one-click jump to the model list.
	 */
	private _notifyNewModels(names: string[]): void {
		const count = names.length;
		const preview = names.slice(0, 3).join(', ');
		const more = count > 3 ? ` and ${count - 3} more` : '';
		const message = count === 1
			? `New model available: ${preview}. Open the model list to download it.`
			: `${count} new models available: ${preview}${more}. Open the model list to download them.`;
		this.notificationService.notify({
			severity: Severity.Info,
			message,
			actions: {
				primary: [{
					id: 'locopilot.viewNewModels',
					label: 'View models',
					tooltip: '',
					class: undefined,
					enabled: true,
					run: () => this.commandService.executeCommand('workbench.action.chat.openLoCoPilotSettings', { section: LOCOPILOT_SETTINGS_SECTION_LIST_MODELS }),
				}],
			},
		});
	}

	/**
	 * One-time pass that snaps every catalog-originated model to its intended default visibility (only the
	 * curated few visible, the rest hidden). Needed because earlier builds seeded all models visible. Runs
	 * once; after this, the user's Show/Hide choices are respected and never reset again.
	 */
	private async _migrateVisibilityOnce(): Promise<void> {
		const hardware = this._hardware();
		if (this.storageService.getBoolean(LoCoPilotCatalogSeedContribution.VISIBILITY_MIGRATION_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		for (const model of this.customLanguageModelsService.getCustomModels()) {
			const entry = findCatalogEntry(model.modelName, model.format);
			if (!entry) {
				continue; // not a catalog model - leave the user's own models untouched.
			}
			const shouldHide = catalogDefaultHidden(entry, hardware);
			if ((model.hidden ?? false) !== shouldHide) {
				try {
					await this.customLanguageModelsService.hideCustomModel(model.id, shouldHide);
				} catch (e) {
					this.logService.warn(`[LoCoPilot Catalog] Visibility migration failed for "${model.modelName}": ${e}`);
				}
			}
		}
		this.storageService.store(LoCoPilotCatalogSeedContribution.VISIBILITY_MIGRATION_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/** Fetch + validate the remote catalog. Returns [] on any problem (offline, timeout, bad data) - never throws. */
	private async _fetchRemoteCatalog(): Promise<ICatalogModel[]> {
		const url = this._remoteCatalogUrl;
		if (!url) {
			this.logService.info('[LoCoPilot Catalog] No remote catalog URL configured; using bundled catalog only.');
			return [];
		}
		const cts = new CancellationTokenSource();
		const timer = setTimeout(() => cts.cancel(), REMOTE_FETCH_TIMEOUT_MS);
		try {
			// `Cache-Control: no-cache` forces the network stack to REVALIDATE instead of trusting its disk cache.
			// This is not belt-and-braces: an origin that serves the catalog with an ETag/Last-Modified but no
			// Cache-Control (the default for a plain S3/CloudFront object) leaves Chromium - and so Electron, and
			// so this request - to invent a *heuristic* freshness lifetime of ~10% of the object's age. A catalog
			// file untouched for two months therefore reads as fresh for ~5 days, and the app serves the STALE
			// body from disk without ever hitting the network. That failure is completely silent: the old JSON is
			// still a valid array, every id in it is already seeded, so nothing is added and nothing is logged,
			// and it survives restarts because the disk cache does. Revalidation is cheap - a 304 is resolved
			// inside the net stack and handed back as a 200 with the cached body, so this costs one conditional
			// request per launch and removes the dependency on the origin's headers being right.
			const res = await this.requestService.request({
				type: 'GET',
				url,
				headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
			}, cts.token);
			if (res.res.statusCode !== 200) {
				// Logged rather than silent: a non-200 here (403 from a bad bucket policy, 404 from a moved
				// object) is indistinguishable from "no new models" to the user, so leave a trace to grep for.
				this.logService.warn(`[LoCoPilot Catalog] Remote catalog fetch returned HTTP ${res.res.statusCode} (using bundled): ${url}`);
				return [];
			}
			const raw = await streamToBuffer(res.stream).then(b => b.toString());
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				this.logService.warn(`[LoCoPilot Catalog] Remote catalog is not a JSON array (using bundled): ${url}`);
				return [];
			}
			const entries = parsed.filter((e): e is ICatalogModel => this._isValidCatalogEntry(e));
			// Always log the outcome, including the all-zero case. A successful fetch that adds nothing used to
			// look identical to no fetch at all, which is the single hardest state to diagnose from a user's logs.
			this.logService.info(`[LoCoPilot Catalog] Remote catalog fetched: ${entries.length} valid entr${entries.length === 1 ? 'y' : 'ies'} of ${parsed.length} received.`);
			if (entries.length !== parsed.length) {
				this.logService.warn(`[LoCoPilot Catalog] ${parsed.length - entries.length} remote entr${parsed.length - entries.length === 1 ? 'y was' : 'ies were'} rejected as malformed.`);
			}
			return entries;
		} catch (e) {
			this.logService.info(`[LoCoPilot Catalog] Remote catalog unavailable (using bundled): ${e}`);
			return [];
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
	}

	/** Minimal shape guard so a malformed remote entry can never seed a broken model. */
	private _isValidCatalogEntry(e: unknown): e is ICatalogModel {
		if (!e || typeof e !== 'object') {
			return false;
		}
		const o = e as Partial<ICatalogModel>;
		const engineOk: CatalogEngine[] = ['gguf', 'mlx'];
		// `contextWindow` is optional, but if present it must be a sane positive integer - reject the
		// whole entry otherwise, so a malformed remote value (string, NaN, negative) can never be seeded.
		const contextWindowOk = o.contextWindow === undefined
			|| (typeof o.contextWindow === 'number' && Number.isInteger(o.contextWindow) && o.contextWindow > 0);
		return typeof o.catalogId === 'string' && o.catalogId.length > 0
			&& typeof o.displayName === 'string' && o.displayName.length > 0
			&& typeof o.repoId === 'string' && /.+\/.+/.test(o.repoId)
			&& typeof o.format === 'string' && o.format.length > 0
			&& typeof o.engine === 'string' && engineOk.includes(o.engine as CatalogEngine)
			&& contextWindowOk;
	}
}
