/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICustomLanguageModelsService, customModelVisionEnabled, type ICustomLanguageModel } from '../common/customLanguageModelsService.js';
import { ChatConfiguration } from '../common/constants.js';
import { ILoCoPilotFileLog } from './locopilotFileLog.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import {
	detectLlamaBackend,
	getRecommendedBackend,
	getDefaultLlamaServerPaths,
	getBundledLlamaServerPath,
	getBundledPlatformArch,
	getLlamaCppServerCommand,
	getLlamaServerBaseUrl,
	getLlamaServerHealthUrl,
	getLlamaServerRootUrl,
	computeGpuLayers,
	computeCpuMoeLayers,
	computeKvBudgetBytes,
	clampContextSize,
	shouldUseBundledVulkan,
	metalOffloadBudgetBytes,
	usableSystemMemoryBytes,
	KV_BUDGET_FRACTION,
	KV_CLAMP_BUDGET_FRACTION,
	ADAPTIVE_Q4_KV_CONTEXT_FLOOR,
	RUNTIME_OVERHEAD_BYTES,
	DEFAULT_LLAMA_CONTEXT_SIZE,
	MIN_CLAMPED_CONTEXT,
	LOCOPILOT_LLAMA_SERVER_PORT,
	LlamaBackend,
	resolveKvCacheType,
	kvCacheBytesPerElem,
	DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16,
	type LlamaServerTuning,
	type FlashAttentionMode,
	type KvCacheType
} from './locopilotLlamaCppServer.js';
import { readGgufModelInfo, isMoeModelInfo, isSwaModelInfo, kvBytesPerTokenPerLayer, type IGgufModelInfo } from './locopilotGgufMetadata.js';
import { ILoCoPilotSystemInfoService, type IMemoryStatus, type ISystemHardwareInfo, type MemoryPressureLevel } from '../../../../platform/locopilotSystemInfo/common/locopilotSystemInfo.js';
import { dirname } from '../../../../base/common/path.js';
import { isWindows, isMacintosh } from '../../../../base/common/platform.js';
import {
	getBundledMlxPython,
	getMlxLmServerCommand,
	getMlxServerBaseUrl,
	LOCOPILOT_MLX_SERVER_PORT,
	hfModelLooksLikeMlx,
	isAppleSiliconMac,
	shouldUseMlxServerForHfModel,
	type MlxServerTuning,
} from './locopilotMlxServer.js';
import { findDraftPairing } from './locopilotModelCatalog.js';
import { LoCoPilotModelDownloadService, modelDownloadDirName } from './locopilotModelDownloadService.js';
import { joinPath } from '../../../../base/common/resources.js';
import { streamToBuffer, VSBuffer } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalService, ITerminalInstance } from '../../terminal/browser/terminal.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { timeout } from '../../../../base/common/async.js';

export const ILoCoPilotLocalModelRunner = createDecorator<ILoCoPilotLocalModelRunner>('locopilotLocalModelRunner');

/**
 * Max persisted KV slot caches to keep on disk (one per warmed model+mode prefix). Older ones are
 * LRU-evicted after each save. Each `.bin` is the full prefix KV (tens to hundreds of MB), so this bounds
 * the cache dir at a few GB while comfortably covering the user's 2-3 hot models across modes.
 */
const MAX_SLOT_CACHE_ENTRIES = 10;

/** How long a "launch blocked at the fit gate" reason stays relevant to the chat panel before it's treated as stale. */
const LAUNCH_BLOCK_TTL_MS = 60_000;

/**
 * Lifecycle phase of a local model server:
 *  - 'starting': process is being launched (no port bound yet).
 *  - 'loading' : process is up but still reading weights into RAM/VRAM (endpoint not 200 yet).
 *  - 'ready'   : the OpenAI endpoint answered 200; safe to send requests.
 */
export type LocalServerPhase = 'starting' | 'loading' | 'ready';

/**
 * Cross-window active-server lock file contents. A launch first writes a 'claiming' entry (atomic exclusive
 * create - only one window across the machine wins the race to start a server), then overwrites it with a
 * 'running' entry carrying the real pid/port once the server is up. Other windows read this to attach to or
 * replace the single active server.
 */
interface IActiveServerLock {
	phase: 'claiming' | 'running';
	modelId: string;
	kind: 'llama' | 'mlx';
	/** Present while phase==='claiming' (and carried into 'running') to identify the owning window. */
	claimToken?: string;
	/** Present once phase==='running'. */
	pid?: number;
	/** Present once phase==='running'. */
	port?: number;
	servedModelId?: string;
}

export interface ILoCoPilotLocalModelRunner {
	readonly _serviceBrand: undefined;
	readonly onDidServerStateChange: Event<string>;
	readonly onDidLogUpdate: Event<string>;
	/** Fired when a server launch fails. Payload contains modelId and a human-readable reason. */
	readonly onDidServerStartFailed: Event<{ modelId: string; message: string }>;
	/** Fired when the live memory snapshot changes, so Auto-label consumers can re-derive the resolved model. */
	readonly onDidAvailableRamChange: Event<void>;
	/** Current load phase for a model whose server we are starting/running, or undefined when not managed. */
	getServerPhase(modelId: string): LocalServerPhase | undefined;
	/**
	 * The context window (`-c`) the model's server was actually launched with - i.e. the value AFTER the
	 * memory clamp, which can be far smaller than the model's nominal/catalog window on a tight machine.
	 * Undefined until the model has been launched at least once this session. Consumers (the context-usage
	 * gauge, the agent's context manager) should prefer this over the nominal window so they summarize/trim
	 * against the real budget instead of over-filling a window the server will silently truncate.
	 */
	getLaunchedContextWindow(modelId: string): number | undefined;
	/** Latest human-readable load-progress line (parsed from llama.cpp output), if any. */
	getLoadProgress(modelId: string): string | undefined;
	/**
	 * Eagerly start (warm up) a model's server in the background, without waiting. No-op when the model
	 * is already running/starting, is not a startable local model, or prewarm-on-select is disabled.
	 * Used to hide the cold start behind the user's typing time when they pick a model.
	 */
	prewarmModel(modelId: string): void;
	getBackend(): LlamaBackend;
	getBackendPriority(): LlamaBackend[];
	getServerBaseUrl(modelId: string): string | undefined;
	/**
	 * The model id the running server was loaded with (the `--model` value). Chat requests should send
	 * this as their `model` field instead of the catalog/HF name, because MLX (mlx_lm.server) tries to
	 * load a different model when the request id doesn't match what it booted with. Undefined when the
	 * server isn't running or the engine ignores the field (llama.cpp).
	 */
	getServedModelId(modelId: string): string | undefined;
	getServerLogs(modelId: string): string[];
	/**
	 * Launches the server for `modelId`. `interactive` = true for explicit user actions (send message, Start
	 * button, Retry, picker): a model that won't fit shows the "Run anyway / Keep current" dialog. false for
	 * background pre-warm / crash-relaunch: a non-fitting model is skipped silently, and a prior "Run anyway"
	 * choice (the `_forcedLaunch` flag) still carries the relaunch through.
	 */
	startServerInTerminal(modelId: string, interactive?: boolean): Promise<void>;
	/**
	 * Ensures a local server for the model is running and ready to answer chat requests.
	 * If not running, starts it (evicting the least-recently-used server first when the resident-model
	 * budget is reached) and waits until the OpenAI-compatible endpoint responds. Reusing a running
	 * server also refreshes its keep-alive idle timer.
	 * Returns the server base URL when ready, or undefined if it could not be started.
	 */
	ensureServerForModel(modelId: string, token?: CancellationToken): Promise<string | undefined>;
	/**
	 * Restore a previously-saved KV cache slot (the warmed system+tools prefix) from disk into the running
	 * llama.cpp server so the first real turn reuses it instead of re-prefilling. Returns true only when a
	 * matching cache file existed and the server loaded it. No-op (false) for MLX/non-llama servers, when
	 * the server isn't ready, or when slot persistence is disabled.
	 */
	restoreSlotCache(modelId: string, key: string, token?: CancellationToken): Promise<boolean>;
	/**
	 * Persist the running llama.cpp server's slot-0 KV cache (the warmed prefix) to disk under `key`, so a
	 * future session can restore it. No-op for MLX/non-llama servers or when slot persistence is disabled.
	 */
	saveSlotCache(modelId: string, key: string, token?: CancellationToken): Promise<void>;
	stopServer(modelId: string): void;
	/**
	 * Stops every running llama.cpp/MLX server we manage, except an optional one to keep.
	 * Used to free CPU/RAM when switching to a different local engine (e.g. an Ollama model),
	 * since those servers are not otherwise touched by that engine's request path.
	 */
	stopManagedServers(exceptModelId?: string): void;
	runOllamaModelInTerminal(modelId: string): Promise<void>;
	isServerRunning(modelId: string): boolean;
	/** True while the server process is being launched (between button click and first state change). */
	isServerStarting(modelId: string): boolean;
	/**
	 * Read-only mirror of the interactive launch gate for Auto's step-down: would `modelId` fit the RAM a
	 * launch would ACTUALLY get right now (live available + what this launch's own eviction frees, counting
	 * only the non-reclaimable working set)? Runs the same math as the real gate but WITHOUT side effects - no
	 * "Run anyway?" prompt, no recorded block, no server start. True when it fits or the fit can't be measured
	 * (non-RAM backend, no probe, unknown footprint - i.e. the real gate wouldn't block either).
	 */
	wouldModelFitForLaunch(modelId: string): Promise<boolean>;
	/**
	 * The reason a recent launch of `modelId` was abandoned at a memory/fit gate (user declined "Run anyway",
	 * or a pre-warm skipped a too-big model), or undefined when there is none / it has gone stale. Lets the
	 * chat panel distinguish a model that WON'T start (fit-blocked) from one that is merely still loading.
	 */
	getRecentLaunchFailure(modelId: string): string | undefined;
}

export class LoCoPilotLocalModelRunner extends Disposable implements ILoCoPilotLocalModelRunner {
	declare readonly _serviceBrand: undefined;
	static readonly ID = 'locopilot.localModelRunner';

	private readonly _onDidServerStateChange = this._register(new Emitter<string>());
	readonly onDidServerStateChange = this._onDidServerStateChange.event;

	private readonly _onDidLogUpdate = this._register(new Emitter<string>());
	readonly onDidLogUpdate = this._onDidLogUpdate.event;

	private readonly _onDidServerStartFailed = this._register(new Emitter<{ modelId: string; message: string }>());
	readonly onDidServerStartFailed = this._onDidServerStartFailed.event;

	/**
	 * Fires when the live memory snapshot changes (a fresh probe landed). The model picker listens so the
	 * "Auto (X)" label re-derives when available RAM shifts - otherwise it only re-rendered on a server
	 * state change and drifted out of sync with the dropdown and the actual per-request resolution (Q1).
	 */
	private readonly _onDidAvailableRamChange = this._register(new Emitter<void>());
	readonly onDidAvailableRamChange = this._onDidAvailableRamChange.event;

	private static readonly MAX_LOG_LINES = 2000;

	/** Models whose server launch is in progress (sent to terminal but not yet confirmed running/failed). */
	private startingServers = new Set<string>();
	/**
	 * In-flight launch promises keyed by modelId. Set synchronously at the start of a launch so concurrent
	 * callers (e.g. startup pre-warm racing the model-picker's select pre-warm) share one launch instead of
	 * each spawning a server on the same port - the classic "exit code 1" double-start at startup.
	 */
	private readonly _startInFlight = new Map<string, Promise<void>>();
	/** Ports picked by an in-flight launch but not yet bound; reserved so concurrent launches don't reuse them. */
	private readonly _reservedPorts = new Set<number>();
	/**
	 * PID of the model server THIS window currently owns and has published to the cross-window active-server lock.
	 * Used so the coordination step never kills our own process (only another window's) and so we only clear the
	 * lock when it still points at us. Undefined when this window owns no running server.
	 */
	private _ownedServerPid: number | undefined;
	/** Token for the 'claiming' lock this window holds while its launch is in flight (before the server is up). */
	private _myClaimToken: string | undefined;
	/** Trailing-throttle timer for mirroring the owned server's logs to the shared log file. */
	private _logMirrorTimer: ReturnType<typeof setTimeout> | undefined;
	/** Per-model watchers tailing the shared log file for records attached to another window's server. */
	private readonly _foreignLogWatchers = new Map<string, IDisposable>();
	/** Debounce timer for re-syncing local state after the shared active-server lock changes on disk. */
	private _lockSyncTimer: ReturnType<typeof setTimeout> | undefined;
	/** Remaining probe retries for a lock that appeared but whose server is still loading (not healthy yet). */
	private _lockSyncRetries = 0;
	private runningServers = new Map<string, {
		port: number;
		/**
		 * The terminal that owns this server's process. Undefined for a *foreign* record - a server started by a
		 * DIFFERENT app window that this window has attached to (see {@link _coordinateGlobalSingleServer}). A
		 * foreign record is a read-only handle: this window sends chat/KV requests to its port over HTTP but does
		 * not own the process, so it must never dispose a terminal (there is none) or run idle/LRU teardown for it.
		 */
		terminal?: ITerminalInstance;
		/** True when this record points at a server owned by another window (attached via the active-server lock). */
		foreign?: boolean;
		kind: 'llama' | 'mlx';
		/**
		 * The model identifier the server was actually loaded with (the value passed to `--model`).
		 * For MLX this is the on-disk model directory; mlx_lm.server is per-request model-aware and will
		 * try to (re)load a *different* model if a chat request's `model` field doesn't match this, which
		 * silently stalls the request. Chat requests must send this id, not the HF repo name. Undefined
		 * for engines (llama.cpp) that ignore the request's `model` field.
		 */
		servedModelId?: string;
		logs: string[];
		/** Epoch ms of the last request/use; drives least-recently-used eviction and the idle timer. */
		lastUsedAt: number;
		/** True once the OpenAI endpoint answered 200 (phase 'ready'); false while still loading weights. */
		ready: boolean;
		/** Pending idle-unload timer; cleared/reset on each use. */
		idleTimer?: ReturnType<typeof setTimeout>;
		/** Latest parsed load-progress line shown in the loading UI. */
		loadProgress?: string;
	}>();
	/**
	 * The terminal that owns each model's *current* launch. A model can be stopped and restarted (manual
	 * Retry, LRU eviction then reuse, engine handoff), which leaves the previous terminal's onExit listener
	 * still registered. Without an ownership check, that stale exit would delete the freshly-started record
	 * and fire a bogus "Couldn't start…" crash for a model that is actually running/starting. Each onExit
	 * compares against this map and ignores the event unless it owns the live launch.
	 */
	private readonly _activeLaunchTerminals = new Map<string, ITerminalInstance>();
	/** Models we are intentionally stopping, so the process-exit handler doesn't report a stop as a crash. */
	private readonly _intentionalStops = new Set<string>();
	/**
	 * Models the user chose "Run anyway" for at the fit-check dialog: their next launch bypasses BOTH memory
	 * gates. Cleared when the model is stopped (manual stop, eviction, or a watchdog trip), so a model the
	 * machine proved it can't hold re-prompts on the next explicit selection instead of silently forcing again.
	 */
	private readonly _forcedLaunch = new Set<string>();
	/** The last local model that was actually used/ready, so "Keep current" can revert selection to it. */
	private _lastReadyModelId: string | undefined;
	/**
	 * Terminal reason a launch was abandoned at a memory/fit gate (user chose "Keep current model", or a
	 * background pre-warm skipped a too-big model). Lets the chat panel show the real "won't fit / not started"
	 * cause instead of the misleading "taking a moment to start" (which implies the server is still coming up).
	 * Keyed by modelId; the getter treats an entry older than {@link LAUNCH_BLOCK_TTL_MS} as stale so it never
	 * haunts a later, unrelated slow-load. Cleared at the top of every fresh launch attempt and on ready.
	 */
	private readonly _launchBlockReason = new Map<string, { message: string; at: number }>();
	/** Models whose server process exited before it ever became ready (so readiness polling can bail early). */
	private readonly _crashedBeforeReady = new Set<string>();
	/** Models whose next crash should be logged but NOT surfaced as a notification (e.g. a pre-warm attempt that will be retried). */
	private readonly _suppressCrashNotice = new Set<string>();
	/** Cache of on-disk weight sizes (bytes) keyed by modelId, so the eviction budget doesn't re-stat on every switch. */
	private readonly _modelSizeCache = new Map<string, number>();
	/**
	 * Cache of the FULL estimated resident cost (weights + KV + runtime) per model, populated by
	 * {@link _estimateModelCost}. The sync prospective-RAM path (the picker's "Auto (X)" label) reads this so it
	 * scores against the SAME eviction credit the async request-time probe uses - otherwise the label (weights
	 * only) and the actual pick (full cost) can resolve to different models on the same machine (Q1).
	 */
	private readonly _modelCostCache = new Map<string, number>();
	/** Cached hardware probe (CPU cores / GPU VRAM); hardware doesn't change during a session. */
	private _hardwareInfo: Promise<ISystemHardwareInfo | undefined> | undefined;
	/** Cache of GGUF model info (layer count, expert count, context length) keyed by resolved model file path. */
	private readonly _modelInfoCache = new Map<string, IGgufModelInfo>();
	/**
	 * True once a llama-server launch crashed because the binary rejected the speculative-decoding flags
	 * (`--spec-type` / `--model-draft`), e.g. an old user-provided build. Auto-speculation is then disabled
	 * for the rest of the session and the failed launch is retried once without the flags (self-healing).
	 */
	private _specFlagsUnsupported = false;
	/** Model ids whose LAST llama-server launch included speculative flags; consulted by the crash fallback. */
	private readonly _launchedWithSpecFlags = new Set<string>();
	/**
	 * True once a llama-server launch crashed because the binary rejected `--cache-ram` (older builds predate
	 * it). The cap is then skipped for the session and the failed launch retried once without it - same
	 * self-healing shape as the speculative flags.
	 */
	private _cacheRamUnsupported = false;
	/** Model ids whose LAST llama-server launch included --cache-ram; consulted by the crash fallback. */
	private readonly _launchedWithCacheRam = new Set<string>();
	/**
	 * True once a llama-server launch crashed because the binary rejected `--swa-full` (a newer flag older
	 * builds predate). It is then skipped for the session and the failed launch retried once without it -
	 * same self-healing shape as the speculative flags / --cache-ram.
	 */
	private _swaFullUnsupported = false;
	/** Model ids whose LAST llama-server launch included --swa-full; consulted by the crash fallback. */
	private readonly _launchedWithSwaFull = new Set<string>();
	/** Same self-healing for mlx_lm.server: set when it rejects the optional tuning flags (old mlx-lm argparse). */
	private _mlxExtraFlagsUnsupported = false;
	/** Draft repos we already asked the download service to fetch this session (avoid re-firing per launch). */
	private readonly _draftFetchRequested = new Set<string>();
	/** Whether the one-time "download the CUDA engine?" offer was already shown this session. */
	private _cudaOfferedThisSession = false;
	/** Guards against parallel CUDA engine downloads. */
	private _cudaDownloadInFlight = false;
	/** Last live memory snapshot + when it was taken; a short-lived cache for sync consumers (Auto mode). */
	private _lastMemoryStatus: IMemoryStatus | undefined;
	private _lastMemoryStatusAt = 0;
	/** Guards concurrent memory-status probes so bursts (picker open + launch) share one exec round. */
	private _memoryStatusInFlight: Promise<IMemoryStatus | undefined> | undefined;
	/** Periodic memory watchdog while owned servers are resident (see _updateMemoryWatchdog). */
	private _watchdogTimer: number | undefined;
	/** Consecutive watchdog samples that looked critical; the breaker trips at 2 (~10s) to skip one-tick blips. */
	private _watchdogStrikes = 0;
	/** Swap-in-use (bytes) at the previous watchdog sample, so the tick can detect ACTIVELY GROWING swap (paging). */
	private _watchdogLastSwapBytes = -1;
	/** True once we've shown the user the "memory low" warning for the CURRENT pressure episode; reset on recovery. */
	private _watchdogWarnedThisEpisode = false;
	/** Epoch ms until which automatic (pre-warm) launches stay suppressed after the watchdog tripped. */
	private _watchdogCooldownUntil = 0;
	/** Per-model count of OOM-crash degradation relaunches this session (see _reportServerCrash's OOM ladder). */
	private readonly _oomRetryCount = new Map<string, number>();
	/** Per-model context-size cap applied by the OOM ladder; consulted when building the launch tuning. */
	private readonly _oomContextCap = new Map<string, number>();
	/** Models whose OOM ladder also strips the memory-heavy extras (MTP self-draft / separate draft model). */
	private readonly _oomStripExtras = new Set<string>();
	/** Context size (-c) each model's LAST llama launch actually used, so the OOM ladder can halve it. */
	private readonly _lastLaunchContext = new Map<string, number>();
	/**
	 * Resolved KV-cache tensor type (f16 / q8_0 / q4_0) each model's current llama server launched with. A saved
	 * slot-cache blob is only byte-compatible with a server using the SAME type, so this is folded into the slot
	 * filename: a later launch that resolves a different type (context size shifted the 'auto' choice, or the OOM
	 * ladder capped it) looks for a differently-named file, misses cleanly, and warms - instead of hitting the
	 * server-side "mismatched key type" restore error on an incompatible blob saved under the same name.
	 */
	private readonly _lastLaunchKvType = new Map<string, string>();

	constructor(
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
		@ILoCoPilotFileLog private readonly locopilotFileLog: ILoCoPilotFileLog,
		@ITerminalService private readonly terminalService: ITerminalService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestService private readonly requestService: IRequestService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();
		this._registerCommands();
		// Make sure idle timers, the memory watchdog and child processes are torn down when the service is disposed.
		this._register({ dispose: () => this.stopManagedServers() });
		this._register({ dispose: () => this._stopMemoryWatchdog() });
		// Watch the shared active-server lock so status stays in sync across windows: when another window
		// starts/stops/replaces the global model server, this window updates its own records (attach a foreign
		// handle to the new server, drop handles that no longer match) and the My Models UI follows live.
		const lockUri = this._activeServerLockUri();
		// Watch the containing directory, not the lock file itself: the lock is created/deleted constantly and a
		// direct file watch logs "Watcher shutdown because watched path got deleted" every time it's removed.
		this._register(this.fileService.watch(this.environmentService.cacheHome));
		this._register(this.fileService.onDidFilesChange(e => {
			if (e.contains(lockUri)) {
				this._scheduleLockSync();
			}
		}));
		this._register(toDisposable(() => {
			for (const w of this._foreignLogWatchers.values()) { w.dispose(); }
			this._foreignLogWatchers.clear();
			if (this._lockSyncTimer) { clearTimeout(this._lockSyncTimer); }
			if (this._logMirrorTimer) { clearTimeout(this._logMirrorTimer); }
		}));
	}

	private _registerCommands(): void {
		const self = this;
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.startLlamaServer', title: { value: 'Start Llama Server', original: 'Start Llama Server' } });
			}
			async run(accessor: ServicesAccessor, modelId?: string): Promise<void> {
				if (modelId) {
					await self.startServerInTerminal(modelId, true); // explicit user action (Start/Retry) -> may prompt "Run anyway?"
				}
			}
		});
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.runOllamaModel', title: { value: 'Run Ollama Model', original: 'Run Ollama Model' } });
			}
			async run(accessor: ServicesAccessor, modelId?: string): Promise<void> {
				if (modelId) {
					await self.runOllamaModelInTerminal(modelId);
				}
			}
		});
		// Eager pre-warm hook fired from the chat model picker when a model is selected.
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.prewarmModel', title: { value: 'Pre-warm Local Model', original: 'Pre-warm Local Model' } });
			}
			async run(accessor: ServicesAccessor, modelId?: string): Promise<void> {
				if (modelId) {
					self.prewarmModel(modelId);
				}
			}
		});
		// Power-user override for the bundled local engine (auto/cpu/gpu). The choice is normally automatic
		// (see _resolveServerLaunch); this command is the supported way to force it without the settings UI.
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'locopilot.selectLocalEngine',
					title: { value: 'Select Local Model Engine (CPU/GPU)', original: 'Select Local Model Engine (CPU/GPU)' },
					category: { value: 'LoCoPilot', original: 'LoCoPilot' },
					f1: true,
				});
			}
			async run(accessor: ServicesAccessor): Promise<void> {
				const quickInput = accessor.get(IQuickInputService);
				const current = self.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppEngine) ?? 'auto';
				const mark = (id: string) => id === current ? ' (current)' : '';
				const items: (IQuickPickItem & { id: 'auto' | 'cpu' | 'gpu' })[] = [
					{ id: 'auto', label: `Auto${mark('auto')}`, description: 'Use the GPU when a capable one is detected, otherwise CPU (recommended)' },
					{ id: 'cpu', label: `CPU${mark('cpu')}`, description: 'Always run on the CPU' },
					{ id: 'gpu', label: `GPU (Vulkan)${mark('gpu')}`, description: 'Force the bundled GPU engine, even on integrated graphics' },
				];
				const picked = await quickInput.pick(items, {
					placeHolder: isMacintosh
						? 'Local model engine - note: macOS always uses Metal, so this has no effect here'
						: 'Choose the engine for local GGUF models (applies on the next model start)',
				});
				if (picked && picked.id !== current) {
					await self.configurationService.updateValue(ChatConfiguration.LocopilotLlamaCppEngine, picked.id);
				}
			}
		});
	}

	/**
	 * True when the user pointed `locopilot.llamaCpp.serverPath` at their own llama.cpp build.
	 * Only then is it safe to attempt a GPU backend on non-Mac, since the bundled Windows/Linux
	 * binaries are CPU-only and forcing GPU offload onto them breaks startup.
	 */
	private _hasCustomServerPath(): boolean {
		return !!this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath)?.trim();
	}

	/**
	 * Returns the backend that will be used (or is recommended) for running the model.
	 * Metal on Apple Silicon, GPU (CUDA/Vulkan) only for user-provided non-Mac builds, else CPU.
	 */
	getBackend(): LlamaBackend {
		return getRecommendedBackend(this._hasCustomServerPath());
	}

	/**
	 * Returns ordered list of backends to try (best first).
	 */
	getBackendPriority(): LlamaBackend[] {
		return detectLlamaBackend(this._hasCustomServerPath());
	}

	/**
	 * Hardware-aware backend choice for an actual launch. Starts from the static recommendation
	 * ({@link getBackend}) and, only when that is the generic discrete-GPU pick `cuda` (custom build on a
	 * non-Mac), refines it from the detected GPU vendor: NVIDIA -> `cuda`, AMD/Intel -> `vulkan`. This avoids
	 * launching a CUDA build against an AMD/Intel GPU (which would fail), without ever forcing a GPU backend
	 * onto the bundled CPU-only binaries (those still resolve to `cpu`/`metal` and are returned unchanged).
	 */
	private async _resolveBackendForLaunch(): Promise<LlamaBackend> {
		const top = this.getBackend();
		if (top !== 'cuda') {
			return top; // metal / cpu are not GPU-vendor dependent
		}
		const hw = await this._getHardwareInfo();
		const gpus = hw?.gpus ?? [];
		if (gpus.some(g => g.vendor === 'nvidia')) {
			return 'cuda';
		}
		if (gpus.some(g => g.vendor === 'amd' || g.vendor === 'intel')) {
			this._log('[LoCoPilot Runner] Detected AMD/Intel GPU; preferring Vulkan backend over CUDA.');
			return 'vulkan';
		}
		return top; // unknown vendor -> keep the static recommendation
	}

	/** True when a path on disk points at an existing file (best-effort; false on any error). */
	private async _isExistingFile(fsPath: string): Promise<boolean> {
		try {
			return (await this.fileService.stat(URI.file(fsPath))).isFile;
		} catch {
			return false;
		}
	}

	/**
	 * Resolves the llama-server binary AND the backend to launch with together, since they are coupled
	 * (the bundled Vulkan binary must run with the Vulkan backend, the CPU binary with CPU, etc.).
	 *
	 * Priority:
	 *  1. User-configured custom build -> honor it, backend from the GPU-vendor-aware resolver.
	 *  2. Apple Silicon -> the bundled Metal binary (current behavior).
	 *  3. Windows/Linux: pick the bundled CPU or **Vulkan** (GPU) binary per the `engine` setting:
	 *     'auto' (default) uses Vulkan when the GPU is worth it ({@link shouldUseBundledVulkan}) and the
	 *     binary shipped; 'gpu' forces Vulkan whenever the binary shipped; 'cpu' forces the CPU binary.
	 *     VRAM-aware partial offload then applies automatically on the Vulkan path.
	 *  4. CPU fallback (then conventional install paths).
	 */
	private async _resolveServerLaunch(): Promise<{ serverPath: string | undefined; backend: LlamaBackend }> {
		// 1. Custom build path set by the user wins (may be a CUDA/Vulkan build). The `engine` setting is
		//    about the *bundled* engines, so it does not apply here.
		if (this._hasCustomServerPath()) {
			return { serverPath: await this.resolveServerPath(), backend: await this._resolveBackendForLaunch() };
		}

		// 2. Apple Silicon: the bundled binary is a Metal build. The `engine` setting (cpu/gpu) is a
		//    Windows/Linux concept, so it does not apply on macOS.
		if (this.getBackend() === 'metal') {
			return { serverPath: await this.resolveServerPath(), backend: 'metal' };
		}

		// 3. Windows/Linux: choose CPU vs bundled Vulkan, honoring the user's engine preference.
		const engine = this.configurationService.getValue<'auto' | 'cpu' | 'gpu'>(ChatConfiguration.LocopilotLlamaCppEngine) ?? 'auto';

		// 3a. Windows x64 + NVIDIA GPU: prefer the on-demand **CUDA** engine when installed - prompt
		// processing (time-to-first-token on long agent prompts) is several times faster than Vulkan there.
		// When not installed, this offers/starts the one-time download in the background and this launch
		// proceeds with Vulkan/CPU as before; the CUDA engine is picked up from the next start onward.
		if (engine !== 'cpu') {
			const cudaPath = await this._maybeUseCudaEngine();
			if (cudaPath) {
				this._log(`[LoCoPilot Runner] Using downloaded CUDA engine: ${cudaPath}`);
				return { serverPath: cudaPath, backend: 'cuda' };
			}
		}

		if (engine !== 'cpu') {
			const hw = await this._getHardwareInfo();
			// 'gpu' forces Vulkan regardless of how capable the GPU looks; 'auto' gates on shouldUseBundledVulkan.
			const wantVulkan = engine === 'gpu' || (!!hw && shouldUseBundledVulkan(hw.gpus));
			if (wantVulkan) {
				const vulkanPath = getBundledLlamaServerPath(this._appRoot, 'vulkan');
				if (vulkanPath && await this._isExistingFile(vulkanPath)) {
					const detected = hw?.gpus.map(g => g.name).join(', ') || 'unknown GPU';
					this._log(`[LoCoPilot Runner] Using bundled Vulkan engine (engine=${engine}, GPU: ${detected}).`);
					return { serverPath: vulkanPath, backend: 'vulkan' };
				}
				this._log(`[LoCoPilot Runner] Vulkan engine requested (engine=${engine}) but not bundled in this build; falling back to CPU.`);
			}
		}

		// 4. CPU fallback (bundled CPU binary, then conventional install locations).
		return { serverPath: await this.resolveServerPath(), backend: 'cpu' };
	}

	/**
	 * Local install dir for the on-demand CUDA engine, or undefined off Windows x64. Lives under the same
	 * cache root as downloaded models, so uninstall/cache cleanup treats engine and models alike.
	 */
	private _cudaEngineDir(): URI | undefined {
		if (!isWindows || getBundledPlatformArch() !== 'win32-x64') {
			return undefined;
		}
		return joinPath(this.environmentService.cacheHome, 'locopilot-engines', 'win32-x64-cuda');
	}

	/**
	 * Directory where llama.cpp persists per-slot KV caches (`--slot-save-path`), so a warmed system+tools
	 * prefix survives an app restart. Lives under the shared cache root alongside models and engines.
	 */
	private _kvCacheDir(): URI {
		return joinPath(this.environmentService.cacheHome, 'locopilot-kv-cache');
	}

	/** Memoized best-effort creation of {@link _kvCacheDir}; llama.cpp needs the dir to exist before launch. */
	private _kvCacheDirReady: Promise<boolean> | undefined;
	private _ensureKvCacheDir(): Promise<boolean> {
		if (!this._kvCacheDirReady) {
			this._kvCacheDirReady = (async () => {
				try {
					await this.fileService.createFolder(this._kvCacheDir());
					return true;
				} catch (e) {
					this._log(`[LoCoPilot Runner] Could not create KV cache dir (slot persistence disabled): ${e}`);
					return false;
				}
			})();
		}
		return this._kvCacheDirReady;
	}

	/**
	 * Filesystem-safe slot-cache filename for a (model, mode) prefix, tagged with the server's resolved KV cache
	 * type. The type tag is what stops the "mismatched key type" restore error: a saved blob is byte-compatible
	 * only with a server using the same KV type, so a launch that resolves a different type (context shift flipped
	 * the 'auto' f16<->q8_0 choice, or the OOM ladder capped context) looks for a differently-named file and
	 * misses cleanly instead of restoring an incompatible blob. Falls back to 'kvunknown' when the type isn't
	 * known here (e.g. a server owned by another window) - a real launch never resolves to that tag, so such a
	 * blob is simply never picked up by a launching window rather than mismatched.
	 */
	private _slotCacheFileName(modelId: string, key: string): string {
		// Only trust the locally-recorded KV type when THIS window owns the server; a foreign (attached) server was
		// launched elsewhere, so our record's type may be stale/absent - fall back to the never-restored tag.
		const foreign = this.runningServers.get(modelId)?.foreign === true;
		const kvType = (!foreign && this._lastLaunchKvType.get(modelId)) || 'kvunknown';
		return `${key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)}.${kvType}.bin`;
	}

	/** Finds `name` (case-insensitive) under `dir`, descending at most `depth` directory levels. */
	private async _findFileRecursive(dir: URI, name: string, depth: number): Promise<string | undefined> {
		try {
			const resolved = await this.fileService.resolve(dir);
			for (const c of resolved.children ?? []) {
				if (c.isFile && c.name.toLowerCase() === name) {
					return c.resource.fsPath;
				}
			}
			if (depth > 0) {
				for (const c of resolved.children ?? []) {
					if (c.isDirectory) {
						const found = await this._findFileRecursive(c.resource, name, depth - 1);
						if (found) {
							return found;
						}
					}
				}
			}
		} catch {
			// dir missing/unreadable -> not installed
		}
		return undefined;
	}

	/** Full path to the installed CUDA llama-server.exe, or undefined when not (yet) downloaded. */
	private async _installedCudaServerPath(): Promise<string | undefined> {
		const dir = this._cudaEngineDir();
		return dir ? this._findFileRecursive(dir, 'llama-server.exe', 2) : undefined;
	}

	/**
	 * CUDA engine decision for a launch on Windows: returns the installed CUDA llama-server path when this
	 * machine has an NVIDIA GPU and the engine was downloaded; otherwise (still honoring the
	 * `locopilot.llamaCpp.cudaEngine` setting) starts or offers the one-time background download and returns
	 * undefined so the current launch proceeds on Vulkan/CPU.
	 */
	private async _maybeUseCudaEngine(): Promise<string | undefined> {
		if (!this._cudaEngineDir()) {
			return undefined; // not Windows x64
		}
		const setting = this.configurationService.getValue<'auto' | 'on' | 'off'>(ChatConfiguration.LocopilotLlamaCppCudaEngine) ?? 'auto';
		if (setting === 'off') {
			return undefined;
		}
		const hw = await this._getHardwareInfo();
		if (!hw?.gpus.some(g => g.vendor === 'nvidia')) {
			return undefined; // CUDA only helps NVIDIA; AMD/Intel stay on Vulkan
		}
		const installed = await this._installedCudaServerPath();
		if (installed) {
			return installed;
		}
		if (setting === 'on') {
			void this._downloadCudaEngine(false);
		} else if (!this._cudaOfferedThisSession) {
			this._cudaOfferedThisSession = true;
			this.notificationService.prompt(
				Severity.Info,
				'An NVIDIA GPU was detected. Download the CUDA engine (~650 MB, one time) to make local models respond much faster on long prompts?',
				[
					{ label: 'Download', run: () => { void this._downloadCudaEngine(true); } },
					{
						label: 'Don\'t Ask Again',
						run: () => { void this.configurationService.updateValue(ChatConfiguration.LocopilotLlamaCppCudaEngine, 'off'); }
					},
				]
			);
		}
		return undefined;
	}

	/**
	 * Picks the newest llama.cpp release that ships BOTH Windows CUDA zips: the engine build and the matching
	 * CUDA runtime (cudart) DLLs. CUDA 12.x is chosen over 13.x for driver compatibility (12.x runs on any
	 * driver from R525 up; 13.x needs much newer drivers). The very latest tag is sometimes still uploading
	 * assets, so several releases are scanned.
	 */
	private async _findCudaRelease(): Promise<{ tag: string; engineUrl: string; cudartUrl: string } | undefined> {
		const res = await this.requestService.request({
			type: 'GET',
			url: 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10',
			headers: { 'Accept': 'application/vnd.github+json' },
		}, CancellationToken.None);
		if ((res.res.statusCode ?? 0) !== 200) {
			return undefined;
		}
		const raw = await streamToBuffer(res.stream).then(b => b.toString());
		const releases = JSON.parse(raw) as { tag_name: string; assets?: { name: string; browser_download_url: string }[] }[];
		for (const r of releases) {
			const engineAsset = (r.assets ?? []).find(a => /^llama-.*-bin-win-cuda-12\.\d+-x64\.zip$/.test(a.name));
			const cudartAsset = (r.assets ?? []).find(a => /^cudart-.*-cuda-12\.\d+-x64\.zip$/.test(a.name));
			if (engineAsset && cudartAsset) {
				return { tag: r.tag_name, engineUrl: engineAsset.browser_download_url, cudartUrl: cudartAsset.browser_download_url };
			}
		}
		return undefined;
	}

	/**
	 * Extracts a zip on Windows via PowerShell's built-in Expand-Archive in a hidden transient terminal
	 * (the workbench renderer has no zip library, and PowerShell is always present on Windows). Resolves
	 * to the process exit code (0 = success).
	 */
	private async _extractZipWithPowerShell(zipFsPath: string, destFsPath: string): Promise<number | undefined> {
		const terminal = await this.terminalService.createTerminal({
			config: {
				name: 'LoCoPilot Engine Setup',
				executable: 'powershell.exe',
				args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
					`Expand-Archive -LiteralPath "${zipFsPath}" -DestinationPath "${destFsPath}" -Force`],
				isTransient: true,
				hideFromUser: true,
			}
		});
		try {
			return await new Promise<number | undefined>(resolve => {
				const d = terminal.onExit(code => {
					d.dispose();
					resolve(typeof code === 'number' ? code : undefined);
				});
			});
		} finally {
			terminal.dispose();
		}
	}

	/**
	 * One-time background download + install of the llama.cpp CUDA engine (engine zip + cudart DLL zip,
	 * ~650 MB total) into {@link _cudaEngineDir}. Both zips extract into the SAME directory so llama-server.exe
	 * finds the CUDA runtime DLLs beside it (Windows loads DLLs from the exe's own directory). Never touches a
	 * running server; the engine is picked up by the next `_resolveServerLaunch`.
	 * `interactive`: true when the user just clicked Download (surface errors as notifications, not only logs).
	 */
	private async _downloadCudaEngine(interactive: boolean): Promise<void> {
		if (this._cudaDownloadInFlight) {
			return;
		}
		const dir = this._cudaEngineDir();
		if (!dir) {
			return;
		}
		this._cudaDownloadInFlight = true;
		try {
			if (interactive) {
				this.notificationService.info('Downloading the CUDA engine (~650 MB) in the background. You can keep working - it will be used the next time a local model starts.');
			}
			const release = await this._findCudaRelease();
			if (!release) {
				throw new Error('No llama.cpp release with Windows CUDA assets was found (network or GitHub API issue).');
			}
			this._log(`[LoCoPilot Runner] Downloading CUDA engine ${release.tag}: ${release.engineUrl} + ${release.cudartUrl}`);
			await this.fileService.createFolder(dir);
			const zips: [string, URI][] = [
				[release.engineUrl, joinPath(dir, '_tmp-engine.zip')],
				[release.cudartUrl, joinPath(dir, '_tmp-cudart.zip')],
			];
			for (const [url, target] of zips) {
				if (this.requestService.requestToFile) {
					const res = await this.requestService.requestToFile({ type: 'GET', url }, target.fsPath, CancellationToken.None, generateUuid());
					if ((res.res.statusCode ?? 0) !== 200) {
						throw new Error(`Download failed (${res.res.statusCode}): ${url}`);
					}
				} else {
					const res = await this.requestService.request({ type: 'GET', url }, CancellationToken.None);
					if ((res.res.statusCode ?? 0) !== 200) {
						throw new Error(`Download failed (${res.res.statusCode}): ${url}`);
					}
					await this.fileService.writeFile(target, res.stream);
				}
			}
			for (const [, target] of zips) {
				const exit = await this._extractZipWithPowerShell(target.fsPath, dir.fsPath);
				if (exit !== 0) {
					throw new Error(`Extracting ${target.fsPath} failed (exit ${exit ?? 'unknown'}).`);
				}
			}
			for (const [, target] of zips) {
				try {
					await this.fileService.del(target);
				} catch { /* leftover zip is harmless */ }
			}
			const bin = await this._installedCudaServerPath();
			if (!bin) {
				throw new Error('llama-server.exe was not found after extraction.');
			}
			this._log(`[LoCoPilot Runner] CUDA engine ${release.tag} installed at ${bin}.`);
			this.notificationService.info('The CUDA engine is ready. It will be used the next time a local model starts.');
		} catch (e) {
			this._log(`[LoCoPilot Runner] CUDA engine download failed: ${e}`);
			// Remove a partial install so the next attempt starts clean and _installedCudaServerPath can't
			// pick up a half-extracted engine.
			try {
				await this.fileService.del(dir, { recursive: true });
			} catch { /* ignore */ }
			if (interactive) {
				this.notificationService.error(`Couldn't download the CUDA engine: ${e}. The bundled engine keeps working; you can retry from the next launch prompt or set "locopilot.llamaCpp.cudaEngine" to "on".`);
			}
		} finally {
			this._cudaDownloadInFlight = false;
		}
	}

	/**
	 * Base URL for the local OpenAI-compatible server (llama.cpp or mlx-lm). Use this when sending chat requests.
	 */
	getServerBaseUrl(modelId: string): string | undefined {
		const running = this.runningServers.get(modelId);
		if (running) {
			return running.kind === 'mlx'
				? getMlxServerBaseUrl(running.port)
				: getLlamaServerBaseUrl(running.port);
		}
		return undefined;
	}

	async restoreSlotCache(modelId: string, key: string, token: CancellationToken = CancellationToken.None): Promise<boolean> {
		// Only llama.cpp exposes the /slots save/restore API; MLX and unmanaged endpoints have none.
		const running = this.runningServers.get(modelId);
		if (!running || running.kind !== 'llama' || !running.ready) {
			this._log(`[LoCoPilot Runner] KV slot restore skipped for ${modelId}: server not ready (present=${!!running}, kind=${running?.kind ?? 'none'}, ready=${running?.ready ?? false}).`);
			return false;
		}
		const filename = this._slotCacheFileName(modelId, key);
		// The file must exist under the slot-save dir, or llama.cpp rejects the restore. Check first so a
		// cold first-ever run (no cache yet) quietly falls back to warming instead of logging a failure.
		try {
			await this.fileService.stat(joinPath(this._kvCacheDir(), filename));
		} catch {
			this._log(`[LoCoPilot Runner] KV slot restore skipped for ${modelId}: no cache file "${filename}" in ${this._kvCacheDir().fsPath}.`);
			return false;
		}
		this._log(`[LoCoPilot Runner] KV slot restore: found "${filename}", requesting restore for ${modelId}...`);
		try {
			const res = await this.requestService.request({
				type: 'POST',
				url: `${getLlamaServerRootUrl(running.port)}/slots/0?action=restore`,
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({ filename }),
			}, token);
			const status = res.res.statusCode ?? 0;
			// Always drain the body so the connection is freed; keep it to surface the real error on failure.
			const body = await streamToBuffer(res.stream).then(b => b.toString()).catch(() => '');
			if (status === 200) {
				this._log(`[LoCoPilot Runner] Restored KV slot cache "${filename}" for ${modelId}.`);
				return true;
			}
			// A non-200 (e.g. 400 when the saved prefix is incompatible with the current weights/context) just
			// means we re-warm.
			this._log(`[LoCoPilot Runner] KV slot restore for ${modelId} returned ${status}; will warm instead: ${body.slice(0, 500) || '<empty body>'}`);
			return false;
		} catch (e) {
			this._log(`[LoCoPilot Runner] KV slot restore failed (ignored) for ${modelId}: ${e}`);
			return false;
		}
	}

	async saveSlotCache(modelId: string, key: string, token: CancellationToken = CancellationToken.None): Promise<void> {
		const running = this.runningServers.get(modelId);
		if (!running || running.kind !== 'llama' || !running.ready) {
			return;
		}
		if (!await this._ensureKvCacheDir()) {
			return;
		}
		const filename = this._slotCacheFileName(modelId, key);
		try {
			const res = await this.requestService.request({
				type: 'POST',
				url: `${getLlamaServerRootUrl(running.port)}/slots/0?action=save`,
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({ filename }),
			}, token);
			const status = res.res.statusCode ?? 0;
			// Always drain the body so the connection is freed; keep it around to surface the real error.
			const body = await streamToBuffer(res.stream).then(b => b.toString()).catch(() => '');
			if (status !== 200) {
				// The endpoint rejected the save (e.g. 400/501 when speculative decoding or a quantized KV
				// cache makes the slot state unsaveable). Nothing is written to disk in this case, so log the
				// real status + body instead of falsely reporting success - that is what "Saved" used to hide.
				this._log(`[LoCoPilot Runner] KV slot save for ${modelId} returned ${status} (no file written): ${body.slice(0, 500) || '<empty body>'}`);
				return;
			}
			this._log(`[LoCoPilot Runner] Saved KV slot cache "${filename}" for ${modelId} (status ${status}).`);
			// Keep the KV-cache dir bounded: retain only the most-recently-saved caches, evict the rest (LRU).
			await this._pruneSlotCaches();
		} catch (e) {
			this._log(`[LoCoPilot Runner] KV slot save failed (ignored) for ${modelId}: ${e}`);
		}
	}

	/**
	 * LRU eviction for the persisted KV-cache dir: keep the {@link MAX_SLOT_CACHE_ENTRIES} most-recently
	 * modified `.bin` files (freshly-saved caches touch their mtime), delete the older ones. Best-effort.
	 */
	private async _pruneSlotCaches(): Promise<void> {
		try {
			const dir = this._kvCacheDir();
			const stat = await this.fileService.resolve(dir, { resolveMetadata: true });
			const caches = (stat.children ?? [])
				.filter(c => !c.isDirectory && c.name.endsWith('.bin'))
				.sort((a, b) => b.mtime - a.mtime); // newest first
			for (const stale of caches.slice(MAX_SLOT_CACHE_ENTRIES)) {
				try {
					await this.fileService.del(stale.resource);
					this._log(`[LoCoPilot Runner] Evicted stale KV slot cache "${stale.name}" (LRU).`);
				} catch { /* ignore individual delete failures */ }
			}
		} catch (e) {
			this._log(`[LoCoPilot Runner] KV slot cache prune failed (ignored): ${e}`);
		}
	}

	getServedModelId(modelId: string): string | undefined {
		return this.runningServers.get(modelId)?.servedModelId;
	}

	isServerRunning(modelId: string): boolean {
		return this.runningServers.has(modelId);
	}

	isServerStarting(modelId: string): boolean {
		return this.startingServers.has(modelId);
	}

	getServerLogs(modelId: string): string[] {
		return this.runningServers.get(modelId)?.logs ?? [];
	}

	getServerPhase(modelId: string): LocalServerPhase | undefined {
		const running = this.runningServers.get(modelId);
		if (running) {
			return running.ready ? 'ready' : 'loading';
		}
		return this.startingServers.has(modelId) ? 'starting' : undefined;
	}

	getLoadProgress(modelId: string): string | undefined {
		return this.runningServers.get(modelId)?.loadProgress;
	}

	getLaunchedContextWindow(modelId: string): number | undefined {
		return this._lastLaunchContext.get(modelId);
	}

	stopServer(modelId: string): void {
		const running = this.runningServers.get(modelId);
		if (running) {
			if (running.idleTimer) {
				clearTimeout(running.idleTimer);
			}
			if (running.foreign) {
				// A record attached to another window's server: we own no terminal here. Just drop our handle -
				// the owning window is responsible for the process lifecycle and the active-server lock.
				this._disposeForeignLogWatcher(modelId);
				this.runningServers.delete(modelId);
				this._onDidServerStateChange.fire(modelId);
				this._log(`[LoCoPilot Runner] Detached from foreign server for model ${modelId}.`);
				return;
			}
			this._intentionalStops.add(modelId); // mark so onExit treats this as a clean stop, not a crash
			this._forcedLaunch.delete(modelId); // a stopped model re-prompts "Run anyway?" on its next launch
			running.terminal?.dispose();
			this.runningServers.delete(modelId);
			void this._clearActiveServerLockIfOwned();
			this._onDidServerStateChange.fire(modelId);
			this._log(`[LoCoPilot Runner] Stopped server for model ${modelId}`);
		}
	}

	/**
	 * Stops an owned server AND waits until its process has actually released the port + its wired weights
	 * before resolving. Eviction on a model switch must be serialized against the replacement launch:
	 * {@link stopServer} only *requests* teardown (disposing the terminal SIGTERMs the pty asynchronously),
	 * so a launch that proceeds immediately briefly DOUBLE-BOOKS RAM - the dying model's weights are still
	 * resident while the new model loads. On a memory-tight machine that transient spike is a top cause of a
	 * switch OOM-ing or tripping the watchdog on a launch that would have been fine seconds later. Foreign
	 * records (owned by another window) and already-gone models resolve immediately - there is nothing here
	 * to wait on. Never throws: a teardown-wait failure must not block the switch.
	 */
	private async _stopServerAndWait(modelId: string): Promise<void> {
		const rec = this.runningServers.get(modelId);
		if (!rec || rec.foreign) {
			this.stopServer(modelId);
			return;
		}
		const { port, kind } = rec;
		let pid: number | undefined;
		try {
			await rec.terminal?.processReady;
			pid = rec.terminal?.processId;
		} catch {
			// processId unavailable -> we can still poll the health endpoint for the port to close
		}
		this.stopServer(modelId);
		if (typeof pid === 'number' && pid > 1) {
			await this._waitForServerGone(port, kind, pid).catch(() => undefined);
		}
	}

	/**
	 * Cancels an in-flight launch - a model still in its 'starting' phase (terminal spawned, weights loading)
	 * that has NOT yet been promoted into runningServers. The resident budget must be able to unload these too:
	 * a rapid model switch (select A in the picker, then select B before A finishes its ~5s startup) otherwise
	 * leaves A invisible to the count budget, so both end up running. Disposing the launch terminal tears down
	 * the process; the per-engine launch routine re-checks launch ownership (via _activeLaunchTerminals) before
	 * promoting, so a cancelled launch will not resurrect itself as a running server.
	 */
	private _cancelStartingServer(modelId: string): void {
		const terminal = this._activeLaunchTerminals.get(modelId);
		this._intentionalStops.add(modelId); // a llama onExit registered during the window must treat this as a clean stop
		this._startInFlight.delete(modelId);
		this._endStarting(modelId);
		if (terminal) {
			// Drop ownership first so the launch routine's promotion guard sees the mismatch and aborts; the
			// llama onExit handler also early-returns on the same mismatch, so no stale crash is reported.
			this._activeLaunchTerminals.delete(modelId);
			terminal.dispose();
		}
		this._log(`[LoCoPilot Runner] Cancelled in-flight launch for model ${modelId} (resident budget / single-active).`);
	}

	/**
	 * Records that a model was just used: bumps its LRU timestamp and (re)arms the idle-unload timer.
	 * Called on every request path so a model in active use is never evicted.
	 */
	private _touch(modelId: string): void {
		const running = this.runningServers.get(modelId);
		if (!running) {
			return;
		}
		running.lastUsedAt = Date.now();
		this._lastReadyModelId = modelId; // the model actively in use; "Keep current" reverts selection here
		this._armIdleTimer(modelId);
	}

	/**
	 * (Re)arms the idle-unload timer for a model. After `keepAliveMinutes` of no use the server is
	 * stopped to free RAM (Ollama-style keep-alive). A value of 0 disables auto-unload.
	 */
	private _armIdleTimer(modelId: string): void {
		const running = this.runningServers.get(modelId);
		if (!running) {
			return;
		}
		if (running.foreign) {
			return; // idle-unload is the owning window's job; we only hold a read-only handle
		}
		if (running.idleTimer) {
			clearTimeout(running.idleTimer);
			running.idleTimer = undefined;
		}
		const minutes = this.configurationService.getValue<number>(ChatConfiguration.LocopilotLocalKeepAliveMinutes);
		const ms = (typeof minutes === 'number' && minutes > 0) ? minutes * 60_000 : 0;
		if (ms <= 0) {
			return; // never auto-unload
		}
		running.idleTimer = setTimeout(() => {
			const still = this.runningServers.get(modelId);
			if (still && Date.now() - still.lastUsedAt >= ms) {
				this._log(`[LoCoPilot Runner] Unloading idle model ${modelId} after ${minutes} min of inactivity.`);
				this.stopServer(modelId);
			}
		}, ms);
	}

	/**
	 * Maximum number of local servers to keep resident at once. `singleActiveModel` (off by default) forces 1
	 * for users who opt into the old single-model behavior; otherwise the `maxResidentModels` budget (default 1) applies.
	 */
	private _maxResidentModels(): number {
		const singleActive = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLocalSingleActiveModel) !== false;
		if (singleActive) {
			return 1;
		}
		const configured = this.configurationService.getValue<number>(ChatConfiguration.LocopilotLocalMaxResidentModels);
		return (typeof configured === 'number' && configured >= 1) ? Math.floor(configured) : 1;
	}

	/**
	 * Enforces the resident-model budget before starting `keepModelId`: while making room would exceed the
	 * limit, evicts the least-recently-used *other* server. This replaces the old "stop everything on switch"
	 * behavior so switching back to a recently-used model is instant (no reload) while RAM stays bounded.
	 *
	 * Two budgets are combined (an "other" is evicted, oldest first, while ANY is violated):
	 *  1. The {@link _maxResidentModels} count (hard upper bound, always applied).
	 *  2. A memory budget (Apple Silicon / CPU backends only, where weights live in system RAM): the estimated
	 *     resident footprint of all loaded models must fit within `memoryBudgetFraction` of total RAM AND must
	 *     not drive free RAM below the `minFreeMemoryGB` floor. Discrete-GPU backends (CUDA/Vulkan) keep weights
	 *     in VRAM, which we can't reliably size from here, so they rely on the count budget alone.
	 *
	 * Always keeps at least the incoming model's slot free; never evicts `keepModelId`.
	 */
	private async _enforceResidentBudget(keepModelId: string): Promise<void> {
		const max = this._maxResidentModels();

		// Cross-engine guard (applied before the count/memory budget, regardless of either): llama.cpp and
		// mlx-lm both keep weights in the SAME unified memory on Apple Silicon, and our per-model footprint
		// estimate can't fully capture each engine's runtime cost (KV cache, llama's prompt cache, speculative
		// draft). Running two different engines at once is the most common path to an out-of-memory abort on a
		// model switch, so always unload resident servers of a *different* engine kind than the incoming model.
		const keepKind = await this._intendedServerKind(keepModelId);
		for (const [id, rec] of Array.from(this.runningServers.entries())) {
			if (id !== keepModelId && rec.kind !== keepKind) {
				this._log(`[LoCoPilot Runner] Cross-engine switch: evicting ${rec.kind} server ${id} before starting ${keepKind} model ${keepModelId}.`);
				await this._stopServerAndWait(id); // serialize: the two engines must never be co-resident
			}
		}
		// Same cross-engine guard for launches still in their 'starting' phase (not yet in runningServers).
		// Without this, selecting a second model before the first finished loading would let two engines come
		// up at once - the most common path to an out-of-memory abort on a switch.
		for (const id of Array.from(this.startingServers)) {
			if (id === keepModelId) {
				continue;
			}
			const kind = await this._intendedServerKind(id);
			if (kind !== keepKind) {
				this._log(`[LoCoPilot Runner] Cross-engine switch: cancelling in-flight ${kind} launch ${id} before starting ${keepKind} model ${keepModelId}.`);
				this._cancelStartingServer(id);
			}
		}

		// We are about to add keepModelId, so the others may occupy at most max-1 slots.
		const evictable = () => Array.from(this.runningServers.entries())
			.filter(([id]) => id !== keepModelId)
			.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt); // oldest first

		// --- Memory budget inputs (best-effort; absent on web or when stats are unavailable) ---
		// Use the LIVE availableBytes snapshot (free + reclaimable), NOT raw os.freemem(): on macOS freemem is
		// wildly pessimistic (~1-3 GB while 9 GB is truly available), so the old freemem-based floor check was
		// almost always "violated" and would over-evict the moment maxResidentModels > 1. This keeps eviction
		// reasoning from the SAME number as the launch gate (_memoryAllowsLaunch) instead of a stricter one.
		const memInfo = this._useMemoryBudget() ? await this._getMemoryStatus() : undefined;
		let cap = Number.POSITIVE_INFINITY;     // max total resident bytes allowed
		let floor = 0;                          // min free bytes to preserve
		let newCost = 0;                        // estimated footprint of the model we are about to load
		const otherCost = new Map<string, number>(); // estimated footprint of each currently-running model
		if (memInfo) {
			const fraction = this.configurationService.getValue<number>(ChatConfiguration.LocopilotLocalMemoryBudgetFraction);
			const minFreeGb = this.configurationService.getValue<number>(ChatConfiguration.LocopilotLocalMinFreeMemoryGB);
			cap = (typeof fraction === 'number' && fraction > 0 ? fraction : 0.7) * memInfo.totalBytes;
			floor = (typeof minFreeGb === 'number' && minFreeGb > 0 ? minFreeGb : 0) * 1024 * 1024 * 1024;
			newCost = await this._estimateModelCost(keepModelId);
			for (const [id] of this.runningServers) {
				if (id !== keepModelId) {
					otherCost.set(id, await this._estimateModelCost(id));
				}
			}
		}

		let freedBytes = 0; // memory reclaimed by evictions so far (added back to the free estimate)
		const memoryViolated = (others: [string, unknown][]): boolean => {
			if (!memInfo) {
				return false;
			}
			const residentOther = others.reduce((sum, [id]) => sum + (otherCost.get(id) ?? 0), 0);
			const totalAfter = residentOther + newCost;
			const freeAfter = memInfo.availableBytes + freedBytes - newCost;
			return totalAfter > cap || freeAfter < floor;
		};

		let others = evictable();
		// Keep evicting the LRU "other" while either budget is exceeded, but never evict the last remaining
		// slot we need for keepModelId (loop naturally stops when others is empty).
		while (others.length > 0 && (others.length > Math.max(0, max - 1) || memoryViolated(others))) {
			const [lruId] = others[0];
			const reason = others.length > Math.max(0, max - 1) ? `count budget (${max})` : 'memory budget';
			this._log(`[LoCoPilot Runner] Resident ${reason} reached; evicting LRU model ${lruId}.`);
			freedBytes += otherCost.get(lruId) ?? 0;
			// Wait for the evicted process to actually release its RAM before the loop re-checks the budget
			// (and before the caller launches keepModelId): otherwise the freed weights are still resident and
			// the replacement load spikes memory into a switch OOM. See _stopServerAndWait.
			await this._stopServerAndWait(lruId);
			others = evictable();
		}

		// In-flight launches (still 'starting', not yet promoted to runningServers) also occupy a slot against
		// the count budget. This is the actual cause of "I selected one model, then another, and both run": the
		// second launch's budget check ran while the first was still in its startup window, so runningServers
		// looked empty and nothing was evicted. Cancel any *other* still-starting launches that would push the
		// committed total (resident others + starting others + the incoming model) over the count budget.
		const residentOtherCount = () => Array.from(this.runningServers.keys()).filter(id => id !== keepModelId).length;
		const startingOthers = Array.from(this.startingServers).filter(id => id !== keepModelId);
		while (startingOthers.length > 0 && residentOtherCount() + startingOthers.length + 1 > max) {
			const victim = startingOthers.pop()!;
			this._log(`[LoCoPilot Runner] Resident count budget (${max}) reached; cancelling in-flight launch ${victim}.`);
			this._cancelStartingServer(victim);
		}
	}

	/**
	 * True when the memory-aware budget should be consulted: only on backends that keep weights in system RAM
	 * (Metal on Apple Silicon, or CPU). CUDA/Vulkan keep weights in VRAM, which we can't size reliably here, so
	 * those fall back to the count budget alone.
	 */
	private _useMemoryBudget(): boolean {
		const backend = this.getBackend();
		return backend === 'metal' || backend === 'cpu';
	}

	/**
	 * Extra RESIDENT bytes an MLX launch commits beyond weights+KV, so the fit gates reserve for them the same
	 * way the llama.cpp path reserves for its MTP/draft/mmproj extras (the two engines must reason alike - Q4).
	 * MLX auto-tune pins a cross-request prompt cache at ~15% of total RAM (mirrors `promptCacheBytes` in
	 * {@link _startMlxServerInTerminal}); the paired speculative draft is NOT included here because it is loaded
	 * only after its own {@link _extrasFitBudget} check at launch. Returns 0 when auto-tune is off / unsupported.
	 */
	private _mlxRuntimeReserveBytes(totalMemBytes: number): number {
		const autoTune = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotMlxAutoTune) !== false
			&& !this._mlxExtraFlagsUnsupported;
		if (!autoTune || !(totalMemBytes > 0)) {
			return 0;
		}
		return Math.floor(totalMemBytes * 0.15);
	}

	/** Reads total/free system RAM via the native host. Returns undefined on web or if the query fails. */
	private async _getSystemMemory(): Promise<{ totalmem: number; freemem: number } | undefined> {
		try {
			return await this.instantiationService.invokeFunction(async (accessor) => {
				const native = accessor.get(INativeHostService);
				const stats = await native.getOSStatistics();
				return { totalmem: stats.totalmem, freemem: stats.freemem };
			});
		} catch {
			return undefined; // no native host (web), or stats unavailable -> skip the memory budget
		}
	}

	/**
	 * LIVE memory snapshot (total, AVAILABLE = free + reclaimable, pressure, swap) from the shared-process
	 * system-info service. Unlike `_getSystemMemory` (raw os.freemem, misleadingly low on macOS/Linux) this
	 * is the figure launch decisions and the watchdog may trust. `maxAgeMs` > 0 accepts a recent cached
	 * snapshot (UI/scoring callers); 0 forces a fresh probe (launch gate, watchdog). Undefined on web or
	 * when the probe fails - callers must then skip availability reasoning, never block on it.
	 */
	private async _getMemoryStatus(maxAgeMs = 0): Promise<IMemoryStatus | undefined> {
		if (this._lastMemoryStatus && maxAgeMs > 0 && Date.now() - this._lastMemoryStatusAt <= maxAgeMs) {
			return this._lastMemoryStatus;
		}
		if (!this._memoryStatusInFlight) {
			this._memoryStatusInFlight = this.instantiationService.invokeFunction(async (accessor) => {
				try {
					const status = await accessor.get(ILoCoPilotSystemInfoService).getMemoryStatus();
					if (status.totalBytes > 0 && status.availableBytes > 0) {
						const prevAvailable = this._lastMemoryStatus?.availableBytes;
						this._lastMemoryStatus = status;
						this._lastMemoryStatusAt = Date.now();
						// Notify Auto-label consumers when available RAM shifts enough to plausibly change which
						// model Auto resolves to (>~0.25 GB). Threshold keeps idle probe jitter from churning the UI.
						if (prevAvailable === undefined || Math.abs(status.availableBytes - prevAvailable) > 0.25 * 1024 ** 3) {
							this._onDidAvailableRamChange.fire();
						}
						return status;
					}
					return undefined;
				} catch {
					return undefined; // service not registered (web) or probe failed
				} finally {
					this._memoryStatusInFlight = undefined;
				}
			});
		}
		return this._memoryStatusInFlight;
	}

	/**
	 * The engine a model will (or does) run under. Reuses the running server's kind when up; otherwise mirrors
	 * the selection in _doStartServerInTerminal (MLX for Apple-Silicon HF models whose weights look like MLX,
	 * llama.cpp otherwise) so the budget can reason about a not-yet-started model.
	 */
	private async _intendedServerKind(modelId: string): Promise<'llama' | 'mlx'> {
		const running = this.runningServers.get(modelId);
		if (running) {
			return running.kind;
		}
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (model?.provider === 'huggingface' && model.localPath && isAppleSiliconMac()) {
			const hasGguf = await this.pathResolvesToGguf(model.localPath);
			if (shouldUseMlxServerForHfModel(model, hasGguf, true)) {
				return 'mlx';
			}
		}
		return 'llama';
	}

	/**
	 * KV-cache bytes for `ctxTokens` of context, derived from the model's REAL attention geometry (kv heads x
	 * head dim x layers, at f16 k+v) so the footprint estimate, the pre-flight fit gate, and the context clamp
	 * all size the KV cache the SAME way. Best-effort: for MLX (no GGUF to probe) or when the GGUF can't be
	 * parsed, falls back to a conservative flat ~128 KiB/token that covers a typical 7-13B model.
	 */
	private async _kvBytesForContext(localPath: string, kind: 'llama' | 'mlx', ctxTokens: number): Promise<number> {
		const FALLBACK_BYTES_PER_TOKEN = 128 * 1024;
		if (kind === 'llama') {
			try {
				const filePath = await this.resolveModelFilePath(localPath);
				const info = await this._getModelInfo(filePath);
				const perTokenPerLayer = kvBytesPerTokenPerLayer(info, 2); // f16 k+v; conservative for a budget
				const layers = info.layerCount && info.layerCount > 0 ? info.layerCount : 32;
				if (perTokenPerLayer && perTokenPerLayer > 0) {
					return ctxTokens * perTokenPerLayer * layers;
				}
			} catch {
				// fall through to the flat fallback below
			}
		}
		return ctxTokens * FALLBACK_BYTES_PER_TOKEN;
	}

	/**
	 * Estimates a model's *resident* memory footprint in bytes - honestly, not just weights. Adds the runtime
	 * cost the old `weights * 1.2` heuristic ignored, which is exactly what let two models "fit" on paper and
	 * then OOM in practice:
	 *  - KV cache: sized from the model's real attention geometry (shared with the fit gate / context clamp).
	 *  - llama.cpp prompt cache: the server reserves a sizeable host-RAM prompt cache (`--cache-ram`).
	 *  - speculative draft: a SEPARATE draft model adds its (small) file; an MTP self-draft shares the mmap'd
	 *    weights and only adds a small KV/context slice - NOT another weights-worth (see the MTP branch).
	 * Weight bytes are cached per model (they don't change); the runtime terms are cheap to recompute.
	 * Returns 0 when the weight size can't be determined (e.g. Ollama), so an unknown model never blocks a load.
	 */
	private async _estimateModelCost(modelId: string): Promise<number> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.localPath || model.provider === 'ollama') {
			this._modelSizeCache.set(modelId, 0);
			this._modelCostCache.set(modelId, 0);
			return 0;
		}
		let weightBytes = this._modelSizeCache.get(modelId);
		if (weightBytes === undefined) {
			weightBytes = await this._weightBytesOnDisk(model.localPath);
			this._modelSizeCache.set(modelId, weightBytes);
		}
		if (weightBytes === 0) {
			this._modelCostCache.set(modelId, 0);
			return 0; // unknown weight size -> don't let the budget block this load
		}

		const kind = await this._intendedServerKind(modelId);
		// Context window the engine will actually allocate KV for (clamped like the launch path does).
		const ctxTokens = Math.max(
			MIN_CLAMPED_CONTEXT,
			model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_LLAMA_CONTEXT_SIZE
		);
		const GB = 1024 * 1024 * 1024;
		// KV cache: sized from the model's REAL attention geometry (same source the pre-flight fit gate and the
		// context clamp use), so this estimate and those gates agree instead of drifting apart. Falls back to a
		// conservative ~128 KiB/token (a typical 7-13B f16 k+v across all layers) when the GGUF can't be parsed.
		let runtime = await this._kvBytesForContext(model.localPath, kind, ctxTokens);
		if (kind === 'llama') {
			runtime += 2 * GB; // conservative slice of llama.cpp's host-RAM prompt cache (default --cache-ram 8 GiB).
			const tuning = this._getLlamaTuning(model);
			const sepDraft = tuning.draftModelPath?.trim();
			if (tuning.multiTokenPrediction) {
				// MTP self-draft points `--model-draft` at the SAME GGUF, which llama.cpp mmaps - the weight pages
				// are SHARED with the main model, so there is no second full copy in RSS. The real added cost is
				// the draft decode path's small KV/context, not another weights-worth. The old `+= weightBytes`
				// doubled a 20 GB MTP model to ~40 GB, which over-evicted AND - since this same figure feeds the
				// "evictable" reclaim estimate - made Auto believe unloading it frees ~2x the RAM it actually does.
				runtime += Math.min(weightBytes * 0.1, GB); // draft KV/context slack, never a whole weights copy.
			} else if (sepDraft) {
				// A separate draft costs its own (much smaller) file; full weights only when it can't be statted.
				runtime += (await this._fileBytes(sepDraft)) || weightBytes;
			} else {
				// Auto-paired draft (enabled at launch when downloaded + fits): count it when it's on disk.
				// triggerFetch=false: cost estimation must never kick off a download.
				const draft = await this._resolvePairedDraft(model, 'gguf', false).catch(() => undefined);
				if (draft) {
					runtime += draft.bytes;
				}
			}
			// The mmproj projector is only loaded when vision is explicitly enabled (see customModelVisionEnabled).
			if (model.localPath && customModelVisionEnabled(model)) {
				const mmprojPath = await this.resolveMmprojPath(model.localPath);
				if (mmprojPath) {
					runtime += await this._fileBytes(mmprojPath);
				}
			}
		}
		const cost = weightBytes + runtime;
		this._modelCostCache.set(modelId, cost); // let the sync prospective-RAM path reuse the full estimate (Q1)
		return cost;
	}

	/** Sums the on-disk size of a model's weights: the .gguf file, or every file in an MLX/sharded directory. */
	private async _weightBytesOnDisk(localPath: string): Promise<number> {
		try {
			const uri = URI.file(localPath);
			const stat = await this.fileService.stat(uri);
			if (stat.isFile) {
				return stat.size ?? 0;
			}
			if (stat.isDirectory) {
				const resolved = await this.fileService.resolve(uri, { resolveMetadata: true });
				return (resolved.children ?? []).reduce((sum, c) => sum + (c.isFile ? (c.size ?? 0) : 0), 0);
			}
		} catch {
			// path missing / unreadable -> treat as unknown (0), so it never blocks a load
		}
		return 0;
	}

	/** Size in bytes of a single file (e.g. the mmproj projector), or 0 when missing/unreadable. */
	private async _fileBytes(filePath: string): Promise<number> {
		try {
			const stat = await this.fileService.stat(URI.file(filePath));
			return stat.isFile ? (stat.size ?? 0) : 0;
		} catch {
			return 0;
		}
	}

	stopManagedServers(exceptModelId?: string): void {
		for (const modelId of Array.from(this.runningServers.keys())) {
			if (modelId !== exceptModelId) {
				this.stopServer(modelId);
			}
		}
	}

	/**
	 * Command and args to run the llama.cpp server for the given model.
	 * Caller can run this in a terminal or via a process spawner.
	 * Uses locopilot.llamaCpp.serverPath when set (works on Mac, Windows, Linux).
	 */
	getServerRunConfig(modelId: string): { command: string; args: string[]; backend: LlamaBackend } | undefined {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.localPath) {
			return undefined;
		}
		const serverPath = this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath);
		const backend = getRecommendedBackend(!!serverPath?.trim());
		const { command, args } = getLlamaCppServerCommand(model.localPath, backend, serverPath, LOCOPILOT_LLAMA_SERVER_PORT, this._getLlamaTuning(model));
		return { command, args, backend };
	}

	/**
	 * Environment additions so the dynamic loader finds the shared libraries that ship next to the
	 * bundled llama-server (libllama/libggml/...). The binary already has an @loader_path rpath on
	 * macOS and Windows searches the exe's own directory, but we set the platform library-path vars
	 * too as belt-and-suspenders - especially for user-supplied builds whose libs sit in a sibling
	 * dir. `strictEnv` is left false so this merges over the inherited VS Code environment.
	 */
	private _serverLaunchEnv(serverPath: string): { [key: string]: string | null } | undefined {
		const dir = dirname(serverPath);
		if (!dir) { return undefined; }
		if (isMacintosh) { return { DYLD_LIBRARY_PATH: dir }; }
		if (isWindows) { return undefined; } // Windows loads DLLs from the exe's own directory automatically.
		return { LD_LIBRARY_PATH: dir };
	}

	/**
	 * Reports a llama-server process that exited before becoming ready (i.e. crashed at launch). Builds
	 * a concrete, platform-specific message - the usual culprit on Windows is a missing Microsoft Visual
	 * C++ Redistributable, and on Linux a missing system library - then logs it, fires the failure event,
	 * and shows an actionable notification so the user isn't left staring at a stuck "running" state.
	 */
	private async _reportServerCrash(modelId: string, modelName: string, exitCode: number | undefined, logs: string[]): Promise<void> {
		// Use a generous tail: the real fatal line is often the very last thing the engine prints, and a short
		// window can scroll it off behind startup banners (device_info, system_info, tokenizer warnings, etc.).
		const tail = logs.slice(-60).join('\n');
		const code = exitCode ?? 'unknown';
		this._log(`[LoCoPilot Runner] llama-server for "${modelName}" exited before serving (exit ${code}). Last output:\n${tail}`);

		// Self-healing for --cache-ram: an older build rejects the flag by name at argument parsing. Checked
		// BEFORE the generic spec-flag heuristic because that regex also matches "invalid argument" - without
		// the name check a cache-ram rejection would wrongly disable speculation (and then crash again).
		const cacheRamRejected = /cache-ram/i.test(tail) && /invalid argument|unrecognized (?:argument|option)|unknown (?:argument|option)/i.test(tail);
		if (this._launchedWithCacheRam.has(modelId) && !this._cacheRamUnsupported && cacheRamRejected) {
			this._cacheRamUnsupported = true;
			this._launchedWithCacheRam.delete(modelId);
			this._log(`[LoCoPilot Runner] llama-server rejected --cache-ram (older build); skipping the prompt-cache cap for this session and relaunching "${modelName}" without it.`);
			this._endStarting(modelId);
			timeout(6000).then(() => {
				if (!this.runningServers.has(modelId) && !this.startingServers.has(modelId)) {
					this.startServerInTerminal(modelId).catch(e => this._log(`[LoCoPilot Runner] Relaunch without --cache-ram failed: ${e}`));
				}
			});
			return;
		}

		// Self-healing for --swa-full: an older build rejects the flag by name at argument parsing. Checked
		// (like --cache-ram) BEFORE the generic spec-flag heuristic, whose regex also matches "invalid
		// argument" - without the name check a swa-full rejection would wrongly disable speculation instead.
		const swaFullRejected = /swa-full/i.test(tail) && /invalid argument|unrecognized (?:argument|option)|unknown (?:argument|option)/i.test(tail);
		if (this._launchedWithSwaFull.has(modelId) && !this._swaFullUnsupported && swaFullRejected) {
			this._swaFullUnsupported = true;
			this._launchedWithSwaFull.delete(modelId);
			this._log(`[LoCoPilot Runner] llama-server rejected --swa-full (older build); skipping it for this session and relaunching "${modelName}" without it.`);
			this._endStarting(modelId);
			timeout(6000).then(() => {
				if (!this.runningServers.has(modelId) && !this.startingServers.has(modelId)) {
					this.startServerInTerminal(modelId).catch(e => this._log(`[LoCoPilot Runner] Relaunch without --swa-full failed: ${e}`));
				}
			});
			return;
		}

		// Self-healing for speculative decoding: when THIS launch carried spec flags and the output shows the
		// build rejected them (old build without --spec-type) or the draft/target pair is incompatible
		// (tokenizer mismatch), disable speculation for the session and retry once WITHOUT the flags instead
		// of surfacing a scary crash for something that runs fine unspeculated.
		const specRejected = /invalid argument|unrecognized (?:argument|option)|unknown (?:argument|option)|not compatible with the target model|draft.*vocab|vocab.*draft/i.test(tail);
		if (this._launchedWithSpecFlags.has(modelId) && !this._specFlagsUnsupported && specRejected) {
			this._specFlagsUnsupported = true;
			this._launchedWithSpecFlags.delete(modelId);
			this._log(`[LoCoPilot Runner] llama-server rejected the speculative-decoding flags; disabling speculation for this session and relaunching "${modelName}" without it.`);
			this._endStarting(modelId);
			// Wait out the original launch's in-flight window (its startup wait may still be pending) so the
			// retry starts a genuinely fresh launch instead of being coalesced into the crashed one.
			timeout(6000).then(() => {
				if (!this.runningServers.has(modelId) && !this.startingServers.has(modelId)) {
					this.startServerInTerminal(modelId).catch(e => this._log(`[LoCoPilot Runner] Relaunch without speculation failed: ${e}`));
				}
			});
			return;
		}

		// OOM degradation ladder (Ollama-style): a launch that died because memory ran out is not a bug to
		// report, it's a footprint to shrink. Instead of surfacing a scary crash, retry with progressively
		// smaller memory demands - attempt 1: halve the context window and strip the memory-heavy extras
		// (MTP self-draft / separate draft model); attempt 2: floor the context at the minimum. The caps are
		// per-model per-session; only after both attempts still OOM does the user see an actionable error.
		const oomCrash = /out of memory|outofmemory|failed to allocate|unable to allocate|cudamalloc failed|kiogpucommandbuffercallbackerroroutofmemory|insufficient memory|not enough (?:memory|space)|ggml_backend.*buffer.*(?:fail|null)|std::bad_alloc/i.test(tail);
		if (oomCrash) {
			const attempts = this._oomRetryCount.get(modelId) ?? 0;
			if (attempts < 2) {
				this._oomRetryCount.set(modelId, attempts + 1);
				const lastCtx = this._lastLaunchContext.get(modelId) ?? DEFAULT_LLAMA_CONTEXT_SIZE;
				const newCap = attempts === 0
					? Math.max(MIN_CLAMPED_CONTEXT, Math.floor(lastCtx / 2 / 1024) * 1024)
					: MIN_CLAMPED_CONTEXT;
				this._oomContextCap.set(modelId, newCap);
				this._oomStripExtras.add(modelId);
				this._log(`[LoCoPilot Runner] "${modelName}" ran out of memory (attempt ${attempts + 1}/2); relaunching with context capped at ${newCap} and speculative extras stripped.`);
				this._endStarting(modelId);
				timeout(6000).then(() => {
					if (!this.runningServers.has(modelId) && !this.startingServers.has(modelId)) {
						this.startServerInTerminal(modelId).catch(e => this._log(`[LoCoPilot Runner] OOM-degraded relaunch failed: ${e}`));
					}
				});
				return;
			}
			// Both degraded attempts still OOM-ed: this model genuinely doesn't fit right now. Be honest
			// and specific instead of the generic "couldn't start" message.
			const oomMessage = `"${modelName}" ran out of memory while loading, even with reduced settings. Close some applications to free up memory, or choose a smaller model.`;
			this._endStarting(modelId, oomMessage);
			this.notificationService.notify({ severity: Severity.Error, message: oomMessage });
			return;
		}

		const actions: { label: string; run: () => void }[] = [];

		// Keep the user-facing wording friendly and free of internal details (engine names, settings keys,
		// file paths). The full diagnostic output is always written to the logs above and reachable via the
		// "Show Logs" action below; the toast just needs to say it failed and that retrying / contacting
		// support is the next step.
		const message = `Couldn't start the local model "${modelName}". Please try again - if it keeps happening, restart LoCoPilot or contact LoCoPilot support.`;

		actions.push({ label: 'Show Logs', run: () => this.commandService.executeCommand('workbench.action.toggleDevTools') });

		this._endStarting(modelId, message);
		this.notificationService.prompt(Severity.Error, message, actions);
	}

	/**
	 * Reads llama.cpp performance settings. All values default to safe, self-falling-back behavior:
	 * flash attention 'auto', KV cache 'f16', MTP/mlock off.
	 * MTP is per-model first (the model's own toggle), then the global setting as a fallback default.
	 */
	private _getLlamaTuning(model?: ICustomLanguageModel): LlamaServerTuning {
		const cfg = this.configurationService;
		const perModelMtp = model?.mtp;
		const globalMtp = cfg.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppMtp);
		// Context window is per-model first (the model's own contextWindow, set or auto-derived from the
		// GGUF), then the global setting, which itself defaults to DEFAULT_LLAMA_CONTEXT_SIZE. This way a
		// long-context model gets a matching `-c` instead of every model sharing one global window.
		const perModelContext = model?.contextWindow && model.contextWindow > 0 ? model.contextWindow : undefined;
		return {
			contextSize: perModelContext ?? cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppContextSize),
			flashAttention: cfg.getValue<FlashAttentionMode>(ChatConfiguration.LocopilotLlamaCppFlashAttention),
			kvCacheType: cfg.getValue<KvCacheType>(ChatConfiguration.LocopilotLlamaCppKvCacheType),
			multiTokenPrediction: perModelMtp !== undefined ? perModelMtp : globalMtp,
			mtpArgs: cfg.getValue<string>(ChatConfiguration.LocopilotLlamaCppMtpArgs),
			cacheReuse: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppCacheReuse),
			draftModelPath: cfg.getValue<string>(ChatConfiguration.LocopilotLlamaCppDraftModelPath),
			draftGpuLayers: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppDraftGpuLayers),
			parallelSlots: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppParallel),
			continuousBatching: cfg.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppContinuousBatching),
			threads: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppThreads),
			batchSize: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppBatchSize),
			ubatchSize: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppUbatchSize),
			// MoE offload: a negative value means "auto" (left undefined so _augmentTuningWithHardware sizes it
			// from the GGUF expert count + memory budget); 0 or more is an explicit user override.
			cpuMoeLayers: (() => {
				const v = cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppCpuMoeLayers);
				return typeof v === 'number' && v >= 0 ? Math.floor(v) : undefined;
			})(),
			promptLookup: cfg.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppPromptLookup),
			promptLookupArgs: cfg.getValue<string>(ChatConfiguration.LocopilotLlamaCppPromptLookupArgs),
			// Default to our managed KV-cache dir (created lazily before launch) so slot save/restore works
			// out of the box for cross-session prefix reuse; an explicit user path still wins.
			slotSavePath: cfg.getValue<string>(ChatConfiguration.LocopilotLlamaCppSlotSavePath)?.trim() || this._kvCacheDir().fsPath,
			mlock: cfg.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppMlock),
			extraArgs: cfg.getValue<string>(ChatConfiguration.LocopilotLlamaCppExtraArgs),
		};
	}

	/**
	 * Probes (once, cached) the host hardware - CPU core counts and GPU VRAM - via the shared-process
	 * system-info service. Returns undefined on web or when the service is unavailable, so callers degrade
	 * gracefully to llama.cpp's own auto-detection.
	 */
	private _getHardwareInfo(): Promise<ISystemHardwareInfo | undefined> {
		if (!this._hardwareInfo) {
			this._hardwareInfo = this.instantiationService.invokeFunction(async (accessor) => {
				try {
					return await accessor.get(ILoCoPilotSystemInfoService).getHardwareInfo();
				} catch {
					return undefined; // service not registered (web) or probe failed
				}
			});
		}
		return this._hardwareInfo;
	}

	/** Reads (and caches) GGUF model info (layer/expert count, context length) for a resolved file path. */
	private async _getModelInfo(modelPath: string): Promise<IGgufModelInfo> {
		const cached = this._modelInfoCache.get(modelPath);
		if (cached) {
			return cached;
		}
		const info = await readGgufModelInfo(this.fileService, modelPath, e => this._log(`[LoCoPilot Runner] GGUF metadata parse aborted for "${modelPath}": ${e}`));
		this._log(`[LoCoPilot Runner] GGUF metadata for "${modelPath}": layers=${info.layerCount ?? '?'}, ctx=${info.contextLength ?? '?'}, experts=${info.expertCount ?? '?'}, slidingWindow=${info.slidingWindow ?? 'none'}.`);
		this._modelInfoCache.set(modelPath, info);
		return info;
	}

	/**
	 * Memory budget (bytes) the weights may use on a given backend, or undefined when unknown:
	 *  - discrete GPU (cuda/vulkan): the largest detected dedicated VRAM pool (any vendor).
	 *  - metal (Apple Silicon): the unified-memory WIRED ceiling ({@link metalOffloadBudgetBytes}), i.e. a
	 *    fraction of total RAM - NOT raw total. macOS caps a Metal app's working set at ~70% of RAM; sizing
	 *    the offload/KV budget off raw total (the old bug) let us wire weights + a large KV past that limit,
	 *    which paged to SSD and hung/overheated the machine into a thermal shutdown.
	 *  - cpu: the usable system-RAM budget ({@link usableSystemMemoryBytes}). Weights and KV live in system
	 *    RAM here, so without a budget the context clamp never ran on CPU backends and a user-set long
	 *    context could allocate an unclamped KV cache straight into swap. Eviction still handles pressure
	 *    from OTHER models; this budget sizes the KV of the one being launched.
	 */
	private async _memoryBudgetBytes(backend: LlamaBackend, hw: ISystemHardwareInfo): Promise<number | undefined> {
		if (backend === 'cuda' || backend === 'vulkan') {
			const vram = hw.gpus.map(g => g.totalVramBytes).filter(v => v > 0);
			return vram.length ? Math.max(...vram) : undefined;
		}
		const mem = await this._getSystemMemory();
		if (!mem?.totalmem) {
			return undefined;
		}
		const budget = backend === 'metal' ? metalOffloadBudgetBytes(mem.totalmem, hw.metalWiredLimitBytes) : usableSystemMemoryBytes(mem.totalmem);
		return budget > 0 ? budget : undefined;
	}

	/**
	 * Augments the base (settings-derived) tuning with hardware-aware values that the user hasn't pinned:
	 *  - `--threads`: defaults to the machine's physical (performance) core count (faster than llama.cpp's
	 *    hyperthread-counting auto-detect on hybrid CPUs). Skipped if the user set threads.
	 *  - `--n-cpu-moe`: for Mixture-of-Experts models larger than the memory budget, offloads expert tensors
	 *    of as many blocks as needed to system RAM so the model fits a small GPU at near-full speed (#1).
	 *  - `--n-gpu-layers`: for *dense* models larger than VRAM on a discrete GPU, offloads only the layers
	 *    that fit instead of an all-or-nothing full offload that would OOM the GPU.
	 *  - context clamp: caps `-c` to the model's trained window and to what the KV-cache budget can hold (#5).
	 *  - `-b`/`-ub`: sensible prefill batch defaults on GPU backends for faster time-to-first-token (#7).
	 *
	 * All steps are best-effort: any missing data leaves the base tuning untouched.
	 */
	private async _augmentTuningWithHardware(modelPath: string, backend: LlamaBackend, base: LlamaServerTuning, extraResidentBytes: number = 0): Promise<LlamaServerTuning> {
		const hw = await this._getHardwareInfo();
		if (!hw) {
			return base;
		}
		const tuning: LlamaServerTuning = { ...base };

		// Thread auto-tuning: only when the user left it on auto (0/unset).
		if ((!tuning.threads || tuning.threads <= 0) && hw.physicalCoreCount > 0) {
			tuning.threads = hw.physicalCoreCount;
			this._log(`[LoCoPilot Runner] Auto-set --threads to ${hw.physicalCoreCount} (physical cores).`);
		}

		const info = await this._getModelInfo(modelPath);
		const rawBudget = await this._memoryBudgetBytes(backend, hw);
		// Reserve for co-resident allocations the main weights+KV split below does NOT otherwise see: a draft/
		// MTP model (a second copy of the weights) and the mmproj projector. Without this, the offload and the
		// context clamp size themselves as if those extras were free, then overflow the device at decode.
		const budget = rawBudget !== undefined ? Math.max(0, rawBudget - Math.max(0, extraResidentBytes)) : undefined;
		if (rawBudget !== undefined && extraResidentBytes > 0) {
			this._log(`[LoCoPilot Runner] Reserving ~${Math.round(extraResidentBytes / 1e9)}GB for draft/projector; weights+KV budget ${Math.round(rawBudget / 1e9)}GB -> ${Math.round((budget ?? 0) / 1e9)}GB.`);
		}

		// #1 MoE expert offload vs dense partial GPU offload. These are mutually exclusive: a MoE model uses
		// --n-cpu-moe (keep attention on GPU, experts on CPU); a dense model uses --n-gpu-layers.
		// Size the offload off the budget MINUS the KV reserve: weights and the KV cache share the same
		// device memory, so a model whose weights nearly fill the budget must still offload enough to leave
		// room for KV - otherwise we wire full weights PLUS a large KV past the limit and page/OOM.
		const modelBytes = await this._weightBytesOnDisk(modelPath);
		const offloadBudget = budget && budget > 0 ? Math.floor(budget * (1 - KV_BUDGET_FRACTION)) : 0;
		if (backend !== 'cpu' && budget && budget > 0) {
			if (isMoeModelInfo(info) && tuning.cpuMoeLayers === undefined) {
				const moe = computeCpuMoeLayers({ backend, modelBytes, layerCount: info.layerCount, expertCount: info.expertCount, memoryBudgetBytes: offloadBudget });
				if (moe !== undefined) {
					tuning.cpuMoeLayers = moe;
					this._log(`[LoCoPilot Runner] MoE model (${Math.round(modelBytes / 1e9)}GB, ${info.expertCount} experts) exceeds the ${Math.round(offloadBudget / 1e9)}GB weight budget; offloading experts of ${moe}/${info.layerCount} blocks to CPU (--n-cpu-moe).`);
				}
			} else if (!isMoeModelInfo(info) && tuning.gpuLayers === undefined && (backend === 'cuda' || backend === 'vulkan')) {
				const layers = computeGpuLayers({ backend, modelBytes, layerCount: info.layerCount, vramBytes: offloadBudget });
				if (layers !== undefined) {
					tuning.gpuLayers = layers;
					this._log(`[LoCoPilot Runner] Dense model (${Math.round(modelBytes / 1e9)}GB) exceeds the ${Math.round(offloadBudget / 1e9)}GB VRAM weight budget; offloading ${layers}/${info.layerCount} layers to GPU, rest on CPU.`);
				}
			}
		}

		// #5 Context clamp: never request more than the model supports, nor more than the KV budget can hold.
		// The KV allowance is weight-aware (computeKvBudgetBytes): at most KV_BUDGET_FRACTION of the budget,
		// and never more than what remains after the weights RESIDENT IN THE SAME POOL plus runtime overhead.
		// The fraction-only allowance (the old behavior) let a dense Metal model whose weights already filled
		// ~85% of the wired budget still claim a full 25% KV on top - past the ceiling, straight into paging.
		if (tuning.contextSize && tuning.contextSize > 0) {
			// Size the KV estimate at the SAME precision the server will actually allocate. 'auto' picks q8_0
			// for the default window and larger (~half the bytes of f16), so estimating at that precision lets
			// the clamp grant roughly twice the context for the same budget instead of over-clamping on an f16
			// assumption. Resolve from the requested window; getLlamaCppServerCommand re-resolves from the
			// clamped window for the actual flag (a negligible diff only right at the quant threshold).
			// Resolve the KV precision from the REQUESTED window (before the clamp shrinks it). A long-context
			// catalog model (e.g. 131K/256K) resolves to q8_0; we size the clamp at that precision AND pin it
			// below so the launch runs the same precision even after the clamp drops the window under the
			// auto-quant threshold - otherwise the server would re-resolve 'auto' to f16 and use ~2x the KV the
			// clamp budgeted (unsafe on a tight machine, and it wastes the extra window q8_0 was meant to buy).
			let resolvedKvType = resolveKvCacheType(tuning.kvCacheType ?? 'auto', tuning.contextSize);
			const kvBytesPerElem = kvCacheBytesPerElem(resolvedKvType);
			// Estimate KV bytes/token/layer from the model's attention geometry at the cache precision. When the
			// GGUF lacks the attention keys, fall back to the conservative f16 default SCALED to the precision
			// (q8_0 -> ~half), so a quantized cache actually grants ~2x the window instead of being sized as f16.
			let perTokenPerLayer = kvBytesPerTokenPerLayer(info, kvBytesPerElem)
				?? Math.round(DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 * kvBytesPerElem / 2);
			let kvBudgetBytes: number | undefined;
			if (budget && budget > 0) {
				// Discrete GPUs: partial offload caps the weights that land in VRAM at the offload budget;
				// Metal/CPU: the full weights share the one unified/system pool with the KV cache.
				const residentWeights = (backend === 'cuda' || backend === 'vulkan') ? Math.min(modelBytes, offloadBudget) : modelBytes;
				// Unknown weight size (0) degrades to the plain fraction allowance. Floor at 1 byte so a
				// zero-remainder budget still CLAMPS to the minimum context instead of skipping the clamp
				// (clampContextSize treats 0/undefined as "no budget known").
				kvBudgetBytes = modelBytes > 0
					? Math.max(1, computeKvBudgetBytes(budget, residentWeights))
					: budget * KV_CLAMP_BUDGET_FRACTION;
			}
			let clamped = clampContextSize({
				requestedContext: tuning.contextSize,
				modelContextLength: info.contextLength,
				kvBudgetBytes,
				layerCount: info.layerCount,
				kvBytesPerTokenPerLayer: perTokenPerLayer,
			});
			// Adaptive KV precision (ONLY when the user left kvCacheType on 'auto'): if q8_0 still can't reach a
			// usable window because the model's weights leave little room for KV, drop to 4-bit q4_0 - it roughly
			// halves the per-token KV cost, turning a cramped window (e.g. ~22K on a 24B/32GB) into ~1.8x that at a
			// modest quality cost. Gated on q8_0 landing BELOW the floor AND the user actually wanting more, so a
			// model that already gets a comfortable q8_0 window keeps full quality. Big models are the beneficiaries;
			// small models never reach this branch because q8_0 already clears the floor for them.
			if ((tuning.kvCacheType ?? 'auto') === 'auto' && resolvedKvType === 'q8_0'
				&& clamped < ADAPTIVE_Q4_KV_CONTEXT_FLOOR && clamped < tuning.contextSize && kvBudgetBytes && kvBudgetBytes > 0) {
				const q4BytesPerElem = kvCacheBytesPerElem('q4_0');
				const q4PerTokenPerLayer = kvBytesPerTokenPerLayer(info, q4BytesPerElem)
					?? Math.round(DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 * q4BytesPerElem / 2);
				const q4Clamped = clampContextSize({
					requestedContext: tuning.contextSize,
					modelContextLength: info.contextLength,
					kvBudgetBytes,
					layerCount: info.layerCount,
					kvBytesPerTokenPerLayer: q4PerTokenPerLayer,
				});
				if (q4Clamped > clamped) {
					this._log(`[LoCoPilot Runner] Adaptive KV: q8_0 window ${clamped} is below the ${ADAPTIVE_Q4_KV_CONTEXT_FLOOR}-token floor; switching to 4-bit q4_0 KV to reach ${q4Clamped}.`);
					resolvedKvType = 'q4_0';
					perTokenPerLayer = q4PerTokenPerLayer;
					clamped = q4Clamped;
				}
			}
			if (clamped < tuning.contextSize) {
				this._log(`[LoCoPilot Runner] Clamped context ${tuning.contextSize} -> ${clamped} to fit the model/memory budget (KV ${resolvedKvType}, ~${perTokenPerLayer} B/tok/layer).`);
				tuning.contextSize = clamped;
			}
			// Pin the precision the clamp sized for so getLlamaCppServerCommand doesn't re-resolve 'auto' from the
			// (possibly now sub-threshold) clamped window and flip to f16. No-op when the user pinned a fixed type.
			tuning.kvCacheType = resolvedKvType;
		}

		// SWA full cache: sliding-window models (Gemma 2/3) default to a window-sized KV for their SWA layers,
		// which invalidates the server's prompt-cache checkpoints and forces a full prompt re-process every
		// turn. `--swa-full` keeps the whole KV so cross-turn reuse works. Our context clamp above already
		// sized `-c` assuming full KV across ALL layers (it doesn't model the SWA reduction), so a model that
		// passed the clamp/fit gate already has room for the full cache - enabling it here is memory-consistent.
		// Setting: 'auto' (on for SWA models when we have a memory budget to reason about), 'on' (force for SWA),
		// 'off'. Skipped for the session once a build rejected the flag.
		if (tuning.swaFull === undefined && !this._swaFullUnsupported) {
			const mode = this.configurationService.getValue<'auto' | 'on' | 'off'>(ChatConfiguration.LocopilotLlamaCppSwaFull) ?? 'auto';
			// 'on' forces --swa-full even when our GGUF SWA sniff didn't fire (detection can miss newer archs like
			// gemma-4 whose sliding_window key we don't capture). llama.cpp harmlessly ignores it on non-SWA models,
			// and if a build rejects the flag by name the launch-crash fallback strips it. 'auto' still needs a
			// positively-detected SWA model + a memory budget.
			if (mode === 'on') {
				tuning.swaFull = true;
				this._log(`[LoCoPilot Runner] Forcing --swa-full (mode=on, detectedSwa=${isSwaModelInfo(info)}, window=${info.slidingWindow ?? 'n/a'}).`);
			} else if (mode === 'auto' && isSwaModelInfo(info) && budget !== undefined && budget > 0) {
				tuning.swaFull = true;
				this._log(`[LoCoPilot Runner] SWA model (window ${info.slidingWindow}); enabling --swa-full so the prompt cache survives across turns (mode=auto).`);
			}
		}

		// #2 Host prompt-cache cap: without an explicit --cache-ram the server claims up to the build default
		// (8 GiB) of host RAM for its prompt cache - far more than the footprint accounting books for it.
		// Cap it at min(2 GiB, 10% of RAM). Skipped when a build already rejected the flag this session.
		if (tuning.cacheRamMiB === undefined && !this._cacheRamUnsupported) {
			const mem = await this._getSystemMemory();
			if (mem?.totalmem && mem.totalmem > 0) {
				const MiB = 1024 * 1024;
				tuning.cacheRamMiB = Math.min(2048, Math.floor((mem.totalmem * 0.10) / MiB));
			}
		}

		// #7 Prefill batch tuning on GPU backends: a larger *physical* batch (ubatch) processes the prompt in
		// bigger chunks, which meaningfully cuts time-to-first-token on a GPU. We raise ubatch from the build
		// default (512) to 1024 - a safe bump the GPU memory comfortably absorbs, and the offload logic above
		// already keeps the model within budget. CPU is left alone (large batches don't help and cost RAM).
		// Only applied when the user hasn't pinned these.
		if (backend === 'cuda' || backend === 'vulkan' || backend === 'metal') {
			if (!tuning.batchSize || tuning.batchSize <= 0) {
				tuning.batchSize = 2048;
			}
			if (!tuning.ubatchSize || tuning.ubatchSize <= 0) {
				tuning.ubatchSize = 1024;
			}
		}

		return tuning;
	}

	/**
	 * Minimum resident footprint vs usable memory for running `modelPath` on `backend`, or undefined when a
	 * required figure (weight size, RAM stats) is unknown - callers treat undefined as "fits" so we never
	 * block or degrade a launch we can't reason about. Shared by the pre-flight fit gate and the
	 * auto-speculation draft gate, so both answer "does X more resident bytes still fit?" identically.
	 */
	private async _computeFit(modelPath: string, backend: LlamaBackend, discreteVramBytes: number | undefined, extraResidentBytes: number = 0): Promise<{ requiredBytes: number; usableBytes: number; weightBytes: number } | undefined> {
		const weightBytes = await this._weightBytesOnDisk(modelPath);
		if (weightBytes <= 0) {
			return undefined; // unknown size -> can't reason about it.
		}
		const mem = await this._getSystemMemory();
		if (!mem?.totalmem) {
			return undefined; // no RAM stats (e.g. web).
		}

		// Minimum resident footprint: weights + the smallest KV cache we'd ever allocate + a runtime slice.
		// The GGUF probe is best-effort (it does not apply to MLX directories); fall back to safe defaults.
		let info: IGgufModelInfo | undefined;
		try {
			info = await this._getModelInfo(modelPath);
		} catch {
			info = undefined;
		}
		const perTokenPerLayer = (info && kvBytesPerTokenPerLayer(info, 2)) || 4096;
		const layerCount = info?.layerCount && info.layerCount > 0 ? info.layerCount : 32;
		const kvMinBytes = MIN_CLAMPED_CONTEXT * perTokenPerLayer * layerCount;
		const runtimeOverhead = RUNTIME_OVERHEAD_BYTES; // host buffers / compute scratch; shared with the KV-budget sizing.
		// extraResidentBytes covers a draft/MTP model (a second copy of the weights) and the mmproj projector
		// when vision is enabled - both are loaded ON TOP of the weights+KV and previously went uncounted here,
		// so an MTP + vision model passed this gate and then OOM-ed the GPU at decode.
		const requiredBytes = weightBytes + kvMinBytes + runtimeOverhead + Math.max(0, extraResidentBytes);

		// Usable memory:
		//  - metal (Apple Silicon): the WIRED working-set ceiling (~70% of unified RAM). macOS caps a Metal
		//    app there; using the looser 85% system figure (the old bug) let a model clear this gate and then
		//    bust the GPU ceiling at decode (kIOGPUCommandBufferCallbackErrorOutOfMemory).
		//  - cuda/vulkan/cpu: system RAM left for inference (85%), plus discrete VRAM when weights offload to a GPU.
		const usableBytes = backend === 'metal'
			? metalOffloadBudgetBytes(mem.totalmem, (await this._getHardwareInfo())?.metalWiredLimitBytes)
			: usableSystemMemoryBytes(mem.totalmem) + (discreteVramBytes && discreteVramBytes > 0 ? discreteVramBytes : 0);
		return { requiredBytes, usableBytes, weightBytes };
	}

	/**
	 * Whether the model would STILL fit this machine with `extraResidentBytes` more loaded alongside it
	 * (e.g. a speculative draft model). Unknown inputs count as "fits" - consistent with the pre-flight gate.
	 */
	private async _extrasFitBudget(modelPath: string, backend: LlamaBackend, discreteVramBytes: number | undefined, extraResidentBytes: number): Promise<boolean> {
		const fit = await this._computeFit(modelPath, backend, discreteVramBytes, extraResidentBytes);
		return !fit || fit.requiredBytes <= fit.usableBytes;
	}

	/**
	 * Resolves the on-disk speculative-decoding draft paired with this model in the catalog, filtered to the
	 * engine that will run it (`gguf` -> a .gguf file for llama.cpp, `mlx` -> a weights directory for mlx-lm).
	 * When the pairing exists but the draft is not downloaded yet, kicks off a background fetch (once per
	 * session) so the NEXT launch gets it, and returns undefined - a launch never waits on a draft download.
	 */
	private async _resolvePairedDraft(model: ICustomLanguageModel, engine: 'gguf' | 'mlx', triggerFetch: boolean = true): Promise<{ path: string; bytes: number; repoId: string } | undefined> {
		const pairing = findDraftPairing(model.modelName);
		if (!pairing) {
			return undefined;
		}
		const isMlxPairing = pairing.draftFormat.toLowerCase() === 'mlx';
		if ((engine === 'mlx') !== isMlxPairing) {
			return undefined; // pairing targets the other engine (e.g. GGUF draft for an MLX run)
		}
		const draftDir = joinPath(this.environmentService.cacheHome, LoCoPilotModelDownloadService.MODELS_DIR, modelDownloadDirName(pairing.draftRepoId));
		if (engine === 'gguf') {
			const filePath = await this.resolveModelFilePath(draftDir.fsPath);
			if (filePath.toLowerCase().endsWith('.gguf')) {
				const bytes = await this._fileBytes(filePath);
				if (bytes > 0) {
					return { path: filePath, bytes, repoId: pairing.draftRepoId };
				}
			}
		} else {
			const invalid = await this._validateMlxModelPath(draftDir.fsPath);
			if (!invalid) {
				const bytes = await this._weightBytesOnDisk(draftDir.fsPath);
				if (bytes > 0) {
					return { path: draftDir.fsPath, bytes, repoId: pairing.draftRepoId };
				}
			}
		}
		// Paired but not on disk: fetch in the background so a future launch benefits. Never block this one.
		if (triggerFetch && !this._draftFetchRequested.has(pairing.draftRepoId)) {
			this._draftFetchRequested.add(pairing.draftRepoId);
			this._log(`[LoCoPilot Runner] Draft ${pairing.draftRepoId} for ${model.modelName} is not downloaded yet; fetching in the background.`);
			this.commandService.executeCommand('locopilot.ensureDraftModel', model.modelName, model.token)
				.then(undefined, e => this._log(`[LoCoPilot Runner] Background draft fetch failed (ignored): ${e}`));
		}
		return undefined;
	}

	/**
	 * Pre-flight fit check. Returns true when the model can plausibly run on this machine; returns false -
	 * after showing a clear, actionable notification - when it cannot fit even at the minimum context. This
	 * is the guard that stops an oversized model from launching straight into the swap/OOM death spiral
	 * (UI freeze -> 100% GPU -> heat -> thermal shutdown) that a too-big GGUF causes on a memory-tight machine.
	 *
	 * Honest-but-lenient: we only block when even the SMALLEST viable footprint (weights + a minimum KV cache
	 * + a runtime slice) exceeds usable memory, so a model that merely needs context/offload tuning still
	 * launches (the budget/clamp logic handles it). Any missing input (unknown weight size, no RAM stats, web)
	 * returns true so we never block a launch we can't reason about.
	 *
	 * `discreteVramBytes`: dedicated VRAM (CUDA/Vulkan) that can hold offloaded weights ON TOP of system RAM;
	 * undefined on unified-memory (Metal) / CPU, where weights live in system RAM regardless of any offload.
	 */
	private async _checkModelFitsOrNotify(modelId: string, modelPath: string, backend: LlamaBackend, discreteVramBytes: number | undefined, interactive: boolean, extraResidentBytes: number = 0): Promise<boolean> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model) {
			return true;
		}
		if (this._forcedLaunch.has(modelId)) {
			return true; // user already chose "Run anyway" for this model
		}
		const fit = await this._computeFit(modelPath, backend, discreteVramBytes, extraResidentBytes);
		if (fit && fit.requiredBytes > fit.usableBytes) {
			// CAPABILITY failure: even the minimum footprint exceeds what this machine can EVER offer (total
			// usable RAM), so this model cannot safely run here. Unlike the transient gate this is a HARD
			// shortfall, so the "Run anyway" dialog warns more strongly (it may freeze/overheat the machine);
			// the watchdog is the backstop if the user proceeds anyway.
			const GB = 1024 * 1024 * 1024;
			const needGb = Math.ceil(fit.requiredBytes / GB);
			const haveGb = Math.max(1, Math.round(fit.usableBytes / GB));
			this._log(`[LoCoPilot Runner] ${modelId} exceeds usable RAM: needs ~${needGb}GB but only ~${haveGb}GB is usable on this machine (interactive=${interactive}).`);
			const name = model.displayName || model.modelName;
			if (!interactive) {
				// Background pre-warm of a too-big model: skip silently (no dialog, no toast).
				this._recordLaunchBlocked(modelId, this._buildFitBlockedMessage(name, needGb, haveGb, true));
				this._endStarting(modelId);
				return false;
			}
			return this._promptRunAnyway(modelId, name, needGb, haveGb, true);
		}
		return true;
	}

	/**
	 * Lowers the just-launched server process's scheduling priority (best-effort, behind the
	 * `locopilot.local.backgroundPriority` setting, default on). On macOS this applies the 'utility' QoS
	 * clamp - under contention the scheduler prefers efficiency cores for it, which keeps the editor UI
	 * fluid during weight loading/decode and runs measurably cooler - while an otherwise-idle machine
	 * still gives the server full throughput. Windows/Linux get below-normal priority / nice+5.
	 */
	private async _deprioritizeServerProcess(terminal: ITerminalInstance, modelName: string, delayMs = 0): Promise<void> {
		if (this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLocalBackgroundPriority) === false) {
			return;
		}
		try {
			await terminal.processReady; // processId is only populated once the pty has spawned
			if (delayMs > 0) {
				// MLX runs inside a shell (sendText), so give the shell a moment to fork the actual python
				// server before we look for child processes to deprioritize.
				await timeout(delayMs);
			}
			const pid = terminal.processId;
			if (typeof pid !== 'number' || pid <= 1) {
				return;
			}
			const ok = await this.instantiationService.invokeFunction(accessor =>
				accessor.get(ILoCoPilotSystemInfoService).deprioritizeProcess(pid));
			this._log(`[LoCoPilot Runner] ${ok ? 'Lowered' : 'Could not lower'} scheduling priority of the "${modelName}" server (pid ${pid}).`);
		} catch (e) {
			this._log(`[LoCoPilot Runner] Deprioritizing the "${modelName}" server failed (ignored): ${e}`);
		}
	}

	// ---- Runtime memory watchdog (circuit breaker) ----------------------------------------------------
	//
	// Every pre-launch estimate can be wrong (GGUF variance, compute buffers, OTHER apps allocating while
	// the model runs), and the failure mode of "wrong" on a memory-tight machine is not an error - it is
	// the swap/thrash death spiral: UI freeze, sustained 100% GPU, heat, sometimes a forced reboot. A
	// thrashing process never exits, so onExit-based crash handling can't catch it. This watchdog is the
	// safety net behind all the estimation: while THIS window owns a resident server it samples the live
	// memory state and, when the system is genuinely drowning (two consecutive critical samples, ~10s),
	// stops our servers - a 1-second recovery instead of a frozen machine. Killing our own process is
	// always the better trade: the user can relaunch a smaller model; they can't un-freeze a Mac.

	/**
	 * Minimum available-memory floor (bytes) below which a watchdog sample counts as critical. Raised from
	 * 1 GiB to 1.5 GiB so the breaker reacts BEFORE the machine is fully out of headroom (at 1 GiB free the
	 * editor is already janky); killing our own server early is the cheap recovery.
	 */
	private static readonly WATCHDOG_AVAILABLE_FLOOR_MIN = Math.round(1.5 * 1024 * 1024 * 1024); // 1.5 GiB
	/**
	 * Fraction of TOTAL RAM used as the floor when it is larger than the absolute minimum (scales up on big
	 * machines). Raised from 0.03 to 0.08 so e.g. a 32 GB Mac trips at ~2.5 GB free (heavy paging territory)
	 * rather than waiting for a flat 1 GB, giving the breaker a useful head start.
	 */
	private static readonly WATCHDOG_AVAILABLE_FLOOR_FRACTION = 0.08;
	/**
	 * HARD near-OOM floor (bytes). Below this, allocations are about to fail no matter what the pressure/swap
	 * signals say, so it is an INDEPENDENT kill condition (unlike the warn floor above, which only ARMS the
	 * paging/advisory checks). Deliberately well below the warn floor - a deliberately-tight big model is meant
	 * to sit under the warn floor while running fine, but sitting under ~1 GB reclaimable is genuine danger.
	 */
	private static readonly WATCHDOG_HARD_FLOOR_MIN = Math.round(0.6 * 1024 * 1024 * 1024); // 0.6 GiB
	private static readonly WATCHDOG_HARD_FLOOR_FRACTION = 0.03;
	/** Sample interval; two bad samples trip the breaker, so reaction time is ~2x this. */
	private static readonly WATCHDOG_INTERVAL_MS = 5000;
	/** How long automatic (pre-warm) launches stay suppressed after the breaker trips (or a first strike lands). */
	private static readonly WATCHDOG_COOLDOWN_MS = 60_000;

	/**
	 * Available-memory floor (bytes) for THIS machine: the larger of a 1 GiB absolute minimum and a small
	 * fraction of total RAM. A flat 1 GiB reacts too late on a 64 GB workstation (1 GB free there already means
	 * heavy paging) yet is fine on an 8 GB laptop; scaling by total RAM keeps the trip point proportionate.
	 */
	private _watchdogAvailableFloor(totalBytes: number): number {
		return Math.max(
			LoCoPilotLocalModelRunner.WATCHDOG_AVAILABLE_FLOOR_MIN,
			Math.floor(totalBytes * LoCoPilotLocalModelRunner.WATCHDOG_AVAILABLE_FLOOR_FRACTION)
		);
	}

	/** HARD near-OOM floor (bytes): below this, a kill is warranted on its own (see {@link WATCHDOG_HARD_FLOOR_MIN}). */
	private _watchdogHardFloor(totalBytes: number): number {
		return Math.max(
			LoCoPilotLocalModelRunner.WATCHDOG_HARD_FLOOR_MIN,
			Math.floor(totalBytes * LoCoPilotLocalModelRunner.WATCHDOG_HARD_FLOOR_FRACTION)
		);
	}

	/** True when this window owns at least one live server process (foreign attachments don't count). */
	private _ownsResidentServer(): boolean {
		for (const rec of this.runningServers.values()) {
			if (!rec.foreign) {
				return true;
			}
		}
		return false;
	}

	/**
	 * One-time, non-alarming heads-up that memory is tight, shown at most once per pressure episode (the latch is
	 * cleared when memory recovers above the warn floor). Only when a SINGLE server is resident - with more than one
	 * the watchdog sheds extras instead, so a warning would be premature. Deliberately reassures that the model keeps
	 * running and is only stopped if the system actually starts paging, matching the kill logic in the tick.
	 */
	private _maybeWarnMemoryLow(): void {
		if (this._watchdogWarnedThisEpisode || this._ownedServerCount() > 1) {
			return;
		}
		this._watchdogWarnedThisEpisode = true;
		this.notificationService.notify({
			severity: Severity.Warning,
			message: 'Your system is running low on memory. The local model will keep running - LoCoPilot will only stop it if the system starts paging to disk. Close other apps to free memory, or switch to a smaller model.',
		});
	}

	/** Number of live server processes THIS window owns (foreign attachments excluded). */
	private _ownedServerCount(): number {
		let n = 0;
		for (const rec of this.runningServers.values()) {
			if (!rec.foreign) {
				n++;
			}
		}
		return n;
	}

	/**
	 * Graceful first-strike relief: evict our least-recently-used OWNED servers while keeping the most-recently
	 * -used one resident. Only acts when more than one owned server is up (the multi-resident case, e.g.
	 * `maxResidentModels > 1`); with a single server there is nothing to shed short of killing it, which the
	 * second strike handles. Fire-and-forget teardown - we want the pressure relieved this tick, not awaited.
	 */
	private _watchdogRelieveByEvictingExtras(): void {
		const owned = Array.from(this.runningServers.entries())
			.filter(([, rec]) => !rec.foreign)
			.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt); // oldest first
		if (owned.length <= 1) {
			return; // single owned server: nothing to shed without killing the active model (strike 2's job)
		}
		const keepMru = owned[owned.length - 1][0];
		for (const [id] of owned) {
			if (id === keepMru) {
				continue;
			}
			const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === id);
			this._log(`[LoCoPilot Runner] Memory watchdog (first strike): evicting extra resident model ${model?.displayName || model?.modelName || id} to relieve pressure while keeping the active one.`);
			this.stopServer(id);
		}
	}

	/**
	 * (Re)evaluates whether the watchdog should be running. Called after every server promotion; the tick
	 * itself stops the timer once no owned server remains, so stop paths need no hook. Disabled entirely by
	 * the `locopilot.local.memoryWatchdog` setting.
	 */
	private _updateMemoryWatchdog(): void {
		const enabled = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLocalMemoryWatchdog) !== false;
		if (!enabled || !this._ownsResidentServer()) {
			this._stopMemoryWatchdog();
			return;
		}
		if (this._watchdogTimer) {
			return; // already running
		}
		this._watchdogStrikes = 0;
		this._watchdogLastSwapBytes = -1;
		this._watchdogWarnedThisEpisode = false;
		this._watchdogTimer = mainWindow.setInterval(() => void this._memoryWatchdogTick(), LoCoPilotLocalModelRunner.WATCHDOG_INTERVAL_MS);
		this._log('[LoCoPilot Runner] Memory watchdog armed (5s sampling while a local server is resident).');
	}

	private _stopMemoryWatchdog(): void {
		if (this._watchdogTimer) {
			mainWindow.clearInterval(this._watchdogTimer);
			this._watchdogTimer = undefined;
			this._watchdogStrikes = 0;
			this._watchdogLastSwapBytes = -1;
			this._watchdogWarnedThisEpisode = false;
		}
	}

	/** Swap growth (bytes/tick) that counts as active paging - the machine is spilling RAM to disk. */
	private static readonly WATCHDOG_SWAP_GROWTH_BYTES = 256 * 1024 * 1024; // 256 MiB per ~5s sample

	private async _memoryWatchdogTick(): Promise<void> {
		if (!this._ownsResidentServer()) {
			this._stopMemoryWatchdog();
			return;
		}
		const mem = await this._getMemoryStatus();
		if (!mem) {
			return; // probe unavailable this tick; keep sampling
		}

		// KILL ONLY WHEN REQUIRED. A big local model is SUPPOSED to run the machine tight - "available" sits low and
		// macOS may report CRITICAL memory pressure the whole time, because it is compressing/reclaiming hard to keep
		// the model's working set resident. That is not a freeze: compression is fast and the model runs fine (this
		// is how a 27B fits a 32 GB Mac). What actually freezes a Mac is sustained PAGING TO DISK. So we trip only on
		// signals that mean the machine is genuinely in trouble, and treat mere pressure/decline as an advisory:
		//  - IMMEDIATE (1 sample): CRITICAL THERMAL - imminent throttle/shutdown, no time to wait another 5 s.
		//  - TWO SAMPLES (~10 s): swap actively GROWING while memory is low (paging to disk NOW), OR available under
		//    the HARD near-OOM floor (allocations about to fail regardless of other signals), OR a platform with no
		//    pressure/swap signal at all that's low (last resort), OR SERIOUS thermal.
		// NOTE: kernel CRITICAL memory pressure and a downward available-trend are deliberately NOT kill conditions -
		// on their own they fire constantly for a deliberately-tight model (e.g. the KV cache filling on the first
		// generation is a monotonic decline into headroom we already budgeted). They drive the ADVISORY warn instead.
		const warnFloor = this._watchdogAvailableFloor(mem.totalBytes);
		const hardFloor = this._watchdogHardFloor(mem.totalBytes);
		const lowAvailable = mem.availableBytes < warnFloor;
		const nearlyOut = mem.availableBytes < hardFloor;
		const swapGrowing = mem.swapUsedBytes >= 0 && this._watchdogLastSwapBytes >= 0
			&& (mem.swapUsedBytes - this._watchdogLastSwapBytes) > LoCoPilotLocalModelRunner.WATCHDOG_SWAP_GROWTH_BYTES;
		const hasPressureSignal = mem.pressure !== 'unknown';
		const noSignals = mem.pressure === 'unknown' && mem.swapUsedBytes < 0;
		this._watchdogLastSwapBytes = mem.swapUsedBytes;

		// Kill ONLY on genuine, CORROBORATED trouble. The hard lesson from small machines: on a 16 GB Mac running
		// even a tiny 4B model, "available" routinely sits under the floor (the editor is itself an Electron app)
		// and macOS swaps cold pages opportunistically with nothing wrong - so "low available + a swap tick" is NOT
		// evidence of a problem and must never stop a model that is running fine. The trustworthy signal is the
		// kernel's OWN verdict combined with actual paging:
		//  - macOS / Linux (a pressure signal exists): CRITICAL memory pressure AND swap actively growing together =
		//    a real paging spiral (what freezes the machine). Neither alone qualifies - critical pressure is normal
		//    for a deliberately-tight big model, and swap growth alone is normal opportunistic paging.
		//  - Signal-less platforms (Windows): fall back to low-available + swap growth, or low-available alone when
		//    there's no swap figure either (last resort - it's all we have).
		//  - nearlyOut (below the hard near-OOM floor) and SERIOUS thermal are independent last-resort kills.
		const thermalEmergency = mem.thermalPressure === 'critical';
		const pagingSpiral = hasPressureSignal
			? (mem.pressure === 'critical' && swapGrowing)
			: (lowAvailable && (swapGrowing || noSignals));
		const killCritical = pagingSpiral
			|| nearlyOut
			|| mem.thermalPressure === 'serious';
		if (!thermalEmergency && !killCritical) {
			// Not in kill territory. Reset strikes; if the kernel reports CRITICAL pressure while we're low, give a
			// ONE-TIME, non-escalating heads-up (the model keeps running). Clear the latch on recovery above the floor.
			this._watchdogStrikes = 0;
			if (lowAvailable && mem.pressure === 'critical') {
				this._maybeWarnMemoryLow();
			} else if (mem.availableBytes >= warnFloor) {
				this._watchdogWarnedThisEpisode = false; // recovered - allow a fresh warning next episode
			}
			return;
		}
		this._watchdogStrikes++;
		const GB = 1024 * 1024 * 1024;
		this._log(`[LoCoPilot Runner] Memory watchdog: kill-critical sample ${this._watchdogStrikes} (thermalEmergency=${thermalEmergency}, available ~${(mem.availableBytes / GB).toFixed(1)}GB, warnFloor ~${(warnFloor / GB).toFixed(1)}GB, hardFloor ~${(hardFloor / GB).toFixed(1)}GB, nearlyOut=${nearlyOut}, swapGrowing=${swapGrowing}, pagingSpiral=${pagingSpiral}, pressure=${mem.pressure}, thermal=${mem.thermalPressure}, swap used ~${mem.swapUsedBytes >= 0 ? (mem.swapUsedBytes / GB).toFixed(1) + 'GB' : 'n/a'}).`);
		// Only a thermal emergency trips on the first strike; every memory signal needs two consecutive samples.
		if (!thermalEmergency && this._watchdogStrikes < 2) {
			// GRACEFUL FIRST STRIKE: don't kill the user's model yet, but relieve pressure and stop making it
			// worse. (1) Suppress automatic pre-warm launches right away so nothing new loads while we're tight.
			// (2) If more than one of OUR servers is resident, evict the least-recently-used extras now, keeping
			// the most-recently-used (the one the user is likely mid-conversation with). Often this alone clears
			// the pressure so the second strike never lands and the active model survives. (3) Single server: warn.
			this._watchdogCooldownUntil = Date.now() + LoCoPilotLocalModelRunner.WATCHDOG_COOLDOWN_MS;
			this._watchdogRelieveByEvictingExtras();
			this._maybeWarnMemoryLow();
			return;
		}

		// Trip the breaker: free our memory NOW and tell the user why their model stopped.
		const stoppedNames: string[] = [];
		for (const [id, rec] of Array.from(this.runningServers.entries())) {
			if (rec.foreign) {
				continue;
			}
			const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === id);
			stoppedNames.push(model?.displayName || model?.modelName || id);
			this.stopServer(id);
		}
		this._stopMemoryWatchdog();
		this._watchdogCooldownUntil = Date.now() + LoCoPilotLocalModelRunner.WATCHDOG_COOLDOWN_MS;
		const thermalCause = mem.thermalPressure === 'critical' || mem.thermalPressure === 'serious';
		this._log(`[LoCoPilot Runner] Memory watchdog TRIPPED: stopped ${stoppedNames.join(', ') || 'local server'} to keep the system responsive (thermal=${mem.thermalPressure}, pressure=${mem.pressure}).`);
		const names = stoppedNames.join('", "');
		this.notificationService.notify({
			severity: Severity.Warning,
			message: thermalCause
				? `LoCoPilot stopped "${names}" because your system was overheating. Let it cool down and try again, or switch to a smaller model.`
				: `LoCoPilot stopped "${names}" because your system was running out of memory. Close some applications and try again, or switch to a smaller model.`,
		});
	}

	/**
	 * Best-effort warm-up for a just-launched local server (llama.cpp or mlx-lm): poll until the HTTP
	 * endpoint answers, then fire a tiny 1-token request so GPU/Metal kernels are compiled and the prompt
	 * cache is primed before the user's first message. Fire-and-forget; all failures are swallowed (the
	 * server may simply still be loading).
	 *
	 * For MLX this ping matters even more than for llama.cpp: mlx_lm.server answers GET /v1/models 200
	 * while the weights are still loading on its worker thread, so the endpoint probe alone is optimistic -
	 * the 1-token request is the first thing that actually blocks until the model is usable. Its completion
	 * is therefore the real "weights loaded" signal, and we flip the record to ready on it.
	 *
	 * `requestModel` must be what the server was loaded with (llama.cpp ignores it; mlx_lm tries to load a
	 * DIFFERENT model when it mismatches, so pass the served model dir there - see getServedModelId).
	 */
	private async _warmUpLocalServer(modelId: string, port: number, kind: 'llama' | 'mlx', requestModel: string): Promise<void> {
		// llama-server has a dedicated /health; mlx_lm.server only exposes the OpenAI surface, so probe /models.
		const probeUrl = kind === 'llama' ? getLlamaServerHealthUrl(port) : `${getMlxServerBaseUrl(port)}/models`;
		const baseUrl = kind === 'llama' ? getLlamaServerBaseUrl(port) : getMlxServerBaseUrl(port);
		const token = CancellationToken.None;
		// Poll fast at first (a small model is up in ~1-2s; 1s granularity wasted most of that), then back
		// off to 1s. Total window ~2 minutes (large models on a cold disk cache take a while).
		const FAST_ATTEMPTS = 20; // 20 x 250ms = first 5 seconds
		const MAX_ATTEMPTS = FAST_ATTEMPTS + 115;
		let up = false;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			// Stop immediately if the server crashed or was stopped/evicted - otherwise we'd keep hitting a
			// dead port with ERR_CONNECTION_REFUSED for the full 2 minutes.
			if (this._crashedBeforeReady.has(modelId) || !this.runningServers.has(modelId)) {
				this._log(`[LoCoPilot Runner] Warm-up aborted for ${modelId}: server is no longer running.`);
				return;
			}
			try {
				const res = await this.requestService.request({ type: 'GET', url: probeUrl }, token);
				const status = res.res.statusCode ?? 0;
				if (status === 200) {
					up = true;
					break;
				}
			} catch {
				// not up yet
			}
			await timeout(attempt < FAST_ATTEMPTS ? 250 : 1000);
		}
		if (!up) {
			this._log(`[LoCoPilot Runner] Warm-up skipped: server on port ${port} did not become ready in time.`);
			return;
		}
		try {
			const body = JSON.stringify({
				model: requestModel,
				messages: [{ role: 'user', content: 'ping' }],
				max_tokens: 1,
				stream: false,
			});
			await this.requestService.request({
				type: 'POST',
				url: `${baseUrl}/chat/completions`,
				headers: { 'Content-Type': 'application/json' },
				data: body,
			}, token);
			this._log(`[LoCoPilot Runner] Warm-up request completed for ${kind} server on port ${port}.`);
			// A completed generation is the strongest readiness signal there is (for MLX it is the ONLY
			// reliable one - see above). Flip the phase so the UI turns green without waiting for a real
			// request to run through ensureServerForModel.
			const rec = this.runningServers.get(modelId);
			if (rec && !rec.ready) {
				rec.ready = true;
				rec.loadProgress = undefined;
				this._onDidServerStateChange.fire(modelId);
			}
		} catch (e) {
			this._log(`[LoCoPilot Runner] Warm-up request failed (ignored): ${e}`);
		}
	}

	/**
	 * Install root of the app (where resources/ lives). Only present on desktop; undefined on web.
	 * appRoot is declared on INativeEnvironmentService, so read it through that subtype.
	 */
	private get _appRoot(): string | undefined {
		return (this.environmentService as Partial<INativeEnvironmentService>).appRoot;
	}

	/**
	 * Resolves the path to use for llama-server. Priority:
	 *   1. User override (locopilot.llamaCpp.serverPath) - for remote/custom builds. Advanced; unset by default.
	 *      Only honored when it still points at an existing binary; a configured-but-missing path (e.g. the
	 *      user deleted their own llama.cpp build) is ignored so we transparently fall back to the bundled
	 *      engine instead of trying to exec a dead path and crashing on startup.
	 *   2. Bundled binary shipped inside the app (resources/bin/<platform>-<arch>/llama-server) - the
	 *      zero-setup default that ships with every package via scripts/fetch-llama-binaries.mjs.
	 *   3. Conventional install locations (~/llama.cpp/build/bin, Homebrew, etc.).
	 *   4. undefined → fall back to llama-server on PATH.
	 */
	private async resolveServerPath(): Promise<string | undefined> {
		const configured = this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath)?.trim();
		if (configured) {
			if (await this._isExistingFile(configured)) {
				return configured;
			}
			this._log(`[LoCoPilot Runner] Configured llama.cpp server path does not exist; falling back to the bundled engine: ${configured}`);
		}
		// Prefer the binary we ship inside the installer - no user setup required.
		const bundled = getBundledLlamaServerPath(this._appRoot);
		if (bundled) {
			try {
				const stat = await this.fileService.stat(URI.file(bundled));
				if (stat.isFile) {
					return bundled;
				}
			} catch {
				// Not bundled for this build (e.g. binary not fetched, or unsupported arch) - fall through.
			}
		}
		const userHome = await this.pathService.userHome();
		const homeFs = userHome.fsPath;
		const pathsToTry = getDefaultLlamaServerPaths(homeFs);
		for (const p of pathsToTry) {
			try {
				const stat = await this.fileService.stat(URI.file(p));
				if (stat.isFile || stat.isDirectory) {
					return p;
				}
			} catch {
				// skip
			}
		}
		return undefined;
	}

	/**
	 * Resolves the Python interpreter for mlx_lm.server. Priority:
	 *   1. User override (locopilot.mlx.pythonPath) - advanced; unset by default.
	 *   2. Bundled self-contained Python with mlx-lm pre-installed, shipped in the macOS arm64 package
	 *      (resources/mlx/darwin-arm64/python/bin/python3) - the zero-setup default.
	 *   3. `python3` on PATH (legacy fallback; requires the user to have installed mlx-lm themselves).
	 */
	private async resolveMlxPython(): Promise<string> {
		const configured = (this.configurationService.getValue<string>(ChatConfiguration.LocopilotMlxPythonPath) ?? '').trim();
		if (configured) {
			return configured;
		}
		const bundled = getBundledMlxPython(this._appRoot);
		if (bundled) {
			try {
				const stat = await this.fileService.stat(URI.file(bundled));
				if (stat.isFile) {
					return bundled;
				}
			} catch {
				// Not bundled in this build - fall through to PATH.
			}
		}
		return 'python3';
	}

	/** Resolves localPath to a .gguf file path (if it's a directory, finds first .gguf). */
	private async resolveModelFilePath(localPath: string): Promise<string> {
		const uri = URI.file(localPath);
		try {
			const stat = await this.fileService.stat(uri);
			if (stat.isFile && localPath.toLowerCase().endsWith('.gguf')) {
				return localPath;
			}
			if (stat.isDirectory) {
				const dirStat = await this.fileService.resolve(uri);
				const children = dirStat.children ?? [];
				const gguf = children.find(c => c.name.toLowerCase().endsWith('.gguf'));
				if (gguf) {
					return gguf.resource.fsPath;
				}
				for (const c of children) {
					if (c.isDirectory) {
						const subStat = await this.fileService.resolve(c.resource);
						const subGguf = (subStat.children ?? []).find(x => x.name.toLowerCase().endsWith('.gguf'));
						if (subGguf) {
							return subGguf.resource.fsPath;
						}
					}
				}
			}
		} catch {
			// ignore
		}
		return localPath;
	}

	/**
	 * Finds the multimodal projector (`mmproj-*.gguf`) next to the model weights, or undefined when none was
	 * downloaded (text-only model, or a vision model fetched before projector support existed). The download
	 * service places it in the same directory as the main GGUF, so we look there. Passed to llama.cpp via
	 * `--mmproj` to enable image input.
	 */
	private async resolveMmprojPath(localPath: string): Promise<string | undefined> {
		try {
			const stat = await this.fileService.stat(URI.file(localPath));
			const modelDir = stat.isDirectory ? localPath : dirname(localPath);
			const resolved = await this.fileService.resolve(URI.file(modelDir));
			const match = (resolved.children ?? []).find(c => c.isFile && /^mmproj.*\.gguf$/i.test(c.name));
			return match?.resource.fsPath;
		} catch {
			return undefined;
		}
	}

	/** True if the resolved local path is a single GGUF file (Hugging Face layout). */
	private async pathResolvesToGguf(localPath: string): Promise<boolean> {
		const p = await this.resolveModelFilePath(localPath);
		return p.toLowerCase().endsWith('.gguf');
	}

	/**
	 * Validates that an MLX model path is usable before we spawn the server. Returns a human-readable error
	 * string when the path is unusable, or undefined when it looks good. Checks: non-empty, exists on disk, and
	 * the resolved model directory actually contains MLX weights (a config.json plus at least one .safetensors).
	 */
	private async _validateMlxModelPath(localPath: string | undefined): Promise<string | undefined> {
		if (!localPath) {
			return 'This MLX model has no local path set. Download the model again, then retry.';
		}
		let modelDir: string;
		try {
			const stat = await this.fileService.stat(URI.file(localPath));
			modelDir = stat.isDirectory ? localPath : dirname(localPath);
		} catch {
			return `The MLX model files were not found at "${localPath}". The download may be incomplete - re-download the model and retry.`;
		}
		try {
			const resolved = await this.fileService.resolve(URI.file(modelDir), { resolveMetadata: true });
			const names = (resolved.children ?? []).filter(c => c.isFile).map(c => c.name.toLowerCase());
			const hasConfig = names.includes('config.json');
			const hasWeights = names.some(n => n.endsWith('.safetensors') || n.endsWith('.npz'));
			if (!hasConfig || !hasWeights) {
				return `The folder for this MLX model ("${modelDir}") is missing weight files (config.json and *.safetensors). The download is likely incomplete - re-download the model and retry.`;
			}
		} catch {
			return `The MLX model folder "${modelDir}" could not be read. Re-download the model and retry.`;
		}
		return undefined;
	}

	/** Model root for mlx-lm: directory, or parent when localPath is a file. */
	private async getMlxModelRootPath(localPath: string): Promise<string> {
		const uri = URI.file(localPath);
		try {
			const stat = await this.fileService.stat(uri);
			if (stat.isDirectory) {
				return localPath;
			}
		} catch {
			// treat as file path
		}
		return dirname(localPath);
	}

	private async findAvailablePort(startPort: number): Promise<number> {
		let port = startPort;
		// Seed from both running servers AND ports already reserved by in-flight launches, then reserve our
		// pick *synchronously* (before the async probe). This prevents two concurrent launches - e.g. two
		// different models warming at startup or during a rapid switch - from both choosing the default port
		// and colliding (the second process fails to bind and exits 1).
		const usedPorts = new Set<number>([
			...Array.from(this.runningServers.values()).map(s => s.port),
			...this._reservedPorts,
		]);
		while (usedPorts.has(port)) {
			port++;
		}
		this._reservedPorts.add(port);
		// On desktop, ask the main process to pick a 127.0.0.1 port that is not already bound (e.g. leftover mlx/llama).
		return this.instantiationService.invokeFunction((accessor) => {
			try {
				const native = accessor.get(INativeHostService);
				return native.findFreePort(port, 40, 5000, 1).then(free => {
					const chosen = free !== 0 ? free : port;
					if (chosen !== port) {
						this._reservedPorts.delete(port);
						this._reservedPorts.add(chosen);
					}
					return chosen;
				});
			} catch {
				// No native host (e.g. web): keep session-local heuristic only.
				return Promise.resolve(port);
			}
		});
	}

	/** Releases a port reserved by {@link findAvailablePort} once the server is tracked (or its launch failed). */
	private _releaseReservedPort(port: number): void {
		this._reservedPorts.delete(port);
	}

	// --- Cross-window single-server coordination -------------------------------------------------------------
	//
	// Every app window runs its own copy of this renderer-side service, so without coordination each window
	// launches its own model server (a second multi-GB process + KV cache). To keep only ONE model resident
	// system-wide, launches route through a shared on-disk lock under the per-user cache home. The lock records
	// the one active server ({ pid, port, kind, modelId }). On launch a window either ATTACHES to that server
	// (same model, still healthy) or REPLACES it (different model: kill it, then start its own). The lock lives
	// in cacheHome, which is shared across windows of the same user/install.

	private _activeServerLockUri(): URI {
		return joinPath(this.environmentService.cacheHome, 'locopilot-active-server.lock');
	}

	private async _readActiveServerLock(): Promise<IActiveServerLock | undefined> {
		try {
			const buf = await this.fileService.readFile(this._activeServerLockUri());
			const parsed = JSON.parse(buf.value.toString());
			if (!parsed || typeof parsed.modelId !== 'string' || (parsed.kind !== 'llama' && parsed.kind !== 'mlx')) {
				return undefined;
			}
			const kind: 'llama' | 'mlx' = parsed.kind;
			if (parsed.phase === 'claiming' && typeof parsed.claimToken === 'string') {
				const lock: IActiveServerLock = { phase: 'claiming', modelId: parsed.modelId, kind, claimToken: parsed.claimToken };
				return lock;
			}
			// A 'running' lock (or a legacy lock with no phase field) must carry a real pid+port.
			if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
				const lock: IActiveServerLock = {
					phase: 'running',
					modelId: parsed.modelId,
					kind,
					pid: parsed.pid,
					port: parsed.port,
					servedModelId: typeof parsed.servedModelId === 'string' ? parsed.servedModelId : undefined,
					claimToken: typeof parsed.claimToken === 'string' ? parsed.claimToken : undefined,
				};
				return lock;
			}
		} catch {
			// Missing/unreadable/corrupt lock -> treat as "no active server".
		}
		return undefined;
	}

	/** Health-probe a server's OpenAI/health endpoint on 127.0.0.1. Returns true only on a 200 within the timeout. */
	private async _probeServerHealth(port: number, kind: 'llama' | 'mlx'): Promise<boolean> {
		const url = kind === 'llama' ? getLlamaServerHealthUrl(port) : `${getMlxServerBaseUrl(port)}/models`;
		try {
			const src = new CancellationTokenSource();
			const timer = setTimeout(() => src.cancel(), 1500);
			try {
				const res = await this.requestService.request({ type: 'GET', url }, src.token);
				const status = res.res.statusCode ?? 0;
				await streamToBuffer(res.stream).catch(() => undefined); // drain so the connection frees
				return status >= 200 && status < 300;
			} finally {
				clearTimeout(timer);
				src.dispose();
			}
		} catch {
			return false;
		}
	}

	/** Best-effort kill of another window's server process by PID via the native host. */
	private async _killForeignServer(pid: number, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
		try {
			await this.instantiationService.invokeFunction(accessor => accessor.get(INativeHostService).killProcess(pid, signal));
			this._log(`[LoCoPilot Runner] Sent ${signal} to the previously-active model server (pid ${pid}) started by another window.`);
		} catch (e) {
			this._log(`[LoCoPilot Runner] Could not ${signal} previously-active server pid ${pid} (ignored): ${e}`);
		}
	}

	/**
	 * Waits until a just-killed server has actually gone away before we launch the replacement. Without this the
	 * new server races the dying one: the old process still holds the port and (worse) the GPU/Metal working set
	 * for a moment after SIGTERM, so the fresh launch fails to bind / can't fit params to device memory and exits
	 * with a crash toast. Polls the health endpoint until it stops answering, escalates to SIGKILL if the process
	 * ignores SIGTERM, then adds a short grace for the OS to reclaim the freed GPU memory.
	 */
	private async _waitForServerGone(port: number, kind: 'llama' | 'mlx', pid: number): Promise<void> {
		const deadline = Date.now() + 8000;
		let escalated = false;
		while (Date.now() < deadline) {
			if (!await this._probeServerHealth(port, kind)) {
				break; // HTTP listener closed -> the process is shutting down / gone
			}
			// If it's still answering ~3s in, SIGTERM didn't take (e.g. mid-request); force it.
			if (!escalated && Date.now() > deadline - 5000) {
				escalated = true;
				await this._killForeignServer(pid, 'SIGKILL');
			}
			await timeout(250);
		}
		// Grace for the OS to release the GPU/Metal memory and the socket the old process held.
		await timeout(600);
	}

	/**
	 * Publishes THIS window's freshly-started server to the shared active-server lock so other windows can attach
	 * to or replace it. Awaits the terminal's real PID (needed so another window can kill it on replace).
	 */
	private async _publishActiveServerLock(port: number, kind: 'llama' | 'mlx', terminal: ITerminalInstance, modelId: string, servedModelId?: string): Promise<void> {
		try {
			await terminal.processReady; // processId is only populated once the pty has spawned
			const pid = terminal.processId;
			if (typeof pid !== 'number') {
				return; // no PID -> another window couldn't kill it, so don't advertise a server it can't manage
			}
			// Only publish if we still own this exact running record (a rapid switch may have replaced it).
			const rec = this.runningServers.get(modelId);
			if (!rec || rec.terminal !== terminal) {
				return;
			}
			this._ownedServerPid = pid;
			this._myClaimToken = undefined; // the claim is now upgraded to a running entry
			const content = JSON.stringify({ phase: 'running', pid, port, kind, modelId, servedModelId });
			await this.fileService.writeFile(this._activeServerLockUri(), VSBuffer.fromString(content));
		} catch (e) {
			this._log(`[LoCoPilot Runner] Failed to publish active-server lock (ignored): ${e}`);
		}
	}

	/**
	 * Called when THIS window's server process exits unexpectedly. Reads the shared lock to tell a genuine crash
	 * apart from another window intentionally killing our server to take over (attach-else-replace). Returns true
	 * when we were replaced externally (caller should stay silent - it isn't a crash). On a real crash the lock
	 * still points at our now-dead pid, so we clear that stale entry here. Either way we drop our owned-pid.
	 */
	private async _wasReplacedByAnotherWindow(ownedPid: number | undefined): Promise<boolean> {
		if (ownedPid === undefined) {
			return false; // we never published a server -> treat the exit as a normal crash
		}
		let replaced = false;
		try {
			const lock = await this._readActiveServerLock();
			// Lock gone or now pointing at a different pid => another window cleared/replaced us on purpose.
			replaced = !lock || lock.pid !== ownedPid;
			if (!replaced) {
				// Stale lock still names our dead process; clean it up so the next launch doesn't attach to a corpse.
				try { await this.fileService.del(this._activeServerLockUri()); } catch { /* already gone */ }
			}
		} catch {
			replaced = false;
		}
		if (this._ownedServerPid === ownedPid) {
			this._ownedServerPid = undefined;
		}
		return replaced;
	}

	/** Clears the shared lock, but only if it still points at the process this window owns (avoids racing another window). */
	private async _clearActiveServerLockIfOwned(): Promise<void> {
		if (this._ownedServerPid === undefined) {
			return;
		}
		const owned = this._ownedServerPid;
		this._ownedServerPid = undefined;
		try {
			const lock = await this._readActiveServerLock();
			if (lock && lock.pid === owned) {
				await this.fileService.del(this._activeServerLockUri());
				await this.fileService.del(this._activeServerLogUri()).catch(() => undefined);
			}
		} catch {
			// lock already gone / unwritable -> nothing to clean up
		}
	}

	/** Shared file mirroring the active server's recent logs, so windows attached to it can show them too. */
	private _activeServerLogUri(): URI {
		return joinPath(this.environmentService.cacheHome, 'locopilot-active-server.log');
	}

	/**
	 * Mirrors the owned server's logs to the shared log file (trailing throttle) so OTHER windows attached to
	 * this server can display them. Rewrites the whole capped buffer each flush - simple and self-healing.
	 */
	private _mirrorLogsToSharedFile(modelId: string): void {
		if (this._ownedServerPid === undefined || this._logMirrorTimer) {
			return; // not the global owner yet (pid unpublished), or a flush is already scheduled
		}
		this._logMirrorTimer = setTimeout(() => {
			this._logMirrorTimer = undefined;
			const rec = this.runningServers.get(modelId);
			if (!rec || rec.foreign || this._ownedServerPid === undefined) {
				return;
			}
			this.fileService.writeFile(this._activeServerLogUri(), VSBuffer.fromString(rec.logs.join('\n')))
				.catch(() => undefined); // best-effort; the in-window log view never depends on this
		}, 500);
	}

	/** Loads the shared log file into a foreign record's log buffer and notifies the log view. */
	private async _loadForeignLogs(modelId: string): Promise<void> {
		try {
			const buf = await this.fileService.readFile(this._activeServerLogUri());
			const rec = this.runningServers.get(modelId);
			if (rec?.foreign) {
				rec.logs = buf.value.toString().split('\n');
				this._onDidLogUpdate.fire(modelId);
			}
		} catch {
			// No shared log yet (owner hasn't flushed) - the placeholder line stays until it appears.
		}
	}

	/**
	 * Tails the shared log file for a foreign record so the log view updates live in this window too. The
	 * containing dir is already watched (see constructor), so this only needs a change listener - no direct
	 * file watch (which would log "watched path got deleted" when the owner clears the log on teardown).
	 */
	private _watchForeignLogs(modelId: string): void {
		this._disposeForeignLogWatcher(modelId);
		const uri = this._activeServerLogUri();
		const listener = this.fileService.onDidFilesChange(e => {
			if (e.contains(uri)) {
				void this._loadForeignLogs(modelId);
			}
		});
		this._foreignLogWatchers.set(modelId, listener);
	}

	private _disposeForeignLogWatcher(modelId: string): void {
		this._foreignLogWatchers.get(modelId)?.dispose();
		this._foreignLogWatchers.delete(modelId);
	}

	/**
	 * Registers a read-only record for a server owned by another window: it shows as running in this window's
	 * UI, chat requests go to its port, and its logs are tailed from the shared log file.
	 */
	private async _attachForeignRecord(lock: { pid: number; port: number; kind: 'llama' | 'mlx'; modelId: string; servedModelId?: string }): Promise<void> {
		this.startingServers.delete(lock.modelId);
		this.runningServers.set(lock.modelId, {
			port: lock.port,
			kind: lock.kind,
			foreign: true,
			servedModelId: lock.servedModelId,
			logs: ['This model was started in another LoCoPilot window; showing its mirrored server logs.'],
			lastUsedAt: Date.now(),
			ready: true,
		});
		this._watchForeignLogs(lock.modelId);
		await this._loadForeignLogs(lock.modelId);
		this._onDidServerStateChange.fire(lock.modelId);
		this._onDidLogUpdate.fire(lock.modelId);
		this._log(`[LoCoPilot Runner] Attached to model ${lock.modelId} running in another window on port ${lock.port}.`);
	}

	/** Debounced entry point for lock-file changes; also used for the "server still loading" probe retries. */
	private _scheduleLockSync(delayMs: number = 300): void {
		if (this._lockSyncTimer) {
			clearTimeout(this._lockSyncTimer);
		}
		this._lockSyncTimer = setTimeout(() => {
			this._lockSyncTimer = undefined;
			void this._syncFromActiveServerLock();
		}, delayMs);
	}

	/**
	 * Re-syncs this window's records with the shared lock after it changed on disk. Keeps every window's
	 * My Models status identical: drops foreign handles whose server was stopped/replaced elsewhere, and
	 * attaches a foreign handle when another window started a server we don't know about yet. A lock whose
	 * server is still loading (health probe fails) is retried for a while - the lock is published at launch,
	 * before the weights finish loading.
	 */
	private async _syncFromActiveServerLock(): Promise<void> {
		const lock = await this._readActiveServerLock();
		// Treat a 'claiming' lock (a launch in flight elsewhere, no server yet) as "nothing to attach to yet".
		const running = lock && lock.phase === 'running' ? lock : undefined;
		// Drop foreign handles that no longer match a running lock (their server was stopped or replaced elsewhere).
		for (const [id, rec] of Array.from(this.runningServers.entries())) {
			if (rec.foreign && (!running || running.modelId !== id || running.port !== rec.port)) {
				this._disposeForeignLogWatcher(id);
				this.runningServers.delete(id);
				this._onDidServerStateChange.fire(id);
				this._log(`[LoCoPilot Runner] Foreign server for ${id} went away (lock changed); detached.`);
			}
		}
		if (!running || (this._ownedServerPid !== undefined && running.pid === this._ownedServerPid)) {
			// No global server yet, a claim is still in flight, or it's our own. If a claim is pending, poll a bit
			// so we attach once it becomes 'running'.
			if (lock && lock.phase === 'claiming' && this._lockSyncRetries++ < 40) {
				this._scheduleLockSync(3000);
			} else {
				this._lockSyncRetries = 0;
			}
			return;
		}
		if (this.runningServers.has(running.modelId) || this.startingServers.has(running.modelId)) {
			this._lockSyncRetries = 0;
			return; // already tracked (own or foreign)
		}
		if (!this.customLanguageModelsService.getCustomModels().some(m => m.id === running.modelId)) {
			return; // model unknown to this window's list - nothing to show
		}
		if (running.port === undefined || !await this._probeServerHealth(running.port, running.kind)) {
			// Published at launch; weights may still be loading. Retry for up to ~2 minutes, then give up
			// (a later ensureServerForModel or lock change will retry anyway).
			if (this._lockSyncRetries++ < 40) {
				this._scheduleLockSync(3000);
			} else {
				this._lockSyncRetries = 0;
			}
			return;
		}
		this._lockSyncRetries = 0;
		await this._attachForeignRecord({ pid: running.pid!, port: running.port, kind: running.kind, modelId: running.modelId, servedModelId: running.servedModelId });
	}

	/**
	 * Enforces "one model server at a time across all windows" before a launch, and closes the cold-start race
	 * where two windows pre-warm the same model simultaneously and both bind the base port. It uses the lock file
	 * as an atomic mutex: a launch must win an exclusive 'claiming' create before it may pick a port and spawn.
	 *
	 *  - No lock            -> try to atomically claim it. Winner returns 'proceed'; a loser re-reads and reacts.
	 *  - Someone claiming   -> another window is mid-launch: wait for it to resolve, then re-evaluate.
	 *  - Healthy, same model -> ATTACH to it (no duplicate) and return 'attached'.
	 *  - Healthy, other model -> REPLACE: kill it, wait for it to fully release the port/GPU, then claim + proceed.
	 *  - Dead/stale lock    -> clear it and retry.
	 *
	 * Returns 'attached' when the caller should reuse another window's server, or 'proceed' (holding a claim that
	 * {@link _publishActiveServerLock} later upgrades to 'running', or {@link _releaseClaimIfHeld} releases on failure).
	 */
	private async _coordinateGlobalSingleServer(modelId: string): Promise<'attached' | 'proceed'> {
		const deadline = Date.now() + 30_000; // bound the wait for another window's in-flight launch
		for (; ;) {
			const lock = await this._readActiveServerLock();

			// No active lock: atomically claim the exclusive right to launch. createFile with overwrite:false
			// fails if another window created the lock first, which is what makes this race-safe.
			if (!lock) {
				const token = generateUuid();
				try {
					await this.fileService.createFile(
						this._activeServerLockUri(),
						VSBuffer.fromString(JSON.stringify({ phase: 'claiming', claimToken: token, modelId, kind: 'llama' })),
						{ overwrite: false }
					);
				} catch {
					continue; // lost the create race; re-read and react to whoever won
				}
				// createFile's existence check isn't OS-atomic, so two windows can both create and the last write
				// wins. Read back and only proceed if OUR token is the one that stuck; otherwise back off and retry.
				const after = await this._readActiveServerLock();
				if (after?.phase === 'claiming' && after.claimToken === token) {
					this._myClaimToken = token;
					return 'proceed';
				}
				await timeout(50 + Math.floor(Math.random() * 100)); // jitter to de-sync racing windows
				continue;
			}

			// Another window (or this one) is mid-launch. Wait for that claim to become 'running' or vanish.
			if (lock.phase === 'claiming') {
				if (lock.claimToken && lock.claimToken === this._myClaimToken) {
					return 'proceed'; // it's our own claim
				}
				if (Date.now() > deadline) {
					// The claim never progressed (the claiming window likely crashed mid-launch). Steal it.
					this._log('[LoCoPilot Runner] Stale launch claim in the active-server lock; taking it over.');
					try { await this.fileService.del(this._activeServerLockUri()); } catch { /* gone */ }
					continue;
				}
				this._beginStarting(modelId); // show a spinner while we wait for the other launch
				await timeout(300);
				continue;
			}

			// phase === 'running'. A server this window already owns? let the normal guards handle it.
			if (this._ownedServerPid !== undefined && lock.pid === this._ownedServerPid) {
				return 'proceed';
			}
			const healthy = lock.port !== undefined && await this._probeServerHealth(lock.port, lock.kind);
			if (!healthy) {
				// Dead/crashed owner: clear the stale lock and retry (the next iteration claims it).
				try { await this.fileService.del(this._activeServerLockUri()); } catch { /* already gone */ }
				continue;
			}
			if (lock.modelId === modelId) {
				await this._attachForeignRecord({ pid: lock.pid!, port: lock.port!, kind: lock.kind, modelId: lock.modelId, servedModelId: lock.servedModelId });
				return 'attached';
			}
			// A different model is globally active: stop it so only one model stays resident, then loop back to
			// claim - but WAIT for it to fully release the port/GPU first, or our fresh launch races the dying one.
			this._beginStarting(modelId); // show a spinner during the (multi-second) handoff instead of a dead UI
			await this._killForeignServer(lock.pid!);
			try { await this.fileService.del(this._activeServerLockUri()); } catch { /* already gone */ }
			await this._waitForServerGone(lock.port!, lock.kind, lock.pid!);
			continue;
		}
	}

	/**
	 * Releases the 'claiming' lock this window holds if its launch never reached the 'running' state (e.g. a
	 * failed fit check or a spawn error). Without this, a bailed launch would leave the mutex held and block
	 * every window from starting a model.
	 */
	private async _releaseClaimIfHeld(): Promise<void> {
		if (this._myClaimToken === undefined) {
			return;
		}
		const token = this._myClaimToken;
		this._myClaimToken = undefined;
		try {
			const lock = await this._readActiveServerLock();
			if (lock && lock.phase === 'claiming' && lock.claimToken === token) {
				await this.fileService.del(this._activeServerLockUri());
			}
		} catch {
			// lock already gone / upgraded to running -> nothing to release
		}
	}

	/** Mark a model as starting and notify the UI immediately so it can show a spinner. */
	private _beginStarting(modelId: string): void {
		this.startingServers.add(modelId);
		this._onDidServerStateChange.fire(modelId);
	}

	/** Clear the starting state and optionally fire a failure event with a reason for the UI. */
	private _endStarting(modelId: string, failureMessage?: string): void {
		this.startingServers.delete(modelId);
		if (failureMessage) {
			this._onDidServerStartFailed.fire({ modelId, message: failureMessage });
		}
		this._onDidServerStateChange.fire(modelId);
	}

	/** Record why a launch was abandoned at a memory/fit gate, so the chat panel can show the real reason. */
	private _recordLaunchBlocked(modelId: string, message: string): void {
		this._launchBlockReason.set(modelId, { message, at: Date.now() });
	}

	/**
	 * The reason a recent launch of `modelId` was abandoned at a memory/fit gate, or undefined when there is
	 * none (or it has gone stale). Consumed by the provider so a fit-blocked model reports "won't fit" rather
	 * than the "taking a moment to start" message reserved for a server that really is still coming up.
	 */
	getRecentLaunchFailure(modelId: string): string | undefined {
		const rec = this._launchBlockReason.get(modelId);
		if (!rec) {
			return undefined;
		}
		if (Date.now() - rec.at > LAUNCH_BLOCK_TTL_MS) {
			this._launchBlockReason.delete(modelId);
			return undefined;
		}
		return rec.message;
	}

	/** Forget any recorded fit-gate block for `modelId` (a fresh launch attempt or a successful start supersedes it). */
	private _clearLaunchBlocked(modelId: string): void {
		this._launchBlockReason.delete(modelId);
	}

	/**
	 * Starts the llama.cpp server for the given model in a new terminal.
	 * Uses recommended backend (GPU/Metal/CPU). The server runs until the terminal is closed.
	 *
	 * Concurrent callers for the same model share a single launch (see {@link _startInFlight}) so two
	 * pre-warm triggers cannot spawn duplicate servers on the same port.
	 */
	startServerInTerminal(modelId: string, interactive: boolean = false): Promise<void> {
		if (this.runningServers.has(modelId)) {
			this._log(`[LoCoPilot Runner] Server for model ${modelId} is already running.`);
			return Promise.resolve();
		}
		const inFlight = this._startInFlight.get(modelId);
		if (inFlight) {
			this._log(`[LoCoPilot Runner] Launch already in progress for model ${modelId}; reusing it.`);
			return inFlight;
		}
		const launch = this._doStartServerInTerminal(modelId, interactive).finally(() => {
			this._startInFlight.delete(modelId);
			// Safety net: the cross-window handoff optimistically shows a spinner (_beginStarting) before it
			// knows the launch will succeed. If the launch then bails early (failed fit check, missing engine,
			// etc.) without promoting to a running server, clear that leftover "starting" state so the picker
			// doesn't hang on a spinner forever.
			if (this.startingServers.has(modelId) && !this.runningServers.has(modelId)) {
				this._endStarting(modelId);
			}
			// If we won the launch claim but never promoted to a running server (bailed early or attached to
			// another window's server), release the mutex so other windows aren't blocked from launching.
			if (this._myClaimToken !== undefined) {
				void this._releaseClaimIfHeld();
			}
		});
		this._startInFlight.set(modelId, launch);
		return launch;
	}

	private async _doStartServerInTerminal(modelId: string, interactive: boolean): Promise<void> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.localPath) {
			this._log(`[LoCoPilot Runner] Model ${modelId} not found or has no local path.`);
			return;
		}
		// A fresh launch attempt supersedes any prior fit-gate block: clear it now so a stale "won't fit" reason
		// can't outlive a retry. If this attempt bails at a gate again, that gate re-records the current reason.
		this._clearLaunchBlocked(modelId);

		// Coordinate with other app windows before doing anything expensive: if another window already runs this
		// exact model, attach to it (no second process); if it runs a different model, stop that one first so only
		// one model stays resident system-wide. Returns 'attached' when we reused another window's server.
		if (await this._coordinateGlobalSingleServer(modelId) === 'attached') {
			return;
		}

		// Availability guard - EVERY launch path reaches here (message send, manual Start, Retry, picker,
		// pre-warm). Refuse to start a model that won't fit the RAM free RIGHT NOW, rather than loading it
		// into a swap/thrash hang. Placed BEFORE eviction so the RAM that stopping our other resident servers
		// will free is credited (a model that fits after the switch is not blocked). Shows a toast pointing at
		// Auto / a smaller model. The capability gate (too big for TOTAL RAM) runs later per backend; this is
		// the transient "not right now" companion.
		if (!await this._memoryAllowsLaunch(modelId, interactive)) {
			return;
		}

		// NOTE: the resident-model budget (eviction of the previous model) is enforced LATER, only AFTER the
		// per-backend capability gate has passed - see the _enforceResidentBudget calls in each launch branch
		// below. It must not run before that gate: if the user answers "Keep current model" at the fit dialog,
		// the previous model has to still be running (nothing evicted yet). Both gates run first; only a launch
		// that is actually going ahead evicts.

		// Wait until the workbench has finished restoring before spawning. During early startup VS Code
		// revives/restores persistent terminals; a terminal we create before that restoration runs gets
		// torn down with the pty (SIGHUP), which is the "exit 1 right after the server started listening"
		// crash seen when a model is pre-warmed on reload. The Restored phase guarantees terminal
		// restoration has completed, so freshly-created terminals are stable. (No-op once already restored,
		// e.g. for a manual launch from the model picker.)
		await this.lifecycleService.when(LifecyclePhase.Restored);
		// Also wait until the terminal/pty backend is actually connected before spawning.
		await this.terminalService.whenConnected;

		if (model.provider === 'huggingface' && isAppleSiliconMac()) {
			const hasGguf = await this.pathResolvesToGguf(model.localPath);
			if (shouldUseMlxServerForHfModel(model, hasGguf, true)) {
				// Same pre-flight fit check as the llama.cpp path: MLX runs on Apple Silicon unified memory via
				// Metal, so there is no separate VRAM pool and the same ~70% wired working-set ceiling applies -
				// pass 'metal' so the gate uses that ceiling rather than the looser 85% system figure. Size the
				// weights from the RESOLVED model root, not the raw localPath, so this matches the transient gate
				// and the actual launch (Q4). The prompt-cache headroom is reserved in the SOFT transient gate
				// (_memoryAllowsLaunch), not here - it is a growable, throttled cache, not a hard capability limit.
				const mlxModelDir = await this.getMlxModelRootPath(model.localPath);
				if (!await this._checkModelFitsOrNotify(modelId, mlxModelDir, 'metal', undefined, interactive)) {
					return;
				}
				// Both gates passed (or the user chose "Run anyway"): NOW evict the previous model to make room.
				await this._enforceResidentBudget(modelId);
				await this._startMlxServerInTerminal(modelId, model as ICustomLanguageModel & { localPath: string });
				return;
			}
		} else if (model.provider === 'huggingface' && !isAppleSiliconMac()) {
			const hasGguf = await this.pathResolvesToGguf(model.localPath);
			if (hfModelLooksLikeMlx(model, hasGguf)) {
				this.notificationService.notify({
					severity: Severity.Error,
					message: 'This MLX model can only be run on Apple Silicon (M1 or later) using mlx-lm. Use a GGUF build with llama.cpp on this machine, or use a cloud/localhost provider instead.',
				});
				return;
			}
		}

		const { serverPath, backend } = await this._resolveServerLaunch();
		if (!serverPath) {
			this.notificationService.prompt(
				Severity.Error,
				'The bundled llama.cpp engine could not be found for this build. This is unexpected - try reinstalling LoCoPilot. If you maintain your own llama.cpp build, you can point at it with the "locopilot.llamaCpp.serverPath" setting.',
				[
					{
						label: 'Open Settings',
						run: () => {
							this.commandService.executeCommand('workbench.action.openSettings', ChatConfiguration.LocopilotLlamaCppServerPath);
						}
					},
					{
						label: 'Get llama.cpp',
						run: () => {
							this.openerService.open('https://github.com/ggml-org/llama.cpp');
						}
					}
				]
			);
			return;
		}

		const modelPath = await this.resolveModelFilePath(model.localPath);

		// Pre-flight fit check: refuse (with a clear toast) a model that can't fit this machine, rather than
		// spawning it into a swap/OOM hang. Discrete GPUs (CUDA/Vulkan) can hold offloaded weights in VRAM on
		// top of system RAM; Metal/CPU keep weights in system RAM, so no extra pool is added.
		let discreteVramBytes: number | undefined;
		if (backend === 'cuda' || backend === 'vulkan') {
			const hw = await this._getHardwareInfo();
			const vram = (hw?.gpus ?? []).map(g => g.totalVramBytes).filter(v => v > 0);
			discreteVramBytes = vram.length ? Math.max(...vram) : undefined;
		}

		// Build the base tuning and resolve the vision projector FIRST, so both the pre-flight fit check and
		// the hardware-aware budget below account for the *full* resident footprint - weights + KV + a draft
		// model (MTP) + the mmproj projector. Loading these extras without reserving for them is what OOM-ed
		// the Metal command buffer (kIOGPUCommandBufferCallbackErrorOutOfMemory) on a 16GB Mac.
		const baseTuning = this._getLlamaTuning(model);
		// OOM degradation ladder: a previous launch of this model died from memory exhaustion, so this one
		// runs with the reduced footprint the ladder chose (smaller context, no speculative extras).
		const oomCap = this._oomContextCap.get(modelId);
		if (oomCap && (!baseTuning.contextSize || baseTuning.contextSize > oomCap)) {
			this._log(`[LoCoPilot Runner] OOM ladder: capping context for ${modelId} at ${oomCap}.`);
			baseTuning.contextSize = oomCap;
		}
		if (this._oomStripExtras.has(modelId)) {
			baseTuning.multiTokenPrediction = false;
			baseTuning.draftModelPath = undefined;
		}
		// Vision: load the projector (`--mmproj`) ONLY when the user has explicitly enabled vision for this
		// model. The projector is downloaded for every vision-capable model, but loading it wires ~1GB+ into
		// the GPU/Metal working set. So it stays off by default (text-only) and is opt-in per model; see
		// customModelVisionEnabled.
		let mmprojBytes = 0;
		if (customModelVisionEnabled(model)) {
			const mmprojPath = await this.resolveMmprojPath(model.localPath);
			if (mmprojPath) {
				baseTuning.mmprojPath = mmprojPath;
				mmprojBytes = await this._fileBytes(mmprojPath);
				this._log(`[LoCoPilot Runner] Vision enabled for ${modelId}: using projector ${mmprojPath} (~${Math.round(mmprojBytes / 1e6)}MB).`);
			}
		}
		// Resident extras beyond weights+KV: the vision projector plus whatever draft model speculation loads.
		// MTP self-drafts from the same GGUF (~doubles weights); a user-configured separate draft costs its own
		// file size (fall back to a full weights-worth when it can't be statted - the safe direction).
		const weightBytesForBudget = await this._weightBytesOnDisk(modelPath);
		let extraResidentBytes = mmprojBytes;
		const userDraftPath = baseTuning.draftModelPath?.trim();
		if (baseTuning.multiTokenPrediction) {
			extraResidentBytes += weightBytesForBudget;
		} else if (userDraftPath) {
			extraResidentBytes += (await this._fileBytes(userDraftPath)) || weightBytesForBudget;
		}

		// Automatic speculative decoding (default on): when the user configured nothing themselves, use the
		// catalog-paired small draft model when it is downloaded AND the machine still fits with it loaded;
		// otherwise fall back to n-gram drafting (zero extra memory). Skipped for MTP models (self-draft is
		// better) and for the rest of the session once a build rejected the speculative flags.
		const autoSpec = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppAutoSpeculative) !== false
			&& !this._specFlagsUnsupported;
		// Paired drafts are GPU/Metal-only: on a pure CPU backend the draft model competes with the target
		// for the same cores, so speculation can end up *slower* than plain decode. CPU machines keep the
		// n-gram fallback below, which drafts from the context with no second model and near-zero overhead.
		if (autoSpec && backend !== 'cpu' && !baseTuning.multiTokenPrediction && !userDraftPath && !this._oomStripExtras.has(modelId)) {
			const draft = await this._resolvePairedDraft(model, 'gguf');
			if (draft && await this._extrasFitBudget(modelPath, backend, discreteVramBytes, extraResidentBytes + draft.bytes)) {
				baseTuning.draftModelPath = draft.path;
				extraResidentBytes += draft.bytes;
				this._log(`[LoCoPilot Runner] Auto speculative decoding: drafting with ${draft.repoId} (~${Math.round(draft.bytes / 1e6)}MB).`);
			} else if (draft) {
				this._log(`[LoCoPilot Runner] Auto speculative decoding: draft ${draft.repoId} skipped (would exceed the memory budget); using n-gram drafting instead.`);
			}
		}
		if (autoSpec && !baseTuning.multiTokenPrediction && !(baseTuning.draftModelPath && baseTuning.draftModelPath.trim()) && !baseTuning.promptLookup) {
			// ngram-mod: drafts long runs (48-64 tokens) by matching n-grams already in the context. No extra
			// model, no extra memory; strongest on repetitive output (code edits, file rewrites).
			baseTuning.promptLookup = true;
			baseTuning.promptLookupArgs = '--spec-type ngram-mod';
			this._log('[LoCoPilot Runner] Auto speculative decoding: n-gram drafting enabled (--spec-type ngram-mod).');
		}
		// A build that already rejected speculative flags gets them stripped so the relaunch (and every
		// launch after) starts cleanly. This also drops MTP: same --spec-type mechanism, same rejection.
		if (this._specFlagsUnsupported && (baseTuning.multiTokenPrediction || baseTuning.draftModelPath?.trim() || baseTuning.promptLookup)) {
			this._log('[LoCoPilot Runner] This llama.cpp build does not support speculative decoding flags; launching without them.');
			baseTuning.multiTokenPrediction = false;
			baseTuning.draftModelPath = undefined;
			baseTuning.promptLookup = false;
			extraResidentBytes = mmprojBytes;
		}

		if (!await this._checkModelFitsOrNotify(modelId, modelPath, backend, discreteVramBytes, interactive, extraResidentBytes)) {
			return;
		}

		// Both gates passed (or the user chose "Run anyway"): NOW evict the previous model to make room. Doing
		// this only here - after the fit dialog - means "Keep current model" leaves the previous server running.
		await this._enforceResidentBudget(modelId);

		const port = await this.findAvailablePort(LOCOPILOT_LLAMA_SERVER_PORT);
		// Make sure the slot-save dir exists before launch: llama.cpp only touches it on save/restore, but
		// creating it up front keeps the --slot-save-path flag valid for the whole server lifetime.
		await this._ensureKvCacheDir();
		const tuning = await this._augmentTuningWithHardware(modelPath, backend, baseTuning, extraResidentBytes);
		// Remember the context this launch runs with, so an OOM crash can halve it on the retry.
		const launchContext = tuning.contextSize ?? DEFAULT_LLAMA_CONTEXT_SIZE;
		this._lastLaunchContext.set(modelId, launchContext);
		// Remember the resolved KV cache type this server uses, so slot save/restore only reuses a byte-compatible
		// blob (see _lastLaunchKvType / _slotCacheFileName). Mirrors getLlamaCppServerCommand's own resolution.
		this._lastLaunchKvType.set(modelId, resolveKvCacheType(tuning.kvCacheType ?? 'auto', launchContext));
		const { command, args } = getLlamaCppServerCommand(modelPath, backend, serverPath, port, tuning);
		// Remember whether this launch carries speculative flags, so a crash caused by an old build rejecting
		// them can be told apart from a real failure and self-healed (relaunch without speculation).
		if (args.includes('--spec-type') || args.includes('--model-draft')) {
			this._launchedWithSpecFlags.add(modelId);
		} else {
			this._launchedWithSpecFlags.delete(modelId);
		}
		// Same bookkeeping for --cache-ram, so an old build's rejection of it can be told apart and self-healed.
		if (args.includes('--cache-ram')) {
			this._launchedWithCacheRam.add(modelId);
		} else {
			this._launchedWithCacheRam.delete(modelId);
		}
		// Same bookkeeping for --swa-full (newer flag; old builds reject it) so its rejection can be self-healed.
		if (args.includes('--swa-full')) {
			this._launchedWithSwaFull.add(modelId);
		} else {
			this._launchedWithSwaFull.delete(modelId);
		}
		this._log(`[LoCoPilot Runner] Starting llama.cpp server for model ${modelId} on port ${port} with backend: ${backend}`);

		// Launch the binary DIRECTLY as the terminal's process (executable + args[]), NOT by typing a
		// command line into a shell. This avoids shell-specific quoting bugs - most importantly the
		// PowerShell gotcha where a quoted path (e.g. an install under "C:\Program Files\...") is echoed
		// as a string literal instead of executed, so llama-server.exe never starts and the port stays
		// closed. Passing args as a string[] lets the pty escape them correctly on every platform.
		const launchEnv = this._serverLaunchEnv(serverPath);
		const cmdLineForLog = [command, ...args].join(' ');
		this._log(`[LoCoPilot Runner] Executing: ${cmdLineForLog}`);
		const isBundled = serverPath === getBundledLlamaServerPath(this._appRoot) || serverPath === getBundledLlamaServerPath(this._appRoot, 'vulkan');
		this._log(`[LoCoPilot Runner] Using llama-server: ${serverPath} (bundled = ${isBundled}).`);

		this._beginStarting(modelId);
		try {
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: `Llama Server - ${model.modelName}`,
					executable: command,
					args,
					env: launchEnv ?? undefined,
					// Keep the terminal open if the process exits/crashes so the real error (e.g. a missing
					// dependency) stays visible instead of the window vanishing.
					waitOnExit: true,
					// Do NOT persist this terminal across window reloads. Persistent terminals are kept alive by
					// the pty host on reload, which orphans the old llama-server process - it keeps holding the
					// GPU/Metal memory (and the port). The next startup pre-warm then launches a fresh server
					// while the orphan is still resident, so the new process dies mid-load ("fitting params to
					// device memory" -> exit 1). Transient terminals are torn down cleanly on reload, so each
					// window starts from a clean slate and the pre-warmed model loads reliably.
					isTransient: true,
					// Run the server process normally but keep its terminal out of the panel/tab list. The
					// server logs still flow through terminal.onLineData below (so the in-app "Logs" view in
					// the model UI keeps working); they just no longer clutter the user's terminal.
					hideFromUser: true,
				}
			});

			const logs: string[] = [];
			this._crashedBeforeReady.delete(modelId);
			this._intentionalStops.delete(modelId);
			// This terminal now owns the model's lifecycle. Any previously-registered onExit (from an earlier
			// start that was stopped/evicted/retried) will see a mismatch here and ignore its exit, so it can't
			// clobber this record or raise a false crash for a model that is now running.
			this._activeLaunchTerminals.set(modelId, terminal);

			this._register(terminal.onLineData(line => {
				logs.push(line);
				if (logs.length > LoCoPilotLocalModelRunner.MAX_LOG_LINES) {
					logs.splice(0, logs.length - LoCoPilotLocalModelRunner.MAX_LOG_LINES);
				}
				const rec = this.runningServers.get(modelId);
				if (rec) {
					const progress = this._parseLoadProgress(line);
					if (progress) {
						rec.loadProgress = progress;
					}
					// llama.cpp prints this once the HTTP endpoint is up and the model is loaded. Use it to flip
					// the phase to 'ready' even for launches that don't go through ensureServerForModel (e.g. the
					// manual Retry path), so the running indicator turns green promptly.
					if (!rec.ready && /server is listening|HTTP server listening|all slots are idle|model loaded/i.test(line)) {
						rec.ready = true;
						rec.loadProgress = undefined;
						this._onDidServerStateChange.fire(modelId);
					}
				}
				this._onDidLogUpdate.fire(modelId);
				this._mirrorLogsToSharedFile(modelId); // so windows attached to this server see the logs too
			}));

			// If the process exits, decide whether it was an intentional stop or a real crash. A crash
			// (non-zero/undefined exit, not user-initiated) is the cause of the classic "stuck on
			// running, then connection refused" symptom: the binary died at launch (missing dependency,
			// unsupported CPU, etc.) so nothing ever bound the port. Surface a concrete message instead.
			this._register(terminal.onExit(code => {
				const exitCode = typeof code === 'number' ? code : undefined;
				// Ignore exits from a terminal that no longer owns this model's launch. A stale handler firing
				// after a restart must not delete the new record or report a crash for a model that is now up.
				if (this._activeLaunchTerminals.get(modelId) !== terminal) {
					this._log(`[LoCoPilot Runner] Ignoring exit (code ${exitCode ?? 'n/a'}) from a superseded terminal for model ${modelId}.`);
					return;
				}
				this._activeLaunchTerminals.delete(modelId);
				this._releaseReservedPort(port); // the process is gone; free its port reservation
				const wasIntentional = this._intentionalStops.delete(modelId);
				// Only delete the record if it is still THIS terminal's record (defensive: a concurrent restart
				// could have replaced it between the ownership check above and here).
				const current = this.runningServers.get(modelId);
				if (current && current.terminal === terminal) {
					this.runningServers.delete(modelId);
					this._onDidServerStateChange.fire(modelId);
				}
				// Capture our owned pid now; the async check below reads the shared lock to see if this exit was
				// caused by another window replacing us (attach-else-replace) rather than a genuine crash.
				const ownedPid = this._ownedServerPid;
				if (wasIntentional) {
					void this._wasReplacedByAnotherWindow(ownedPid); // clears our stale lock entry, if any
					this._log(`[LoCoPilot Runner] Server for model ${modelId} stopped (exit ${exitCode ?? 'n/a'}).`);
					return;
				}
				this._crashedBeforeReady.add(modelId);
				// A pre-warm attempt that will be retried suppresses its notification so a self-healing
				// startup race doesn't flash a scary "failed to start" toast; the crash is still logged.
				if (this._suppressCrashNotice.delete(modelId)) {
					void this._wasReplacedByAnotherWindow(ownedPid);
					const tail = logs.slice(-60).join('\n');
					this._log(`[LoCoPilot Runner] Pre-warm attempt for "${model.modelName}" exited (exit ${exitCode ?? 'n/a'}); will retry. Last output:\n${tail}`);
				} else {
					void (async () => {
						// Another window intentionally stopped our server to run its own model - that is the smooth
						// handoff, not a crash, so stay silent instead of flashing a "Couldn't start" toast.
						if (await this._wasReplacedByAnotherWindow(ownedPid)) {
							this._crashedBeforeReady.delete(modelId);
							this._log(`[LoCoPilot Runner] Server for ${modelId} was stopped by another window taking over; not reporting a crash.`);
							return;
						}
						await this._reportServerCrash(modelId, model.modelName, exitCode, logs);
					})();
				}
			}));

			// Promote to runningServers immediately (ready=false, phase 'loading') instead of sleeping a fixed
			// 5 seconds first. The old wait added a hard 5s floor to EVERY cold start - even a small model
			// that loads in ~1s - purely as a window for an early crash to happen before promotion. That
			// protection is event-driven anyway: onExit deletes the record and sets _crashedBeforeReady
			// (which readiness polling and warm-up both bail on), so a crashed launch can never stay
			// "running". Promoting now also lets onLineData capture load progress from the very first line
			// (previously dropped while the record didn't exist) and lets ensureServerForModel begin its
			// readiness poll right away.

			// The process may already have died while we awaited terminal creation (onExit set
			// _crashedBeforeReady and reported it) - do NOT promote a dead process or start warm-up.
			if (this._crashedBeforeReady.has(modelId)) {
				this._releaseReservedPort(port);
				this.startingServers.delete(modelId);
				this._log(`[LoCoPilot Runner] Not marking ${modelId} as running - it crashed during startup.`);
				return;
			}

			// The resident budget may have cancelled this launch while we awaited terminal creation (e.g. the
			// user selected another model). _cancelStartingServer dropped our ownership and disposed the
			// terminal, so do NOT promote a dead terminal into runningServers - that was how two models ended
			// up "running" at once.
			if (this._activeLaunchTerminals.get(modelId) !== terminal) {
				this._releaseReservedPort(port);
				this.startingServers.delete(modelId);
				this._log(`[LoCoPilot Runner] Launch for ${modelId} was superseded/cancelled during startup; not promoting to running.`);
				return;
			}

			this.startingServers.delete(modelId); // running state replaces starting state
			this.runningServers.set(modelId, { port, terminal, kind: 'llama', logs, lastUsedAt: Date.now(), ready: false });
			this._releaseReservedPort(port); // now tracked via runningServers; reservation no longer needed
			// Advertise this server to other windows so they attach to it instead of launching a duplicate.
			void this._publishActiveServerLock(port, 'llama', terminal, modelId);
			this._onDidServerStateChange.fire(modelId);
			// A resident server means estimates are now live commitments - arm the memory circuit breaker.
			this._updateMemoryWatchdog();
			// Keep the machine responsive (and cooler) while the model loads/serves: run it below the UI.
			void this._deprioritizeServerProcess(terminal, model.modelName);

			// Warm up in the background so the first real message has no kernel-JIT / cache lag.
			if (this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppWarmup) !== false) {
				this._warmUpLocalServer(modelId, port, 'llama', model.modelName);
			}

			this._log(`[LoCoPilot Runner] Terminal started with: ${cmdLineForLog}`);
		} catch (e) {
			this._releaseReservedPort(port);
			this._log(`[LoCoPilot Runner] Failed to start terminal: ${e}`);
			this._endStarting(modelId, `Failed to start llama-server terminal: ${e}`);
			throw e;
		}
	}

	/**
	 * Auto-start-on-use entry point. Reuses startServerInTerminal (which picks llama.cpp or mlx-lm),
	 * but first frees memory by evicting the least-recently-used server when the resident-model budget is
	 * reached, then waits until the server's OpenAI endpoint actually responds so the caller can send immediately.
	 */
	async ensureServerForModel(modelId: string, token: CancellationToken = CancellationToken.None): Promise<string | undefined> {
		// Already running AND ready - reuse as-is, and refresh its LRU/idle state so it isn't evicted while
		// in use. A record that exists but is not yet ready (weights still loading, e.g. a pre-warm that just
		// launched) must NOT be returned here: doing so would let the caller fire a request the server rejects
		// with 503 while it loads. Instead we fall through to _waitForServerReady below so the request waits.
		const existingRec = this.runningServers.get(modelId);
		if (existingRec?.ready) {
			// A foreign record points at another window's server; that window may have closed it since we attached.
			// Re-probe before handing back its URL - if it's gone, drop the stale handle and fall through to launch
			// our own (which will re-run cross-window coordination and either re-attach or start fresh).
			if (existingRec.foreign && !await this._probeServerHealth(existingRec.port, existingRec.kind)) {
				this._disposeForeignLogWatcher(modelId);
				this.runningServers.delete(modelId);
				this._onDidServerStateChange.fire(modelId);
				this._log(`[LoCoPilot Runner] Foreign server for ${modelId} is no longer reachable; will (re)launch.`);
			} else {
				this._touch(modelId);
				return this.getServerBaseUrl(modelId);
			}
		}

		// Only launch (and enforce the RAM budget) when there is no server record at all. If one already
		// exists but is mid-load, skip straight to waiting for it to become ready - relaunching would be a
		// no-op (startServerInTerminal guards on runningServers) and re-budgeting could evict the very model
		// we are waiting on.
		if (!existingRec) {
			// Launch (no-op if another caller already kicked it off; startServerInTerminal guards on runningServers).
			// The resident-model budget (LRU eviction, singleActiveModel -> 1) is enforced inside the launch itself
			// (_doStartServerInTerminal), so every start path - manual button, Retry, picker, auto-start - is bounded.
			// interactive=true: this runs on the user's send/use action, so a too-big model prompts "Run anyway?".
			await this.startServerInTerminal(modelId, true);
		}

		const baseUrl = this.getServerBaseUrl(modelId);
		if (!baseUrl) {
			// startServerInTerminal already surfaced the reason (missing binary, unsupported MLX, etc.).
			return undefined;
		}

		const ready = await this._waitForServerReady(baseUrl, token, modelId);
		if (!ready) {
			return undefined;
		}
		// Mark ready (phase -> 'ready') and start the idle keep-alive timer.
		const rec = this.runningServers.get(modelId);
		if (rec) {
			rec.ready = true;
			rec.loadProgress = undefined;
		}
		this._clearLaunchBlocked(modelId); // it started fine; drop any stale "won't fit" reason
		this._touch(modelId);
		this._onDidServerStateChange.fire(modelId);
		return baseUrl;
	}

	prewarmModel(modelId: string): void {
		if (this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLocalPrewarmOnSelect) === false) {
			return;
		}
		// After the memory watchdog stopped a server for system health, don't let an automatic pre-warm
		// immediately reload weights into the same starved machine. Explicit user actions (send message,
		// Start button) still launch - they re-run the availability gate, which will warn with numbers.
		if (Date.now() < this._watchdogCooldownUntil) {
			this._log(`[LoCoPilot Runner] Pre-warm of ${modelId} skipped: memory watchdog cooldown active.`);
			return;
		}
		// Nothing to do if it's already up or mid-launch.
		if (this.runningServers.has(modelId) || this.startingServers.has(modelId)) {
			if (this.runningServers.has(modelId)) {
				this._touch(modelId); // selecting a warm model should reset its idle timer
			}
			return;
		}
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		// Only pre-warm models we actually launch a managed server for (GGUF/MLX). Ollama/localhost/cloud
		// manage their own lifecycle, so there is nothing to warm here.
		if (!model || !model.localPath || (model.provider !== 'huggingface' && model.provider !== 'localhost')) {
			return;
		}
		this._log(`[LoCoPilot Runner] Pre-warming model ${modelId} in the background.`);
		// Fire-and-forget: the user's typing overlaps the weight load. Swallow errors (the eventual real
		// request will surface any failure with full context).
		this._prewarmWithRetry(modelId).catch(e => this._log(`[LoCoPilot Runner] Pre-warm for ${modelId} failed (ignored): ${e}`));
	}

	/**
	 * Pre-warm launch with one automatic retry. A pre-warm fired right at window startup races the rest of
	 * startup (notably the in-process embedder, which also spins up the GPU/Metal backend); under that
	 * transient contention the engine occasionally aborts mid-load (clean exit 1) even though the very same
	 * command starts fine a moment later - which is exactly why a manual start from the model picker always
	 * works. Rather than surface a scary "failed to start" notification for a self-healing race, we wait for
	 * startup to settle and try once more. The real request path still reports a genuine, persistent failure.
	 */
	private async _prewarmWithRetry(modelId: string): Promise<void> {
		// Let the window finish coming up before we drop the single heaviest startup operation (loading
		// multi-GB weights into RAM + spinning up the GPU/Metal backend) on top of it. Waiting for the
		// Eventually phase (idle, after restoration) plus a short configurable delay keeps that I/O and
		// GPU spike from stuttering the mouse/UI right as the workbench settles. This runs ONLY on the
		// pre-warm path, never on a real message send, so it never slows an actual request. For a model
		// the user picks later in the dropdown, Eventually has long since passed and resolves instantly,
		// so a mid-session pick still warms promptly (minus the small idle delay).
		await this.lifecycleService.when(LifecyclePhase.Eventually);
		const delayMs = this.configurationService.getValue<number>(ChatConfiguration.LocopilotLocalPrewarmStartupDelayMs);
		if (typeof delayMs === 'number' && delayMs > 0) {
			await timeout(delayMs);
			// A real request (or another trigger) may have already started it while we waited.
			if (this.runningServers.has(modelId) || this.startingServers.has(modelId)) {
				return;
			}
		}
		// First attempt is silent on crash - we retry, so don't alarm the user with a notification yet.
		this._suppressCrashNotice.add(modelId);
		const baseUrl = await this.ensureServerForModel(modelId);
		this._suppressCrashNotice.delete(modelId);
		// Success, or it failed for a real reason already surfaced by ensureServerForModel (missing binary,
		// unsupported MLX, ...) - in which case it isn't flagged as a startup crash, so don't retry.
		if (baseUrl || !this._crashedBeforeReady.has(modelId)) {
			return;
		}
		this._log(`[LoCoPilot Runner] Pre-warm for ${modelId} crashed during startup; retrying once after a short delay.`);
		this._crashedBeforeReady.delete(modelId);
		await timeout(4000); // let the embedder / other startup GPU work finish before the second attempt
		if (this.runningServers.has(modelId) || this.startingServers.has(modelId)) {
			return; // a real request (or another trigger) already (re)started it in the meantime
		}
		// Second attempt is NOT suppressed: if it still crashes, surface the real failure to the user.
		await this.ensureServerForModel(modelId);
	}

	/**
	 * Shows the "this model may not fit" decision dialog and returns the user's choice as a boolean:
	 *  - true  = "Run anyway": the model is added to {@link _forcedLaunch} so this launch (and its degraded
	 *            relaunches) skip both memory gates. The watchdog remains the safety net if it thrashes.
	 *  - false = "Keep current model" (also the Close/Esc result): selection is reverted to the model still
	 *            in use, nothing is evicted, and the launch is aborted.
	 * `hard` picks the wording: the transient "not enough free right now" case is mild; the capability case
	 * ("bigger than this machine's memory") warns that it may freeze/overheat the machine.
	 */
	/**
	 * Chat-panel message for a model that was NOT started because it couldn't fit. `hard` = larger than this
	 * machine can ever hold (capability); otherwise a transient "not enough free right now" shortfall.
	 */
	private _buildFitBlockedMessage(name: string, needGb: number, haveGb: number, hard: boolean): string {
		return hard
			? `**${name}** wasn't started: it needs about ${needGb} GB, more than this computer can safely provide (about ${haveGb} GB usable). Pick a smaller model or switch the picker to Auto.`
			: `**${name}** wasn't started: it needs about ${needGb} GB but only about ${haveGb} GB is free right now. Close other apps to free memory, pick a smaller model, or switch the picker to Auto - then send again.`;
	}

	/**
	 * Honest, platform-specific description of what "Run anyway" risks, because the failure mode of overcommitting
	 * memory differs by OS and a generic "may slow down" undersells it on the platform (macOS unified memory) where
	 * it is worst. `hard` (model larger than the machine can hold) leads with a stronger warning than the transient
	 * "not enough free right now" case. All variants end on the reassurance that the watchdog is the safety net.
	 */
	private _runAnywayConsequenceDetail(hard: boolean): string {
		const lead = hard
			? 'This model is larger than this computer can safely hold.'
			: 'There isn\'t enough free memory for it right now.';
		let mechanism: string;
		if (isMacintosh) {
			// Apple Silicon shares one memory pool between CPU and GPU, so overcommit can't be isolated to one app:
			// the OS falls back to compressing/swapping pages and the WHOLE system beach-balls, not just LoCoPilot.
			mechanism = 'On this Mac memory is shared with the GPU, so exceeding it forces heavy swapping and your entire system - not just LoCoPilot - can become slow or unresponsive until the model is stopped.';
		} else if (isWindows) {
			// Windows doesn't overcommit: an allocation past the commit limit fails outright, so the server tends to
			// crash rather than degrade. Disk-backed paging also thrashes the machine before that point.
			mechanism = 'On Windows, if memory runs out the model can fail to allocate and crash, and heavy paging to disk may make the system slow until it does.';
		} else {
			// Linux overcommits then invokes the OOM killer, which may reap a DIFFERENT process (browser, editor) -
			// not necessarily the model - to reclaim memory.
			mechanism = 'On Linux, if memory runs out the kernel may terminate this or another running application to reclaim it, and the system can slow badly from swapping first.';
		}
		return `${lead} ${mechanism} LoCoPilot will stop the model automatically if it detects the system is running out of memory.`;
	}

	private async _promptRunAnyway(modelId: string, name: string, needGb: number, haveGb: number, hard: boolean): Promise<boolean> {
		const message = `"${name}" needs about ${needGb} GB of memory, but only about ${haveGb} GB is available.`;
		const detail = this._runAnywayConsequenceDetail(hard);
		const { result } = await this.dialogService.prompt<'run' | 'keep'>({
			type: Severity.Warning,
			message,
			detail,
			buttons: [{ label: 'Run anyway', run: () => 'run' as const }],
			cancelButton: { label: 'Keep current model', run: () => 'keep' as const },
		});
		if (result === 'run') {
			this._forcedLaunch.add(modelId);
			this._clearLaunchBlocked(modelId); // proceeding now; drop any prior "blocked" reason
			this._log(`[LoCoPilot Runner] User chose "Run anyway" for ${modelId} (needs ~${needGb}GB, have ~${haveGb}GB, hard=${hard}); bypassing the fit gate.`);
			return true;
		}
		this._log(`[LoCoPilot Runner] User chose "Keep current model" for ${modelId}; not launching.`);
		this._recordLaunchBlocked(modelId, this._buildFitBlockedMessage(name, needGb, haveGb, hard));
		this._endStarting(modelId);
		this._revertSelectionAwayFrom(modelId);
		return false;
	}

	/**
	 * "Keep current model": if the declined model is the one currently SELECTED (the user just picked it),
	 * put the selection back so the picker label matches what is actually running. Reverts to the owned server
	 * still resident (the model in use), else the last model that was used, else leaves the selection alone.
	 * Deliberately never stops or changes any running server - "keep current" must be side-effect-free on it.
	 */
	private _revertSelectionAwayFrom(declinedModelId: string): void {
		if (this.customLanguageModelsService.getSelectedCustomModelId() !== declinedModelId) {
			return; // the declined launch wasn't a selection change (e.g. a background retry) - nothing to revert
		}
		const running = Array.from(this.runningServers.entries()).find(([id, rec]) => !rec.foreign && id !== declinedModelId);
		const revertTo = running?.[0]
			?? (this._lastReadyModelId && this._lastReadyModelId !== declinedModelId ? this._lastReadyModelId : undefined);
		if (revertTo) {
			this.customLanguageModelsService.setSelectedCustomModelId(revertTo);
			this._log(`[LoCoPilot Runner] Reverted model selection to ${revertTo} after declining ${declinedModelId}.`);
		}
	}

	/**
	 * Availability guard applied to EVERY launch path (message send, manual Start, Retry, picker, pre-warm):
	 * may we load `modelId` given the RAM free RIGHT NOW? Returns true (proceed) whenever we can't reason
	 * about it - unknown weight size, no live probe, a discrete-GPU backend whose VRAM occupancy we can't
	 * size, or web. When the minimum footprint clearly won't fit currently-available memory (or the kernel
	 * already reports critical pressure): a `_forcedLaunch` model proceeds; an INTERACTIVE launch (user action)
	 * shows the Run-anyway / Keep-current dialog; a non-interactive one (pre-warm) is skipped silently. Called
	 * BEFORE the launch's own eviction, so RAM that stopping our other resident servers will free is credited -
	 * a model that fits AFTER the switch is never blocked. This is the transient companion to the capability
	 * gate (models too big for total RAM).
	 */
	private async _memoryAllowsLaunch(modelId: string, interactive: boolean): Promise<boolean> {
		const fit = await this._computeLaunchFit(modelId, interactive);
		if (!fit || fit.fits) {
			return true; // can't measure (never block on the unmeasurable), or it fits.
		}
		this._log(`[LoCoPilot Runner] ${modelId} would not fit free RAM: needs ~${fit.needGb}GB but only ~${fit.haveGb}GB is free right now (pressure=${fit.pressure}, evictable ~${fit.evictableGb}GB, interactive=${interactive}).`);
		if (!interactive) {
			this._recordLaunchBlocked(modelId, this._buildFitBlockedMessage(fit.name, fit.needGb, fit.haveGb, false));
			this._endStarting(modelId); // background pre-warm: skip silently, no dialog/toast
			return false;
		}
		// Transient shortfall (soft): eviction is already credited above, so "Run anyway" usually fits.
		return this._promptRunAnyway(modelId, fit.name, fit.needGb, fit.haveGb, false);
	}

	async wouldModelFitForLaunch(modelId: string): Promise<boolean> {
		// Read-only: same fit math as the interactive launch gate, no prompt / no recorded block / no start.
		const fit = await this._computeLaunchFit(modelId, true);
		return !fit || fit.fits;
	}

	/**
	 * Pure, side-effect-free fit computation shared by {@link _memoryAllowsLaunch} and the read-only
	 * {@link wouldModelFitForLaunch} predicate. Returns `undefined` when the fit can't be measured (non-RAM
	 * backend, missing model, already force-launched, no live probe, unresolved path, or unknown footprint) -
	 * every case the real gate treats as "don't block". Otherwise reports whether the model fits and the
	 * numbers used, so callers can log / prompt without recomputing.
	 */
	private async _computeLaunchFit(modelId: string, interactive: boolean): Promise<{ fits: boolean; needGb: number; haveGb: number; name: string; pressure: MemoryPressureLevel; evictableGb: number } | undefined> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.localPath || !this._useMemoryBudget()) {
			return undefined; // discrete-GPU / CPU-VRAM-less reasoning, or missing model -> don't block
		}
		if (this._forcedLaunch.has(modelId)) {
			return undefined; // user already chose "Run anyway" for this model
		}
		const mem = await this._getMemoryStatus();
		if (!mem) {
			return undefined; // no live probe -> never block on what we can't measure
		}
		const kind = await this._intendedServerKind(modelId);
		const backend: LlamaBackend = kind === 'mlx' ? 'metal' : this.getBackend();
		let modelPath: string;
		try {
			modelPath = kind === 'mlx' ? await this.getMlxModelRootPath(model.localPath) : await this.resolveModelFilePath(model.localPath);
		} catch {
			return undefined;
		}
		// MLX commits a ~15%-of-RAM prompt cache alongside the weights; reserve it here so a model that leaves no
		// headroom for its cache trips this SOFT "not enough free right now" gate (Run-anyway available) instead
		// of thrashing after launch. llama.cpp's growable KV is bounded by the context clamp instead, so 0 there.
		const extraResidentBytes = kind === 'mlx' ? this._mlxRuntimeReserveBytes(mem.totalBytes) : 0;
		const fit = await this._computeFit(modelPath, backend, undefined, extraResidentBytes);
		if (!fit) {
			return undefined; // unknown footprint -> don't block
		}
		// Credit only the RAM the launch's own eviction will ACTUALLY free. _enforceResidentBudget keeps the
		// (maxResidentModels - 1) most-recently-used other servers and evicts the rest, so crediting EVERY
		// resident other would over-count when the budget allows more than one model to stay (a model that only
		// "fits" because we assumed servers that will remain resident get evicted). With the default budget of 1
		// this reduces to "credit all others" as before; it only tightens the multi-resident case (Q3). The
		// memory budget may evict still more, so this is the conservative (never over-admitting) direction.
		const keepOthers = Math.max(0, this._maxResidentModels() - 1);
		const otherServers = Array.from(this.runningServers.entries())
			.filter(([id, rec]) => id !== modelId && !rec.foreign)
			.sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt); // most-recently-used first (these are kept)
		let evictableBytes = 0;
		for (const [id] of otherServers.slice(keepOthers)) {
			evictableBytes += await this._estimateModelCost(id);
		}
		const availableNow = mem.availableBytes + evictableBytes;
		// Only the NON-RECLAIMABLE working set must be physically free at launch: KV cache + compute/graph
		// overhead (+ the MLX prompt-cache reserve folded into requiredBytes via extraResidentBytes). The
		// weights do NOT need to be free right now - on CPU they are mmap-pageable, and on Metal they are wired
		// only up to the ceiling the pre-flight CAPABILITY gate (_checkModelFitsOrNotify) already verified, which
		// macOS satisfies by reclaiming file cache / compressing cold pages. Gating an interactive launch on the
		// whole footprint (weights included) is exactly what falsely refused a model that fits the machine
		// whenever the editor + browser were holding reclaimable RAM (e.g. Gemma 4B on a 16 GB Mac). Background
		// pre-warm keeps the strict full-footprint check - refusing an optional speculative load is harmless.
		const requiredFreeNow = interactive ? Math.max(0, fit.requiredBytes - fit.weightBytes) : fit.requiredBytes;
		const GB = 1024 * 1024 * 1024;
		return {
			fits: mem.pressure !== 'critical' && requiredFreeNow <= availableNow,
			needGb: Math.ceil(requiredFreeNow / GB),
			haveGb: Math.max(0, Math.floor(availableNow / GB)),
			name: model.displayName || model.modelName,
			pressure: mem.pressure,
			evictableGb: Math.round(evictableBytes / GB),
		};
	}

	/**
	 * Extracts a short, human-friendly load-progress hint from a llama.cpp/mlx server log line, or
	 * undefined when the line carries no progress signal. Used by the loading UI while weights load.
	 */
	private _parseLoadProgress(line: string): string | undefined {
		const l = line.trim();
		// llama.cpp prints an explicit load progress percentage, e.g. "load: ... 42.00 %".
		const pct = l.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
		if (pct && /load|tensor|model|buffer/i.test(l)) {
			return `Loading weights… ${Math.round(parseFloat(pct[1]))}%`;
		}
		if (/load_tensors|loading model|llama_model_loader/i.test(l)) {
			return 'Loading weights…';
		}
		if (/warming up|warmup/i.test(l)) {
			return 'Warming up…';
		}
		return undefined;
	}

	/**
	 * Polls the OpenAI-compatible `/models` endpoint (served by both llama.cpp and mlx-lm) until it
	 * responds 200 or the timeout/cancellation hits. Engine-agnostic readiness check.
	 */
	private async _waitForServerReady(baseUrl: string, token: CancellationToken, modelId?: string): Promise<boolean> {
		const url = `${baseUrl}/models`;
		// Large models on a cold cache can take several minutes to load into memory; poll for up to ~5
		// minutes. We only give up early when the process actually crashes (checked below), so the wait is
		// bounded by real readiness, not an arbitrary short timeout that surfaced a false "could not start".
		// Poll fast (250ms) for the first 5 seconds so a small model that's ready in ~1-2s doesn't pay a
		// full extra second of 1s-granularity polling, then back off to 1s for the long tail.
		const fastAttempts = 20; // 20 x 250ms = first 5 seconds
		const maxAttempts = fastAttempts + 295;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (token.isCancellationRequested) {
				return false;
			}
			// If the server process already exited (crashed at launch), stop polling immediately - the
			// onExit handler has surfaced the real reason. Avoids the old 2-minute "running" hang.
			if (modelId && this._crashedBeforeReady.has(modelId)) {
				return false;
			}
			try {
				const res = await this.requestService.request({ type: 'GET', url }, token);
				if ((res.res.statusCode ?? 0) === 200) {
					return true;
				}
			} catch {
				// not up yet
			}
			await timeout(attempt < fastAttempts ? 250 : 1000);
		}
		this._log(`[LoCoPilot Runner] Server at ${baseUrl} did not become ready in time.`);
		return false;
	}

	/**
	 * Inspects a single line of mlx_lm.server output for a fatal model-load failure and, if found, returns
	 * a human-readable explanation; otherwise undefined. mlx_lm prints a Python traceback to stderr when the
	 * worker thread can't load the weights. The most common case for users is picking an MLX repo that is a
	 * *multimodal* model (Gemma 3n / "E4B", Qwen-VL, etc.): mlx-lm is text-only and rejects the extra
	 * vision/audio weights with "Received N parameters not in model", which needs mlx-vlm instead.
	 */
	private _mlxLoadFailureReason(line: string, modelName: string): string | undefined {
		const l = line.toLowerCase();
		// Multimodal / architecture-mismatch: weights mlx-lm's text loader doesn't recognize.
		if (l.includes('parameters not in model') || l.includes('language_model.model') || l.includes('vision_tower') || l.includes('audio_tower')) {
			return `The MLX model "${modelName}" looks like a multimodal model, which the text-only MLX engine (mlx-lm) cannot run. Use a text MLX build (its weights load cleanly), or a GGUF build with llama.cpp instead.`;
		}
		// Unsupported architecture in this mlx-lm version.
		if (l.includes('model type') && l.includes('not supported') || l.includes('no module named') && l.includes('mlx_lm.models')) {
			return `The MLX model "${modelName}" uses an architecture this version of mlx-lm does not support. Update the bundled MLX runtime, or use a GGUF build with llama.cpp instead.`;
		}
		// Generic load-time errors (out of memory, corrupt/incomplete download, safetensors errors).
		if (l.includes('safetensorerror') || l.includes('metal::malloc') || (l.includes('error') && l.includes('safetensors'))) {
			return `The MLX model "${modelName}" failed to load (possibly a corrupt or incomplete download, or out of memory). Try re-downloading it, or use a smaller model.`;
		}
		return undefined;
	}

	/**
	 * Starts `mlx_lm.server` for downloaded Hugging Face MLX weights (Apple Silicon only).
	 */
	private async _startMlxServerInTerminal(modelId: string, model: ICustomLanguageModel & { localPath: string }): Promise<void> {
		// Preflight: never spawn mlx_lm.server with a missing/empty model path. Doing so builds `--model ''`,
		// which makes the server start without weights and then either crash with a Python traceback or hang
		// (GET /v1/models keeps returning 200 while chat requests block forever). Fail fast with a clear,
		// actionable message and no wasted subprocess instead.
		const localPath = model.localPath?.trim();
		const pathError = await this._validateMlxModelPath(localPath);
		if (pathError) {
			this._log(`[LoCoPilot Runner] MLX preflight failed for "${model.modelName}": ${pathError}`);
			this._endStarting(modelId, pathError);
			if (!this._suppressCrashNotice.has(modelId)) {
				this.notificationService.notify({ severity: Severity.Error, message: pathError });
			}
			return;
		}

		const modelDir = await this.getMlxModelRootPath(localPath!);
		const port = await this.findAvailablePort(LOCOPILOT_MLX_SERVER_PORT);
		const pythonCmd = await this.resolveMlxPython();

		// Automatic mlx-lm tuning (default on): cap the server's cross-request prompt cache to a slice of
		// total RAM (upstream default is unbounded, which lets cached KV crowd out a small machine), and use
		// the catalog-paired small draft model for speculative decoding when it is downloaded and fits.
		// Skipped for the session once an older mlx-lm rejected the flags (argparse exits on unknown args;
		// detected below and relaunched without them).
		const mlxTuning: MlxServerTuning = {};
		const mlxAutoTune = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotMlxAutoTune) !== false
			&& !this._mlxExtraFlagsUnsupported;
		if (mlxAutoTune) {
			const mem = await this._getSystemMemory();
			if (mem?.totalmem && mem.totalmem > 0) {
				mlxTuning.promptCacheBytes = Math.floor(mem.totalmem * 0.15);
				// Cap MLX's total Metal allocation at the same wired budget the llama.cpp path uses. MLX's own
				// default is ~95% of unified RAM - far past the wired ceiling - and mlx_lm.server only pins the
				// wired limit, so nothing upstream stops a long prompt's KV growth from paging the machine.
				// Applied via the -c bootstrap in getMlxLmServerCommand (no CLI flag exists); soft cap - MLX
				// throttles allocation instead of hard-failing. Also cap the freed-buffer reuse cache, which
				// otherwise defaults to the memory limit and can hoard GBs after a big prefill.
				mlxTuning.memoryLimitBytes = metalOffloadBudgetBytes(mem.totalmem, (await this._getHardwareInfo())?.metalWiredLimitBytes);
				mlxTuning.cacheLimitBytes = Math.floor(mem.totalmem * 0.10);
				this._log(`[LoCoPilot Runner] MLX memory limits: mx.set_memory_limit ~${Math.round(mlxTuning.memoryLimitBytes / 1e9)}GB (wired budget), mx.set_cache_limit ~${Math.round(mlxTuning.cacheLimitBytes / 1e9)}GB.`);
			}
			const draft = await this._resolvePairedDraft(model, 'mlx');
			if (draft && await this._extrasFitBudget(modelDir, 'metal', undefined, draft.bytes)) {
				mlxTuning.draftModelDir = draft.path;
				this._log(`[LoCoPilot Runner] Auto speculative decoding (MLX): drafting with ${draft.repoId} (~${Math.round(draft.bytes / 1e6)}MB).`);
			} else if (draft) {
				this._log(`[LoCoPilot Runner] Auto speculative decoding (MLX): draft ${draft.repoId} skipped (would exceed the memory budget).`);
			}
		}
		const mlxExtraFlagsUsed = !!(mlxTuning.promptCacheBytes || mlxTuning.draftModelDir);
		const { command, args } = getMlxLmServerCommand(modelDir, port, pythonCmd, mlxTuning);
		const q = (p: string) => (p.includes(' ') || p.includes('"') ? `"${p.replace(/"/g, '\\"')}"` : p);
		const argsQuoted = args.map(a => (a === modelDir || a.includes(' ') ? q(a) : a));
		const cmdLine = [command, ...argsQuoted].join(' ');

		this._log(`[LoCoPilot Runner] Starting mlx-lm server for model ${modelId} on port ${port}: ${cmdLine}`);

		this._beginStarting(modelId);
		try {
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: `MLX - ${model.modelName}`,
					// Transient so the process is torn down on window reload instead of being orphaned by the
					// pty host (see the llama-server launch for the full rationale).
					isTransient: true,
					// Keep the server terminal hidden; logs still reach the in-app Logs view via onLineData.
					hideFromUser: true,
				}
			});
			// Claim launch ownership so the resident budget can cancel this in-flight launch (and the promotion
			// guard below can detect that cancellation) just like the llama path.
			this._activeLaunchTerminals.set(modelId, terminal);

			// Register the log listener BEFORE the command runs: an old mlx-lm rejects unknown optional flags
			// via argparse within the first ~1-2s ("unrecognized arguments: ..."), which is inside the startup
			// wait below - a listener registered only after promotion would miss it entirely.
			const logs: string[] = [];
			let mlxRejectedExtraFlags = false;
			this._register(terminal.onLineData(line => {
				logs.push(line);
				if (logs.length > LoCoPilotLocalModelRunner.MAX_LOG_LINES) {
					logs.splice(0, logs.length - LoCoPilotLocalModelRunner.MAX_LOG_LINES);
				}
				this._onDidLogUpdate.fire(modelId);
				this._mirrorLogsToSharedFile(modelId); // so windows attached to this server see the logs too

				// Optional-tuning-flag rejection (argparse): an old mlx-lm exits immediately on unknown args,
				// so this launch is already dead. Remember for the session, tear the launch down right here
				// (it may or may not have been promoted to runningServers yet), and retry once WITHOUT the
				// flags - the session flag makes the retry build a plain command line.
				if (mlxExtraFlagsUsed && !mlxRejectedExtraFlags && /unrecognized arguments/i.test(line)) {
					mlxRejectedExtraFlags = true;
					this._mlxExtraFlagsUnsupported = true;
					this._log(`[LoCoPilot Runner] mlx_lm.server rejected the optional tuning flags (old mlx-lm); they stay off for this session: ${line}`);
					this._releaseReservedPort(port);
					if (this.runningServers.get(modelId)?.terminal === terminal) {
						this.stopServer(modelId);
					} else if (this._activeLaunchTerminals.get(modelId) === terminal) {
						this._cancelStartingServer(modelId);
					}
					if (this._activeLaunchTerminals.get(modelId) === terminal) {
						this._activeLaunchTerminals.delete(modelId);
					}
					this._log(`[LoCoPilot Runner] Relaunching MLX server for ${modelId} without the optional tuning flags.`);
					timeout(1000).then(() => {
						if (!this.runningServers.has(modelId) && !this.startingServers.has(modelId)) {
							this.startServerInTerminal(modelId).catch(e => this._log(`[LoCoPilot Runner] MLX relaunch without tuning flags failed: ${e}`));
						}
					});
					return;
				}

				// mlx_lm loads the weights on a background worker thread; if that load throws (e.g. an
				// unsupported / multimodal architecture), the worker thread dies but the HTTP thread stays
				// up and keeps answering GET /v1/models with 200. So our readiness probe passes, the model
				// shows "ready", yet every chat request enqueues and blocks forever with no error - an
				// infinite spinner. Detect the load failure from the server's own traceback and surface it
				// as a real error instead of hanging. Only act before the model has served anything.
				const current = this.runningServers.get(modelId);
				if (current && !current.ready && !this._crashedBeforeReady.has(modelId)) {
					const reason = this._mlxLoadFailureReason(line, model.modelName);
					if (reason) {
						this._crashedBeforeReady.add(modelId);
						this._log(`[LoCoPilot Runner] MLX model "${model.modelName}" failed to load: ${line}`);
						this.stopServer(modelId);
						this._endStarting(modelId, reason);
						if (!this._suppressCrashNotice.has(modelId)) {
							this.notificationService.notify({ severity: Severity.Error, message: reason });
						}
					}
				}
			}));

			await new Promise<void>(resolve => setTimeout(resolve, 400));
			await terminal.sendText(cmdLine, true);

			// Promote immediately (ready=false) instead of sleeping a fixed 5 seconds - same rationale as the
			// llama path above. The old wait existed to observe an argparse flag rejection before promotion;
			// that detection now lives in the onLineData handler (which tears down and relaunches whether the
			// rejection lands before or after promotion), so nothing needs the fixed window anymore. Promoting
			// now also means the load-failure detection in onLineData (which gates on the runningServers
			// record) covers tracebacks printed in the first seconds, which previously fell into the gap.

			// The resident budget (or the flag-rejection teardown above) may have cancelled this launch while
			// we awaited the terminal. Don't promote a disposed terminal into runningServers - that produced
			// two "running" models at once.
			if (this._activeLaunchTerminals.get(modelId) !== terminal) {
				this._releaseReservedPort(port);
				this.startingServers.delete(modelId);
				this._log(`[LoCoPilot Runner] MLX launch for ${modelId} was superseded/cancelled during startup; not promoting to running.`);
				return;
			}

			this.startingServers.delete(modelId);
			this.runningServers.set(modelId, { port, terminal, kind: 'mlx', servedModelId: modelDir, logs, lastUsedAt: Date.now(), ready: false });
			this._releaseReservedPort(port); // now tracked via runningServers; reservation no longer needed
			// Advertise this server to other windows so they attach to it instead of launching a duplicate.
			void this._publishActiveServerLock(port, 'mlx', terminal, modelId, modelDir);
			this._onDidServerStateChange.fire(modelId);
			// A resident server means estimates are now live commitments - arm the memory circuit breaker.
			this._updateMemoryWatchdog();
			// Keep the machine responsive (and cooler) while the model loads/serves: run it below the UI.
			// The delay lets the terminal's shell fork the actual python server first (see the helper).
			void this._deprioritizeServerProcess(terminal, model.modelName, 3000);

			// Warm up in the background: mlx_lm.server answers /v1/models 200 while the weights are still
			// loading, so this 1-token ping is the first thing that truly waits for the model to be usable -
			// it absorbs the load + Metal kernel compile ahead of the user's first message and flips the
			// phase to ready when it completes. The request's `model` must be the served model dir (mlx_lm
			// is per-request model-aware; a mismatched id makes it try to load a different model).
			if (this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppWarmup) !== false) {
				this._warmUpLocalServer(modelId, port, 'mlx', modelDir);
			}

			this._register(terminal.onDisposed(() => {
				this._releaseReservedPort(port);
				if (this._activeLaunchTerminals.get(modelId) === terminal) {
					this._activeLaunchTerminals.delete(modelId);
				}
				if (this.runningServers.has(modelId)) {
					this.runningServers.delete(modelId);
					void this._wasReplacedByAnotherWindow(this._ownedServerPid); // clears our stale lock entry, if any
					this._onDidServerStateChange.fire(modelId);
					this._log(`[LoCoPilot Runner] MLX terminal closed for model ${modelId}`);
				}
			}));
		} catch (e) {
			this._releaseReservedPort(port);
			this._log(`[LoCoPilot Runner] Failed to start MLX terminal: ${e}`);
			const usingBundled = pythonCmd === getBundledMlxPython(this._appRoot);
			const failMsg = usingBundled
				? `Failed to start the bundled MLX runtime. This is unexpected - try reinstalling LoCoPilot. To use your own Python instead, set "locopilot.mlx.pythonPath".`
				: `Failed to start MLX server with "${pythonCmd}". Install mlx-lm (${pythonCmd} -m pip install 'mlx-lm', Apple Silicon only), or set "locopilot.mlx.pythonPath".`;
			this._endStarting(modelId, failMsg);
			throw e;
		}
	}

	/**
	 * Runs the Ollama model in a new terminal.
	 */
	async runOllamaModelInTerminal(modelId: string): Promise<void> {
		if (this.runningServers.has(modelId)) {
			this._log(`[LoCoPilot Runner] Ollama model ${modelId} is already running.`);
			return;
		}

		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || model.provider !== 'ollama') {
			this._log(`[LoCoPilot Runner] Ollama model ${modelId} not found.`);
			return;
		}
		const baseUrl = (model.localPath || 'http://localhost:11434').replace(/\/$/, '');
		// If baseUrl is not default, we might need to set OLLAMA_HOST
		const hostEnv = baseUrl !== 'http://localhost:11434' ? `OLLAMA_HOST=${baseUrl} ` : '';
		// Keep the model resident so subsequent chat requests skip the cold-start reload. Empty = Ollama default.
		const keepAlive = (this.configurationService.getValue<string>(ChatConfiguration.LocopilotOllamaKeepAlive) ?? '').trim();
		const keepAliveArg = keepAlive ? ` --keepalive ${keepAlive}` : '';
		const cmdLine = `${hostEnv}ollama run${keepAliveArg} ${model.modelName}`;
		this._log(`[LoCoPilot Runner] Running Ollama model: ${cmdLine}`);
		this._beginStarting(modelId);
		try {
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: `Ollama - ${model.modelName}`,
					// Transient so it doesn't get revived/orphaned across window reloads (see llama-server).
					isTransient: true,
					// Keep the server terminal hidden; logs still reach the in-app Logs view via onLineData.
					hideFromUser: true,
				}
			});
			await new Promise<void>(resolve => setTimeout(resolve, 400));
			await terminal.sendText(cmdLine, true);

			await timeout(5000);

			const logs: string[] = [];
			this.startingServers.delete(modelId);
			// For Ollama, we don't manage the port, it's always the baseUrl port, but we track the terminal
			this.runningServers.set(modelId, { port: 11434, terminal, kind: 'llama', logs, lastUsedAt: Date.now(), ready: true });
			this._onDidServerStateChange.fire(modelId);

			this._register(terminal.onLineData(line => {
				logs.push(line);
				if (logs.length > LoCoPilotLocalModelRunner.MAX_LOG_LINES) {
					logs.splice(0, logs.length - LoCoPilotLocalModelRunner.MAX_LOG_LINES);
				}
				this._onDidLogUpdate.fire(modelId);
			}));

			this._register(terminal.onDisposed(() => {
				if (this.runningServers.has(modelId)) {
					this.runningServers.delete(modelId);
					this._onDidServerStateChange.fire(modelId);
					this._log(`[LoCoPilot Runner] Terminal closed for Ollama model ${modelId}`);
				}
			}));
		} catch (e) {
			this._log(`[LoCoPilot Runner] Failed to run Ollama in terminal: ${e}`);
			this._endStarting(modelId, `Failed to start Ollama terminal: ${e}`);
			throw e;
		}
	}

	runModel(modelId: string): void {
		this.startServerInTerminal(modelId, true); // explicit user "Run" action -> may prompt "Run anyway?"
	}

	private _log(msg: string, ...args: unknown[]): void {
		this.logService.info(msg, ...args);
		this.locopilotFileLog.log(msg, ...args);
	}
}
