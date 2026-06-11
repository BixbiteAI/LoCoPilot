/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IntervalTimer, TimeoutTimer } from '../../../../base/common/async.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isMacintosh, isWindows, isLinux } from '../../../../base/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/**
 * Optional update-feed URL. When set (here or, preferably, via `product.json` -> `locopilotUpdateUrl`),
 * the app polls it and tells the user when a newer build exists - the Cursor-style "Update available"
 * toast - WITHOUT any auto-download/auto-install. The user clicks to open the download page.
 *
 * Strictly best-effort and offline-safe: any failure (offline, timeout, bad JSON) is swallowed, so
 * offline users are never bothered. product.json wins; this constant is the fallback.
 *
 * Expected feed shape (a single JSON object):
 *   {
 *     "version": "1.110.0",                       // required - the latest available app version
 *     "url": "https://yourdomain.com/download",   // required - fallback download page / asset
 *     "urls": {                                    // optional - direct per-platform installers; the matching
 *       "darwin-arm64": "https://.../app-arm64.dmg",  //   one is used when present, else `url` is used.
 *       "darwin-x64":   "https://.../app-x64.dmg",     //   Keys: <os>-<arch> where os = darwin|win32|linux
 *       "win32-x64":    "https://.../Setup-x64.exe",   //   and arch = arm64|x64.
 *       "win32-arm64":  "https://.../Setup-arm64.exe"
 *     },
 *     "notes": "Faster MLX startup, 2 new models", // optional - shown in the toast
 *     "mandatory": false                           // optional - if true, the toast is sticky
 *   }
 */
const UPDATE_FEED_URL = '';

/** How long to wait for the update feed before giving up. */
const FETCH_TIMEOUT_MS = 5000;

/** Wait this long after launch before checking, so startup isn't slowed. */
const INITIAL_DELAY_MS = 10_000;

/** Re-check on this interval for long-running sessions. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

interface IUpdateFeed {
	readonly version: string;
	readonly url: string;
	readonly urls?: Record<string, string>;
	readonly notes?: string;
	readonly mandatory?: boolean;
}

/** `<os>-<arch>` key for this running build, e.g. "darwin-arm64", used to pick a direct installer. */
function currentPlatformKey(): string {
	const os = isMacintosh ? 'darwin' : isWindows ? 'win32' : isLinux ? 'linux' : 'unknown';
	const nodeProcess = (globalThis as { vscode?: { process?: { arch?: string } }; process?: { arch?: string } }).vscode?.process
		?? (globalThis as { process?: { arch?: string } }).process;
	const arch = nodeProcess?.arch === 'arm64' ? 'arm64' : 'x64';
	return `${os}-${arch}`;
}

/**
 * Notifies the user when a newer app build is available. This intentionally does NOT download or install
 * anything (the app ships outside an auto-update channel); it just surfaces a dismissible toast linking to
 * the download. A version the user dismisses is remembered so they are not nagged about the same build.
 */
export class LoCoPilotUpdateCheckContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'locopilot.updateCheckService';

	/** Last update version the user explicitly dismissed - so we don't re-notify for the same build. */
	private static readonly DISMISSED_VERSION_KEY = 'locopilot.update.dismissedVersion';

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const startTimer = this._register(new TimeoutTimer());
		startTimer.setIfNotSet(() => void this._check(), INITIAL_DELAY_MS);
		const recheck = this._register(new IntervalTimer());
		recheck.cancelAndSet(() => void this._check(), RECHECK_INTERVAL_MS);
	}

	private get _feedUrl(): string {
		return (this.productService.locopilotUpdateUrl || UPDATE_FEED_URL || '').trim();
	}

	private async _check(): Promise<void> {
		const feed = await this._fetchFeed();
		if (!feed) {
			return;
		}
		const current = this.productService.version || '0.0.0';
		if (!isNewer(feed.version, current)) {
			return; // up to date
		}
		const dismissed = this.storageService.get(LoCoPilotUpdateCheckContribution.DISMISSED_VERSION_KEY, StorageScope.APPLICATION, '');
		if (dismissed === feed.version && !feed.mandatory) {
			return; // user already said "not now" for this exact build
		}
		this._notify(feed);
	}

	private _notify(feed: IUpdateFeed): void {
		const downloadUrl = feed.urls?.[currentPlatformKey()] || feed.url;
		const notes = feed.notes ? ` ${feed.notes}` : '';
		this.notificationService.notify({
			severity: Severity.Info,
			sticky: feed.mandatory === true,
			message: `LoCoPilot ${feed.version} is available (you have ${this.productService.version}).${notes}`,
			actions: {
				primary: [{
					id: 'locopilot.update.download',
					label: 'Download update',
					tooltip: '',
					class: undefined,
					enabled: true,
					run: () => { void this.openerService.open(downloadUrl, { openExternal: true }); },
				}],
				secondary: feed.mandatory ? [] : [{
					id: 'locopilot.update.dismiss',
					label: 'Not now',
					tooltip: '',
					class: undefined,
					enabled: true,
					run: () => this.storageService.store(
						LoCoPilotUpdateCheckContribution.DISMISSED_VERSION_KEY, feed.version,
						StorageScope.APPLICATION, StorageTarget.MACHINE),
				}],
			},
		});
	}

	/** Fetch + validate the update feed. Returns undefined on any problem - never throws. */
	private async _fetchFeed(): Promise<IUpdateFeed | undefined> {
		const url = this._feedUrl;
		if (!url) {
			return undefined;
		}
		const cts = new CancellationTokenSource();
		const timer = setTimeout(() => cts.cancel(), FETCH_TIMEOUT_MS);
		try {
			const res = await this.requestService.request({ type: 'GET', url, headers: { Accept: 'application/json' } }, cts.token);
			if (res.res.statusCode !== 200) {
				return undefined;
			}
			const raw = await streamToBuffer(res.stream).then(b => b.toString());
			const o = JSON.parse(raw);
			if (o && typeof o === 'object'
				&& typeof o.version === 'string' && o.version.length > 0
				&& typeof o.url === 'string' && /^https?:\/\//.test(o.url)) {
				let urls: Record<string, string> | undefined;
				if (o.urls && typeof o.urls === 'object') {
					urls = {};
					for (const [k, v] of Object.entries(o.urls)) {
						if (typeof v === 'string' && /^https?:\/\//.test(v)) {
							urls[k] = v;
						}
					}
				}
				return {
					version: o.version,
					url: o.url,
					urls,
					notes: typeof o.notes === 'string' ? o.notes : undefined,
					mandatory: o.mandatory === true,
				};
			}
			return undefined;
		} catch (e) {
			this.logService.info(`[LoCoPilot Update] Update feed unavailable: ${e}`);
			return undefined;
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
	}
}

/** Semver-ish "is a newer than b" comparison: numeric, dot-separated, missing parts treated as 0. */
function isNewer(a: string, b: string): boolean {
	const pa = a.split('.').map(n => parseInt(n, 10) || 0);
	const pb = b.split('.').map(n => parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) {
			return da > db;
		}
	}
	return false;
}
