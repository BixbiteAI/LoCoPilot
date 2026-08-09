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
	planMoeExpertOffload,
	buildExpertOffloadOverride,
	computeKvBudgetBytes,
	clampContextSize,
	kvCacheBytesForContext,
	selectAutomaticKvCache,
	shouldUseBundledVulkan,
	metalOffloadBudgetBytes,
	usableSystemMemoryBytes,
	discreteVramBudgetBytes,
	splitDiscreteGpuFootprint,
	KV_BUDGET_FRACTION,
	KV_CLAMP_BUDGET_FRACTION,
	RUNTIME_OVERHEAD_BYTES,
	runtimeOverheadBytesForTuning,
	DEFAULT_LLAMA_CONTEXT_SIZE,
	MIN_CLAMPED_CONTEXT,
	ABSOLUTE_MIN_CONTEXT,
	MAX_CLAMPED_CONTEXT,
	TARGET_MIN_CONTEXT,
	LOCOPILOT_LLAMA_SERVER_PORT,
	LlamaBackend,
	resolveKvCachePlan,
	kvCacheBytesPerElem,
	kvPlanBytesPerElem,
	kvPlanId,
	KV_CACHE_TIERS,
	symmetricKvPlan,
	DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16,
	DEFAULT_CLAMP_LAYER_COUNT,
	MTP_DRAFT_KV_LAYER_EQUIV,
	mtpHeadResidentBytes,
	swaFullKvHeadroomBytes,
	maxContextForFullSwa,
	MIN_FULL_SWA_CONTEXT,
	SWA_FULL_REPLAN_TARGET_CONTEXT,
	SWA_FULL_REPLAN_MAX_TIER,
	applyKvQuantCapability,
	kvCacheTiersFor,
	detectRejectedKvQuantHalf,
	KV_QUANT_FULLY_SUPPORTED,
	resolveAutoPerformanceProfile,
	type ResolvedPerformanceProfile,
	type LlamaServerTuning,
	type FlashAttentionMode,
	type KvCacheType,
	type KvCachePlan,
	type KvQuantCapability
} from './locopilotLlamaCppServer.js';
import { readGgufModelInfo, isMoeModelInfo, isSwaModelInfo, kvBytesPerTokenPerLayer, kvLayerCount, recurrentStateBytes, type IGgufModelInfo } from './locopilotGgufMetadata.js';
import { readMlxModelInfo } from './locopilotMlxMetadata.js';
import { ILoCoPilotSystemInfoService, type IGpuInfo, type IMemoryStatus, type ISystemHardwareInfo, type MemoryPressureLevel, type PowerSource } from '../../../../platform/locopilotSystemInfo/common/locopilotSystemInfo.js';
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
	MLX_MIN_PROMPT_CACHE_BYTES,
	MLX_TIGHT_FIT_HEADROOM_BYTES,
	MLX_PROMPT_CACHE_DIR_ENV,
	MLX_PROMPT_CACHE_EXT,
	MLX_PROMPT_CACHE_HELPER_FILENAME,
	MLX_PROMPT_CACHE_RESTORE_PATH,
	MLX_PROMPT_CACHE_SAVE_PATH,
	type MlxServerTuning,
} from './locopilotMlxServer.js';
import { MLX_PROMPT_CACHE_HELPER_SOURCE } from './locopilotMlxPromptCacheScript.js';
import { showTransientNotification } from './locopilotNotify.js';
import { findDraftPairing, type IAutoModelPlan, type IHardwareProfile } from './locopilotModelCatalog.js';
import { LoCoPilotModelDownloadService, modelDownloadDirName, isMmprojGgufPath, isMtpGgufPath } from './locopilotModelDownloadService.js';
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

/**
 * How long a "launch blocked at the fit gate / crashed" reason stays relevant to the chat panel before it's
 * treated as stale. 5 minutes (was 60s): a model that terminally failed keeps reporting its real reason for a
 * while instead of decaying back to the misleading "taking a moment to start". A fresh launch attempt or a
 * successful ready still clears it immediately.
 */
const LAUNCH_BLOCK_TTL_MS = 300_000;
/**
 * The pre-launch footprint is necessarily an estimate: mmap residency, driver scratch and reclaimable file
 * cache vary by engine/OS. Treat a shortfall within 10% (at least 512 MiB) as estimator noise rather than
 * interrupting the user. The hard total-capability gate and runtime watchdog still bound unsafe launches.
 */
const LAUNCH_FIT_TOLERANCE_FRACTION = 0.10;
const LAUNCH_FIT_TOLERANCE_MIN_BYTES = 512 * 1024 * 1024;

/**
 * Lifecycle phase of a local model server:
 *  - 'starting': process is being launched (no port bound yet).
 *  - 'loading' : process is up but still reading weights into RAM/VRAM (endpoint not 200 yet).
 *  - 'ready'   : the OpenAI endpoint answered 200; safe to send requests.
 */
export type LocalServerPhase = 'starting' | 'loading' | 'ready' | 'stopping';

/**
 * Cross-window active-server lock file contents. A launch first writes a 'claiming' entry (atomic exclusive
 * create - only one window across the machine wins the race to start a server), then overwrites it with a
 * 'running' entry carrying the real pid/port once the server is up. Other windows read this to attach to or
 * replace the single active server.
 */
/**
 * A launch's measured footprint against the memory pool that constrains it. On single-pool backends (Metal /
 * CPU) `requiredBytes` vs `usableBytes` is the whole story. On a discrete GPU the footprint is split across two
 * pools that fail differently - VRAM hard-OOMs, host RAM pages - so the pair reports whichever pool is TIGHTER,
 * and the host half is carried separately because the live-availability gate can only measure host RAM.
 */
interface IModelFit {
	/** Footprint in the constraining pool. */
	readonly requiredBytes: number;
	/** Capacity of that same pool. */
	readonly usableBytes: number;
	/** Weight-file bytes, for callers that discount mmap-able / VRAM-resident weights. */
	readonly weightBytes: number;
	/** Discrete GPU only: the host-RAM half of the footprint. */
	readonly hostRequiredBytes?: number;
	/** Discrete GPU only: the weight bytes that will reside in VRAM after the offload plan. */
	readonly gpuWeightBytes?: number;
}

/**
 * A planned MLX launch: the effective context window plus every mlx_lm.server knob it implies. Produced before
 * the memory gates run (so they measure the real configuration) and consumed by the launch itself, mirroring
 * how the llama.cpp path finalizes its tuning ahead of the same gates.
 */
interface IMlxLaunchPlan {
	readonly tuning: MlxServerTuning;
	/** Effective window. Mutable: the availability gate may shrink it to fit memory free right now. */
	contextSize: number;
	/** False when auto-tuning is off (or a build rejected the flags), so the launch skips the add-ons too. */
	readonly autoTuned: boolean;
}

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
	 * button, Retry, picker): a model that won't fit shows the "Run anyway / Cancel" dialog. false for
	 * background pre-warm / crash-relaunch: a non-fitting model is skipped silently, and a prior "Run anyway"
	 * choice (the `_forcedLaunch` flag) still carries the relaunch through.
	 * Returns true when the launch proceeded (already running, attached, or spawned past the fit gates);
	 * false when it was abandoned (Cancel at the fit dialog, silent pre-warm skip, missing path, etc.).
	 */
	startServerInTerminal(modelId: string, interactive?: boolean): Promise<boolean>;
	/**
	 * Ensures a local server for the model is running and ready to answer chat requests.
	 * If not running, starts it (evicting the least-recently-used server first when the resident-model
	 * budget is reached) and waits until the OpenAI-compatible endpoint responds. Reusing a running
	 * server also refreshes its keep-alive idle timer.
	 * Returns the server base URL when ready, or undefined if it could not be started.
	 * `interactive` (default true) mirrors startServerInTerminal's flag: true for a user action (send/Start),
	 * where a non-fitting model may show the "Run anyway?" dialog; false for background pre-warm, where a
	 * non-fitting model is skipped silently instead of interrupting the user with a modal.
	 */
	ensureServerForModel(modelId: string, token?: CancellationToken, interactive?: boolean): Promise<string | undefined>;
	/**
	 * Marks a foreground request as active so idle-unload cannot stop its server mid-stream. Calls must be
	 * balanced with {@link endModelRequest}, normally from a `finally` block.
	 */
	beginModelRequest(modelId: string): void;
	/** Marks a foreground request complete and starts keep-alive from completion of the final active request. */
	endModelRequest(modelId: string): void;
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
	 * True between a {@link stopServerAndAwaitTeardown} request and the moment the process is really gone and
	 * its RAM has come back. UI uses this for a disabled "Stopping..." state so the row can't offer Start while
	 * the weights are still resident - a restart in that window measures pre-teardown memory and needlessly
	 * fails the fit gate (or pops "Run anyway?") for a model that fits fine seconds later.
	 */
	isServerStopping(modelId: string): boolean;
	/**
	 * Stop a server and resolve only once its process has exited and the OS has released its memory. Prefer
	 * this over the fire-and-forget {@link stopServer} for user-facing stop controls: it publishes a
	 * 'stopping' phase (see {@link isServerStopping}) for the whole teardown, and a launch of the same model
	 * queued during that window waits for it rather than racing the dying process for RAM.
	 */
	stopServerAndAwaitTeardown(modelId: string): Promise<void>;
	/**
	 * Read-only mirror of the interactive launch gate for Auto's step-down: would `modelId` fit the RAM a
	 * launch would ACTUALLY get right now (live available + what this launch's own eviction frees, counting
	 * only the non-reclaimable working set)? Runs the same math as the real gate but WITHOUT side effects - no
	 * "Run anyway?" prompt, no recorded block, no server start. True when it fits or the fit can't be measured
	 * (non-RAM backend, no probe, unknown footprint - i.e. the real gate wouldn't block either).
	 */
	wouldModelFitForLaunch(modelId: string): Promise<boolean>;

	/**
	 * What the launch planner would ACTUALLY give `modelId` on this machine - the real weight bytes on disk
	 * (whichever quant was downloaded) and the context window the clamp would grant. Feeds Auto's ranking so it
	 * prefers a model that runs WELL over the biggest one that merely loads (see {@link IAutoModelPlan}).
	 *
	 * SYNCHRONOUS and cache-backed by design: Auto resolves on render paths (the picker label redraws on every
	 * dropdown open), which cannot await. A miss returns undefined - meaning "not measured yet, use the catalog
	 * figures" - and schedules a background measurement, so the first paint after a model appears is catalog-
	 * accurate and every later one is planner-accurate.
	 */
	getAutoPlan(modelId: string): IAutoModelPlan | undefined;

	/**
	 * This machine's hardware facts for the "Best for you" recommendation - total RAM, Apple Silicon, and the
	 * target GPU's VRAM. Sourced here (rather than each UI reading `startupMetrics.totalmem` on its own) so the
	 * chat picker's badge and the model-list chip are computed from IDENTICAL inputs and cannot disagree.
	 *
	 * Synchronous and cache-backed for the same reason as {@link getAutoPlan}: these are render paths. Returns
	 * undefined until the GPU probe completes, which callers treat as "fall back to the curated tier pick".
	 */
	getHardwareProfile(): IHardwareProfile | undefined;
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
	private readonly _startInFlight = new Map<string, Promise<boolean>>();
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
	/** Periodic health re-probe of foreign records (servers owned by other windows) - see _updateForeignProbe. */
	private _foreignProbeTimer: number | undefined;
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
		/**
		 * Epoch ms this record was promoted (the launch's terminal came up). The memory watchdog uses it for a
		 * load-grace window: the RAM dip while multi-GB weights load is an expected, budgeted transient, so
		 * soft kill signals (low-available / paging) are ignored for a short period after promotion - only the
		 * hard near-OOM floor and thermal emergencies act during the load.
		 */
		startedAt: number;
		/** True once the OpenAI endpoint answered 200 (phase 'ready'); false while still loading weights. */
		ready: boolean;
		/** Number of requests currently streaming through this server; idle-unload is suspended while non-zero. */
		activeRequests?: number;
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
	 * In-flight teardowns keyed by model: the promise resolves when the process is gone AND its memory has
	 * been observed to come back (see _stopServerAndWait). Drives the 'stopping' phase, and a launch of the
	 * same model started during the window awaits it instead of gating against RAM the dying process still holds.
	 */
	private readonly _pendingStops = new Map<string, Promise<void>>();
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
	 * Model ids whose LAST launch created a real SECOND (draft) KV context - `--model-draft` or an MTP/next-n
	 * `--spec-type draft-*`. llama.cpp's /slots save+restore only captures the MAIN context, so a restored blob
	 * leaves the draft context uninitialized and the server re-processes the whole prompt anyway ("lack of cache
	 * data"). Worse, the restore returns 200, which makes the warm trigger think the prefix is ready and skip the
	 * in-session warm that DOES work for these models. So slot save/restore is disabled for them (see
	 * saveSlotCache/restoreSlotCache) and they always warm in-session. n-gram speculation (ngram-mod/-cache) has
	 * no separate KV context, so it is NOT included here - its slot caches restore fine.
	 */
	private readonly _launchedWithDraftContext = new Set<string>();
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
	/** Consecutive watchdog samples that looked critical; required duration depends on cause and active use. */
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
	/**
	 * Models we've already shown the plain-language "tight fit - context below the comfort floor" notice for,
	 * so a relaunch (OOM ladder, prewarm) or a later turn doesn't nag the user again this session.
	 */
	private readonly _tightContextNoticed = new Set<string>();
	/**
	 * Models whose GPU backend wedged at compute while the process stayed alive (Metal command-buffer OOM ->
	 * "backend is in error state"). Latched so {@link _handleWedgedBackend} tears down + relaunches ONCE per
	 * resident server instead of on every torrential error line; cleared when a fresh launch starts.
	 */
	private readonly _wedgedBackends = new Set<string>();
	/** Context size (-c) each model's LAST llama launch actually used, so the OOM ladder can halve it. */
	private readonly _lastLaunchContext = new Map<string, number>();
	/**
	 * Context size the SERVER reports it is really running with, scraped from its own startup log
	 * ("new slot ... n_ctx = N" / "n_ctx_seq (N) < n_ctx_train").
	 *
	 * This is not always the `-c` we asked for: llama.cpp runs its own `-fit` pass ("fitting params to device
	 * memory") and will silently shrink the context to fit VRAM - e.g. a 12B Q8_0 with a full-size SWA cache
	 * came back at 17408 for a request on a round tier boundary. Reporting the REQUESTED figure then overstates
	 * the window to the context gauge and, worse, to the agent's summariser, which would not compact until far
	 * past the point the server starts truncating.
	 *
	 * Deliberately kept SEPARATE from {@link _lastLaunchContext}: the OOM ladder halves from what we asked for,
	 * and folding the server's own reduction into that would change relaunch sizing. This map is read-only
	 * reporting - {@link getLaunchedContextWindow} prefers it, nothing else does.
	 */
	private readonly _actualContextWindow = new Map<string, number>();
	/**
	 * Resolved KV-cache tensor type (f16 / q8_0 / q4_0) each model's current llama server launched with. A saved
	 * slot-cache blob is only byte-compatible with a server using the SAME type, so this is folded into the slot
	 * filename: a later launch that resolves a different type (context size shifted the 'auto' choice, or the OOM
	 * ladder capped it) looks for a differently-named file, misses cleanly, and warms - instead of hitting the
	 * server-side "mismatched key type" restore error on an incompatible blob saved under the same name.
	 */
	private readonly _lastLaunchKvType = new Map<string, string>();
	/**
	 * Per-model record of which KV halves this engine could actually quantize. llama.cpp implements a quantized
	 * V cache only in the Flash Attention kernel, so when `-fa auto` resolves to OFF for a model (its FA tensor
	 * can't be placed on the accelerator) a `--cache-type-v q8_0` launch dies during context creation - with
	 * exit code 0, before the server ever listens, which is why nothing else caught it. Learned from that
	 * failure and applied to every later launch of the SAME model.
	 *
	 * Deliberately per-model rather than per-session (unlike {@link _cacheRamUnsupported} and friends): this is
	 * a property of the model + its offload plan, not of the binary. Gemma-4-12B fails where Gemma-4-E4B
	 * succeeds on the same build, so a session-wide switch would downgrade the KV cache of every other model.
	 */
	private readonly _kvQuantCapability = new Map<string, KvQuantCapability>();
	/** Resolves once the persisted {@link _kvQuantCapability} map has been read from disk (or found absent). */
	private _kvQuantCapabilityLoaded: Promise<void> | undefined;
	/**
	 * Model ids whose launch died with MTP (`--spec-type draft-mtp`) enabled, so they must run DENSE from now on.
	 *
	 * Per-model and persisted, for the same reason as {@link _kvQuantCapability}: whether the embedded MTP head
	 * loads is a property of the MODEL's conversion, not of the binary. The session-wide
	 * {@link _specFlagsUnsupported} switch is the wrong tool here - one mis-converted MTP GGUF would otherwise
	 * disable speculative decoding for every OTHER model this session, including catalog models whose MTP works
	 * and the unrelated n-gram fallback. Persisting it means an affected model costs one failed launch EVER,
	 * rather than one on every app start.
	 */
	private readonly _mtpUnsupported = new Set<string>();
	/** Resolves once the persisted {@link _mtpUnsupported} set has been read from disk (or found absent). */
	private _mtpUnsupportedLoaded: Promise<void> | undefined;
	/** Model ids whose LAST llama-server launch emitted the MTP flags; consulted by the crash fallback. */
	private readonly _launchedWithMtp = new Set<string>();
	/** Model ids whose LAST launch emitted a quantized `--cache-type-k`; consulted by the crash fallback. */
	private readonly _launchedWithQuantizedK = new Set<string>();
	/** Model ids whose LAST launch emitted a quantized `--cache-type-v`; consulted by the crash fallback. */
	private readonly _launchedWithQuantizedV = new Set<string>();
	/** Measured launch plans (real weight bytes + planned context) backing the synchronous {@link getAutoPlan}. */
	private readonly _autoPlanCache = new Map<string, IAutoModelPlan>();
	/** Models whose plan measurement is already running, so a redrawing picker can't spawn duplicates. */
	private readonly _autoPlanInFlight = new Set<string>();
	/** Cached hardware facts backing the synchronous {@link getHardwareProfile}. */
	private _hardwareProfile: IHardwareProfile | undefined;
	private _hardwareProfileInFlight: Promise<void> | undefined;

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
		// Auto's measured plans describe a specific model file under specific settings, so drop them whenever
		// either can change: a finished download can swap the quant on disk (the picker sizes it per machine),
		// and the context/KV settings feed the same clamp the measurement runs.
		this._register(this.customLanguageModelsService.onDidChangeCustomModels(() => this._invalidateAutoPlans()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatConfiguration.LocopilotLlamaCppContextSize)
				|| e.affectsConfiguration(ChatConfiguration.LocopilotLlamaCppKvCacheType)
				|| e.affectsConfiguration(ChatConfiguration.LocopilotLlamaCppSwaFull)
				// The profile sizes -b/-ub, which feed runtimeOverheadBytesForTuning and therefore the KV budget
				// the context clamp works from - so a cached plan computed under the old profile is stale in the
				// context it planned, not just in the batch flags.
				|| e.affectsConfiguration(ChatConfiguration.LocopilotLocalPerformanceProfile)) {
				this._invalidateAutoPlans();
			}
		}));
		this._register(toDisposable(() => {
			for (const w of this._foreignLogWatchers.values()) { w.dispose(); }
			this._foreignLogWatchers.clear();
			if (this._lockSyncTimer) { clearTimeout(this._lockSyncTimer); }
			if (this._logMirrorTimer) { clearTimeout(this._logMirrorTimer); }
			if (this._foreignProbeTimer) { mainWindow.clearInterval(this._foreignProbeTimer); }
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
					// Gate/start FIRST, then commit the picker selection. Selecting before the fit dialog meant
					// Cancel left the picker on the declined model whenever revert couldn't find a prior server.
					const launched = await self.startServerInTerminal(modelId, true); // explicit user action (Start/Retry) -> may prompt "Run anyway?"
					if (launched) {
						self._selectStartedModelInChatPanel(modelId);
					}
				}
			}
		});
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.runOllamaModel', title: { value: 'Run Ollama Model', original: 'Run Ollama Model' } });
			}
			async run(accessor: ServicesAccessor, modelId?: string): Promise<void> {
				if (modelId) {
					const run = self.runOllamaModelInTerminal(modelId);
					self._selectStartedModelInChatPanel(modelId);
					await run;
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

	/**
	 * Side-effect-free prediction used by Auto's fit check. Mirrors `_resolveServerLaunch` without offering or
	 * downloading an engine: only an already-installed CUDA engine or already-bundled Vulkan binary is selected.
	 */
	private async _resolveBackendForFit(): Promise<LlamaBackend> {
		if (this._hasCustomServerPath()) {
			return this._resolveBackendForLaunch();
		}
		if (this.getBackend() === 'metal') {
			return 'metal';
		}
		const engine = this.configurationService.getValue<'auto' | 'cpu' | 'gpu'>(ChatConfiguration.LocopilotLlamaCppEngine) ?? 'auto';
		if (engine === 'cpu') {
			return 'cpu';
		}
		if (await this._installedCudaServerPath()) {
			const hw = await this._getHardwareInfo();
			if (hw?.gpus.some(g => g.vendor === 'nvidia')) {
				return 'cuda';
			}
		}
		const hw = await this._getHardwareInfo();
		const wantsVulkan = engine === 'gpu' || (!!hw && shouldUseBundledVulkan(hw.gpus));
		const vulkanPath = getBundledLlamaServerPath(this._appRoot, 'vulkan');
		if (wantsVulkan && vulkanPath && await this._isExistingFile(vulkanPath)) {
			return 'vulkan';
		}
		return 'cpu';
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
	 * File the learned {@link _kvQuantCapability} map is persisted to. Worth surviving a restart: without it every
	 * app start would repeat the same failed launch (and its "couldn't start" toast) for an affected model before
	 * healing itself again.
	 */
	private _kvQuantCapabilityUri(): URI {
		return joinPath(this.environmentService.cacheHome, 'locopilot-kv-quant-support.json');
	}

	/**
	 * Loads the persisted per-model KV-quantization capabilities once per session. Best-effort in every failure
	 * mode: a missing, unreadable or malformed file just leaves the map empty, which means "assume both halves
	 * work" - the same state a fresh install is in, and self-healing again on the first failure.
	 */
	private _ensureKvQuantCapabilityLoaded(): Promise<void> {
		if (!this._kvQuantCapabilityLoaded) {
			this._kvQuantCapabilityLoaded = (async () => {
				try {
					const buf = await this.fileService.readFile(this._kvQuantCapabilityUri());
					const parsed = JSON.parse(buf.value.toString()) as Record<string, { k?: boolean; v?: boolean }>;
					for (const [modelId, entry] of Object.entries(parsed ?? {})) {
						if (entry && typeof entry === 'object') {
							this._kvQuantCapability.set(modelId, { k: entry.k !== false, v: entry.v !== false });
						}
					}
					if (this._kvQuantCapability.size > 0) {
						this._log(`[LoCoPilot Runner] Loaded KV-quantization support for ${this._kvQuantCapability.size} model(s) from a previous session.`);
					}
				} catch {
					// No file yet (the common case) or unreadable - both mean "nothing learned", which is the default.
				}
			})();
		}
		return this._kvQuantCapabilityLoaded;
	}

	/** File the learned {@link _mtpUnsupported} set is persisted to. See that field for why it survives restarts. */
	private _mtpUnsupportedUri(): URI {
		return joinPath(this.environmentService.cacheHome, 'locopilot-mtp-support.json');
	}

	/**
	 * Loads the persisted per-model MTP failures once per session. Best-effort in every failure mode: a missing,
	 * unreadable or malformed file leaves the set empty, i.e. "assume MTP works where the GGUF says it does" -
	 * the fresh-install state, which self-heals again on the first failed launch.
	 */
	private _ensureMtpUnsupportedLoaded(): Promise<void> {
		if (!this._mtpUnsupportedLoaded) {
			this._mtpUnsupportedLoaded = (async () => {
				try {
					const buf = await this.fileService.readFile(this._mtpUnsupportedUri());
					const parsed = JSON.parse(buf.value.toString()) as string[];
					for (const modelId of Array.isArray(parsed) ? parsed : []) {
						if (typeof modelId === 'string' && modelId) {
							this._mtpUnsupported.add(modelId);
						}
					}
					if (this._mtpUnsupported.size > 0) {
						this._log(`[LoCoPilot Runner] ${this._mtpUnsupported.size} model(s) are known to fail with MTP from a previous session; they will run dense.`);
					}
				} catch {
					// No file yet (the common case) or unreadable - both mean "nothing learned", which is the default.
				}
			})();
		}
		return this._mtpUnsupportedLoaded;
	}

	/** Writes the learned MTP failures back out. Best-effort: losing them only costs one self-heal next start. */
	private async _persistMtpUnsupported(): Promise<void> {
		try {
			await this.fileService.writeFile(this._mtpUnsupportedUri(), VSBuffer.fromString(JSON.stringify([...this._mtpUnsupported], undefined, 2)));
		} catch (e) {
			this._log(`[LoCoPilot Runner] Could not persist MTP support (it will be re-learned next session): ${e}`);
		}
	}

	/** Writes the learned capabilities back out. Best-effort: losing them only costs one self-heal next start. */
	private async _persistKvQuantCapability(): Promise<void> {
		try {
			const payload: Record<string, KvQuantCapability> = {};
			for (const [modelId, capability] of this._kvQuantCapability) {
				// Only the restrictions are worth storing; a fully-supported model is the default.
				if (!capability.k || !capability.v) {
					payload[modelId] = capability;
				}
			}
			await this.fileService.writeFile(this._kvQuantCapabilityUri(), VSBuffer.fromString(JSON.stringify(payload, undefined, 2)));
		} catch (e) {
			this._log(`[LoCoPilot Runner] Could not persist KV-quantization support (it will be re-learned next session): ${e}`);
		}
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
	/**
	 * Writes {@link MLX_PROMPT_CACHE_HELPER_SOURCE} into the KV-cache dir and returns its path, or undefined
	 * when it could not be written (in which case the launch simply omits it and behaves as before).
	 */
	private async _writeMlxPromptCacheHelper(): Promise<string | undefined> {
		if (!await this._ensureKvCacheDir()) {
			return undefined;
		}
		const target = joinPath(this._kvCacheDir(), MLX_PROMPT_CACHE_HELPER_FILENAME);
		try {
			await this.fileService.writeFile(target, VSBuffer.fromString(MLX_PROMPT_CACHE_HELPER_SOURCE));
			return target.fsPath;
		} catch (e) {
			this._log(`[LoCoPilot Runner] Could not write the MLX prompt-cache helper (persistence disabled): ${e}`);
			return undefined;
		}
	}

	/**
	 * Filename for an MLX persisted prompt cache. Separate from {@link _slotCacheFileName} because mx.load
	 * sniffs the format from the extension and rejects the llama path's `.bin`, and because the two engines'
	 * blobs are not interchangeable - keeping the names distinct stops one engine ever finding the other's.
	 */
	private _mlxPromptCacheFileName(key: string): string {
		return `${key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)}.mlx${MLX_PROMPT_CACHE_EXT}`;
	}

	/** POSTs to one of the helper's endpoints; resolves the parsed body plus status. */
	private async _mlxPromptCacheRequest(port: number, path: string, filename: string, token: CancellationToken): Promise<{ status: number; body: string }> {
		const res = await this.requestService.request({
			type: 'POST',
			url: `http://127.0.0.1:${port}${path}`,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ filename }),
		}, token);
		const body = await streamToBuffer(res.stream).then(b => b.toString()).catch(() => '');
		return { status: res.res.statusCode ?? 0, body };
	}

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
				showTransientNotification(this.notificationService, Severity.Info, 'Downloading the CUDA engine (~650 MB) in the background. You can keep working - it will be used the next time a local model starts.');
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
			showTransientNotification(this.notificationService, Severity.Info, 'The CUDA engine is ready. It will be used the next time a local model starts.');
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
		// llama.cpp exposes /slots natively; MLX gets the equivalent from the bootstrap helper. Unmanaged
		// endpoints (localhost/ollama) have neither.
		const running = this.runningServers.get(modelId);
		if (!running || (running.kind !== 'llama' && running.kind !== 'mlx') || !running.ready) {
			this._log(`[LoCoPilot Runner] KV slot restore skipped for ${modelId}: server not ready (present=${!!running}, kind=${running?.kind ?? 'none'}, ready=${running?.ready ?? false}).`);
			return false;
		}
		if (running.kind === 'mlx') {
			return this._restoreMlxPromptCache(modelId, key, running.port, token);
		}
		// Draft-context models (MTP / separate draft): /slots restore only reloads the MAIN KV, so the restored
		// prefix is NOT reusable (the server re-prefills the whole prompt with "lack of cache data") - yet the
		// restore returns 200. Returning false here makes the warm trigger fall through to the in-session warm,
		// which builds a genuinely reusable prefix for these models. See _launchedWithDraftContext.
		if (this._launchedWithDraftContext.has(modelId)) {
			this._log(`[LoCoPilot Runner] KV slot restore skipped for ${modelId}: draft/MTP context - restored slots aren't reusable, warming in-session instead.`);
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
		if (!running || (running.kind !== 'llama' && running.kind !== 'mlx') || !running.ready) {
			return;
		}
		if (running.kind === 'mlx') {
			return this._saveMlxPromptCache(modelId, key, running.port, token);
		}
		// Don't persist slot caches for draft-context models: their restored blobs aren't reusable (see
		// restoreSlotCache / _launchedWithDraftContext), so writing them only burns disk (these are the
		// hundreds-of-MB files) for a cache that would never be restored usefully.
		if (this._launchedWithDraftContext.has(modelId)) {
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
	 * MLX counterpart of the llama.cpp `/slots?action=restore` path. On a hit the warmed system+tools prefix
	 * is already resident, so turn 1 skips the multi-thousand-token prefill entirely (~29 s on an M3 for the
	 * measured 7661-token prefix).
	 */
	private async _restoreMlxPromptCache(modelId: string, key: string, port: number, token: CancellationToken): Promise<boolean> {
		const filename = this._mlxPromptCacheFileName(key);
		// A cold first-ever run has no blob yet; check before asking so that case logs as "nothing to restore"
		// rather than as a failure.
		try {
			await this.fileService.stat(joinPath(this._kvCacheDir(), filename));
		} catch {
			this._log(`[LoCoPilot Runner] MLX prompt cache restore skipped for ${modelId}: no cache file "${filename}" in ${this._kvCacheDir().fsPath}.`);
			return false;
		}
		this._log(`[LoCoPilot Runner] MLX prompt cache restore: found "${filename}", requesting restore for ${modelId}...`);
		try {
			const { status, body } = await this._mlxPromptCacheRequest(port, MLX_PROMPT_CACHE_RESTORE_PATH, filename, token);
			if (status === 200) {
				this._log(`[LoCoPilot Runner] Restored MLX prompt cache "${filename}" for ${modelId}: ${body.slice(0, 200)}`);
				return true;
			}
			// 404 means this server predates the helper (or it failed to install); anything else is a real
			// rejection, e.g. the blob was written for different weights. Either way we fall through to a warm.
			this._log(`[LoCoPilot Runner] MLX prompt cache restore for ${modelId} returned ${status}; will warm instead: ${body.slice(0, 500) || '<empty body>'}`);
			return false;
		} catch (e) {
			this._log(`[LoCoPilot Runner] MLX prompt cache restore failed (ignored) for ${modelId}: ${e}`);
			return false;
		}
	}

	/** MLX counterpart of `/slots?action=save`. Called right after a prefix warm, so the newest cache entry is that prefix. */
	private async _saveMlxPromptCache(modelId: string, key: string, port: number, token: CancellationToken): Promise<void> {
		if (!await this._ensureKvCacheDir()) {
			return;
		}
		const filename = this._mlxPromptCacheFileName(key);
		try {
			const { status, body } = await this._mlxPromptCacheRequest(port, MLX_PROMPT_CACHE_SAVE_PATH, filename, token);
			if (status !== 200) {
				this._log(`[LoCoPilot Runner] MLX prompt cache save for ${modelId} returned ${status} (no file written): ${body.slice(0, 500) || '<empty body>'}`);
				return;
			}
			this._log(`[LoCoPilot Runner] Saved MLX prompt cache "${filename}" for ${modelId}: ${body.slice(0, 200)}`);
			await this._pruneSlotCaches();
		} catch (e) {
			this._log(`[LoCoPilot Runner] MLX prompt cache save failed (ignored) for ${modelId}: ${e}`);
		}
	}

	/**
	 * LRU eviction for the persisted KV-cache dir: keep the {@link MAX_SLOT_CACHE_ENTRIES} most-recently
	 * modified cache blobs (freshly-saved caches touch their mtime), delete the older ones. Best-effort.
	 *
	 * Matches by extension rather than by "everything in the dir": the same directory also holds the MLX
	 * bootstrap helper (a `.py`), which must survive - deleting it would silently turn persistence off.
	 */
	private async _pruneSlotCaches(): Promise<void> {
		try {
			const dir = this._kvCacheDir();
			const stat = await this.fileService.resolve(dir, { resolveMetadata: true });
			const caches = (stat.children ?? [])
				.filter(c => !c.isDirectory && (c.name.endsWith('.bin') || c.name.endsWith(MLX_PROMPT_CACHE_EXT)))
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

	isServerStopping(modelId: string): boolean {
		return this._pendingStops.has(modelId);
	}

	stopServerAndAwaitTeardown(modelId: string): Promise<void> {
		const inFlight = this._pendingStops.get(modelId);
		if (inFlight) {
			return inFlight; // already stopping; a second press just joins the same teardown
		}
		// Deferred to a microtask so _pendingStops is populated BEFORE _stopServerAndWait runs: it calls
		// stopServer, which fires onDidServerStateChange synchronously, and that render must already see the
		// 'stopping' phase - otherwise the row flashes "Start server" for a frame, which is exactly the
		// window we are trying to close.
		const teardown = Promise.resolve()
			.then(() => this._stopServerAndWait(modelId))
			.catch(e => this._log(`[LoCoPilot Runner] Teardown wait for ${modelId} failed (ignored): ${e}`))
			.finally(() => {
				this._pendingStops.delete(modelId);
				this._log(`[LoCoPilot Runner] Teardown complete for ${modelId}; its memory has been released.`);
				this._onDidServerStateChange.fire(modelId);
			});
		this._pendingStops.set(modelId, teardown);
		this._onDidServerStateChange.fire(modelId); // paint "Stopping..." immediately
		return teardown;
	}

	getServerLogs(modelId: string): string[] {
		return this.runningServers.get(modelId)?.logs ?? [];
	}

	getServerPhase(modelId: string): LocalServerPhase | undefined {
		// A teardown in progress outranks whatever record is still lying around: stopServer deletes the record
		// up front, but the process keeps its RAM for a moment afterwards, and during that moment the model is
		// 'stopping' - not stopped, and not startable.
		if (this._pendingStops.has(modelId)) {
			return 'stopping';
		}
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
		// Prefer what the server SAYS it is running (scraped from its log) over what we requested: llama.cpp's
		// own -fit pass can shrink the context below our -c, and the gauge/summariser must budget against the
		// real window. Falls back to the requested figure until the server has printed its slot line.
		return this._actualContextWindow.get(modelId) ?? this._lastLaunchContext.get(modelId);
	}

	/**
	 * Scrape the real context size out of a llama-server startup line. Two forms carry it:
	 *
	 *   slot   load_model: id  0 | task -1 | new slot, n_ctx = 40960
	 *   llama_context: n_ctx_seq (17408) < n_ctx_train (262144) -- the full capacity ...
	 *
	 * The slot line is printed last and is authoritative, so plain last-write-wins is correct; the n_ctx_seq
	 * warning just gets the right number in place a little earlier (and repeats harmlessly for the MTP draft
	 * context, which shares the target's window).
	 */
	private _parseServerContextWindow(line: string): number | undefined {
		const slot = /new slot[^\n]*\bn_ctx\s*=\s*(\d+)/.exec(line);
		const seq = slot ? undefined : /n_ctx_seq\s*\((\d+)\)/.exec(line);
		const raw = slot?.[1] ?? seq?.[1];
		if (!raw) {
			return undefined;
		}
		const parsed = Number(raw);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}

	/** Record the server-reported context window and refresh consumers when it differs from what we had. */
	private _recordActualContextWindow(modelId: string, line: string): void {
		const actual = this._parseServerContextWindow(line);
		if (actual === undefined || this._actualContextWindow.get(modelId) === actual) {
			return;
		}
		const requested = this._lastLaunchContext.get(modelId);
		this._actualContextWindow.set(modelId, actual);
		if (requested !== undefined && requested !== actual) {
			this._log(`[LoCoPilot Runner] Server for ${modelId} is running n_ctx=${actual}, not the requested -c ${requested} (llama.cpp re-fitted it). Reporting ${actual} to the context gauge and summariser.`);
		}
		// Re-derives maxInputTokens in the LM provider, which feeds both the input-box gauge and the agent's
		// context manager.
		this._onDidServerStateChange.fire(modelId);
	}

	stopServer(modelId: string): void {
		const running = this.runningServers.get(modelId);
		if (!running && (this.startingServers.has(modelId) || this._activeLaunchTerminals.has(modelId) || this._startInFlight.has(modelId))) {
			// Stop pressed while the model is still LAUNCHING (weights loading, not yet promoted to
			// runningServers). The old code no-opped here, so the launch completed anyway and the model popped
			// back to "running" moments after the user stopped it - the classic "I stopped it but it still shows
			// running" race. Cancel the in-flight launch instead: dispose its terminal, drop launch ownership
			// (the promotion guard then refuses to promote), and mark the stop intentional so no crash is reported.
			// (The launch promise's own finally-block releases the cross-window claim if it was held.)
			this._forcedLaunch.delete(modelId); // a stopped model re-prompts "Run anyway?" on its next launch
			this._cancelStartingServer(modelId);
			return;
		}
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
		// Expected RAM this teardown should release (weights + runtime), so _waitForServerGone can verify the
		// memory actually came back before the replacement launch commits against it.
		const expectedFreedBytes = this._modelCostCache.get(modelId) ?? this._modelSizeCache.get(modelId) ?? 0;
		this.stopServer(modelId);
		if (typeof pid === 'number' && pid > 1) {
			await this._waitForServerGone(port, kind, pid, expectedFreedBytes).catch(() => undefined);
		}
	}

	/**
	 * Best-effort "is this pid still alive?" probe (signal 0 - no signal is delivered, only existence is
	 * checked). Returns false when the process is gone OR when the probe can't run (no native host); callers
	 * use it to stop waiting, so "can't tell" must not stall a switch.
	 */
	private async _isProcessAlive(pid: number): Promise<boolean> {
		try {
			await this.instantiationService.invokeFunction(accessor =>
				// Signal 0 performs the standard POSIX/Node existence check without delivering a signal.
				accessor.get(INativeHostService).killProcess(pid, 0 as unknown as string));
			return true;
		} catch {
			return false; // ESRCH (gone) or no native host
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
		if ((running.activeRequests ?? 0) === 0) {
			this._armIdleTimer(modelId);
		}
	}

	beginModelRequest(modelId: string): void {
		const running = this.runningServers.get(modelId);
		if (!running) {
			return;
		}
		running.activeRequests = (running.activeRequests ?? 0) + 1;
		running.lastUsedAt = Date.now();
		if (running.idleTimer) {
			clearTimeout(running.idleTimer);
			running.idleTimer = undefined;
		}
	}

	endModelRequest(modelId: string): void {
		const running = this.runningServers.get(modelId);
		if (!running) {
			return;
		}
		running.activeRequests = Math.max(0, (running.activeRequests ?? 0) - 1);
		running.lastUsedAt = Date.now();
		if (running.activeRequests === 0) {
			this._armIdleTimer(modelId);
		}
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
		if ((running.activeRequests ?? 0) > 0) {
			return; // keep-alive starts when the final in-flight request completes
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
			if (still && (still.activeRequests ?? 0) === 0 && Date.now() - still.lastUsedAt >= ms) {
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
	 * System-memory budgeting is useful on every backend. CUDA/Vulkan still retain mmap'd weights, CPU-offloaded
	 * layers, prompt caches and runtime buffers in host RAM; skipping this budget entirely allowed a VRAM-safe
	 * partial offload to exhaust system RAM. Unknown estimates remain zero and therefore never block a launch.
	 */
	private _useMemoryBudget(): boolean {
		return true;
	}

	/**
	 * Extra RESIDENT bytes an MLX launch commits beyond weights+KV, so the fit gates reserve for them the same
	 * way the llama.cpp path reserves for its MTP/draft/mmproj extras (the two engines must reason alike - Q4).
	 * The launch gate only charges MLX's guaranteed minimum prompt cache. The configured cache is a growable
	 * upper bound (and MLX's total allocation is separately capped at the Metal wired limit), so charging the
	 * full ~15%-of-RAM cap here produced false-positive "Run anyway" prompts for models whose startup working
	 * set fits comfortably. The paired speculative draft is handled by its own fit check at launch.
	 * Returns 0 when auto-tune is off / unsupported.
	 */
	private _mlxRuntimeReserveBytes(totalMemBytes: number): number {
		const autoTune = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotMlxAutoTune) !== false
			&& !this._mlxExtraFlagsUnsupported;
		if (!autoTune || !(totalMemBytes > 0)) {
			return 0;
		}
		return MLX_MIN_PROMPT_CACHE_BYTES;
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
		{
			try {
				// llama.cpp resolves to a .gguf file (header geometry); MLX resolves to a weights directory
				// (config.json geometry). Both return the same shape, so the estimate is identical either way -
				// MLX no longer falls back to the flat per-token guess, which was off by several-fold on a
				// modern GQA model and made eviction/Auto decisions from a number unrelated to the real cache.
				const filePath = kind === 'llama' ? await this.resolveModelFilePath(localPath) : await this.getMlxModelRootPath(localPath);
				const info = await this._getModelInfo(filePath);
				const perTokenPerLayer = kvBytesPerTokenPerLayer(info, 2); // f16 k+v; MLX has no KV quantization
				// Only the blocks that really hold a KV cache. On a hybrid (Mamba/attention) stack that is a small
				// fraction of block_count, and charging all of them was worth several GB of cache that never exists.
				const layers = kvLayerCount(info) ?? DEFAULT_CLAMP_LAYER_COUNT;
				if (perTokenPerLayer && perTokenPerLayer > 0) {
					// Windowed-aware, matching the clamp / fit gate: a sliding-window model's SWA layers hold only
					// `window` tokens, so the old all-layers-full estimate over-counted KV (now amplified because the
					// windowing fix lets these models launch at a much larger context) and over-evicted peers. Assume
					// windowed (swa-full off) - the common case on the memory-tight machines where eviction matters.
					// The recurrent blocks of a hybrid model hold a fixed per-slot state instead of a growing cache,
					// so it is added flat rather than scaled by context (0 for a conventional model).
					return kvCacheBytesForContext({
						contextTokens: ctxTokens,
						layerCount: layers,
						kvBytesPerTokenPerLayer: perTokenPerLayer,
						slidingWindow: info.slidingWindow,
					}) + recurrentStateBytes(info);
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
		// Context window the engine will actually allocate KV for. Prefer the context the model's LAST real
		// launch ran with (post memory-clamp / OOM cap) over the nominal window: sizing the estimate from the
		// nominal window systematically over-counted long-context models (the launch clamps `-c` way down on a
		// tight machine), which over-evicted on switches and made Auto step down further than needed.
		const nominalCtx = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_LLAMA_CONTEXT_SIZE;
		const launchedCtx = this._lastLaunchContext.get(modelId);
		const oomCtxCap = this._oomContextCap.get(modelId);
		let effectiveCtx = launchedCtx && launchedCtx > 0 ? Math.min(nominalCtx, launchedCtx) : nominalCtx;
		if (oomCtxCap && oomCtxCap > 0) {
			effectiveCtx = Math.min(effectiveCtx, oomCtxCap);
		}
		const ctxTokens = Math.max(MIN_CLAMPED_CONTEXT, effectiveCtx);
		const GB = 1024 * 1024 * 1024;
		// KV cache: sized from the model's REAL attention geometry (same source the pre-flight fit gate and the
		// context clamp use), so this estimate and those gates agree instead of drifting apart. Falls back to a
		// conservative ~128 KiB/token (a typical 7-13B f16 k+v across all layers) when the GGUF can't be parsed.
		let runtime = await this._kvBytesForContext(model.localPath, kind, ctxTokens);
		if (kind === 'llama') {
			// Match the launch's actual --cache-ram cap instead of always crediting 2 GiB on eviction. The old
			// flat estimate overstated reclaim on small machines and understated an unsupported old build's
			// uncapped default. When stats are unavailable, retain the conservative 2 GiB fallback.
			const mem = await this._getSystemMemory();
			runtime += mem?.totalmem
				? Math.min(2 * GB, Math.floor(mem.totalmem * 0.10))
				: 2 * GB;
			const tuning = this._getLlamaTuning(model);
			const sepDraft = tuning.draftModelPath?.trim();
			if (tuning.multiTokenPrediction) {
				// MTP now loads only the embedded single-layer draft head (`--spec-type draft-mtp` alone, no
				// `--model-draft` second weight copy), so it commits a small bounded extra, not another full
				// model. Keep this formula IDENTICAL to the launch extras gate (see the MTP branch in the launch
				// flow) so eviction accounting matches admission - divergence previously admitted MTP at launch
				// but then under-/over-evicted by almost a whole model.
				runtime += Math.min(Math.max(weightBytes * 0.08, 512 * 1e6), 2 * 1e9);
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
	private _serverLaunchEnv(serverPath: string, tuning?: LlamaServerTuning): { [key: string]: string | null } | undefined {
		const env: { [key: string]: string | null } = {};
		const dir = dirname(serverPath);
		if (dir) {
			if (isMacintosh) { env.DYLD_LIBRARY_PATH = dir; }
			else if (!isWindows) { env.LD_LIBRARY_PATH = dir; } // Windows loads DLLs from the exe's own dir automatically.
		}
		// GGML_OP_OFFLOAD_MIN_BATCH: when a MoE model keeps its routed experts on CPU, lowering the batch-size
		// threshold at which ggml offloads a whole op to the GPU pushes more of prompt PROCESSING onto the GPU
		// (rather than the slow CPU experts), cutting time-to-first-token on long prompts. The build default is
		// 32; 8 offloads more aggressively during prefill. Only set when experts are actually offloaded - it is
		// pointless (though harmless) otherwise.
		const expertsOffloaded = (tuning?.cpuMoeLayers ?? 0) > 0 || (tuning?.overrideTensors?.length ?? 0) > 0;
		if (expertsOffloaded) {
			env.GGML_OP_OFFLOAD_MIN_BATCH = '8';
		}
		return Object.keys(env).length > 0 ? env : undefined;
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

		// Self-healing for a KV cache the engine refuses to create. llama.cpp implements a quantized V cache only
		// inside the Flash Attention kernel, and `-fa auto` legitimately resolves to OFF when the FA tensor can't
		// be placed on the accelerator for this model + offload plan:
		//   W sched_reserve: Flash Attention was auto, set to disabled
		//   E llama_init_from_model: failed to initialize the context: quantized V cache was requested, but this
		//     requires Flash Attention
		// The process then exits BEFORE serving, with exit code 0, so the user saw only the generic "please try
		// again" toast - for a configuration error that would fail identically on every retry, forever. Record the
		// half the engine rejected against THIS model (not the session: it depends on the architecture and its
		// offload plan, so Gemma-4-12B failing must not downgrade Gemma-4-E4B), persist it so the next app start
		// doesn't repeat the failure, and relaunch. The planner then re-runs the KV ladder with that half pinned to
		// f16 and re-clamps the context to the larger cache, so the retry is a genuinely different, viable launch.
		const rejectedKvHalf = detectRejectedKvQuantHalf(tail);
		if (rejectedKvHalf) {
			const current = this._kvQuantCapability.get(modelId) ?? KV_QUANT_FULLY_SUPPORTED;
			const launchedQuantized = rejectedKvHalf === 'k'
				? this._launchedWithQuantizedK.has(modelId)
				: this._launchedWithQuantizedV.has(modelId);
			const alreadyKnown = rejectedKvHalf === 'k' ? !current.k : !current.v;
			if (launchedQuantized && !alreadyKnown) {
				// A rejected K half means this build wants FA for BOTH halves, so give up V at the same time
				// rather than burning a second failed launch to discover it.
				const healed: KvQuantCapability = rejectedKvHalf === 'k' ? { k: false, v: false } : { k: current.k, v: false };
				this._kvQuantCapability.set(modelId, healed);
				this._launchedWithQuantizedK.delete(modelId);
				this._launchedWithQuantizedV.delete(modelId);
				await this._persistKvQuantCapability();
				this._log(`[LoCoPilot Runner] llama-server could not create a quantized ${rejectedKvHalf.toUpperCase()} cache for "${modelName}" (Flash Attention unavailable for this model). Pinning ${healed.k ? 'V' : 'K and V'} to f16 for it from now on and relaunching; the context window is re-clamped for the larger cache.`);
				this._endStarting(modelId);
				timeout(6000).then(() => {
					if (!this.runningServers.has(modelId) && !this.startingServers.has(modelId)) {
						this.startServerInTerminal(modelId).catch(e => this._log(`[LoCoPilot Runner] Relaunch with an f16 ${rejectedKvHalf.toUpperCase()} cache failed: ${e}`));
					}
				});
				return;
			}
		}

		// MTP -> dense fallback. Checked BEFORE the session-wide speculation switch below, because these
		// failures are a property of this MODEL's conversion, not of the binary: demoting the whole session
		// would strip speculation from every other model (including the n-gram path, which is unrelated).
		//
		// The engine fails an unusable MTP head in several distinct ways, all seen in the wild:
		//   - the arch declares MTP but the GGUF omits the key ("QWEN35_MTP requires nextn_predict_layers > 0")
		//   - the draft head loads into a bad graph (GGML_ASSERT "missing result_norm/result_embd tensor")
		//   - the head tensors are malformed ("invalid vector subscript" during llama_model_load)
		// None of these are user-actionable and all of them run fine dense, so we record the demotion (persisted,
		// so it costs one failed launch EVER) and relaunch once without MTP.
		const mtpRejected = /nextn_predict_layers|nextn|result_norm\/result_embd|missing result_norm|invalid vector subscript|mtp/i.test(tail);
		if (this._launchedWithMtp.has(modelId) && !this._mtpUnsupported.has(modelId) && mtpRejected) {
			this._mtpUnsupported.add(modelId);
			this._launchedWithMtp.delete(modelId);
			this._launchedWithSpecFlags.delete(modelId);
			void this._persistMtpUnsupported();
			this._log(`[LoCoPilot Runner] "${modelName}" could not load its Multi-Token Prediction head; running it as a dense model from now on and relaunching. Last output:\n${tail}`);
			this._endStarting(modelId);
			// Wait out the original launch's in-flight window so the retry is a genuinely fresh launch rather
			// than being coalesced into the crashed one (same reasoning as the speculation fallback below).
			timeout(6000).then(() => {
				if (!this.runningServers.has(modelId) && !this.startingServers.has(modelId)) {
					this.startServerInTerminal(modelId).catch(e => this._log(`[LoCoPilot Runner] Dense relaunch without MTP failed: ${e}`));
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

		// Port-bind collision: another server process (a racing pre-warm, another window's launch that the
		// lock coordination missed, or a not-yet-released dying server) already holds the port. This is a
		// self-resolving race, not a user-actionable failure - the OTHER server is typically coming up fine
		// (which is why users saw a scary "Couldn't start" toast and then the model started anyway). Log it,
		// clear the spinner, and retry once after the port has had time to settle; never toast for it.
		const bindFailed = /address already in use|EADDRINUSE|couldn'?t bind|failed to bind|bind: |error while binding/i.test(tail);
		if (bindFailed) {
			this._log(`[LoCoPilot Runner] llama-server for "${modelName}" could not bind its port (already in use); treating as a startup race and retrying once shortly.`);
			this._endStarting(modelId);
			timeout(6000).then(() => {
				if (!this.runningServers.has(modelId) && !this.startingServers.has(modelId)) {
					this.startServerInTerminal(modelId).catch(e => this._log(`[LoCoPilot Runner] Relaunch after port collision failed: ${e}`));
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
			if (this._oomDegradedRelaunch(modelId, modelName)) {
				return;
			}
			// Both degraded attempts still OOM-ed: this model genuinely doesn't fit right now. Be honest
			// and specific instead of the generic "couldn't start" message.
			const oomMessage = `"${modelName}" ran out of memory while loading, even with reduced settings. Close some applications to free up memory, or choose a smaller model.`;
			this._endStarting(modelId, oomMessage);
			this.notificationService.notify({ severity: Severity.Error, message: oomMessage });
			return;
		}

		// Keep the user-facing wording friendly and free of internal details (engine names, settings keys,
		// file paths). The full diagnostic output is always written to the logs above and reachable via the
		// "Show Logs" action below; the toast just needs to say it failed and that retrying / contacting
		// support is the next step.
		const message = `Couldn't start the local model "${modelName}". Please try again - if it keeps happening, restart LoCoPilot or contact LoCoPilot support.`;

		// Clear the spinner now, but DELAY the scary toast a few seconds and re-check: startup races (a
		// prewarm colliding with the embedder's GPU init, a double-start, a cross-window handoff this window
		// couldn't classify) routinely crash one attempt while another trigger starts the very same model
		// successfully moments later. Showing "Couldn't start" for a model that is visibly running seconds
		// later is worse than a short delay on a genuine failure - so only surface it if the model is still
		// neither running nor starting after the settle window.
		this._endStarting(modelId);
		timeout(5000).then(() => {
			if (this.runningServers.has(modelId) || this.startingServers.has(modelId) || this._startInFlight.has(modelId)) {
				this._log(`[LoCoPilot Runner] Suppressed "Couldn't start" for "${modelName}": the model is running/starting again after the crash.`);
				return;
			}
			this._recordLaunchBlocked(modelId, message);
			this._onDidServerStartFailed.fire({ modelId, message });
			this._onDidServerStateChange.fire(modelId);
			this.notificationService.prompt(Severity.Error, message, [
				{ label: 'Show Logs', run: () => this.commandService.executeCommand('workbench.action.toggleDevTools') },
			]);
		});
	}

	/**
	 * The OOM degradation ladder, shared by the crash-on-exit path ({@link _reportServerCrash}) and the
	 * wedged-backend path ({@link _handleWedgedBackend}): a launch that ran out of memory is a footprint to
	 * shrink, not a bug to report. Attempt 1 halves the last-used context AND strips the memory-heavy extras
	 * (MTP self-draft / separate draft / `--swa-full`); attempt 2 floors the context at the minimum. Caps are
	 * per-model per-session. Returns true when a relaunch was scheduled (caller should stop), false when both
	 * attempts are exhausted (caller surfaces the honest "doesn't fit" error).
	 */
	private _oomDegradedRelaunch(modelId: string, modelName: string): boolean {
		const attempts = this._oomRetryCount.get(modelId) ?? 0;
		if (attempts >= 2) {
			return false;
		}
		this._oomRetryCount.set(modelId, attempts + 1);
		const lastCtx = this._lastLaunchContext.get(modelId) ?? DEFAULT_LLAMA_CONTEXT_SIZE;
		// The OOM ladder is the ONE place allowed below the usability floor: the machine has already proven at
		// runtime that it can't hold the planned window, so a cramped model beats no model. First rung halves
		// (not below the usable floor), the last rung drops to the absolute minimum.
		const newCap = attempts === 0
			? Math.max(MIN_CLAMPED_CONTEXT, Math.floor(lastCtx / 2 / 1024) * 1024)
			: ABSOLUTE_MIN_CONTEXT;
		this._oomContextCap.set(modelId, newCap);
		this._oomStripExtras.add(modelId);
		this._log(`[LoCoPilot Runner] "${modelName}" ran out of memory (attempt ${attempts + 1}/2); relaunching with context capped at ${newCap} and the memory-heavy extras (speculative draft / --swa-full) stripped.`);
		this._endStarting(modelId);
		timeout(6000).then(() => {
			if (!this.runningServers.has(modelId) && !this.startingServers.has(modelId)) {
				this.startServerInTerminal(modelId).catch(e => this._log(`[LoCoPilot Runner] OOM-degraded relaunch failed: ${e}`));
			}
		});
		return true;
	}

	/**
	 * Handles a GPU backend that failed at compute but left the *process alive* - the classic Metal OOM where
	 * llama.cpp logs `command buffer ... failed` / `Insufficient Memory`, then `backend is in error state ...
	 * recreate the backend to recover`, yet still prints `model loaded` / `server is listening` and keeps
	 * running. onExit never fires (nothing crashed), so the OOM ladder never ran and every request came back
	 * `Compute error` (`failed to decode, ret = -3`) - the model looked green but was permanently wedged, and
	 * the memory watchdog was left fighting a broken-but-resident model (the warn <-> stop toast flicker).
	 *
	 * We detect the wedge from the log stream, tear the dead server down cleanly, and drive it through the same
	 * OOM ladder as a crash-on-exit: relaunch smaller (and without --swa-full, whose full-size SWA KV cache is
	 * the usual cause on sliding-window models like Gemma). Guarded to fire once per resident server.
	 */
	private async _handleWedgedBackend(modelId: string, modelName: string, logs: string[]): Promise<void> {
		if (this._wedgedBackends.has(modelId) || this._intentionalStops.has(modelId)) {
			return; // already handling this wedge, or the user/eviction is stopping it anyway
		}
		this._wedgedBackends.add(modelId);
		const tail = logs.slice(-60).join('\n');
		this._log(`[LoCoPilot Runner] "${modelName}" GPU backend is wedged (compute failed / backend in error state) while the process stayed alive; tearing it down and retrying with a smaller footprint. Last output:\n${tail}`);
		// Drop the green "ready" state immediately so nothing keeps routing requests at a dead server while we
		// tear it down. _stopServerAndWait marks the stop intentional (so the pending onExit stays silent) and
		// waits for the weights/port to release before the ladder relaunches - avoiding a double-booked-RAM spike.
		const rec = this.runningServers.get(modelId);
		if (rec) {
			rec.ready = false;
			this._onDidServerStateChange.fire(modelId);
		}
		await this._stopServerAndWait(modelId);
		if (!this._oomDegradedRelaunch(modelId, modelName)) {
			const oomMessage = `"${modelName}" ran out of GPU memory while running, even with reduced settings. Close some applications to free up memory, or choose a smaller model.`;
			this._endStarting(modelId, oomMessage);
			this.notificationService.notify({ severity: Severity.Error, message: oomMessage });
		}
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
		// An EXPLICIT global setting wins over the per-model window. The per-model value is usually auto-derived
		// from the GGUF, so treating it as higher priority made `locopilot.llamaCpp.contextSize` unreachable for
		// every downloaded model - you could set it and nothing happened. Only fall back to the per-model window
		// when the user hasn't set the global one.
		const globalContextInspect = cfg.inspect<number>(ChatConfiguration.LocopilotLlamaCppContextSize);
		const explicitGlobalContext = globalContextInspect?.userValue
			?? globalContextInspect?.workspaceValue
			?? globalContextInspect?.workspaceFolderValue;
		return {
			contextSize: (explicitGlobalContext && explicitGlobalContext > 0 ? explicitGlobalContext : undefined)
				?? perModelContext
				?? cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppContextSize),
			flashAttention: cfg.getValue<FlashAttentionMode>(ChatConfiguration.LocopilotLlamaCppFlashAttention),
			kvCacheType: cfg.getValue<KvCacheType>(ChatConfiguration.LocopilotLlamaCppKvCacheType),
			// Anything this model's engine has already refused to quantize (learned from a failed launch, see
			// _kvQuantCapability). Undefined for every model that has never failed, i.e. almost all of them.
			kvQuantCapability: model ? this._kvQuantCapability.get(model.id) : undefined,
			// A model that already crashed with the embedded MTP head runs dense forever after, whatever its
			// flag says - the flag records what the GGUF CLAIMS, this records what the engine actually managed.
			multiTokenPrediction: (model && this._mtpUnsupported.has(model.id))
				? false
				: (perModelMtp !== undefined ? perModelMtp : globalMtp),
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
			// Fine-grained tensor placement (`-ot`): power-user override, one rule per line. When set it wins over
			// the automatic per-layer MoE plan (see _augmentTuningWithHardware, which skips its own -ot when this
			// is non-empty). Empty/unset leaves automatic placement in charge.
			overrideTensors: (() => {
				const raw = cfg.getValue<string>(ChatConfiguration.LocopilotLlamaCppOverrideTensor);
				if (!raw || !raw.trim()) {
					return undefined;
				}
				const rules = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
				return rules.length > 0 ? rules : undefined;
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

	/**
	 * Resolves `locopilot.local.performanceProfile` to a CONCRETE profile for a launch that is about to happen.
	 *
	 * Everything the profile controls (`--threads`, `-b`/`-ub`, MLX's prefill step and prompt-cache count) is a
	 * command-line argument to a server process, and neither llama-server nor mlx_lm.server can change any of
	 * them on a live process. So 'auto' is deliberately a LAUNCH-TIME decision, not a running control loop:
	 * reacting to a mid-session unplug would mean restarting the server, paying a full weight reload and
	 * throwing away the KV/prompt cache, at exactly the moment the user is mid-conversation. That trade is
	 * worse than the heat it would save, so a running server keeps the profile it started with.
	 *
	 * The precedence itself lives in {@link resolveAutoPerformanceProfile}; this method is the plumbing that
	 * feeds it live signals and logs what it decided.
	 */
	private async _resolvePerformanceProfile(): Promise<ResolvedPerformanceProfile> {
		const configured = this.configurationService.getValue<'auto' | ResolvedPerformanceProfile>(ChatConfiguration.LocopilotLocalPerformanceProfile) ?? 'auto';
		if (configured !== 'auto') {
			return configured;
		}
		const [power, mem] = await Promise.all([
			this.instantiationService.invokeFunction(async (accessor) => {
				try {
					return await accessor.get(ILoCoPilotSystemInfoService).getPowerSource();
				} catch {
					return 'unknown' as PowerSource; // service not registered (web) or probe failed
				}
			}),
			// Reuse the launch path's existing sample rather than re-probing: on macOS a memory status costs
			// five subprocesses, and the fit gate has just taken one a moment earlier.
			this._getMemoryStatus(LoCoPilotLocalModelRunner.WATCHDOG_INTERVAL_MS),
		]);
		const thermal = mem?.thermalPressure ?? 'unknown';
		const resolved = resolveAutoPerformanceProfile(power, thermal);
		this._log(`[LoCoPilot Runner] Performance profile auto -> ${resolved} (power=${power}, thermal=${thermal}).`);
		return resolved;
	}

	/**
	 * The adapter the selected backend will actually target (never an unrelated GPU): the one with most VRAM,
	 * counting only adapters that own a SEPARATE memory pool. An integrated GPU is excluded even when it
	 * reports a nonzero "dedicated VRAM" figure, because that figure is a carve-out of system RAM (typically a
	 * few hundred MB) rather than a second pool: budgeting a launch against it would clamp a machine with
	 * 32 GB of usable RAM down to a fraction of a gigabyte. Callers fall back to the system-RAM budget, which
	 * is the pool an iGPU genuinely draws on.
	 */
	private _targetGpu(backend: LlamaBackend, hw: ISystemHardwareInfo | undefined): IGpuInfo | undefined {
		const candidates = (hw?.gpus ?? []).filter(g => {
			if (backend === 'cuda') {
				return g.vendor === 'nvidia';
			}
			return backend === 'vulkan' && g.vendor !== 'apple';
		}).filter(g => g.totalVramBytes > 0 && !g.isIntegrated);
		return candidates.length ? candidates.reduce((a, b) => b.totalVramBytes > a.totalVramBytes ? b : a) : undefined;
	}

	/** Largest VRAM pool that the selected backend can actually target (never an unrelated adapter). */
	private _discreteVramBytes(backend: LlamaBackend, hw: ISystemHardwareInfo | undefined): number | undefined {
		return this._targetGpu(backend, hw)?.totalVramBytes;
	}

	/**
	 * VRAM actually available for inference on the target adapter: free VRAM less the driver/display reserve.
	 * Unlike system RAM there is no swap behind VRAM - overflowing it is a hard OOM, not a slowdown - so the
	 * budget is sized off what is FREE right now (other GPU consumers included) rather than the card's total.
	 */
	private _discreteVramBudgetBytes(backend: LlamaBackend, hw: ISystemHardwareInfo | undefined): number | undefined {
		const gpu = this._targetGpu(backend, hw);
		if (!gpu) {
			return undefined;
		}
		const budget = discreteVramBudgetBytes(gpu.totalVramBytes, gpu.freeVramBytes);
		return budget > 0 ? budget : undefined;
	}

	/**
	 * Reads (and caches) model geometry (layer/expert count, context length, attention shape) for a resolved
	 * path. A `.gguf` file is read from its header; an MLX weights DIRECTORY is read from its `config.json`,
	 * which yields the same shape - so the context clamp, the fit gate and the resident-cost estimator all
	 * work on MLX models instead of falling back to generic constants.
	 */
	private async _getModelInfo(modelPath: string): Promise<IGgufModelInfo> {
		const cached = this._modelInfoCache.get(modelPath);
		if (cached) {
			return cached;
		}
		const isGguf = modelPath.toLowerCase().endsWith('.gguf');
		const info = isGguf
			? await readGgufModelInfo(this.fileService, modelPath, e => this._log(`[LoCoPilot Runner] GGUF metadata parse aborted for "${modelPath}": ${e}`))
			: await readMlxModelInfo(this.fileService, modelPath, e => this._log(`[LoCoPilot Runner] MLX config.json parse aborted for "${modelPath}": ${e}`));
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
			// Free VRAM less the driver reserve, NOT the card's total: the offload plan and the context clamp both
			// size against this, so a card already half-committed to other apps no longer gets planned as if empty.
			const vram = this._discreteVramBudgetBytes(backend, hw);
			if (vram !== undefined) {
				return vram;
			}
			// A GPU backend with no dedicated pool to size against - an integrated GPU (which draws on system
			// RAM, so that is the real ceiling), or a card whose VRAM we could not read. Fall through to the
			// system-RAM budget rather than returning "unknown": an unknown budget skips the offload plan AND
			// the context clamp entirely, which is how a long context ends up allocating its KV into swap.
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
	private async _augmentTuningWithHardware(modelPath: string, backend: LlamaBackend, base: LlamaServerTuning, extraResidentBytes: number = 0, minContext?: number): Promise<LlamaServerTuning> {
		const hw = await this._getHardwareInfo();
		if (!hw) {
			return base;
		}
		const tuning: LlamaServerTuning = { ...base };
		const performanceProfile = await this._resolvePerformanceProfile();

		// Thread auto-tuning: only when the user left it on auto (0/unset).
		if ((!tuning.threads || tuning.threads <= 0) && hw.physicalCoreCount > 0) {
			const threadFraction = performanceProfile === 'quiet' ? 0.5 : (performanceProfile === 'balanced' ? 0.75 : 1);
			tuning.threads = Math.max(1, Math.ceil(hw.physicalCoreCount * threadFraction));
			this._log(`[LoCoPilot Runner] Auto-set --threads to ${tuning.threads}/${hw.physicalCoreCount} physical cores (profile=${performanceProfile}).`);
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
		const userSetOverride = (tuning.overrideTensors?.length ?? 0) > 0;
		if (backend !== 'cpu' && budget && budget > 0) {
			if (isMoeModelInfo(info) && tuning.cpuMoeLayers === undefined && !userSetOverride) {
				// Per-layer accounting: when the GGUF tensor section gave us real per-block expert sizes, offload
				// the experts of EXACTLY the blocks needed to fit (rendered as one `-ot` rule) instead of the coarse
				// "top N blocks" that --n-cpu-moe forces. Fall back to the uniform --n-cpu-moe estimate when the
				// per-layer data is absent (older reader path / unknown quant type).
				const plan = planMoeExpertOffload({
					backend,
					modelBytes,
					perLayerExpertBytes: info.perLayerExpertBytes,
					memoryBudgetBytes: offloadBudget,
				});
				const rule = plan ? buildExpertOffloadOverride(plan) : undefined;
				if (plan && rule) {
					tuning.overrideTensors = [rule];
					this._log(`[LoCoPilot Runner] MoE model (${Math.round(modelBytes / 1e9)}GB, ${info.expertCount} experts) exceeds the ${Math.round(offloadBudget / 1e9)}GB weight budget; per-layer accounting offloads the experts of ${plan.length} block(s) [${plan[0]}..${plan[plan.length - 1]}] to CPU via -ot.`);
				} else {
					const moe = computeCpuMoeLayers({ backend, modelBytes, layerCount: info.layerCount, expertCount: info.expertCount, memoryBudgetBytes: offloadBudget });
					if (moe !== undefined) {
						tuning.cpuMoeLayers = moe;
						this._log(`[LoCoPilot Runner] MoE model (${Math.round(modelBytes / 1e9)}GB, ${info.expertCount} experts) exceeds the ${Math.round(offloadBudget / 1e9)}GB weight budget; offloading experts of ${moe}/${info.layerCount} blocks to CPU (--n-cpu-moe, uniform estimate).`);
					}
				}
			} else if (!isMoeModelInfo(info) && tuning.gpuLayers === undefined && (backend === 'cuda' || backend === 'vulkan')) {
				const layers = computeGpuLayers({
					backend,
					modelBytes,
					layerCount: info.layerCount,
					vramBytes: offloadBudget,
					perLayerWeightBytes: info.perLayerWeightBytes,
					nonLayerWeightBytes: info.nonLayerWeightBytes,
				});
				if (layers !== undefined) {
					tuning.gpuLayers = layers;
					this._log(`[LoCoPilot Runner] Dense model (${Math.round(modelBytes / 1e9)}GB) exceeds the ${Math.round(offloadBudget / 1e9)}GB VRAM weight budget; offloading ${layers}/${info.layerCount} layers to GPU, rest on CPU${info.perLayerWeightBytes ? ' (per-layer accounting)' : ''}.`);
				}
			}
		}

		// Full-size KV estimate (bytes) for the --swa-full headroom gate below. The clamp sizes KV as if EVERY
		// layer holds the full context (it doesn't model the SWA window reduction) - which is exactly what
		// --swa-full allocates. Captured at the FINAL clamped context + precision so the gate can verify the full
		// cache genuinely fits before forcing it on (vs. windowed SWA, which is far smaller on models like Gemma).
		let fullSwaKvBytesEstimate: number | undefined;
		// Same estimate expressed per token, so the gate below can SOLVE for the largest context whose full-size
		// SWA cache fits instead of only answering yes/no at the context the clamp happened to pick.
		let fullSwaBytesPerTokenEstimate: number | undefined;
		// Inputs the swa-full gate needs to RE-PRICE the cache at a different KV precision: the model's f16
		// bytes/token/layer, its layer count, and the precision the (windowed) clamp settled on.
		let f16PerTokenPerLayerForSwa = 0;
		let layersForSwaKv = 0;
		let resolvedKvPlanForSwa: KvCachePlan = symmetricKvPlan('f16');

		// #5 Context clamp: never request more than the model supports, nor more than the KV budget can hold.
		// The KV allowance is weight-aware (computeKvBudgetBytes): at most KV_BUDGET_FRACTION of the budget,
		// and never more than what remains after the weights RESIDENT IN THE SAME POOL plus runtime overhead.
		// The fraction-only allowance (the old behavior) let a dense Metal model whose weights already filled
		// ~85% of the wired budget still claim a full 25% KV on top - past the ceiling, straight into paging.
		if (tuning.contextSize && tuning.contextSize > 0) {
			let kvBudgetBytes: number | undefined;
			const expertsOffloadedForBatch = (tuning.cpuMoeLayers ?? 0) > 0 || (tuning.overrideTensors?.length ?? 0) > 0;
			const plannedUbatch = tuning.ubatchSize && tuning.ubatchSize > 0
				? tuning.ubatchSize
				: (performanceProfile === 'performance' && isMoeModelInfo(info) && expertsOffloadedForBatch && (backend === 'cuda' || backend === 'vulkan')
					? 4096
					: (performanceProfile === 'quiet' || backend === 'cpu' ? 512 : 1024));
			const runtimeOverhead = runtimeOverheadBytesForTuning({ ...tuning, ubatchSize: plannedUbatch }, backend);
			if (budget && budget > 0) {
				// Discrete GPUs: partial offload caps the weights that land in VRAM at the offload budget;
				// Metal/CPU: the full weights share the one unified/system pool with the KV cache.
				const residentWeights = (backend === 'cuda' || backend === 'vulkan') ? Math.min(modelBytes, offloadBudget) : modelBytes;
				// Unknown weight size (0) degrades to the plain fraction allowance. A zero remainder is passed
				// through as-is: clampContextSize reads 0 as "the budget is exhausted" and clamps to the floor,
				// which is what an exhausted budget means (only `undefined` skips the clamp).
				kvBudgetBytes = modelBytes > 0
					? computeKvBudgetBytes(budget, residentWeights, runtimeOverhead)
					: budget * KV_CLAMP_BUDGET_FRACTION;
			}
			// Compare every automatic precision against the same exact model geometry and weight-aware budget.
			// This makes q4 useful whenever it materially extends a requested long context, rather than only below
			// a fixed 32K threshold, while preserving f16 for small windows and near-lossless q8 when it already fits.
			const f16PerTokenPerLayer = kvBytesPerTokenPerLayer(info, kvCacheBytesPerElem('f16'))
				?? DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16;
			// MTP surcharge: with MTP on, llama.cpp allocates a SECOND (draft) context whose KV also scales with
			// n_ctx (~one extra layer's worth per token). Model it by inflating the layer count the clamp budgets
			// for, so the SAME weight-aware budget now sizes the largest context that holds BOTH caches - dynamic
			// per machine, no hard cap. Only the clamp's budgeting uses this; the real layer count is kept below
			// (layersForKv) for the --swa-full estimate, which measures the main KV alone.
			// KV is charged per ATTENTION block, not per transformer block. They are the same number on a
			// conventional model, but a hybrid Mamba/attention stack (Nemotron-H, Jamba) holds a KV cache on only
			// a small fraction of its blocks - charging all of them collapsed the window to the usability floor on
			// machines that could comfortably hold far more context.
			const baseLayerCount = kvLayerCount(info) ?? DEFAULT_CLAMP_LAYER_COUNT;
			const clampLayerCount = tuning.multiTokenPrediction ? baseLayerCount + MTP_DRAFT_KV_LAYER_EQUIV : baseLayerCount;
			// The recurrent half of a hybrid model holds a FIXED per-slot state that does not scale with the
			// window. It is not part of the per-token KV term, so reserve it off the budget BEFORE sizing context -
			// otherwise the clamp hands the window memory the SSM state has already taken.
			const recurrentBytes = recurrentStateBytes(info, Math.max(1, tuning.parallelSlots ?? 1));
			if (recurrentBytes > 0 && kvBudgetBytes !== undefined) {
				kvBudgetBytes = Math.max(0, kvBudgetBytes - recurrentBytes);
				this._log(`[LoCoPilot Runner] Hybrid recurrent model: reserving ~${Math.round(recurrentBytes / 1e6)}MB of fixed SSM state; KV budget for context sizing is now ~${Math.round(kvBudgetBytes / 1e9)}GB across ${baseLayerCount}/${info.layerCount ?? '?'} attention blocks.`);
			}
			let resolvedKvPlan: KvCachePlan;
			let clamped: number;
			if ((tuning.kvCacheType ?? 'auto') === 'auto') {
				const selection = selectAutomaticKvCache({
					requestedContext: tuning.contextSize,
					modelContextLength: info.contextLength,
					kvBudgetBytes,
					layerCount: clampLayerCount,
					kvBytesPerTokenPerLayerF16: f16PerTokenPerLayer,
					// Sliding-window models size KV windowed unless --swa-full is force-ON at clamp time (it's
					// decided AFTER this, so 'undefined' means windowed - the swa-full gate below re-checks fit).
					slidingWindow: info.slidingWindow,
					swaFullOnAllLayers: tuning.swaFull === true,
					minContext,
					// Halves the engine has refused for this model are priced as f16 INSIDE the ladder, so the
					// context we clamp to is the one the bigger cache can actually hold.
					kvQuantCapability: tuning.kvQuantCapability,
				});
				resolvedKvPlan = selection.kvCachePlan;
				clamped = selection.contextSize;
				this._log(`[LoCoPilot Runner] Dynamic KV selected ${kvPlanId(resolvedKvPlan)} (K ${resolvedKvPlan.k} / V ${resolvedKvPlan.v}) for ${clamped}/${tuning.contextSize} requested tokens from the model-specific memory budget${tuning.multiTokenPrediction ? ' (incl. MTP draft-context KV reserve)' : ''}.`);
			} else {
				// A user-pinned type applies to both halves - the asymmetric rung is an automatic choice only. A
				// half the engine has rejected still falls back to f16: honouring the pin literally would just
				// reproduce the startup failure the user can do nothing about.
				resolvedKvPlan = applyKvQuantCapability(
					symmetricKvPlan(tuning.kvCacheType as Exclude<KvCacheType, 'auto'>),
					tuning.kvQuantCapability);
				const fixedPerTokenPerLayer = f16PerTokenPerLayer * kvPlanBytesPerElem(resolvedKvPlan) / kvCacheBytesPerElem('f16');
				clamped = clampContextSize({
					requestedContext: tuning.contextSize,
					modelContextLength: info.contextLength,
					kvBudgetBytes,
					layerCount: clampLayerCount,
					kvBytesPerTokenPerLayer: fixedPerTokenPerLayer,
					slidingWindow: info.slidingWindow,
					swaFullOnAllLayers: tuning.swaFull === true,
					minContext,
				});
			}
			const perTokenPerLayer = f16PerTokenPerLayer * kvPlanBytesPerElem(resolvedKvPlan) / kvCacheBytesPerElem('f16');
			if (clamped < tuning.contextSize) {
				this._log(`[LoCoPilot Runner] Clamped context ${tuning.contextSize} -> ${clamped} to fit the model/memory budget (KV ${kvPlanId(resolvedKvPlan)}, ~${perTokenPerLayer} B/tok/layer).`);
				tuning.contextSize = clamped;
			}
			// Pin the precision the clamp sized for so getLlamaCppServerCommand doesn't re-resolve 'auto' from the
			// (possibly now sub-threshold) clamped window and flip to f16. No-op when the user pinned a fixed type.
			tuning.kvCachePlan = resolvedKvPlan;
			// Full-size KV the SWA layers would take with --swa-full, at the final context + precision. Mirrors
			// clampContextSize's own layer-count fallback (attention blocks only) so the estimate matches what
			// the clamp budgeted.
			const layersForKv = kvLayerCount(info) ?? DEFAULT_CLAMP_LAYER_COUNT;
			fullSwaBytesPerTokenEstimate = perTokenPerLayer * layersForKv;
			fullSwaKvBytesEstimate = fullSwaBytesPerTokenEstimate * (tuning.contextSize ?? 0);
			// Carried out of this block so the swa-full gate can re-price the cache at another precision.
			f16PerTokenPerLayerForSwa = f16PerTokenPerLayer;
			layersForSwaKv = layersForKv;
			resolvedKvPlanForSwa = resolvedKvPlan;
		}

		// SWA full cache: sliding-window models (Gemma 2/3/4) default to a window-sized KV for their SWA layers,
		// which invalidates the server's prompt-cache checkpoints and forces a full prompt re-process every turn.
		// `--swa-full` keeps the whole KV so cross-turn reuse works - but it pins a FULL-size KV cache on EVERY
		// sliding-window layer instead of the small window, which on a heavily-SWA model (Gemma, window 512-1024)
		// multiplies the KV cache several-fold and is the usual cause of the Metal command-buffer OOM. So we no
		// longer force it purely because the clamp "budgeted for full KV": we only turn it on when that full cache
		// genuinely fits (headroom gate below). Setting: 'auto' (on for SWA models when the full cache fits),
		// 'on' (force regardless), 'off'. Skipped for the session once a build rejected the flag.
		if (tuning.swaFull === undefined && !this._swaFullUnsupported) {
			const mode = this.configurationService.getValue<'auto' | 'on' | 'off'>(ChatConfiguration.LocopilotLlamaCppSwaFull) ?? 'auto';
			// 'on' forces --swa-full even when our GGUF SWA sniff didn't fire (detection can miss newer archs like
			// gemma-4 whose sliding_window key we don't capture). llama.cpp harmlessly ignores it on non-SWA models,
			// and if a build rejects the flag by name the launch-crash fallback strips it. 'auto' still needs a
			// positively-detected SWA model + a memory budget AND enough room for the full-size KV cache.
			// Headroom gate applies to BOTH 'auto' and 'on'. 'on' overrides our SWA *detection* (so a newer arch we
			// don't sniff still gets it) but NOT the memory budget: forcing a full-size KV that doesn't fit is exactly
			// what inflates the launch fit estimate into a scary "doesn't fit" popup for a model that runs fine
			// windowed. So we only enable --swa-full when the full cache genuinely fits; the model still runs at the
			// same big context windowed, just re-processing the prompt each turn (a speed hit, not a correctness one).
			// Only when we truly CAN'T size the cache does an explicit 'on' win unconditionally.
			//
			// The host prompt cache (--cache-ram) is NOT part of the weights+KV pool this budget measures: on discrete
			// GPUs it lives in separate system RAM, and on Metal the wired-limit fraction already carves out the host
			// share. Only pure CPU, whose budget is the single shared pool the prompt cache also draws from, reserves it.
			const wantSwaFull = mode === 'on' || (mode === 'auto' && isSwaModelInfo(info));
			if (wantSwaFull && budget !== undefined && budget > 0) {
				const GB = 1024 * 1024 * 1024;
				const isDiscreteGpu = backend === 'cuda' || backend === 'vulkan';
				const residentWeights = isDiscreteGpu ? Math.min(modelBytes, offloadBudget) : modelBytes;
				const promptCacheReserve = backend === 'cpu' ? 2 * GB : 0;
				const canEstimate = fullSwaKvBytesEstimate !== undefined && modelBytes > 0;
				const headroom = canEstimate
					? swaFullKvHeadroomBytes({
						budgetBytes: budget,
						residentWeightBytes: residentWeights,
						fullSwaKvBytes: fullSwaKvBytesEstimate!,
						promptCacheReserveBytes: promptCacheReserve,
						overheadBytes: runtimeOverheadBytesForTuning(tuning, backend),
					})
					: -1;
				// The full cache doesn't fit at the context the clamp picked - but it may fit at a SMALLER one, and
				// that trade is worth taking. A windowed SWA cache makes the server discard its prompt cache and
				// re-prefill the whole conversation every turn (measured on gemma-4-E4B: 33s for a 7.4K-token turn
				// vs 62ms with --swa-full on). So rather than give up, solve for the largest context whose full
				// cache DOES fit and clamp to it - as long as that stays at or above MIN_FULL_SWA_CONTEXT.
				// Re-plan KV PRECISION against the swa-full cost, not just the context. The clamp above sized the
				// cache as WINDOWED (swa-full isn't decided until here), so it happily kept f16 - but with
				// --swa-full EVERY layer holds the full context, which multiplies the cache several-fold and is
				// what forces the trade. Spending a rung of precision here is far cheaper than the context it buys
				// back: q8_0 is ~half the bytes at a quality delta too small to measure, so a Gemma that lands at
				// ~33K on f16 reaches ~64K on q8 for the SAME footprint. Walk down only as far as the comfort
				// target needs, and only when the precision is ours to choose (never over a user-pinned type).
				let tradedContext = 0;
				let tradedPlan = resolvedKvPlanForSwa;
				if (canEstimate && headroom < 0 && layersForSwaKv > 0) {
					const autoKv = (tuning.kvCacheType ?? 'auto') === 'auto';
					const startIndex = autoKv ? KV_CACHE_TIERS.findIndex(t => t.k === tradedPlan.k && t.v === tradedPlan.v) : -1;
					// Descend no further than the near-lossless rung (see SWA_FULL_REPLAN_MAX_TIER) - buying context
					// with 4-bit K/V is a different trade, and not one to make silently.
					const floorIndex = KV_CACHE_TIERS.findIndex(t => t.k === SWA_FULL_REPLAN_MAX_TIER.k && t.v === SWA_FULL_REPLAN_MAX_TIER.v);
					// Pin back to f16 any half this model's engine rejected, so the swa-full trade can't re-introduce
					// the quantized V that made the launch fail in the first place.
					const candidates = (startIndex >= 0 ? KV_CACHE_TIERS.slice(startIndex, Math.max(startIndex + 1, floorIndex + 1)) : [tradedPlan])
						.map(plan => applyKvQuantCapability(plan, tuning.kvQuantCapability));
					// Aim past the general comfort floor: under swa-full the clamp's windowed sizing collapses the
					// window, and stopping at the floor (the old bar) meant f16 satisfied it on the FIRST iteration
					// and q8 was never priced - which is why this whole re-plan was a no-op on the machine it was
					// written for. Never aim beyond what the caller actually asked for.
					const replanTarget = Math.min(tuning.contextSize ?? 0, SWA_FULL_REPLAN_TARGET_CONTEXT);
					for (const candidatePlan of candidates) {
						const perToken = f16PerTokenPerLayerForSwa * kvPlanBytesPerElem(candidatePlan) / kvCacheBytesPerElem('f16') * layersForSwaKv;
						const candidateContext = maxContextForFullSwa({
							budgetBytes: budget,
							residentWeightBytes: residentWeights,
							fullSwaBytesPerToken: perToken,
							requestedContext: tuning.contextSize ?? 0,
							promptCacheReserveBytes: promptCacheReserve,
							overheadBytes: runtimeOverheadBytesForTuning(tuning, backend),
						});
						if (candidateContext > tradedContext) {
							tradedContext = candidateContext;
							tradedPlan = candidatePlan;
						}
						// Good enough: this rung already reaches the target window, so stop spending quality.
						if (candidateContext >= replanTarget) {
							break;
						}
					}
					if (tradedContext >= MIN_FULL_SWA_CONTEXT && (tradedPlan.k !== resolvedKvPlanForSwa.k || tradedPlan.v !== resolvedKvPlanForSwa.v)) {
						this._log(`[LoCoPilot Runner] SWA full-cache re-plan: KV ${kvPlanId(resolvedKvPlanForSwa)} -> ${kvPlanId(tradedPlan)} keeps ${tradedContext} tokens instead of collapsing the window to fit a full-precision cache.`);
						tuning.kvCachePlan = tradedPlan;
						fullSwaBytesPerTokenEstimate = f16PerTokenPerLayerForSwa * kvPlanBytesPerElem(tradedPlan) / kvCacheBytesPerElem('f16') * layersForSwaKv;
					}
				}
				if (canEstimate && headroom >= 0) {
					tuning.swaFull = true;
					this._log(`[LoCoPilot Runner] SWA model (window ${info.slidingWindow}); enabling --swa-full (mode=${mode}) - full-size SWA KV ~${(fullSwaKvBytesEstimate! / GB).toFixed(1)}GB fits with ~${(headroom / GB).toFixed(1)}GB headroom.`);
				} else if (tradedContext >= MIN_FULL_SWA_CONTEXT) {
					// Trade window length for cross-turn reuse. Internal and automatic - the user picks neither the
					// context nor the flag; we just keep the largest window that still lets the prompt cache work.
					const previousContext = tuning.contextSize ?? 0;
					tuning.swaFull = true;
					tuning.contextSize = tradedContext;
					fullSwaKvBytesEstimate = (fullSwaBytesPerTokenEstimate ?? 0) * tradedContext;
					this._log(`[LoCoPilot Runner] SWA model (window ${info.slidingWindow}); enabling --swa-full (mode=${mode}) by trading context ${previousContext} -> ${tradedContext} - the full-size KV ~${(fullSwaKvBytesEstimate / GB).toFixed(1)}GB fits there. Cross-turn prompt reuse is ON (no per-turn re-prefill).`);
				} else if (!canEstimate && mode === 'on') {
					// Can't size the cache (unknown geometry) and the user explicitly forced it: honor the force.
					tuning.swaFull = true;
					this._log(`[LoCoPilot Runner] Forcing --swa-full (mode=on) - cache size unknown, honoring the explicit setting.`);
				} else {
					this._log(`[LoCoPilot Runner] SWA model (window ${info.slidingWindow}); keeping WINDOWED SWA cache (mode=${mode}) - the full-size KV ~${canEstimate ? (fullSwaKvBytesEstimate! / GB).toFixed(1) + 'GB' : 'unknown'} doesn't fit the budget with margin (headroom ~${(headroom / GB).toFixed(1)}GB), and the largest context that would fit (${tradedContext}) is below the ${MIN_FULL_SWA_CONTEXT}-token floor. Cross-turn reuse is off, but the model fits and won't over-warn at launch.`);
				}
			} else if (wantSwaFull && mode === 'on') {
				// No memory budget known at all (e.g. web) but explicitly forced: honor it.
				tuning.swaFull = true;
				this._log(`[LoCoPilot Runner] Forcing --swa-full (mode=on) - no memory budget to check against.`);
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
			// MoE-aware bump: a Mixture-of-Experts model offloading experts to CPU (discrete GPU) benefits from a
			// larger prefill batch - it keeps the GPU fed while expert activations stream over PCIe, which is the
			// slow part of prompt processing for these models. Bump to 4096 there. The offload logic above already
			// sized the split to leave VRAM headroom, so the bigger compute buffer stays within budget. Metal
			// (unified/wired memory) keeps the conservative 2048/1024 - a 4096 ubatch there risks the wired ceiling.
			const expertsOffloaded = (tuning.cpuMoeLayers ?? 0) > 0 || (tuning.overrideTensors?.length ?? 0) > 0;
			const moeBoost = isMoeModelInfo(info) && expertsOffloaded && (backend === 'cuda' || backend === 'vulkan');
			const profileBatch = performanceProfile === 'quiet' ? 1024 : 2048;
			const profileUbatch = performanceProfile === 'quiet' ? 512 : 1024;
			const allowMoeBoost = performanceProfile === 'performance' && moeBoost;
			if (!tuning.batchSize || tuning.batchSize <= 0) {
				tuning.batchSize = allowMoeBoost ? 4096 : profileBatch;
			}
			if (!tuning.ubatchSize || tuning.ubatchSize <= 0) {
				tuning.ubatchSize = allowMoeBoost ? 4096 : profileUbatch;
			}
			if (allowMoeBoost) {
				this._log(`[LoCoPilot Runner] MoE with CPU-offloaded experts on ${backend}: raising prefill batch to -b ${tuning.batchSize} -ub ${tuning.ubatchSize} for faster prompt processing.`);
			}
		}

		// #8 Weight mmap. When ANY tensor is placed on the CPU (`-ot` / `--n-cpu-moe`), those tensors are read on
		// every token: leaving them file-backed makes each decode step fault pages back in through the page cache,
		// which is what llama.cpp's own "tensor overrides to CPU are used with mmap enabled - consider using
		// --no-mmap" warning is about, and what held an expert-offloaded MoE to ~290 tok/s prefill / ~25 tok/s
		// decode on an M1 Max.
		//
		// Gated on the whole footprint fitting PHYSICAL RAM, not the (much smaller) GPU/wired budget: without mmap
		// the weights are anonymous pages that can only reach swap, while mmap'd pages are clean and can simply be
		// dropped. So dropping mmap is the right trade exactly when the model fits RAM and is merely too big for
		// the accelerator - and staying mmap'd is what keeps an oversized model runnable at all. A user-set value
		// (or `--no-mmap` via extraArgs) is left alone.
		if (tuning.noMmap === undefined) {
			const tensorsOnCpu = (tuning.cpuMoeLayers ?? 0) > 0 || (tuning.overrideTensors?.length ?? 0) > 0;
			if (tensorsOnCpu) {
				const mem = await this._getSystemMemory();
				const fit = await this._computeFit(modelPath, backend, undefined, extraResidentBytes, tuning);
				const hostUsable = mem?.totalmem ? usableSystemMemoryBytes(mem.totalmem) : 0;
				// What has to live in HOST memory. On a discrete GPU that is only the CPU-resident share (the rest
				// sits in VRAM and was never mmap'd anyway); on unified memory / CPU there is one pool, and
				// requiredBytes IS the whole footprint. Using requiredBytes on a discrete card would compare the
				// tighter-pool figure - possibly the VRAM side - against host RAM, which means nothing.
				const footprint = fit?.hostRequiredBytes ?? fit?.requiredBytes ?? 0;
				if (hostUsable > 0 && footprint > 0 && footprint <= hostUsable) {
					tuning.noMmap = true;
					this._log(`[LoCoPilot Runner] CPU tensor overrides active and the ~${Math.round(footprint / 1e9)}GB footprint fits ~${Math.round(hostUsable / 1e9)}GB of usable RAM: launching with --no-mmap so the CPU-resident tensors aren't re-faulted every token.`);
				} else {
					this._log(`[LoCoPilot Runner] CPU tensor overrides active but the ~${Math.round(footprint / 1e9)}GB footprint exceeds ~${Math.round(hostUsable / 1e9)}GB of usable RAM: keeping mmap so the weights stay evictable instead of swap-backed.`);
				}
			}
		}

		return tuning;
	}

	/**
	 * Resident footprint vs usable memory for running `modelPath` on `backend`, or undefined when a required
	 * figure (weight size, RAM stats) is unknown. With a finalized llama.cpp tuning this measures the actual
	 * clamped context and resolved KV precision; without one it measures the conservative minimum footprint.
	 * Callers treat undefined as "fits" so we never block or degrade a launch we can't reason about.
	 */
	private async _computeFit(modelPath: string, backend: LlamaBackend, discreteVramBytes: number | undefined, extraResidentBytes: number = 0, tuning?: LlamaServerTuning): Promise<IModelFit | undefined> {
		const weightBytes = await this._weightBytesOnDisk(modelPath);
		if (weightBytes <= 0) {
			return undefined; // unknown size -> can't reason about it.
		}
		const mem = await this._getSystemMemory();
		if (!mem?.totalmem) {
			return undefined; // no RAM stats (e.g. web).
		}

		// Resident footprint: weights + launch-plan KV cache + runtime slice. The GGUF probe is best-effort
		// (it does not apply to MLX directories); fall back to safe defaults.
		let info: IGgufModelInfo | undefined;
		try {
			info = await this._getModelInfo(modelPath);
		} catch {
			info = undefined;
		}
		// When the final llama.cpp tuning is available, account for the context and KV precision that will
		// actually be launched. In particular, treating every launch as f16 made q8/q4 configurations look up to
		// 2-3.5x larger than they really are and prompted "Run anyway" even after auto-tuning made them fit.
		// Callers without a finalized plan (MLX / speculative-extra screening) retain the conservative minimum.
		const contextTokens = tuning
			? Math.max(ABSOLUTE_MIN_CONTEXT, tuning.contextSize ?? DEFAULT_LLAMA_CONTEXT_SIZE)
			: MIN_CLAMPED_CONTEXT;
		// Honour the plan the launch planner pinned (including the asymmetric q4/q8 rung) so the gate charges
		// exactly the cache the launch will allocate; without a plan fall back to the settings-derived type.
		const kvPlan = tuning
			? (tuning.kvCachePlan ?? resolveKvCachePlan(tuning.kvCacheType ?? 'auto', contextTokens))
			: symmetricKvPlan('f16');
		const kvBytesPerElement = kvPlanBytesPerElem(kvPlan);
		const perTokenPerLayer = (info && kvBytesPerTokenPerLayer(info, kvBytesPerElement))
			|| DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 * kvBytesPerElement / kvCacheBytesPerElem('f16');
		// Same fallback the context clamp uses (DEFAULT_CLAMP_LAYER_COUNT). A lower number here would make the
		// gate charge LESS KV than the clamp budgeted for an unknown-geometry model - admitting a launch the
		// clamp had already sized as marginal. Attention blocks only, matching the clamp: on a hybrid stack most
		// blocks are recurrent and hold no KV, and their fixed state is charged separately below.
		const layerCount = (info && kvLayerCount(info)) ?? DEFAULT_CLAMP_LAYER_COUNT;
		// Windowed-aware KV: a sliding-window model with --swa-full off holds only `window` tokens on its SWA
		// layers, so its real footprint is far below `contextTokens * perTok * allLayers`. Mirror the clamp so
		// the gate doesn't reject the large windowed context the clamp granted. swaFull true => full on all layers.
		const kvBytes = kvCacheBytesForContext({
			contextTokens,
			layerCount,
			kvBytesPerTokenPerLayer: perTokenPerLayer,
			slidingWindow: info?.slidingWindow,
			swaFullOnAllLayers: tuning?.swaFull === true,
		});
		const runtimeOverhead = tuning
			? runtimeOverheadBytesForTuning(tuning, backend)
			: RUNTIME_OVERHEAD_BYTES;
		// Hybrid (Mamba/attention) models hold a fixed per-slot recurrent state on top of the attention KV. It
		// doesn't scale with context, so it is added flat here rather than folded into kvBytes; 0 elsewhere.
		const recurrentBytes = info ? recurrentStateBytes(info, Math.max(1, tuning?.parallelSlots ?? 1)) : 0;
		// extraResidentBytes covers a draft/MTP model (a second copy of the weights) and the mmproj projector
		// when vision is enabled - both are loaded ON TOP of the weights+KV and previously went uncounted here,
		// so an MTP + vision model passed this gate and then OOM-ed the GPU at decode.
		const requiredBytes = weightBytes + kvBytes + recurrentBytes + runtimeOverhead + Math.max(0, extraResidentBytes);

		// Discrete GPU: measure the TWO pools separately. VRAM holds the offloaded weights, the entire KV cache
		// and the compute buffers, and overflowing it is a hard driver OOM (no swap sits behind VRAM); host RAM
		// holds the CPU-resident remainder and only pages when short. Summing them into one "usable" figure - the
		// old behavior - admitted launches whose KV could never fit the card because spare system RAM covered the
		// difference on paper. We report whichever pool is tighter, so the caller's single comparison still works
		// and now fails on the pool that will actually fail.
		if (backend === 'cuda' || backend === 'vulkan') {
			const hw = await this._getHardwareInfo();
			const vramBudget = this._discreteVramBudgetBytes(backend, hw);
			if (vramBudget && vramBudget > 0) {
				const hostBudget = usableSystemMemoryBytes(mem.totalmem);
				// Weight bytes that will really live in VRAM after the offload plan the tuner produced. A pinned
				// --n-gpu-layers (dense partial offload) scales proportionally; an expert-offload plan (MoE) keeps
				// attention on the device; no plan at all means llama.cpp will offload everything that fits.
				const gpuWeightBytes = this._gpuResidentWeightBytes(weightBytes, vramBudget, info, tuning);
				const split = splitDiscreteGpuFootprint({
					weightBytes,
					gpuWeightBytes,
					// The recurrent state lives on the device alongside the KV cache, so it is charged to the
					// same pool rather than to host RAM.
					kvBytes: kvBytes + recurrentBytes,
					overheadBytes: runtimeOverhead,
					extraResidentBytes: Math.max(0, extraResidentBytes),
				});
				const vramHeadroom = vramBudget - split.vramRequiredBytes;
				const hostHeadroom = hostBudget - split.hostRequiredBytes;
				const tighter = vramHeadroom <= hostHeadroom
					? { requiredBytes: split.vramRequiredBytes, usableBytes: vramBudget }
					: { requiredBytes: split.hostRequiredBytes, usableBytes: hostBudget };
				return {
					...tighter,
					weightBytes,
					// The live-RAM gate below measures HOST availability only, so it needs the host half even when
					// VRAM is the tighter pool - re-deriving it from a VRAM-side total would be meaningless.
					hostRequiredBytes: split.hostRequiredBytes,
					gpuWeightBytes,
				};
			}
			// VRAM unprobeable: fall through to the combined figure rather than blocking on what we can't measure.
		}

		// Usable memory:
		//  - metal (Apple Silicon): the WIRED working-set ceiling (~70% of unified RAM). macOS caps a Metal
		//    app there; using the looser 85% system figure (the old bug) let a model clear this gate and then
		//    bust the GPU ceiling at decode (kIOGPUCommandBufferCallbackErrorOutOfMemory).
		//  - cpu (and an unprobeable GPU): system RAM left for inference, plus any VRAM weights can offload to.
		const usableBytes = backend === 'metal'
			? metalOffloadBudgetBytes(mem.totalmem, (await this._getHardwareInfo())?.metalWiredLimitBytes)
			: usableSystemMemoryBytes(mem.totalmem) + (discreteVramBytes && discreteVramBytes > 0 ? discreteVramBytes : 0);
		return { requiredBytes, usableBytes, weightBytes };
	}

	/**
	 * Weight bytes that will reside in VRAM once the offload plan runs. Mirrors what `_augmentTuningWithHardware`
	 * decided so the gate charges the device exactly what the launch will put on it:
	 *  - explicit `--n-gpu-layers` (dense partial offload): that share of the layers, plus the non-layer tensors
	 *    (embeddings/output) which llama.cpp keeps on the device whenever any layer is offloaded;
	 *  - MoE expert offload (`--n-cpu-moe` / `-ot`): the experts moved to CPU leave the device, the rest stays;
	 *  - no plan: everything that fits the weight share of the VRAM budget.
	 */
	private _gpuResidentWeightBytes(weightBytes: number, vramBudget: number, info: IGgufModelInfo | undefined, tuning?: LlamaServerTuning): number {
		const layerCount = info?.layerCount && info.layerCount > 0 ? info.layerCount : DEFAULT_CLAMP_LAYER_COUNT;
		if (tuning?.gpuLayers !== undefined && tuning.gpuLayers >= 0) {
			const offloaded = Math.max(0, Math.min(Math.floor(tuning.gpuLayers), layerCount));
			const nonLayer = info?.nonLayerWeightBytes && info.nonLayerWeightBytes > 0 ? info.nonLayerWeightBytes : 0;
			// Real per-layer sizes when the GGUF tensor section gave them (layers are NOT uniform - the first and
			// last blocks differ); otherwise spread the weights evenly across the layer count.
			const layerBytes = info?.perLayerWeightBytes?.length
				? info.perLayerWeightBytes.slice(0, offloaded).reduce((a, b) => a + b, 0)
				: (Math.max(0, weightBytes - nonLayer) / layerCount) * offloaded;
			return Math.min(weightBytes, layerBytes + (offloaded > 0 ? nonLayer : 0));
		}
		if (tuning?.cpuMoeLayers !== undefined && tuning.cpuMoeLayers > 0 && info?.perLayerExpertBytes?.length) {
			// --n-cpu-moe offloads the experts of the FIRST N blocks; everything else stays on the device.
			const movedToCpu = info.perLayerExpertBytes.slice(0, tuning.cpuMoeLayers).reduce((a, b) => a + b, 0);
			return Math.max(0, weightBytes - movedToCpu);
		}
		if (tuning?.overrideTensors?.length) {
			// A `-ot` expert-offload rule was rendered but we can't cheaply re-derive which blocks it names;
			// assume the plan sized itself to the weight share of the budget, which is what produced the rule.
			return Math.min(weightBytes, Math.floor(vramBudget * (1 - KV_BUDGET_FRACTION)));
		}
		return Math.min(weightBytes, Math.floor(vramBudget * (1 - KV_BUDGET_FRACTION)));
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
	 * Honest-but-lenient: llama.cpp callers pass their FINAL auto-tuned footprint (clamped context, resolved
	 * q8/q4 KV and selected extras), so a model that tuning made safe launches without a false warning. MLX is
	 * measured at its minimum viable footprint. Any missing input returns true so we never block a launch we
	 * can't reason about.
	 *
	 * `discreteVramBytes`: dedicated VRAM (CUDA/Vulkan) that can hold offloaded weights ON TOP of system RAM;
	 * undefined on unified-memory (Metal) / CPU, where weights live in system RAM regardless of any offload.
	 */
	private async _checkModelFitsOrNotify(modelId: string, modelPath: string, backend: LlamaBackend, discreteVramBytes: number | undefined, interactive: boolean, extraResidentBytes: number = 0, tuning?: LlamaServerTuning): Promise<boolean> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model) {
			return true;
		}
		if (this._forcedLaunch.has(modelId)) {
			return true; // user already chose "Run anyway" for this model
		}
		const fit = await this._computeFit(modelPath, backend, discreteVramBytes, extraResidentBytes, tuning);
		if (fit && fit.requiredBytes > fit.usableBytes) {
			// CAPABILITY failure: even the final reduced footprint exceeds what this machine can safely offer
			// (total usable RAM). Unlike the transient gate this is a HARD
			// shortfall, so the "Run anyway" dialog warns more strongly (it may freeze/overheat the machine);
			// the watchdog is the backstop if the user proceeds anyway.
			const GB = 1024 * 1024 * 1024;
			const needGb = Math.ceil(fit.requiredBytes / GB);
			const haveGb = Math.max(1, Math.round(fit.usableBytes / GB));
			this._log(`[LoCoPilot Runner] ${modelId} exceeds usable RAM: needs ~${needGb}GB but only ~${haveGb}GB is usable on this machine (interactive=${interactive}).`);
			const name = model.displayName || model.modelName;
			// B: the Metal budget above is a CONSERVATIVE wired fraction that sits below the device's true working-set
			// ceiling, and the runtime watchdog is the real backstop - so a SMALL overage of that budget is not a
			// genuine "won't fit". Only raise the strong Run-anyway dialog on a CLEAR overflow past a tolerance band
			// that approximates the real ceiling; within the band, launch and surface the plain-language tight-fit
			// notice instead. (Metal's fraction understates the ceiling more than the already-realistic CPU/VRAM ones.)
			// Metal's wired fraction is a conservative guess that sits below the device's true working-set ceiling,
			// so a small overage there is not a real shortfall. VRAM is the opposite: it is an exact, hard limit
			// with no swap behind it, so anything over budget is a genuine driver OOM and gets NO tolerance.
			const fitTolerance = backend === 'metal' ? 0.18 : ((backend === 'cuda' || backend === 'vulkan') ? 0 : 0.05);
			if (interactive && fit.requiredBytes <= fit.usableBytes * (1 + fitTolerance)) {
				this._log(`[LoCoPilot Runner] ${modelId} marginally over the conservative budget (~${needGb}GB vs ~${haveGb}GB, within ${Math.round(fitTolerance * 100)}%); launching with a soft notice - the watchdog is the backstop.`);
				if (!this._tightContextNoticed.has(modelId)) {
					this._tightContextNoticed.add(modelId);
					showTransientNotification(this.notificationService, Severity.Warning, `"${name}" is a tight fit for your system's memory. You can still use it, but it may slow down or stop on its own during longer chats. For smoother performance, close some apps to free up memory, or pick a smaller model.`, { timeoutMs: 15000 });
				}
				return true;
			}
			if (!interactive) {
				// Background pre-warm of a too-big model: skip silently (no dialog, no toast).
				this._recordLaunchBlocked(modelId, this._buildFitBlockedMessage(name, needGb, haveGb, true));
				this._endStarting(modelId);
				return false;
			}
			const forced = await this._promptRunAnyway(modelId, name, needGb, haveGb, true);
			if (forced) {
				this._degradeForcedLaunch(modelId, name, tuning, fit.usableBytes, fit.requiredBytes);
			}
			return forced;
		}
		return true;
	}

	/**
	 * Pre-emptive first rung of the OOM ladder for a "Run anyway" past a CLEAR shortfall (i.e. one already outside
	 * the Metal tolerance band). Previously the forced launch went ahead at the FULL planned footprint - the exact
	 * configuration we had just told the user does not fit - and the only correction came after it had crashed the
	 * Metal command buffer, which on MLX means the process aborts outright. Shrinking first turns "warn, then die"
	 * into "warn, then run smaller".
	 *
	 * The context is scaled by the memory ratio we're short by and never taken below the usability floor. This is
	 * deliberately approximate - weights, not KV, are usually what overflows, so the scaled window is a
	 * conservative under-estimate rather than a computed fit - and the runtime ladder still has BOTH of its rungs
	 * afterwards ({@link _oomRetryCount} is untouched here). `tuning` is mutated in place because it is the very
	 * object the launch is about to use: llama.cpp reads `contextSize` as `-c`, and the MLX path adopts a reduced
	 * window from its fit tuning right after this gate returns.
	 */
	private _degradeForcedLaunch(modelId: string, name: string, tuning: LlamaServerTuning | undefined, usableBytes: number, requiredBytes: number): void {
		const planned = tuning?.contextSize ?? 0;
		if (!tuning || planned <= MIN_CLAMPED_CONTEXT || requiredBytes <= 0 || usableBytes <= 0) {
			return;
		}
		const scaled = Math.max(MIN_CLAMPED_CONTEXT, Math.floor(planned * (usableBytes / requiredBytes) / 1024) * 1024);
		if (scaled >= planned) {
			return;
		}
		tuning.contextSize = scaled;
		// Pin the cap so the degraded relaunches the runtime ladder may still need can't raise the window back up.
		this._oomContextCap.set(modelId, scaled);
		this._oomStripExtras.add(modelId);
		this._log(`[LoCoPilot Runner] "${name}" was force-launched past a clear memory shortfall; starting it degraded rather than at the footprint that doesn't fit: context ${planned} -> ${scaled}, memory-heavy extras stripped.`);
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
		showTransientNotification(this.notificationService, Severity.Warning, 'Your system is running low on memory. The local model will keep running - LoCoPilot will only stop it if the system starts paging to disk. Close other apps to free memory, or switch to a smaller model.', { timeoutMs: 15000 });
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

	/** True while this window is streaming at least one request through an owned local server. */
	private _hasActiveOwnedRequest(): boolean {
		for (const rec of this.runningServers.values()) {
			if (!rec.foreign && (rec.activeRequests ?? 0) > 0) {
				return true;
			}
		}
		return false;
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

	/**
	 * Load-grace window after a server is promoted. Loading multi-GB weights (and a switch's brief
	 * old-model/new-model overlap) is an EXPECTED, budgeted memory transient: available RAM craters, macOS may
	 * page opportunistically, and swap ticks up - none of which means the machine is in trouble. During this
	 * window (server not yet ready, or ready for less than this long) the soft kill/warn signals are ignored;
	 * only the hard near-OOM floor and thermal emergencies still act, since those mean allocations are about to
	 * fail regardless. Without this the watchdog routinely killed the NEW model mid-load right after a switch.
	 */
	private static readonly WATCHDOG_LOAD_GRACE_MS = 45_000;

	/** True while any owned server is inside its load-grace window (still loading, or freshly promoted). */
	private _inLoadGraceWindow(): boolean {
		const now = Date.now();
		for (const rec of this.runningServers.values()) {
			if (!rec.foreign && (!rec.ready || now - rec.startedAt < LoCoPilotLocalModelRunner.WATCHDOG_LOAD_GRACE_MS)) {
				return true;
			}
		}
		return false;
	}

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
		// Load-grace: while a server is still loading (or was promoted <45s ago), the RAM dip / paging tick is
		// the expected cost of the load itself - the fit gate already budgeted for it. Soft signals are ignored
		// during that window (no strikes, no warn toast); the hard near-OOM floor and thermal remain live.
		const inLoadGrace = this._inLoadGraceWindow();
		const pagingSpiral = hasPressureSignal
			? (mem.pressure === 'critical' && swapGrowing)
			: (lowAvailable && (swapGrowing || noSignals));
		const seriousThermal = mem.thermalPressure === 'serious';
		const killCritical = pagingSpiral || nearlyOut || seriousThermal;
		if (!thermalEmergency && !killCritical) {
			// Not in kill territory. Reset strikes; if the kernel reports CRITICAL pressure while we're low, give a
			// ONE-TIME, non-escalating heads-up (the model keeps running). Clear the latch on recovery above the floor.
			this._watchdogStrikes = 0;
			if (lowAvailable && mem.pressure === 'critical' && !inLoadGrace) {
				this._maybeWarnMemoryLow();
			} else if (mem.availableBytes >= warnFloor) {
				this._watchdogWarnedThisEpisode = false; // recovered - allow a fresh warning next episode
			}
			return;
		}
		this._watchdogStrikes++;
		// Hard near-OOM remains strict at two samples (~10s). Paging gets one extra sample while a request is
		// actively streaming, avoiding a short allocation/prefill burst without ever masking sustained thrash.
		// macOS "serious" thermal means throttling, not imminent shutdown: retain critical=immediate, but allow
		// serious pressure 30s to recover under utility QoS before unloading the model.
		let requiredStrikes = Number.POSITIVE_INFINITY;
		if (nearlyOut) {
			requiredStrikes = Math.min(requiredStrikes, 2);
		}
		if (pagingSpiral) {
			// Loading legitimately causes one or two sharp paging samples. Keep the signal active rather than
			// disabling the watchdog for 45s, but require 20s of sustained evidence during that grace window.
			requiredStrikes = Math.min(requiredStrikes, inLoadGrace ? 4 : (this._hasActiveOwnedRequest() ? 3 : 2));
		}
		if (seriousThermal) {
			requiredStrikes = Math.min(requiredStrikes, 6);
		}
		const GB = 1024 * 1024 * 1024;
		this._log(`[LoCoPilot Runner] Memory watchdog: kill-critical sample ${this._watchdogStrikes}/${requiredStrikes} (thermalEmergency=${thermalEmergency}, activeRequest=${this._hasActiveOwnedRequest()}, available ~${(mem.availableBytes / GB).toFixed(1)}GB, warnFloor ~${(warnFloor / GB).toFixed(1)}GB, hardFloor ~${(hardFloor / GB).toFixed(1)}GB, nearlyOut=${nearlyOut}, swapGrowing=${swapGrowing}, pagingSpiral=${pagingSpiral}, inLoadGrace=${inLoadGrace}, pressure=${mem.pressure}, thermal=${mem.thermalPressure}, swap used ~${mem.swapUsedBytes >= 0 ? (mem.swapUsedBytes / GB).toFixed(1) + 'GB' : 'n/a'}).`);
		// Critical thermal is immediate. Other causes must persist for their cause-specific recovery window.
		if (!thermalEmergency && this._watchdogStrikes < requiredStrikes) {
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

		// Trip the breaker: free our memory NOW and tell the user why their model stopped. In-flight launches
		// (still loading, not yet promoted) are cancelled too - they are the ones actively allocating.
		const stoppedNames: string[] = [];
		for (const id of Array.from(this.startingServers)) {
			if (!this.runningServers.has(id)) {
				const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === id);
				stoppedNames.push(model?.displayName || model?.modelName || id);
				this._cancelStartingServer(id);
			}
		}
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
		showTransientNotification(this.notificationService, Severity.Warning, thermalCause
			? `LoCoPilot stopped "${names}" because your system was overheating. Let it cool down and try again, or switch to a smaller model.`
			: `LoCoPilot stopped "${names}" because your system was running out of memory. Close some applications and try again, or switch to a smaller model.`, { timeoutMs: 15000 });
	}

	/**
	 * How long the warm-up generation may take before we stop waiting for it. A 30B+ MLX model on a busy
	 * machine needs minutes to get its weights resident before it can emit a single token, so this matches
	 * the patience of the real-request path ({@link _waitForServerReady}) rather than guessing a short
	 * fixed timeout - see the comment at the generation phase for why a short one actively misled the UI.
	 */
	private static readonly WARMUP_GENERATION_BUDGET_MS = 300_000;

	/**
	 * Reason an in-flight or pending warm-up should stop, or undefined to keep going. Covers teardown
	 * (stopped/evicted/crashed) and the case where something else - typically a real request going through
	 * {@link ensureServerForModel} - already proved the server ready, leaving us nothing to prove.
	 */
	private _warmUpAbortReason(modelId: string): string | undefined {
		if (this._crashedBeforeReady.has(modelId)) {
			return 'the server crashed before it became ready';
		}
		const rec = this.runningServers.get(modelId);
		if (!rec) {
			return 'the server is no longer running';
		}
		if (rec.ready) {
			return 'the server is already marked ready';
		}
		return undefined;
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
			const abortReason = this._warmUpAbortReason(modelId);
			if (abortReason) {
				this._log(`[LoCoPilot Runner] Warm-up aborted for ${modelId}: ${abortReason}.`);
				return;
			}
			try {
				const cts = new CancellationTokenSource(token);
				const timer = setTimeout(() => cts.cancel(), 2000);
				try {
					const res = await this.requestService.request({ type: 'GET', url: probeUrl }, cts.token);
					const status = res.res.statusCode ?? 0;
					await streamToBuffer(res.stream).catch(() => undefined);
					if (status === 200) {
						up = true;
						break;
					}
				} finally {
					clearTimeout(timer);
					cts.dispose();
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
		// Generation phase. This request - not the endpoint probe above - is the one that blocks until the
		// weights are actually resident, so it must be as patient as the real-request path. It used to carry
		// a fixed 15s cancel, which large MLX models blew through every time: the ping was abandoned mid-load,
		// the ready flip below never ran, and the model showed grey until the user's first message re-probed
		// it - even though the abandoned ping finished loading the weights moments later. Cancelling only
		// ends OUR read; mlx_lm keeps computing regardless, so the short timeout hid the result without ever
		// saving the work. Retries exist for a server that rejects the request outright (still starting up);
		// a slow load is not a failure and is simply waited out, up to the shared budget.
		const deadline = Date.now() + LoCoPilotLocalModelRunner.WARMUP_GENERATION_BUDGET_MS;
		const body = JSON.stringify({
			model: requestModel,
			messages: [{ role: 'user', content: 'ping' }],
			max_tokens: 1,
			stream: false,
		});
		for (let attempt = 1; Date.now() < deadline; attempt++) {
			const abortReason = this._warmUpAbortReason(modelId);
			if (abortReason) {
				this._log(`[LoCoPilot Runner] Warm-up stopped for ${modelId}: ${abortReason}.`);
				return;
			}
			const cts = new CancellationTokenSource(token);
			// A single attempt may legitimately stay in flight for the whole remaining budget (it is blocked
			// on the load), so instead of a fixed timeout we watch for teardown - or for someone else marking
			// the server ready - while it runs, and cancel only then.
			let watchTimer: ReturnType<typeof setTimeout> | undefined;
			const watch = () => {
				if (this._warmUpAbortReason(modelId) || Date.now() >= deadline) {
					cts.cancel();
					return;
				}
				watchTimer = setTimeout(watch, 2000);
			};
			watchTimer = setTimeout(watch, 2000);
			try {
				const res = await this.requestService.request({
					type: 'POST',
					url: `${baseUrl}/chat/completions`,
					headers: { 'Content-Type': 'application/json' },
					data: body,
				}, cts.token);
				const status = res.res.statusCode ?? 0;
				await streamToBuffer(res.stream).catch(() => undefined);
				if (status >= 200 && status < 300) {
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
					return;
				}
				this._log(`[LoCoPilot Runner] Warm-up attempt ${attempt} got HTTP ${status} from the ${kind} server on port ${port}; retrying.`);
			} catch (e) {
				this._log(`[LoCoPilot Runner] Warm-up attempt ${attempt} failed (ignored): ${e}`);
			} finally {
				clearTimeout(watchTimer);
				cts.dispose();
			}
			await timeout(1000);
		}
		this._log(`[LoCoPilot Runner] Warm-up gave up: ${kind} server on port ${port} did not generate within ${Math.round(LoCoPilotLocalModelRunner.WARMUP_GENERATION_BUDGET_MS / 1000)}s.`);
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
	 *   1. Bundled self-contained Python with mlx-lm pre-installed, shipped in the macOS arm64 package
	 *      (resources/mlx/darwin-arm64/python/bin/python3) - the zero-setup default. Always preferred when
	 *      present, so a stale personal `locopilot.mlx.pythonPath` (e.g. a venv that only exists on the
	 *      machine it was set on) can never mask the runtime we ship.
	 *   2. User override (locopilot.mlx.pythonPath) - advanced; only used when the bundle is absent from
	 *      this build (non-arm64, or the fetch step didn't run). Existence-checked so a dangling path
	 *      doesn't get handed to the shell.
	 *   3. `python3` on PATH (legacy fallback; requires the user to have installed mlx-lm themselves).
	 */
	private async resolveMlxPython(): Promise<string> {
		const bundled = getBundledMlxPython(this._appRoot);
		if (bundled) {
			try {
				const stat = await this.fileService.stat(URI.file(bundled));
				if (stat.isFile) {
					return bundled;
				}
			} catch {
				// Not bundled in this build - fall through to the override / PATH.
			}
		}
		const configured = (this.configurationService.getValue<string>(ChatConfiguration.LocopilotMlxPythonPath) ?? '').trim();
		if (configured) {
			try {
				const stat = await this.fileService.stat(URI.file(configured));
				if (stat.isFile) {
					return configured;
				}
				this._log(`[LoCoPilot Runner] Ignoring locopilot.mlx.pythonPath "${configured}" - not a file; falling back to python3 on PATH.`);
			} catch {
				this._log(`[LoCoPilot Runner] Ignoring locopilot.mlx.pythonPath "${configured}" - path does not exist; falling back to python3 on PATH.`);
			}
		}
		return 'python3';
	}

	/** Resolves localPath to a language-model .gguf (if it's a directory, finds first weight GGUF; never mmproj). */
	private async resolveModelFilePath(localPath: string): Promise<string> {
		const uri = URI.file(localPath);
		try {
			const stat = await this.fileService.stat(uri);
			if (stat.isFile && localPath.toLowerCase().endsWith('.gguf')) {
				// A prior download bug could persist mmproj - or, until the MTP guard was added to the quant
				// pickers, a standalone `mtp-*.gguf` draft head - as localPath. Both are non-model GGUFs, so
				// recover by picking a sibling weight GGUF. This self-heals installs made by older builds.
				if (!isMmprojGgufPath(localPath) && !isMtpGgufPath(localPath)) {
					return localPath;
				}
				const sibling = await this._firstWeightGgufInDir(dirname(localPath));
				if (sibling) {
					const kind = isMmprojGgufPath(localPath) ? 'mmproj' : 'an MTP draft head';
					this._log(`[LoCoPilot Runner] localPath pointed at ${kind}; using sibling weights instead: ${sibling}`);
					return sibling;
				}
				return localPath;
			}
			if (stat.isDirectory) {
				const fromDir = await this._firstWeightGgufInDir(localPath);
				if (fromDir) {
					return fromDir;
				}
				const dirStat = await this.fileService.resolve(uri);
				for (const c of dirStat.children ?? []) {
					if (c.isDirectory) {
						const sub = await this._firstWeightGgufInDir(c.resource.fsPath);
						if (sub) {
							return sub;
						}
					}
				}
			}
		} catch {
			// ignore
		}
		return localPath;
	}

	/** First real weight `.gguf` in a directory (skips mmproj projectors and MTP draft heads), or undefined. */
	private async _firstWeightGgufInDir(dirPath: string): Promise<string | undefined> {
		try {
			const resolved = await this.fileService.resolve(URI.file(dirPath));
			const gguf = (resolved.children ?? []).find(c => c.isFile && c.name.toLowerCase().endsWith('.gguf')
				&& !isMmprojGgufPath(c.name) && !isMtpGgufPath(c.name));
			return gguf?.resource.fsPath;
		} catch {
			return undefined;
		}
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
			const match = (resolved.children ?? []).find(c => c.isFile && isMmprojGgufPath(c.name));
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
	 * ignores SIGTERM, then waits for the PROCESS itself to die and (best-effort) for the RAM to come back.
	 *
	 * The port closing is NOT the end of teardown: llama.cpp closes its listener early in shutdown while still
	 * holding multi-GB of wired Metal/heap memory, and on a tight machine the release takes seconds. The old
	 * flat 600ms grace let a switch proceed while the dying model's weights were still resident, double-booking
	 * RAM - which is what made the freshly-launched replacement trip the memory watchdog ("stopped because your
	 * system was running out of memory") on a switch that would have been fine two seconds later. So after the
	 * port closes we (1) poll the pid until the process is actually gone, then (2) when `expectedFreedBytes` is
	 * known, poll the live memory snapshot until a meaningful share of it is visible as available again (bounded;
	 * macOS can lag reclaiming wired pages). Every wait is bounded so a stuck teardown can never hang a switch.
	 */
	private async _waitForServerGone(port: number, kind: 'llama' | 'mlx', pid: number, expectedFreedBytes: number = 0): Promise<void> {
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
		// Phase 2: the listener is closed, but the process may still be alive releasing its working set.
		// Wait (bounded) for the pid to actually disappear; escalate once if it lingers.
		const pidDeadline = Date.now() + 7000;
		let pidEscalated = escalated;
		while (Date.now() < pidDeadline && await this._isProcessAlive(pid)) {
			if (!pidEscalated && Date.now() > pidDeadline - 3000) {
				pidEscalated = true;
				await this._killForeignServer(pid, 'SIGKILL');
			}
			await timeout(250);
		}
		// Phase 3: verify the RAM actually came back before the caller launches the replacement. The freed
		// figure is an estimate and the OS reclaims lazily, so accept a third of it as "released" and give up
		// after a few seconds rather than stalling the switch.
		if (expectedFreedBytes > 0) {
			const baseline = this._lastMemoryStatus?.availableBytes;
			const target = Math.min(expectedFreedBytes / 3, 4 * 1024 * 1024 * 1024);
			const memDeadline = Date.now() + 5000;
			while (Date.now() < memDeadline) {
				const mem = await this._getMemoryStatus();
				if (!mem || baseline === undefined || (mem.availableBytes - baseline) >= target) {
					break; // recovered enough, or we can't measure - don't stall on the unmeasurable
				}
				await timeout(500);
			}
		}
		// Final grace for the OS to release the GPU/Metal memory and the socket the old process held.
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
			startedAt: Date.now(),
			ready: true,
		});
		this._watchForeignLogs(lock.modelId);
		await this._loadForeignLogs(lock.modelId);
		this._onDidServerStateChange.fire(lock.modelId);
		this._onDidLogUpdate.fire(lock.modelId);
		this._updateForeignProbe();
		this._log(`[LoCoPilot Runner] Attached to model ${lock.modelId} running in another window on port ${lock.port}.`);
	}

	/**
	 * Arms a periodic (30s) health re-probe while any FOREIGN record is held. A foreign record shows as
	 * "running" in this window but its process belongs to another window - if that window (or its server)
	 * dies without cleaning the shared lock, the indicator here would stay green forever and the next send
	 * would "restart a running model". The probe detaches dead foreign handles proactively so the UI stays
	 * honest. The tick disarms itself once no foreign record remains.
	 */
	private _updateForeignProbe(): void {
		if (this._foreignProbeTimer) {
			return; // already armed; the tick disarms itself when no foreign record remains
		}
		this._foreignProbeTimer = mainWindow.setInterval(async () => {
			const foreign = Array.from(this.runningServers.entries()).filter(([, rec]) => rec.foreign);
			if (foreign.length === 0) {
				if (this._foreignProbeTimer) {
					mainWindow.clearInterval(this._foreignProbeTimer);
					this._foreignProbeTimer = undefined;
				}
				return;
			}
			for (const [id, rec] of foreign) {
				if (!await this._probeServerHealth(rec.port, rec.kind)) {
					// Only detach if the record is still the same foreign one (it may have been replaced meanwhile).
					if (this.runningServers.get(id) === rec) {
						this._disposeForeignLogWatcher(id);
						this.runningServers.delete(id);
						this._onDidServerStateChange.fire(id);
						this._log(`[LoCoPilot Runner] Foreign server for ${id} stopped answering; detached (periodic probe).`);
					}
				}
			}
		}, 30_000);
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
			// A launch that ended in a REAL failure (crash, OOM after the retry ladder, spawn/path error) must
			// surface that concrete reason in chat too - not only in the notification toast. Record it so the
			// provider's getRecentLaunchFailure returns it instead of the misleading "taking a moment to start"
			// (which tells the user to wait and resend a model that has actually stopped). It carries the same
			// 60s TTL as a fit-gate block and is cleared by the next launch attempt or a successful ready.
			this._recordLaunchBlocked(modelId, failureMessage);
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
	 * Returns true when the model is (or was successfully promoted to) running/starting; false when the
	 * launch was abandoned before a server record existed (fit Cancel, silent pre-warm skip, etc.).
	 */
	startServerInTerminal(modelId: string, interactive: boolean = false): Promise<boolean> {
		if (this.runningServers.has(modelId)) {
			this._log(`[LoCoPilot Runner] Server for model ${modelId} is already running.`);
			return Promise.resolve(true);
		}
		const inFlight = this._startInFlight.get(modelId);
		if (inFlight) {
			this._log(`[LoCoPilot Runner] Launch already in progress for model ${modelId}; reusing it.`);
			return inFlight;
		}
		const launch = this._doStartServerInTerminal(modelId, interactive)
			.then(() => this.runningServers.has(modelId) || this.startingServers.has(modelId))
			.catch(() => false)
			.finally(() => {
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
		// A fresh server is a fresh chance at native tool calling. The runtime demotes a model after two
		// tool-shaped failures, which is the right call in the moment but was permanent - and with the model
		// list's tools switch gone there is no manual way back, so two transient errors would strand a
		// perfectly capable model on prompt-injected tools forever. Re-arming here costs at most two failed
		// turns to re-learn, and leaves an explicit user override untouched.
		void this.customLanguageModelsService.retryAutoDisabledTools(modelId);
		// If this model is still tearing down, wait for its process to actually release the RAM before doing
		// anything else. Gating a restart while the old process is still resident measures memory that is about
		// to come back, so the launch is refused (or prompts "Run anyway?") for a model that fits fine a second
		// later. The teardown promise is bounded and never rejects, so this can't stall a launch indefinitely.
		const pendingStop = this._pendingStops.get(modelId);
		if (pendingStop) {
			this._log(`[LoCoPilot Runner] Launch of ${modelId} is waiting for its previous instance to finish stopping.`);
			await pendingStop;
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
				const mlxModelDir = await this.getMlxModelRootPath(model.localPath);
				// Plan the MLX launch BEFORE either gate, exactly as the llama.cpp path does. Previously the
				// context/prompt-cache plan was computed inside _startMlxServerInTerminal - i.e. AFTER both gates -
				// so the gates measured a generic minimum footprint rather than the configuration that would really
				// launch, and could warn about a model the plan had already made fit (or wave through one it hadn't).
				const mlxPlan = await this._computeMlxPlan(modelId, mlxModelDir);
				// Present the plan to the shared gates in llama.cpp tuning terms so both engines are measured by the
				// same arithmetic. MLX exposes no KV quantization, so the cache is always f16, and the client is
				// single-user, so there is exactly one slot.
				const mlxFitTuning: LlamaServerTuning = {
					contextSize: mlxPlan.contextSize,
					kvCachePlan: symmetricKvPlan('f16'),
					parallelSlots: 1,
					ubatchSize: mlxPlan.tuning.prefillStepSize ?? 2048,
				};
				// Same plain-language tight-fit notice the llama.cpp path shows: the plan granted the largest window
				// that fits but it landed below the comfort floor on a model whose own window is larger, i.e. the
				// DEVICE is the limit. Informational only - the model still runs, and the watchdog is the backstop.
				const mlxWindowCeiling = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : 0;
				if (interactive
					&& mlxPlan.contextSize < TARGET_MIN_CONTEXT
					&& mlxWindowCeiling >= TARGET_MIN_CONTEXT
					&& !this._oomContextCap.has(modelId)
					&& !this._tightContextNoticed.has(modelId)) {
					this._tightContextNoticed.add(modelId);
					showTransientNotification(this.notificationService, Severity.Warning, `"${model.displayName || model.modelName}" is a tight fit for your system's memory. You can still use it, but it may slow down or stop on its own during longer chats. For smoother performance, close some apps to free up memory, or pick a smaller model.`, { timeoutMs: 15000 });
				}
				if (!await this._memoryAllowsLaunch(modelId, interactive, 'metal', mlxFitTuning)) {
					return;
				}
				// Same pre-flight fit check as the llama.cpp path: MLX runs on Apple Silicon unified memory via
				// Metal, so there is no separate VRAM pool and the same ~70% wired working-set ceiling applies -
				// pass 'metal' so the gate uses that ceiling rather than the looser 85% system figure. Size the
				// weights from the RESOLVED model root, not the raw localPath, so this matches the transient gate
				// and the actual launch (Q4). The prompt-cache headroom is reserved in the SOFT transient gate
				// (_memoryAllowsLaunch), not here - it is a growable, throttled cache, not a hard capability limit.
				if (!await this._checkModelFitsOrNotify(modelId, mlxModelDir, 'metal', undefined, interactive, 0, mlxFitTuning)) {
					return;
				}
				// The transient gate may have shrunk the window to fit memory free RIGHT NOW; adopt that result so
				// the launched server and the gate that admitted it agree on the context.
				if (mlxFitTuning.contextSize && mlxFitTuning.contextSize < mlxPlan.contextSize) {
					this._log(`[LoCoPilot Runner] MLX context reduced by the availability gate: ${mlxPlan.contextSize} -> ${mlxFitTuning.contextSize}.`);
					mlxPlan.contextSize = mlxFitTuning.contextSize;
				}
				// Both gates passed (or the user chose "Run anyway"): NOW evict the previous model to make room.
				await this._enforceResidentBudget(modelId);
				// Re-probe live memory after the eviction actually released its RAM, so the snapshot the
				// watchdog / Auto label / later gates read reflects post-eviction reality, not the pre-switch
				// figure (which is what made a clean switch look like "still out of memory").
				await this._getMemoryStatus();
				await this._startMlxServerInTerminal(modelId, model as ICustomLanguageModel & { localPath: string }, mlxPlan);
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
			discreteVramBytes = this._discreteVramBytes(backend, hw);
		}

		// Build the base tuning and resolve the vision projector FIRST, so both the pre-flight fit check and
		// the hardware-aware budget below account for the *full* resident footprint - weights + KV + a draft
		// model (MTP) + the mmproj projector. Loading these extras without reserving for them is what OOM-ed
		// the Metal command buffer (kIOGPUCommandBufferCallbackErrorOutOfMemory) on a 16GB Mac.
		// Load what previous sessions learned about this engine's KV support BEFORE building the tuning, so a model
		// that already failed on a quantized V cache launches with f16 straight away instead of failing once more.
		await this._ensureKvQuantCapabilityLoaded();
		// Same for MTP: a model whose embedded draft head already failed to load launches dense straight away
		// rather than repeating the crash-and-relaunch once per app start.
		await this._ensureMtpUnsupportedLoaded();
		const baseTuning = this._getLlamaTuning(model);
		// Requested context CEILING: aim for the model's full window and let the memory clamp be the real limiter,
		// instead of the legacy 16384 default silently capping every model. An EXPLICIT per-model context (set by
		// the user in their model list) wins - whether higher OR intentionally lower; otherwise we request the
		// model's trained window from the GGUF. The clamp then grants the largest slice that fits (down to the
		// TARGET_MIN comfort floor, using q4 KV if needed), so a big-window model on a roomy machine gets a big
		// context and a tight one is trimmed to fit - never OOM-ed by requesting more than the device holds.
		try {
			const ceilingInfo = await this._getModelInfo(modelPath);
			const trainedWindow = ceilingInfo.contextLength && ceilingInfo.contextLength > 0 ? ceilingInfo.contextLength : undefined;
			const explicitPerModel = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : undefined;
			// Ask for the model's FULL window and let the memory clamp be the only limiter. There is deliberately no
			// constant ceiling here: a fixed target would hand a 128 GB machine the same window as a 32 GB one, and it
			// is not what makes room for speculative decoding either - the MTP head is subtracted from the budget
			// BEFORE context is sized (see the reserve below and _augmentTuningWithHardware), so a tight machine gives
			// back exactly the length MTP needs and a roomy one gives back nothing. Measured on a 32 GB M1 Max: a 27B
			// lands on q8_0/40960 with MTP on whether this asks for 65536 or the full 262144 - the reserve does the
			// work, a cap would only have cost the 64 GB+ machines their context.
			const requestedCeiling = explicitPerModel ?? trainedWindow ?? baseTuning.contextSize ?? DEFAULT_LLAMA_CONTEXT_SIZE;
			// Never request beyond the trained window (rope stays un-scaled) or the absolute backstop.
			baseTuning.contextSize = Math.max(
				MIN_CLAMPED_CONTEXT,
				Math.min(requestedCeiling, trainedWindow ?? requestedCeiling, MAX_CLAMPED_CONTEXT));
		} catch {
			// GGUF unreadable (e.g. Ollama-managed): leave the settings-derived context as-is.
		}
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
			// Force --swa-full OFF for the relaunch. On sliding-window models (Gemma) it keeps a FULL-size KV
			// cache for every SWA layer instead of the small window, which is the usual cause of the Metal
			// command-buffer OOM. `false` (not undefined) so _augmentTuningWithHardware's auto-enable can't turn
			// it back on. Trades cross-turn prompt-cache reuse for actually fitting - the right call under OOM.
			baseTuning.swaFull = false;
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
		// MTP loads a lightweight embedded head from the same GGUF (see below); a user-configured separate draft
		// costs its own file size (fall back to a full weights-worth when it can't be statted - the safe direction).
		const weightBytesForBudget = await this._weightBytesOnDisk(modelPath);
		let extraResidentBytes = mmprojBytes;
		const userDraftPath = baseTuning.draftModelPath?.trim();
		if (baseTuning.multiTokenPrediction) {
			// MTP's memory has two halves, budgeted in two different places, and conflating them is what used to
			// disable it on the machines it was meant for:
			//   - the DRAFT CONTEXT's KV scales with n_ctx and is charged by the context clamp, via
			//     MTP_DRAFT_KV_LAYER_EQUIV (see _augmentTuningWithHardware). It must not be double-charged here.
			//   - the HEAD TENSORS are a small fixed cost, and are what this reserve covers.
			// The old code reserved ~8% of the WEIGHTS for both halves at once (~1.4 GB on a 27B) and then GATED MTP
			// on that figure BEFORE the clamp had sized anything, pricing the cache at a fabricated 16K/f16 window
			// that no launch ever used. On a 32 GB Mac that arithmetic missed by a few hundred MB, so speculative
			// decoding was silently dropped on a model chosen specifically for it - and the clamp then handed the very
			// same memory to context anyway. MTP is now carried through the planner as a first-class cost and is only
			// ever dropped AFTER a real plan exists: see the post-clamp verification below, which is the sole place
			// that can turn it off and which prices it with the context and KV precision that will really launch.
			extraResidentBytes += mtpHeadResidentBytes(weightBytesForBudget);
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
		// NOTE: n-gram drafting (`--spec-type ngram-mod`) used to be auto-enabled here as the fallback whenever
		// neither MTP nor a paired draft model was available. It is no longer: measured across six real agent
		// sessions (Qwen3-4B, Qwen3-30B-A3B, Qwen3.6-27B, Gemma-4-26B-A4B, Gemma-4-E4B, Nemotron-30B-A3B) it
		// generated ZERO drafts in every single one - `#gen drafts = 0, #acc drafts = 0` in all of them - while
		// still costing a 16 MB mod table per server plus its per-call overhead. Its default
		// `n_match=24` requires a 24-token literal repeat before it will draft anything, which agent chat traffic
		// essentially never produces. MTP is unaffected and remains the real speculation path (it measured 45-54%
		// acceptance on Qwen3.5-0.8B and 70-85% on Qwen3.5-9B), as does a downloaded paired draft model. Users who
		// want n-gram drafting can still turn it on explicitly via `locopilot.llamaCpp.promptLookup`.
		// A build that already rejected speculative flags gets them stripped so the relaunch (and every
		// launch after) starts cleanly. This also drops MTP: same --spec-type mechanism, same rejection.
		if (this._specFlagsUnsupported && (baseTuning.multiTokenPrediction || baseTuning.draftModelPath?.trim() || baseTuning.promptLookup)) {
			this._log('[LoCoPilot Runner] This llama.cpp build does not support speculative decoding flags; launching without them.');
			baseTuning.multiTokenPrediction = false;
			baseTuning.draftModelPath = undefined;
			baseTuning.promptLookup = false;
			extraResidentBytes = mmprojBytes;
		}

		// Finalize all automatic reductions BEFORE either user-facing memory gate. The gate must assess the
		// configuration we will really launch (clamped context, q8/q4 KV, offload plan, stripped extras), not an
		// earlier worst-case approximation that can warn even though auto-tuning has already made the model fit.
		// An active OOM-ladder cap is the one case allowed below the usability floor, so the clamp must be told
		// not to raise it back up (otherwise the degraded relaunch requests the same window that just OOM-ed).
		const oomLadderCap = this._oomContextCap.get(modelId);
		let tuning = await this._augmentTuningWithHardware(
			modelPath, backend, baseTuning, extraResidentBytes,
			oomLadderCap && oomLadderCap > 0 ? oomLadderCap : undefined);
		// MTP post-clamp verification - the ONLY place MTP is dropped for memory reasons.
		// Everything above carried it as a first-class cost, so `tuning` already describes a context sized to hold
		// BOTH the main and the draft KV cache. Only now, with the real context and the real KV precision decided,
		// is there anything worth checking - and unlike the old pre-clamp gate this prices the launch that will
		// actually happen. When it does fail we replan without MTP, which gives the context back the draft cache
		// was holding, so dropping speculation is never also a context penalty.
		if (tuning.multiTokenPrediction) {
			const mtpFit = await this._computeFit(modelPath, backend, discreteVramBytes, extraResidentBytes, tuning);
			if (mtpFit && mtpFit.requiredBytes > mtpFit.usableBytes) {
				this._log(`[LoCoPilot Runner] MTP disabled for ${modelId}: the planned ${tuning.contextSize}-token context plus the draft head needs ~${Math.round(mtpFit.requiredBytes / 1e9)}GB against a ~${Math.round(mtpFit.usableBytes / 1e9)}GB budget. Replanning without it.`);
				baseTuning.multiTokenPrediction = false;
				extraResidentBytes = Math.max(0, extraResidentBytes - mtpHeadResidentBytes(weightBytesForBudget));
				tuning = await this._augmentTuningWithHardware(
					modelPath, backend, baseTuning, extraResidentBytes,
					oomLadderCap && oomLadderCap > 0 ? oomLadderCap : undefined);
			}
		}
		// Tight-fit notice: the clamp granted the largest context that fits, but it landed below the comfort floor
		// (TARGET_MIN) on a model whose own window is larger - i.e. the DEVICE, not the model, is the limit. The
		// model still runs (at best fit; the watchdog auto-stops it if memory later runs out), so this is a plain-
		// language heads-up, NOT a blocking gate. Skipped when the model's own trained window is below the floor
		// (then the small window is just its size, not a shortfall) and when we've already told the user once.
		const finalCtx = tuning.contextSize ?? 0;
		const modelWindowCeiling = baseTuning.contextSize ?? 0; // resolved above to per-model override / trained window
		if (interactive
			&& finalCtx > 0
			&& finalCtx < TARGET_MIN_CONTEXT
			&& modelWindowCeiling >= TARGET_MIN_CONTEXT
			&& !this._oomContextCap.has(modelId) // an OOM-ladder cap is a separate, already-surfaced situation
			&& !this._tightContextNoticed.has(modelId)) {
			this._tightContextNoticed.add(modelId);
			const displayName = model.modelName ?? model.id;
			showTransientNotification(this.notificationService, Severity.Warning, `"${displayName}" is a tight fit for your system's memory. You can still use it, but it may slow down or stop on its own during longer chats. For smoother performance, close some apps to free up memory, or pick a smaller model.`, { timeoutMs: 15000 });
		}
		if (!await this._memoryAllowsLaunch(modelId, interactive, backend, tuning, extraResidentBytes)) {
			return;
		}
		if (!await this._checkModelFitsOrNotify(modelId, modelPath, backend, discreteVramBytes, interactive, extraResidentBytes, tuning)) {
			return;
		}

		// Both gates passed (or the user chose "Run anyway"): NOW evict the previous model to make room. Doing
		// this only here - after the fit dialog - means "Keep current model" leaves the previous server running.
		await this._enforceResidentBudget(modelId);
		// Re-probe live memory after the eviction actually released its RAM, so the snapshot the watchdog /
		// Auto label / later gates read reflects post-eviction reality, not the pre-switch figure.
		await this._getMemoryStatus();

		const port = await this.findAvailablePort(LOCOPILOT_LLAMA_SERVER_PORT);
		// Make sure the slot-save dir exists before launch: llama.cpp only touches it on save/restore, but
		// creating it up front keeps the --slot-save-path flag valid for the whole server lifetime.
		await this._ensureKvCacheDir();
		// Remember the context this launch runs with, so an OOM crash can halve it on the retry.
		const launchContext = tuning.contextSize ?? DEFAULT_LLAMA_CONTEXT_SIZE;
		this._lastLaunchContext.set(modelId, launchContext);
		// Drop the previous server's scraped window so we report the request until THIS launch prints its own
		// n_ctx - otherwise a relaunch at a different size would briefly show the old server's figure.
		this._actualContextWindow.delete(modelId);
		// Remember the resolved KV cache type this server uses, so slot save/restore only reuses a byte-compatible
		// blob (see _lastLaunchKvType / _slotCacheFileName). Mirrors getLlamaCppServerCommand's own resolution.
		this._lastLaunchKvType.set(modelId, kvPlanId(tuning.kvCachePlan ?? resolveKvCachePlan(tuning.kvCacheType ?? 'auto', launchContext)));
		const { command, args } = getLlamaCppServerCommand(modelPath, backend, serverPath, port, tuning);
		// Remember whether this launch carries speculative flags, so a crash caused by an old build rejecting
		// them can be told apart from a real failure and self-healed (relaunch without speculation).
		if (args.includes('--spec-type') || args.includes('--model-draft')) {
			this._launchedWithSpecFlags.add(modelId);
		} else {
			this._launchedWithSpecFlags.delete(modelId);
		}
		// Track whether this launch stood up a real DRAFT KV context (separate draft model, or an MTP/next-n
		// speculative head). Those make /slots save+restore ineffective (see _launchedWithDraftContext), so the
		// prewarm must warm in-session rather than trust a restored blob. n-gram speculation has no such context.
		const specTypeIdx = args.indexOf('--spec-type');
		const specTypeVal = specTypeIdx >= 0 ? args[specTypeIdx + 1] : undefined;
		if (args.includes('--model-draft') || specTypeVal?.startsWith('draft')) {
			this._launchedWithDraftContext.add(modelId);
		} else {
			this._launchedWithDraftContext.delete(modelId);
		}
		// Track MTP separately from speculation as a whole: an MTP-shaped crash must demote THIS MODEL to dense
		// (persisted, see _mtpUnsupported) rather than switch off speculative decoding session-wide.
		if (specTypeVal === 'draft-mtp' && !args.includes('--model-draft')) {
			this._launchedWithMtp.add(modelId);
		} else {
			this._launchedWithMtp.delete(modelId);
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
		// Which KV halves this launch actually asked the engine to quantize. Recorded per half because they fail
		// for different reasons: a quantized V needs Flash Attention, a quantized K does not. The crash handler
		// only trusts a "quantized X cache was requested" error when THIS launch really requested it.
		if (args.includes('--cache-type-k')) {
			this._launchedWithQuantizedK.add(modelId);
		} else {
			this._launchedWithQuantizedK.delete(modelId);
		}
		if (args.includes('--cache-type-v')) {
			this._launchedWithQuantizedV.add(modelId);
		} else {
			this._launchedWithQuantizedV.delete(modelId);
		}
		this._log(`[LoCoPilot Runner] Starting llama.cpp server for model ${modelId} on port ${port} with backend: ${backend}`);

		// Launch the binary DIRECTLY as the terminal's process (executable + args[]), NOT by typing a
		// command line into a shell. This avoids shell-specific quoting bugs - most importantly the
		// PowerShell gotcha where a quoted path (e.g. an install under "C:\Program Files\...") is echoed
		// as a string literal instead of executed, so llama-server.exe never starts and the port stays
		// closed. Passing args as a string[] lets the pty escape them correctly on every platform.
		const launchEnv = this._serverLaunchEnv(serverPath, tuning);
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
			this._wedgedBackends.delete(modelId); // fresh launch: re-arm wedged-backend detection for this server
			// This terminal now owns the model's lifecycle. Any previously-registered onExit (from an earlier
			// start that was stopped/evicted/retried) will see a mismatch here and ignore its exit, so it can't
			// clobber this record or raise a false crash for a model that is now running.
			this._activeLaunchTerminals.set(modelId, terminal);

			this._register(terminal.onLineData(line => {
				logs.push(line);
				if (logs.length > LoCoPilotLocalModelRunner.MAX_LOG_LINES) {
					logs.splice(0, logs.length - LoCoPilotLocalModelRunner.MAX_LOG_LINES);
				}
				// A GPU backend that failed at compute but left the PROCESS ALIVE (the classic Metal command-buffer
				// OOM). These lines only ever print when compute has genuinely failed and, once the backend reports
				// it is "in error state", it is unrecoverable - any following "model loaded"/"listening" is a lie and
				// every decode returns Compute error. Tear it down and drive it through the OOM ladder (relaunch
				// smaller, no --swa-full) instead of leaving a green-but-wedged server. _handleWedgedBackend latches
				// so this fires once per resident server despite the torrential repeats in the log.
				if (/backend is in error state|ggml_backend_sched_graph_compute_async failed|failed to compute graph|failed to decode, ret = -3/i.test(line)) {
					void this._handleWedgedBackend(modelId, model.modelName, logs);
				}
				// Capture the context window the server actually came up with (may be smaller than our -c).
				// Done before the `rec` lookup below: these lines print while the model is still loading, so
				// the figure is already correct by the time the model flips to ready.
				this._recordActualContextWindow(modelId, line);
				const rec = this.runningServers.get(modelId);
				if (rec) {
					const progress = this._parseLoadProgress(line);
					if (progress) {
						rec.loadProgress = progress;
					}
					// llama.cpp prints this once the HTTP endpoint is up and the model is loaded. Use it to flip
					// the phase to 'ready' even for launches that don't go through ensureServerForModel (e.g. the
					// manual Retry path), so the running indicator turns green promptly. Suppressed once the backend
					// is known-wedged so a post-failure "model loaded" line can't re-green a dead server.
					if (!rec.ready && !this._wedgedBackends.has(modelId) && /server is listening|HTTP server listening|all slots are idle|model loaded/i.test(line)) {
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
			this.runningServers.set(modelId, { port, terminal, kind: 'llama', logs, lastUsedAt: Date.now(), startedAt: Date.now(), ready: false });
			this._releaseReservedPort(port); // now tracked via runningServers; reservation no longer needed
			// Advertise this server to other windows so they attach to it instead of launching a duplicate.
			void this._publishActiveServerLock(port, 'llama', terminal, modelId);
			this._onDidServerStateChange.fire(modelId);
			// A resident server means estimates are now live commitments - arm the memory circuit breaker.
			this._updateMemoryWatchdog();
			// Keep the machine responsive (and cooler) while the model loads/serves: run it below the UI.
			void this._deprioritizeServerProcess(terminal, model.modelName);

			// Warm up in the background so the first real message has no kernel-JIT / cache lag.
			// COMMENTED OUT FOR TESTING: this 1-token ping is an unrelated prompt on the single slot,
			// so it evicts the slot's KV/checkpoints ("forcing full prompt re-processing"). Uncomment
			// to restore. (The MLX warm-up call is left alone - it also flips the ready phase.)
			// if (this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppWarmup) !== false) {
			// 	this._warmUpLocalServer(modelId, port, 'llama', model.modelName);
			// }

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
	async ensureServerForModel(modelId: string, token: CancellationToken = CancellationToken.None, interactive: boolean = true): Promise<string | undefined> {
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
			// interactive is true on the user's send/use action (a too-big model prompts "Run anyway?") and false
			// for background pre-warm, which must never interrupt the user with the fit dialog.
			await this.startServerInTerminal(modelId, interactive);
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
		// Only pre-warm models we actually launch a managed server for (GGUF/MLX). Ollama, custom endpoints
		// (provider id `localhost`) and cloud manage their own lifecycle, so there is nothing to warm here -
		// and trying would launch a managed server for a URL we do not own.
		if (!model || !model.localPath || model.provider !== 'huggingface') {
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
		// interactive=false: a background pre-warm must never pop the "Run anyway?" fit dialog.
		this._suppressCrashNotice.add(modelId);
		const baseUrl = await this.ensureServerForModel(modelId, undefined, false);
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
		// Still interactive=false - it remains a background pre-warm, so no fit dialog.
		await this.ensureServerForModel(modelId, undefined, false);
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
			cancelButton: { label: 'Cancel', run: () => 'keep' as const },
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
	 * Explicit user Start (model list / picker play / Ollama Run): pin that model as the chat panel's
	 * selected model so the picker label and subsequent requests target it. Only updates
	 * `selectedCustomModelId` here; the chat input's `_currentLanguageModel` is synced by the model
	 * picker when it sees the selection change (see modelPickerActionItem). Must run AFTER the
	 * interactive launch is already in `_startInFlight` so a picker pre-warm joins that launch.
	 */
	private _selectStartedModelInChatPanel(modelId: string): void {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model) {
			return;
		}
		if (this.customLanguageModelsService.getSelectedCustomModelId() === modelId) {
			return;
		}
		this.customLanguageModelsService.setSelectedCustomModelId(modelId);
		this._log(`[LoCoPilot Runner] Selected started model ${modelId} in chat panel.`);
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
	private async _memoryAllowsLaunch(modelId: string, interactive: boolean, backend?: LlamaBackend, tuning?: LlamaServerTuning, extraResidentBytes: number = 0): Promise<boolean> {
		// Keep one live snapshot for the complete decision. Re-probing while searching context sizes introduces
		// jitter (and repeatedly spawns the platform probes) even though every candidate belongs to one launch.
		const memoryStatus = await this._getMemoryStatus();
		let fit = await this._computeLaunchFit(modelId, interactive, backend, tuning, extraResidentBytes, memoryStatus);
		if (!fit || fit.fits) {
			return true; // can't measure (never block on the unmeasurable), or it fits.
		}

		// A requested long context is not a reason to block a model that can safely serve normal turns at a
		// smaller window. The hardware tuner has already resolved KV quantization/offload/extras; now search for
		// the largest 1024-token context that fits CURRENT available memory and mutate the same tuning object that
		// is passed to getLlamaCppServerCommand. Thus the gate and actual allocation cannot disagree. The usability
		// floor is the minimum useful agent context; only a model that still misses there reaches the dialog.
		const requestedContext = tuning?.contextSize ?? 0;
		if (tuning && requestedContext > MIN_CLAMPED_CONTEXT && fit.pressure !== 'critical') {
			const fitAt = (contextSize: number, kvCachePlan?: KvCachePlan) => this._computeLaunchFit(
				modelId,
				interactive,
				backend,
				{ ...tuning, contextSize, ...(kvCachePlan ? { kvCachePlan } : {}) },
				extraResidentBytes,
				memoryStatus
			);
			const minimumFit = await fitAt(MIN_CLAMPED_CONTEXT);
			if (minimumFit?.fits) {
				const step = 1024;
				let bestContext = MIN_CLAMPED_CONTEXT;
				let bestFit = minimumFit;
				let low = Math.floor(MIN_CLAMPED_CONTEXT / step) + 1;
				let high = Math.max(low - 1, Math.floor(requestedContext / step));
				while (low <= high) {
					const mid = Math.floor((low + high) / 2);
					const candidateContext = mid * step;
					const candidateFit = await fitAt(candidateContext);
					if (!candidateFit) {
						return true; // measurement became unavailable; preserve the established fail-open policy
					}
					if (candidateFit.fits) {
						bestContext = candidateContext;
						bestFit = candidateFit;
						low = mid + 1;
					} else {
						high = mid - 1;
					}
				}
				tuning.contextSize = Math.min(requestedContext, bestContext);
				this._log(`[LoCoPilot Runner] Auto-reduced launch context for ${modelId}: ${requestedContext} -> ${tuning.contextSize} tokens; optimized footprint ~${bestFit.needGb}GB fits ~${bestFit.haveGb}GB currently available.`);
				await this._reclaimKvQualityForContext(modelId, tuning, fitAt);
				return true;
			}
			// If even 4K misses, show/record numbers for that minimum viable plan rather than alarming the user
			// with the much larger requested-context footprint.
			if (minimumFit) {
				fit = minimumFit;
			}
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

	/**
	 * Re-plans KV precision after the transient gate shrank the context, and upgrades it as far as the freed
	 * bytes allow. The launch planner picked the precision for the ORIGINAL window - e.g. it dropped to a 4-bit
	 * K cache purely to reach the comfort floor at 65K. Once available memory forces that window down to, say,
	 * 20K, the cache is several times smaller and a higher-quality rung usually fits again; keeping the lossier
	 * one would give away quality that nothing is buying. Walks {@link KV_CACHE_TIERS} best-first and adopts the
	 * highest-quality rung that still fits at the reduced context.
	 *
	 * No-op when the user pinned a fixed KV type (their choice is not ours to upgrade), when the plan is already
	 * the best rung, or when the fit becomes unmeasurable - the existing plan is always a safe fallback since it
	 * is never more expensive than the one that just passed.
	 */
	private async _reclaimKvQualityForContext(
		modelId: string,
		tuning: LlamaServerTuning,
		fitAt: (contextSize: number, kvCachePlan?: KvCachePlan) => Promise<{ fits: boolean } | undefined>
	): Promise<void> {
		if ((tuning.kvCacheType ?? 'auto') !== 'auto' || !tuning.contextSize) {
			return;
		}
		const current = tuning.kvCachePlan;
		if (!current) {
			return;
		}
		// Walk the ladder the LAUNCH will use: on a model whose engine rejected a half, the plan in hand is a
		// coerced rung (e.g. q8_0-f16) that doesn't appear in the raw ladder at all, and looking it up there would
		// silently skip the reclaim.
		const tiers = kvCacheTiersFor(tuning.kvQuantCapability);
		const currentIndex = tiers.findIndex(t => t.k === current.k && t.v === current.v);
		if (currentIndex <= 0) {
			return; // unknown plan, or already the highest-quality rung
		}
		// f16 is deliberately not reclaimed for large windows: above the auto-quant threshold q8_0's quality
		// delta is unmeasurable while its cache is half the size, so "upgrading" there would only spend memory.
		const startIndex = tuning.contextSize >= DEFAULT_LLAMA_CONTEXT_SIZE ? 1 : 0;
		for (let i = startIndex; i < currentIndex; i++) {
			const candidate = tiers[i];
			const candidateFit = await fitAt(tuning.contextSize, candidate);
			if (candidateFit?.fits) {
				this._log(`[LoCoPilot Runner] Reclaimed KV quality for ${modelId} at the reduced ${tuning.contextSize}-token window: ${kvPlanId(current)} -> ${kvPlanId(candidate)}.`);
				tuning.kvCachePlan = candidate;
				return;
			}
		}
	}

	getHardwareProfile(): IHardwareProfile | undefined {
		if (this._hardwareProfile) {
			return this._hardwareProfile;
		}
		if (!this._hardwareProfileInFlight) {
			// Fire-and-forget from a render path; the result lands in the cache for the next paint.
			this._hardwareProfileInFlight = (async () => {
				const [hw, mem] = await Promise.all([this._getHardwareInfo(), this._getSystemMemory()]);
				if (!hw || !mem?.totalmem) {
					return;
				}
				const appleSilicon = hw.gpus.some(g => g.vendor === 'apple') || isAppleSiliconMac();
				// Only DISCRETE VRAM is a separate pool; Apple's unified memory reports 0 here, and an integrated
				// GPU's "dedicated VRAM" is a system-RAM carve-out - counting it would size every recommendation
				// against a few hundred MB instead of the machine's real memory.
				const target = appleSilicon ? undefined : hw.gpus.reduce<IGpuInfo | undefined>(
					(best, g) => g.vendor !== 'apple' && !g.isIntegrated && g.totalVramBytes > 0 && (!best || g.totalVramBytes > best.totalVramBytes) ? g : best,
					undefined);
				this._hardwareProfile = {
					totalRamBytes: mem.totalmem,
					isAppleSilicon: appleSilicon,
					metalWiredLimitBytes: hw.metalWiredLimitBytes,
					discreteVramBytes: target?.totalVramBytes ?? 0,
					discreteVramFreeBytes: target?.freeVramBytes ?? 0,
				};
				this._onDidAvailableRamChange.fire(); // nudge the badges to redraw with real hardware facts
			})().catch(e => this._log(`[LoCoPilot Runner] Hardware profile probe failed (ignored): ${e}`))
				.finally(() => { this._hardwareProfileInFlight = undefined; });
		}
		return undefined;
	}

	getAutoPlan(modelId: string): IAutoModelPlan | undefined {
		const cached = this._autoPlanCache.get(modelId);
		if (cached) {
			return cached;
		}
		if (!this._autoPlanInFlight.has(modelId)) {
			this._autoPlanInFlight.add(modelId);
			// Fire-and-forget: this call is on a render path. The result lands in the cache for the next paint.
			this._measureAutoPlan(modelId)
				.then(plan => {
					if (plan) {
						this._autoPlanCache.set(modelId, plan);
						this._onDidServerStateChange.fire(modelId); // nudge the picker to redraw with real numbers
					}
				})
				.catch(e => this._log(`[LoCoPilot Runner] Auto plan measurement failed for ${modelId} (ignored): ${e}`))
				.finally(() => this._autoPlanInFlight.delete(modelId));
		}
		return undefined;
	}

	/**
	 * Measures one model's real launch plan: the weight bytes actually on disk and the context the clamp would
	 * grant, using the SAME budget/geometry/KV-ladder path a launch uses. Deliberately does not run the offload
	 * planner or the live-RAM gate - Auto only needs the steady-state shape of the pick, and the request path's
	 * `wouldModelFitForLaunch` step-down still applies the momentary check.
	 */
	private async _measureAutoPlan(modelId: string): Promise<IAutoModelPlan | undefined> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model?.localPath) {
			return undefined;
		}
		const kind = await this._intendedServerKind(modelId);
		let modelPath: string;
		try {
			modelPath = kind === 'mlx' ? await this.getMlxModelRootPath(model.localPath) : await this.resolveModelFilePath(model.localPath);
		} catch {
			return undefined;
		}
		const weightBytes = await this._weightBytesOnDisk(modelPath);
		if (weightBytes <= 0) {
			return undefined;
		}
		const backend: LlamaBackend = kind === 'mlx' ? 'metal' : await this._resolveBackendForFit();
		const hw = await this._getHardwareInfo();
		const budget = hw ? await this._memoryBudgetBytes(backend, hw) : undefined;
		if (!budget || budget <= 0) {
			return { weightBytes, plannedContext: 0 }; // size is known, context isn't - catalog tier still applies
		}
		const info = await this._getModelInfo(modelPath).catch(() => undefined);
		const requestedContext = model.contextWindow && model.contextWindow > 0
			? model.contextWindow
			: (info?.contextLength ?? DEFAULT_LLAMA_CONTEXT_SIZE);
		// Mirror the launch planner: the fixed recurrent state of a hybrid model comes off the budget before the
		// per-token KV term sizes the window, and only attention blocks are charged that term.
		const kvBudgetBytes = Math.max(0, computeKvBudgetBytes(budget, weightBytes, RUNTIME_OVERHEAD_BYTES)
			- (info ? recurrentStateBytes(info) : 0));
		const f16PerTokenPerLayer = (info && kvBytesPerTokenPerLayer(info, kvCacheBytesPerElem('f16')))
			?? DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16;
		const kvLayers = info && kvLayerCount(info);
		// MLX has no KV quantization, so it is measured at f16; llama.cpp runs the same automatic ladder a
		// launch would, including the sliding-window sizing that decides how much context a Gemma really gets.
		const plannedContext = kind === 'mlx'
			? clampContextSize({
				requestedContext,
				modelContextLength: info?.contextLength,
				kvBudgetBytes,
				layerCount: kvLayers,
				kvBytesPerTokenPerLayer: f16PerTokenPerLayer,
			})
			: selectAutomaticKvCache({
				requestedContext,
				modelContextLength: info?.contextLength,
				kvBudgetBytes,
				layerCount: kvLayers,
				kvBytesPerTokenPerLayerF16: f16PerTokenPerLayer,
				slidingWindow: info?.slidingWindow,
			}).contextSize;
		return { weightBytes, plannedContext };
	}

	/** Drops measured Auto plans so they are re-measured against current conditions (RAM, downloads, quants). */
	private _invalidateAutoPlans(): void {
		this._autoPlanCache.clear();
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
	private async _computeLaunchFit(modelId: string, interactive: boolean, resolvedBackend?: LlamaBackend, tuning?: LlamaServerTuning, llamaExtraResidentBytes: number = 0, memoryStatus?: IMemoryStatus): Promise<{ fits: boolean; needGb: number; haveGb: number; name: string; pressure: MemoryPressureLevel; evictableGb: number } | undefined> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.localPath) {
			return undefined;
		}
		if (this._forcedLaunch.has(modelId)) {
			return undefined; // user already chose "Run anyway" for this model
		}
		const mem = memoryStatus ?? await this._getMemoryStatus();
		if (!mem) {
			return undefined; // no live probe -> never block on what we can't measure
		}
		const kind = await this._intendedServerKind(modelId);
		const backend: LlamaBackend = kind === 'mlx' ? 'metal' : (resolvedBackend ?? await this._resolveBackendForFit());
		let modelPath: string;
		try {
			modelPath = kind === 'mlx' ? await this.getMlxModelRootPath(model.localPath) : await this.resolveModelFilePath(model.localPath);
		} catch {
			return undefined;
		}
		// Charge the footprint of the plan that will actually launch. MLX contributes only its guaranteed
		// minimum prompt cache (the larger configured value is a growable cap); llama.cpp contributes the
		// finalized draft/projector extras selected before this gate.
		const extraResidentBytes = kind === 'mlx'
			? this._mlxRuntimeReserveBytes(mem.totalBytes)
			: llamaExtraResidentBytes;
		const hw = await this._getHardwareInfo();
		const discreteVramBytes = this._discreteVramBytes(backend, hw);
		const fit = await this._computeFit(modelPath, backend, discreteVramBytes, extraResidentBytes, tuning);
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
		// availableBytes already includes reclaimable file cache, so excluding all weights double-counted that
		// reclaimability and admitted launches that had room for KV but not for the weights they were about to
		// touch. Metal weights become wired: charge 90%. CPU mmap can page cold tensors, but a sustained decode
		// touches most layers: charge 70% (100% with --mlock). On a discrete GPU charge only the portion that
		// remains in host RAM after the conservative VRAM weight allowance.
		// Discrete GPU: the host half was already computed exactly by _computeFit (weights that did NOT offload,
		// plus the host share of runtime overhead), so use it directly instead of re-deriving one from a total
		// that may now describe the VRAM pool. The VRAM half is not measurable against host availability at all -
		// it is enforced by the capability gate, which compares it to the live free-VRAM budget.
		const hostWeightBytes = fit.gpuWeightBytes !== undefined
			? Math.max(0, fit.weightBytes - fit.gpuWeightBytes)
			: fit.weightBytes;
		const nonWeightBytes = fit.hostRequiredBytes !== undefined
			? Math.max(0, fit.hostRequiredBytes - hostWeightBytes)
			: Math.max(0, fit.requiredBytes - fit.weightBytes);
		let residentWeightBytes: number;
		if (!interactive) {
			residentWeightBytes = hostWeightBytes;
		} else if (backend === 'metal') {
			residentWeightBytes = fit.weightBytes * 0.9;
		} else if (backend === 'cpu') {
			const mlock = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppMlock) === true;
			residentWeightBytes = fit.weightBytes * (mlock ? 1 : 0.7);
		} else if (fit.gpuWeightBytes !== undefined) {
			// Only the CPU-resident remainder competes for host RAM; it is mmap-backed and pages like any weight file.
			residentWeightBytes = hostWeightBytes * 0.7;
		} else {
			const vramWeightAllowance = (discreteVramBytes ?? 0) * (1 - KV_BUDGET_FRACTION) * 0.9;
			residentWeightBytes = Math.max(0, fit.weightBytes - vramWeightAllowance);
		}
		const requiredFreeNow = nonWeightBytes + residentWeightBytes;
		const estimateTolerance = Math.max(
			LAUNCH_FIT_TOLERANCE_MIN_BYTES,
			requiredFreeNow * LAUNCH_FIT_TOLERANCE_FRACTION
		);
		const GB = 1024 * 1024 * 1024;
		return {
			// A critical kernel-pressure signal always blocks. Otherwise only prompt for a material shortfall:
			// exact byte comparison made harmless mmap/cache/driver estimation noise look like an unsafe launch
			// (for example ~8.7 GiB estimated vs ~8.6 GiB kernel-available, displayed misleadingly as 9 vs 8).
			fits: mem.pressure !== 'critical' && requiredFreeNow <= availableNow + estimateTolerance,
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
	 * MLX `/models` becomes available before its worker has loaded weights; a tiny generation is readiness.
	 *
	 * The timeout is deliberately long. Cancelling only ends OUR read of the response - mlx_lm still runs the
	 * ping to completion on its single decode thread - so a short timeout doesn't free the server, it just
	 * leaves an abandoned request queued ahead of the user's real one. At 10s a multi-minute load stacked up
	 * a fresh orphan every ~11s; one patient probe per minute costs the same information for a fraction of
	 * the queue. Callers poll this serially, so at most one probe is ever in flight.
	 */
	private async _probeMlxGenerationReady(baseUrl: string, modelId: string, token: CancellationToken): Promise<boolean> {
		const rec = this.runningServers.get(modelId);
		if (!rec || rec.kind !== 'mlx' || !rec.servedModelId) {
			return false;
		}
		const cts = new CancellationTokenSource(token);
		const timer = setTimeout(() => cts.cancel(), 60_000);
		try {
			const res = await this.requestService.request({
				type: 'POST',
				url: `${baseUrl}/chat/completions`,
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({
					model: rec.servedModelId,
					messages: [{ role: 'user', content: 'ping' }],
					max_tokens: 1,
					stream: false,
				}),
			}, cts.token);
			const status = res.res.statusCode ?? 0;
			await streamToBuffer(res.stream).catch(() => undefined);
			return status >= 200 && status < 300;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
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
		// Wall-clock backstop alongside the attempt count. Each MLX attempt can now block for up to a minute
		// on its generation probe (see _probeMlxGenerationReady), so the attempt count alone would let a
		// server that answers /models but never generates hold this loop for hours instead of minutes.
		const deadline = Date.now() + 10 * 60_000;
		for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
			if (token.isCancellationRequested) {
				return false;
			}
			// If the server process already exited (crashed at launch), stop polling immediately - the
			// onExit handler has surfaced the real reason. Avoids the old 2-minute "running" hang.
			if (modelId && this._crashedBeforeReady.has(modelId)) {
				return false;
			}
			try {
				const cts = new CancellationTokenSource(token);
				const timer = setTimeout(() => cts.cancel(), 2000);
				try {
					const res = await this.requestService.request({ type: 'GET', url }, cts.token);
					const status = res.res.statusCode ?? 0;
					await streamToBuffer(res.stream).catch(() => undefined);
					if (status === 200) {
						const rec = modelId ? this.runningServers.get(modelId) : undefined;
						if (rec?.kind !== 'mlx' || (modelId && await this._probeMlxGenerationReady(baseUrl, modelId, token))) {
							return true;
						}
					}
				} finally {
					clearTimeout(timer);
					cts.dispose();
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
	/**
	 * True for a line that means the MLX process has run out of Metal memory and is dying. Unlike llama.cpp -
	 * which logs the failure, marks the backend "in error state" and stays alive (see {@link _handleWedgedBackend}) -
	 * mlx_lm has no graceful path: the Metal command buffer fails to execute, the C++ runtime throws, and
	 * `libc++abi` aborts the WHOLE process mid-response:
	 *
	 *   libc++abi: terminating due to uncaught exception of type std::runtime_error:
	 *     [METAL] Command buffer execution failed: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)
	 *
	 * Both an OOM token AND a Metal/allocation context are required, so an unrelated command-buffer error or a
	 * chat message that happens to contain "out of memory" can't trip the ladder.
	 */
	private _isFatalMlxOomLine(line: string): boolean {
		const l = line.toLowerCase();
		const outOfMemory = /kiogpucommandbuffercallbackerroroutofmemory|insufficient memory|out of memory|std::bad_alloc|failed to allocate|unable to allocate/.test(l);
		if (!outOfMemory) {
			return false;
		}
		return /\[metal\]|metal::|command buffer|libc\+\+abi|runtime_error|mlx/.test(l);
	}

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
	/**
	 * Plans an MLX launch: the effective context window and every mlx_lm.server memory knob, sized from the
	 * model's REAL attention geometry (`config.json`) against the same Metal wired budget the llama.cpp path
	 * uses. Runs BEFORE the memory gates so they can measure the configuration that will actually launch.
	 *
	 * MLX has no KV-quantization lever - `mlx_lm.server` exposes no `--kv-bits`, and injecting it via the
	 * bootstrap was tried and reverted (see MLX_MEMORY_LIMIT_BOOTSTRAP) - so where llama.cpp trades KV precision
	 * for context, MLX can only trade context. That makes the context clamp the whole of the quality ladder
	 * here, and the weight quant chosen at download time the only other lever.
	 */
	private async _computeMlxPlan(modelId: string, modelDir: string): Promise<IMlxLaunchPlan> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		const tuning: MlxServerTuning = {};
		const info = await this._getModelInfo(modelDir).catch(() => undefined);
		// Same precedence as llama.cpp: the model's own window (set or derived), else the global setting.
		const requestedContext = model?.contextWindow && model.contextWindow > 0
			? model.contextWindow
			: (this.configurationService.getValue<number>(ChatConfiguration.LocopilotLlamaCppContextSize) || DEFAULT_LLAMA_CONTEXT_SIZE);
		const autoTuned = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotMlxAutoTune) !== false
			&& !this._mlxExtraFlagsUnsupported;
		if (!autoTuned) {
			return { tuning, contextSize: requestedContext, autoTuned };
		}
		const mem = await this._getSystemMemory();
		if (!mem?.totalmem || mem.totalmem <= 0) {
			return { tuning, contextSize: requestedContext, autoTuned };
		}
		// Cap MLX's total Metal allocation at the same wired budget the llama.cpp path uses. MLX's own default is
		// ~95% of unified RAM - far past the wired ceiling - and mlx_lm.server only pins the wired limit, so
		// nothing upstream stops a long prompt's KV growth from paging the machine. Applied via the -c bootstrap
		// in getMlxLmServerCommand (no CLI flag exists); soft cap - MLX throttles instead of hard-failing. Also
		// cap the freed-buffer reuse cache, which otherwise defaults to the memory limit and can hoard GBs.
		const wiredBudget = metalOffloadBudgetBytes(mem.totalmem, (await this._getHardwareInfo())?.metalWiredLimitBytes);
		tuning.memoryLimitBytes = wiredBudget;
		tuning.cacheLimitBytes = Math.floor(mem.totalmem * 0.10);
		const weightBytes = await this._weightBytesOnDisk(modelDir);
		// Weight-aware prompt (KV) cache, mirroring llama.cpp's computeKvBudgetBytes: cap it so weights + cache +
		// runtime overhead stay inside the wired budget, instead of a flat 15% of RAM that ignores the weights.
		const flatCache = Math.floor(mem.totalmem * 0.15);
		const kvBudgetBytes = weightBytes > 0 && wiredBudget > 0 ? computeKvBudgetBytes(wiredBudget, weightBytes) : undefined;
		tuning.promptCacheBytes = kvBudgetBytes && kvBudgetBytes > 0
			? Math.max(MLX_MIN_PROMPT_CACHE_BYTES, Math.min(flatCache, kvBudgetBytes))
			: MLX_MIN_PROMPT_CACHE_BYTES;
		// MLX has no `-c`, so the effective window is what we advertise to the provider / context manager. It is
		// now solved with the SAME clamp as llama.cpp, from the model's real attention geometry rather than the
		// old flat 128 KiB/token guess - which over-charged a modern GQA model several-fold and needlessly
		// collapsed its window. The usability floor, the trained-window cap and the OOM ladder all apply here too.
		const oomLadderCap = this._oomContextCap.get(modelId);
		const f16PerTokenPerLayer = (info && kvBytesPerTokenPerLayer(info, kvCacheBytesPerElem('f16')))
			?? DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16;
		const kvLayers = info && kvLayerCount(info);
		const contextSize = clampContextSize({
			requestedContext,
			modelContextLength: info?.contextLength,
			kvBudgetBytes,
			// Attention blocks only - a hybrid stack's recurrent blocks hold a fixed state, not a growing cache.
			layerCount: kvLayers,
			kvBytesPerTokenPerLayer: f16PerTokenPerLayer,
			// MLX keeps a full KV cache on every layer - it has no windowed-SWA mode to model.
			minContext: oomLadderCap && oomLadderCap > 0 ? oomLadderCap : undefined,
		});
		if (contextSize < requestedContext) {
			this._log(`[LoCoPilot Runner] Clamped MLX effective context ${requestedContext} -> ${contextSize} tokens to fit the weight-aware wired budget (~${Math.round(f16PerTokenPerLayer)} B/tok/layer x ${kvLayers ?? '?'} layers).`);
		}
		// Single-user client: requests arrive one at a time, so the server's parallel batching (decode 32 /
		// prompt 8) only multiplies the peak KV + scratch - the top cause of the command-buffer OOM. Pin both
		// to 1 to remove that multiplier with no real throughput loss.
		tuning.decodeConcurrency = 1;
		tuning.promptConcurrency = 1;
		// Tight fit (little wired budget left after the weights): shrink the prefill chunk and hold fewer distinct
		// KV caches so BOTH the transient peak and the resident cache stay small. Roomy fits keep the server
		// defaults (fields left unset) for full prefill speed. (Official mlx_lm.server flags - no monkeypatching.)
		const leftoverAfterWeights = wiredBudget - weightBytes - RUNTIME_OVERHEAD_BYTES;
		// An active OOM ladder rung counts as a tight fit regardless of what the arithmetic says: the machine has
		// already PROVEN at runtime that this plan doesn't hold, so trust the evidence over the estimate. This is
		// what gives MLX a real second rung - context alone is a weak lever when the transient prefill peak (not
		// the resident cache) is what blew the command buffer.
		const oomDegraded = this._oomStripExtras.has(modelId) || (oomLadderCap !== undefined && oomLadderCap > 0);
		const tightFit = oomDegraded || (weightBytes > 0 && leftoverAfterWeights < MLX_TIGHT_FIT_HEADROOM_BYTES);
		const performanceProfile = await this._resolvePerformanceProfile();
		if (tightFit) {
			tuning.prefillStepSize = 512;
			tuning.promptCacheCount = 2;
			this._log(`[LoCoPilot Runner] MLX tight fit (~${(leftoverAfterWeights / 1e9).toFixed(1)}GB left after weights): prefill-step 512, prompt-cache-size 2.`);
		}
		if (oomDegraded) {
			// Past a real OOM, go further than the static tight-fit knobs: the smallest prefill chunk (the
			// transient peak that actually aborts the command buffer), a single cached prefix, and the floor
			// prompt cache. Also pull the hard allocation ceiling below the wired budget so MLX throttles at a
			// level the device has demonstrated it can survive, instead of at the one that just failed.
			tuning.prefillStepSize = 256;
			tuning.promptCacheCount = 1;
			tuning.promptCacheBytes = MLX_MIN_PROMPT_CACHE_BYTES;
			tuning.memoryLimitBytes = Math.floor(wiredBudget * 0.85);
			tuning.cacheLimitBytes = Math.min(tuning.cacheLimitBytes, Math.floor(mem.totalmem * 0.05));
			this._log(`[LoCoPilot Runner] MLX OOM ladder active for ${modelId}: prefill-step 256, one cached prefix, floor prompt cache, memory limit ~${Math.round(tuning.memoryLimitBytes / 1e9)}GB (85% of the wired budget).`);
		}
		if (performanceProfile === 'quiet') {
			tuning.prefillStepSize = 256;
			tuning.promptCacheCount = 1;
		} else if (performanceProfile === 'balanced' && !tightFit) {
			tuning.prefillStepSize = 512;
		}
		this._log(`[LoCoPilot Runner] MLX plan: context ${contextSize}, set_memory_limit ~${Math.round(wiredBudget / 1e9)}GB, set_cache_limit ~${Math.round(tuning.cacheLimitBytes / 1e9)}GB, prompt-cache ~${(tuning.promptCacheBytes / 1e9).toFixed(1)}GB (weight-aware), decode/prompt concurrency 1.`);
		return { tuning, contextSize, autoTuned };
	}

	private async _startMlxServerInTerminal(modelId: string, model: ICustomLanguageModel & { localPath: string }, plan?: IMlxLaunchPlan): Promise<void> {
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
		// The caller plans BEFORE the memory gates so they measure the real configuration; only a direct call
		// without a plan (defensive) computes one here.
		const mlxPlan = plan ?? await this._computeMlxPlan(modelId, modelDir);
		const mlxTuning = mlxPlan.tuning;
		this._lastLaunchContext.set(modelId, mlxPlan.contextSize);
		// mlx_lm honours the requested context verbatim (no -fit equivalent), so there is nothing to scrape
		// back; clear any figure left by a previous llama launch of the same model.
		this._actualContextWindow.delete(modelId);
		// The catalog-paired draft is resolved here rather than in the planner: it depends on a background
		// download completing and is a pure add-on that either fits alongside the planned footprint or is dropped.
		// A draft model is a second set of weights held resident - exactly the kind of extra the OOM ladder exists
		// to shed. The llama path strips it via _oomStripExtras; MLX resolves its draft here, so it checks here.
		if (mlxPlan.autoTuned && !this._oomStripExtras.has(modelId)) {
			const draft = await this._resolvePairedDraft(model, 'mlx');
			if (draft && await this._extrasFitBudget(modelDir, 'metal', undefined, draft.bytes)) {
				mlxTuning.draftModelDir = draft.path;
				this._log(`[LoCoPilot Runner] Auto speculative decoding (MLX): drafting with ${draft.repoId} (~${Math.round(draft.bytes / 1e6)}MB).`);
			} else if (draft) {
				this._log(`[LoCoPilot Runner] Auto speculative decoding (MLX): draft ${draft.repoId} skipped (would exceed the memory budget).`);
			}
		}
		const mlxExtraFlagsUsed = !!(mlxTuning.promptCacheBytes || mlxTuning.draftModelDir);
		// Prompt-cache persistence: mlx_lm has no /slots API, so we install one from the bootstrap. Rewritten
		// on every launch so an app update can never leave a stale helper next to a newer runner. A failure
		// here is not fatal - the server just starts without persistence and re-prefills as before.
		const helperPath = await this._writeMlxPromptCacheHelper();
		if (helperPath) {
			mlxTuning.promptCacheHelperPath = helperPath;
		}
		const { command, args } = getMlxLmServerCommand(modelDir, port, pythonCmd, mlxTuning);
		const q = (p: string) => (p.includes(' ') || p.includes('"') ? `"${p.replace(/"/g, '\\"')}"` : p);
		const argsQuoted = args.map(a => (a === modelDir || a.includes(' ') ? q(a) : a));
		// The helper reads the cache directory from the environment. Terminals are created without an env
		// override, so prefix the shell command - the same shape the Ollama launch uses for OLLAMA_HOST.
		const cacheDirEnv = helperPath ? `${MLX_PROMPT_CACHE_DIR_ENV}=${q(this._kvCacheDir().fsPath)} ` : '';
		const cmdLine = cacheDirEnv + [command, ...argsQuoted].join(' ');

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
			// Fresh launch: re-arm the fatal-OOM detection below, exactly as the llama path does for its
			// wedged-backend detection. Without this a degraded relaunch that OOMs again would go unnoticed and
			// the ladder would stop after a single rung.
			this._wedgedBackends.delete(modelId);
			this._intentionalStops.delete(modelId);
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

				// Fatal Metal OOM. Checked BEFORE the load-failure classifier below, which would otherwise report
				// an out-of-memory abort as "possibly a corrupt or incomplete download" and send the user off to
				// re-download a perfectly good model. Until now nothing caught this at all: the MLX terminal only
				// has an onDisposed handler, and _reportServerCrash (which owns the OOM ladder) is wired to the
				// llama path - so an MLX model that OOM-ed simply vanished and the chat panel claimed it "isn't
				// running yet. It may still be starting", for a process that had already aborted.
				//
				// Route it into the SAME ladder llama.cpp uses. MLX has no KV-quantization lever (mlx_lm.server
				// exposes no --kv-bits), so context is the whole of its ladder: the relaunch advertises a smaller
				// window and drops the memory-heavy extras. Guarded by _wedgedBackends so a torrent of abort lines
				// only triggers one teardown.
				if (this._isFatalMlxOomLine(line) && !this._wedgedBackends.has(modelId) && !this._intentionalStops.has(modelId)) {
					this._wedgedBackends.add(modelId);
					this._log(`[LoCoPilot Runner] MLX server for "${model.modelName}" ran out of Metal memory and is aborting: ${line}`);
					void (async () => {
						const rec = this.runningServers.get(modelId);
						if (rec) {
							// Drop "ready" first so nothing keeps routing requests at a process that is already dying.
							rec.ready = false;
							this._onDidServerStateChange.fire(modelId);
						}
						await this._stopServerAndWait(modelId);
						if (!this._oomDegradedRelaunch(modelId, model.modelName)) {
							const oomMessage = `"${model.modelName}" ran out of memory while running, even with reduced settings. Close some applications to free up memory, or choose a smaller model.`;
							this._endStarting(modelId, oomMessage);
							this.notificationService.notify({ severity: Severity.Error, message: oomMessage });
						}
					})();
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
			this.runningServers.set(modelId, { port, terminal, kind: 'mlx', servedModelId: modelDir, logs, lastUsedAt: Date.now(), startedAt: Date.now(), ready: false });
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
			//
			// KEEP THIS ONE (unlike the llama.cpp warm-up above, which is commented out): measured with
			// it commented, nothing probes the MLX server until the user's first message, so the model
			// sat 23s showing "not started" until a request arrived - _probeMlxGenerationReady only runs
			// on the ensureServerForModel path. MLX also doesn't pay the llama.cpp cost here: mlx_lm keeps
			// per-sequence prompt caches, so the 9-token ping doesn't evict the conversation.
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
			this.runningServers.set(modelId, { port: 11434, terminal, kind: 'llama', logs, lastUsedAt: Date.now(), startedAt: Date.now(), ready: true });
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
		void this.startServerInTerminal(modelId, true).then(launched => { // explicit user "Run" action -> may prompt "Run anyway?"
			if (launched) {
				this._selectStartedModelInChatPanel(modelId);
			}
		});
	}

	private _log(msg: string, ...args: unknown[]): void {
		this.logService.info(msg, ...args);
		this.locopilotFileLog.log(msg, ...args);
	}
}
