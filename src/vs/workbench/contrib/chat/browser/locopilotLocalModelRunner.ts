/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
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
	getLlamaCppServerCommand,
	getLlamaServerBaseUrl,
	getLlamaServerHealthUrl,
	computeGpuLayers,
	computeCpuMoeLayers,
	clampContextSize,
	shouldUseBundledVulkan,
	metalOffloadBudgetBytes,
	usableSystemMemoryBytes,
	KV_BUDGET_FRACTION,
	DEFAULT_LLAMA_CONTEXT_SIZE,
	MIN_CLAMPED_CONTEXT,
	LOCOPILOT_LLAMA_SERVER_PORT,
	LlamaBackend,
	type LlamaServerTuning,
	type FlashAttentionMode,
	type KvCacheType
} from './locopilotLlamaCppServer.js';
import { readGgufModelInfo, isMoeModelInfo, kvBytesPerTokenPerLayer, type IGgufModelInfo } from './locopilotGgufMetadata.js';
import { ILoCoPilotSystemInfoService, type ISystemHardwareInfo } from '../../../../platform/locopilotSystemInfo/common/locopilotSystemInfo.js';
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
} from './locopilotMlxServer.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalService, ITerminalInstance } from '../../terminal/browser/terminal.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { timeout } from '../../../../base/common/async.js';
import { LOCOPILOT_SETTINGS_SECTION_LIST_MODELS } from './chatManagement/locopilotSettingsEditorInput.js';

export const ILoCoPilotLocalModelRunner = createDecorator<ILoCoPilotLocalModelRunner>('locopilotLocalModelRunner');

/**
 * Lifecycle phase of a local model server:
 *  - 'starting': process is being launched (no port bound yet).
 *  - 'loading' : process is up but still reading weights into RAM/VRAM (endpoint not 200 yet).
 *  - 'ready'   : the OpenAI endpoint answered 200; safe to send requests.
 */
export type LocalServerPhase = 'starting' | 'loading' | 'ready';

export interface ILoCoPilotLocalModelRunner {
	readonly _serviceBrand: undefined;
	readonly onDidServerStateChange: Event<string>;
	readonly onDidLogUpdate: Event<string>;
	/** Fired when a server launch fails. Payload contains modelId and a human-readable reason. */
	readonly onDidServerStartFailed: Event<{ modelId: string; message: string }>;
	/** Current load phase for a model whose server we are starting/running, or undefined when not managed. */
	getServerPhase(modelId: string): LocalServerPhase | undefined;
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
	startServerInTerminal(modelId: string): Promise<void>;
	/**
	 * Ensures a local server for the model is running and ready to answer chat requests.
	 * If not running, starts it (evicting the least-recently-used server first when the resident-model
	 * budget is reached) and waits until the OpenAI-compatible endpoint responds. Reusing a running
	 * server also refreshes its keep-alive idle timer.
	 * Returns the server base URL when ready, or undefined if it could not be started.
	 */
	ensureServerForModel(modelId: string, token?: CancellationToken): Promise<string | undefined>;
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
	private runningServers = new Map<string, {
		port: number;
		terminal: ITerminalInstance;
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
	/** Models whose server process exited before it ever became ready (so readiness polling can bail early). */
	private readonly _crashedBeforeReady = new Set<string>();
	/** Models whose next crash should be logged but NOT surfaced as a notification (e.g. a pre-warm attempt that will be retried). */
	private readonly _suppressCrashNotice = new Set<string>();
	/** Cache of on-disk weight sizes (bytes) keyed by modelId, so the eviction budget doesn't re-stat on every switch. */
	private readonly _modelSizeCache = new Map<string, number>();
	/** Cached hardware probe (CPU cores / GPU VRAM); hardware doesn't change during a session. */
	private _hardwareInfo: Promise<ISystemHardwareInfo | undefined> | undefined;
	/** Cache of GGUF model info (layer count, expert count, context length) keyed by resolved model file path. */
	private readonly _modelInfoCache = new Map<string, IGgufModelInfo>();

	constructor(
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
		@ILoCoPilotFileLog private readonly locopilotFileLog: ILoCoPilotFileLog,
		@ITerminalService private readonly terminalService: ITerminalService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestService private readonly requestService: IRequestService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();
		this._registerCommands();
		// Make sure idle timers and child processes are torn down when the service is disposed.
		this._register({ dispose: () => this.stopManagedServers() });
	}

	private _registerCommands(): void {
		const self = this;
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.startLlamaServer', title: { value: 'Start Llama Server', original: 'Start Llama Server' } });
			}
			async run(accessor: ServicesAccessor, modelId?: string): Promise<void> {
				if (modelId) {
					await self.startServerInTerminal(modelId);
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

	stopServer(modelId: string): void {
		const running = this.runningServers.get(modelId);
		if (running) {
			if (running.idleTimer) {
				clearTimeout(running.idleTimer);
			}
			this._intentionalStops.add(modelId); // mark so onExit treats this as a clean stop, not a crash
			running.terminal.dispose();
			this.runningServers.delete(modelId);
			this._onDidServerStateChange.fire(modelId);
			this._log(`[LoCoPilot Runner] Stopped server for model ${modelId}`);
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
				this.stopServer(id);
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
		const memInfo = this._useMemoryBudget() ? await this._getSystemMemory() : undefined;
		let cap = Number.POSITIVE_INFINITY;     // max total resident bytes allowed
		let floor = 0;                          // min free bytes to preserve
		let newCost = 0;                        // estimated footprint of the model we are about to load
		const otherCost = new Map<string, number>(); // estimated footprint of each currently-running model
		if (memInfo) {
			const fraction = this.configurationService.getValue<number>(ChatConfiguration.LocopilotLocalMemoryBudgetFraction);
			const minFreeGb = this.configurationService.getValue<number>(ChatConfiguration.LocopilotLocalMinFreeMemoryGB);
			cap = (typeof fraction === 'number' && fraction > 0 ? fraction : 0.7) * memInfo.totalmem;
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
			const freeAfter = memInfo.freemem + freedBytes - newCost;
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
			this.stopServer(lruId);
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
	 * Estimates a model's *resident* memory footprint in bytes - honestly, not just weights. Adds the runtime
	 * cost the old `weights * 1.2` heuristic ignored, which is exactly what let two models "fit" on paper and
	 * then OOM in practice:
	 *  - KV cache: scales with the context window (a conservative all-layers k+v per-token figure).
	 *  - llama.cpp prompt cache: the server reserves a sizeable host-RAM prompt cache (`--cache-ram`).
	 *  - speculative draft: MTP self-draft or a separate draft model roughly adds another weights-worth.
	 * Weight bytes are cached per model (they don't change); the runtime terms are cheap to recompute.
	 * Returns 0 when the weight size can't be determined (e.g. Ollama), so an unknown model never blocks a load.
	 */
	private async _estimateModelCost(modelId: string): Promise<number> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.localPath || model.provider === 'ollama') {
			this._modelSizeCache.set(modelId, 0);
			return 0;
		}
		let weightBytes = this._modelSizeCache.get(modelId);
		if (weightBytes === undefined) {
			weightBytes = await this._weightBytesOnDisk(model.localPath);
			this._modelSizeCache.set(modelId, weightBytes);
		}
		if (weightBytes === 0) {
			return 0; // unknown weight size -> don't let the budget block this load
		}

		const kind = await this._intendedServerKind(modelId);
		// Context window the engine will actually allocate KV for (clamped like the launch path does).
		const ctxTokens = Math.max(
			MIN_CLAMPED_CONTEXT,
			model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_LLAMA_CONTEXT_SIZE
		);
		// ~128 KiB/token covers a typical 7-13B model's f16 k+v across all layers; conservative for the budget.
		const KV_BYTES_PER_TOKEN = 128 * 1024;
		const GB = 1024 * 1024 * 1024;
		let runtime = ctxTokens * KV_BYTES_PER_TOKEN;
		if (kind === 'llama') {
			runtime += 2 * GB; // conservative slice of llama.cpp's host-RAM prompt cache (default --cache-ram 8 GiB).
			const tuning = this._getLlamaTuning(model);
			const draftActive = !!tuning.multiTokenPrediction || !!(tuning.draftModelPath && tuning.draftModelPath.trim());
			if (draftActive) {
				runtime += weightBytes; // self-draft (MTP) or a same-size draft model roughly doubles weights.
			}
			// The mmproj projector is only loaded when vision is explicitly enabled (see customModelVisionEnabled).
			if (model.localPath && customModelVisionEnabled(model)) {
				const mmprojPath = await this.resolveMmprojPath(model.localPath);
				if (mmprojPath) {
					runtime += await this._fileBytes(mmprojPath);
				}
			}
		}
		return weightBytes + runtime;
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
			slotSavePath: cfg.getValue<string>(ChatConfiguration.LocopilotLlamaCppSlotSavePath),
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
		const info = await readGgufModelInfo(this.fileService, modelPath);
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
	 *  - cpu: undefined (the resident-budget/eviction path handles RAM pressure instead).
	 */
	private async _memoryBudgetBytes(backend: LlamaBackend, hw: ISystemHardwareInfo): Promise<number | undefined> {
		if (backend === 'cuda' || backend === 'vulkan') {
			const vram = hw.gpus.map(g => g.totalVramBytes).filter(v => v > 0);
			return vram.length ? Math.max(...vram) : undefined;
		}
		if (backend === 'metal') {
			const mem = await this._getSystemMemory();
			const budget = mem?.totalmem ? metalOffloadBudgetBytes(mem.totalmem) : 0;
			return budget > 0 ? budget : undefined;
		}
		return undefined;
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
		if (backend !== 'cpu' && budget && budget > 0) {
			const offloadBudget = Math.floor(budget * (1 - KV_BUDGET_FRACTION));
			const modelBytes = await this._weightBytesOnDisk(modelPath);
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
		// Use KV_BUDGET_FRACTION of the memory budget as the KV-cache allowance (weights take the rest); this
		// matches the reserve carved out of the offload budget above so the two decisions stay consistent.
		if (tuning.contextSize && tuning.contextSize > 0) {
			// Estimate KV bytes/token/layer from the model's attention geometry (f16 - conservative, since
			// large windows actually run q8_0 which is ~half). Falls back to clampContextSize's own default
			// when the GGUF lacks the attention keys. Without this the default under-estimates KV by ~25x and
			// a 256K-trained model would never get clamped on a 16GB machine.
			const perTokenPerLayer = kvBytesPerTokenPerLayer(info, 2);
			const clamped = clampContextSize({
				requestedContext: tuning.contextSize,
				modelContextLength: info.contextLength,
				kvBudgetBytes: budget ? budget * KV_BUDGET_FRACTION : undefined,
				layerCount: info.layerCount,
				kvBytesPerTokenPerLayer: perTokenPerLayer,
			});
			if (clamped < tuning.contextSize) {
				this._log(`[LoCoPilot Runner] Clamped context ${tuning.contextSize} -> ${clamped} to fit the model/memory budget (KV ~${perTokenPerLayer ?? 'default'} B/tok/layer).`);
				tuning.contextSize = clamped;
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
	private async _checkModelFitsOrNotify(modelId: string, modelPath: string, backend: LlamaBackend, discreteVramBytes: number | undefined, extraResidentBytes: number = 0): Promise<boolean> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model) {
			return true;
		}
		const weightBytes = await this._weightBytesOnDisk(modelPath);
		if (weightBytes <= 0) {
			return true; // unknown size -> can't reason about it, don't block.
		}
		const mem = await this._getSystemMemory();
		if (!mem?.totalmem) {
			return true; // no RAM stats (e.g. web) -> don't block.
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
		const GB = 1024 * 1024 * 1024;
		const kvMinBytes = MIN_CLAMPED_CONTEXT * perTokenPerLayer * layerCount;
		const runtimeOverhead = Math.round(1.5 * GB); // host buffers / compute scratch; conservative.
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
			? metalOffloadBudgetBytes(mem.totalmem)
			: usableSystemMemoryBytes(mem.totalmem) + (discreteVramBytes && discreteVramBytes > 0 ? discreteVramBytes : 0);
		if (requiredBytes <= usableBytes) {
			return true;
		}

		const needGb = Math.ceil(requiredBytes / GB);
		const haveGb = Math.max(1, Math.round(usableBytes / GB));
		this._log(`[LoCoPilot Runner] Refusing to start ${modelId}: needs ~${needGb}GB but only ~${haveGb}GB is usable on this machine.`);
		const name = model.displayName || model.modelName;
		const message = `"${name}" needs about ${needGb} GB of memory to run, but only about ${haveGb} GB is available on this machine. Please choose a smaller model.`;
		this.notificationService.prompt(Severity.Error, message, [
			{
				label: 'Choose Another Model',
				run: () => {
					this.commandService.executeCommand('workbench.action.chat.openLoCoPilotSettings', { section: LOCOPILOT_SETTINGS_SECTION_LIST_MODELS });
				}
			}
		]);
		return false;
	}

	/**
	 * Best-effort warm-up: poll the server's /health until it is ready, then fire a tiny 1-token
	 * request so GPU kernels are compiled and the cache is primed before the user's first message.
	 * Fire-and-forget; all failures are swallowed (the server may simply still be loading).
	 */
	private async _warmUpLlamaServer(modelId: string, port: number, modelName: string): Promise<void> {
		const healthUrl = getLlamaServerHealthUrl(port);
		const token = CancellationToken.None;
		// Poll readiness for up to ~2 minutes (large models can take a while to load).
		let ready = false;
		for (let attempt = 0; attempt < 120; attempt++) {
			// Stop immediately if the server crashed or was stopped/evicted - otherwise we'd keep hitting a
			// dead port with ERR_CONNECTION_REFUSED for the full 2 minutes.
			if (this._crashedBeforeReady.has(modelId) || !this.runningServers.has(modelId)) {
				this._log(`[LoCoPilot Runner] Warm-up aborted for ${modelId}: server is no longer running.`);
				return;
			}
			try {
				const res = await this.requestService.request({ type: 'GET', url: healthUrl }, token);
				const status = res.res.statusCode ?? 0;
				if (status === 200) {
					ready = true;
					break;
				}
			} catch {
				// not up yet
			}
			await timeout(1000);
		}
		if (!ready) {
			this._log(`[LoCoPilot Runner] Warm-up skipped: server on port ${port} did not become ready in time.`);
			return;
		}
		try {
			const body = JSON.stringify({
				model: modelName,
				messages: [{ role: 'user', content: 'ping' }],
				max_tokens: 1,
				stream: false,
			});
			await this.requestService.request({
				type: 'POST',
				url: `${getLlamaServerBaseUrl(port)}/chat/completions`,
				headers: { 'Content-Type': 'application/json' },
				data: body,
			}, token);
			this._log(`[LoCoPilot Runner] Warm-up request completed for server on port ${port}.`);
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

	/**
	 * Starts the llama.cpp server for the given model in a new terminal.
	 * Uses recommended backend (GPU/Metal/CPU). The server runs until the terminal is closed.
	 *
	 * Concurrent callers for the same model share a single launch (see {@link _startInFlight}) so two
	 * pre-warm triggers cannot spawn duplicate servers on the same port.
	 */
	startServerInTerminal(modelId: string): Promise<void> {
		if (this.runningServers.has(modelId)) {
			this._log(`[LoCoPilot Runner] Server for model ${modelId} is already running.`);
			return Promise.resolve();
		}
		const inFlight = this._startInFlight.get(modelId);
		if (inFlight) {
			this._log(`[LoCoPilot Runner] Launch already in progress for model ${modelId}; reusing it.`);
			return inFlight;
		}
		const launch = this._doStartServerInTerminal(modelId).finally(() => {
			this._startInFlight.delete(modelId);
		});
		this._startInFlight.set(modelId, launch);
		return launch;
	}

	private async _doStartServerInTerminal(modelId: string): Promise<void> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.localPath) {
			this._log(`[LoCoPilot Runner] Model ${modelId} not found or has no local path.`);
			return;
		}

		// Enforce the resident-model budget here, at the single choke point every launch flows through
		// (auto-start-on-use, the manual "Start server" button, Retry, and the model picker all reach this).
		// Doing it here - rather than only in ensureServerForModel - means a manual start also evicts the
		// least-recently-used other server, so we never end up with more resident servers than the budget allows.
		await this._enforceResidentBudget(modelId);

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
				// pass 'metal' so the gate uses that ceiling rather than the looser 85% system figure.
				if (!await this._checkModelFitsOrNotify(modelId, model.localPath, 'metal', undefined)) {
					return;
				}
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
		// A draft/MTP model loads a second copy of the weights (self-draft) or a same-size sidecar, so it
		// roughly doubles the weight footprint. mmprojBytes is the projector when vision is on.
		const draftActive = !!baseTuning.multiTokenPrediction || !!(baseTuning.draftModelPath && baseTuning.draftModelPath.trim());
		const weightBytesForBudget = await this._weightBytesOnDisk(modelPath);
		const extraResidentBytes = (draftActive ? weightBytesForBudget : 0) + mmprojBytes;

		if (!await this._checkModelFitsOrNotify(modelId, modelPath, backend, discreteVramBytes, extraResidentBytes)) {
			return;
		}

		const port = await this.findAvailablePort(LOCOPILOT_LLAMA_SERVER_PORT);
		const tuning = await this._augmentTuningWithHardware(modelPath, backend, baseTuning, extraResidentBytes);
		const { command, args } = getLlamaCppServerCommand(modelPath, backend, serverPath, port, tuning);
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
				if (wasIntentional) {
					this._log(`[LoCoPilot Runner] Server for model ${modelId} stopped (exit ${exitCode ?? 'n/a'}).`);
					return;
				}
				this._crashedBeforeReady.add(modelId);
				// A pre-warm attempt that will be retried suppresses its notification so a self-healing
				// startup race doesn't flash a scary "failed to start" toast; the crash is still logged.
				if (this._suppressCrashNotice.delete(modelId)) {
					const tail = logs.slice(-60).join('\n');
					this._log(`[LoCoPilot Runner] Pre-warm attempt for "${model.modelName}" exited (exit ${exitCode ?? 'n/a'}); will retry. Last output:\n${tail}`);
				} else {
					void this._reportServerCrash(modelId, model.modelName, exitCode, logs);
				}
			}));

			// Wait for the server process to initialise before switching the UI to running state.
			await timeout(5000);

			// If the process already died during this window (onExit set _crashedBeforeReady and reported it),
			// do NOT flip to "running" or start warm-up. Doing so was the cause of the endless /health retry
			// against a dead server and the list showing a crashed model as running.
			if (this._crashedBeforeReady.has(modelId)) {
				this._releaseReservedPort(port);
				this.startingServers.delete(modelId);
				this._log(`[LoCoPilot Runner] Not marking ${modelId} as running - it crashed during startup.`);
				return;
			}

			// The resident budget may have cancelled this launch while we waited (e.g. the user selected another
			// model). _cancelStartingServer dropped our ownership and disposed the terminal, so do NOT promote a
			// dead terminal into runningServers - that was how two models ended up "running" at once.
			if (this._activeLaunchTerminals.get(modelId) !== terminal) {
				this._releaseReservedPort(port);
				this.startingServers.delete(modelId);
				this._log(`[LoCoPilot Runner] Launch for ${modelId} was superseded/cancelled during startup; not promoting to running.`);
				return;
			}

			this.startingServers.delete(modelId); // running state replaces starting state
			this.runningServers.set(modelId, { port, terminal, kind: 'llama', logs, lastUsedAt: Date.now(), ready: false });
			this._releaseReservedPort(port); // now tracked via runningServers; reservation no longer needed
			this._onDidServerStateChange.fire(modelId);

			// Warm up in the background so the first real message has no kernel-JIT / cache lag.
			if (this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppWarmup) !== false) {
				this._warmUpLlamaServer(modelId, port, model.modelName);
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
			this._touch(modelId);
			return this.getServerBaseUrl(modelId);
		}

		// Only launch (and enforce the RAM budget) when there is no server record at all. If one already
		// exists but is mid-load, skip straight to waiting for it to become ready - relaunching would be a
		// no-op (startServerInTerminal guards on runningServers) and re-budgeting could evict the very model
		// we are waiting on.
		if (!existingRec) {
			// Launch (no-op if another caller already kicked it off; startServerInTerminal guards on runningServers).
			// The resident-model budget (LRU eviction, singleActiveModel -> 1) is enforced inside the launch itself
			// (_doStartServerInTerminal), so every start path - manual button, Retry, picker, auto-start - is bounded.
			await this.startServerInTerminal(modelId);
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
		this._touch(modelId);
		this._onDidServerStateChange.fire(modelId);
		return baseUrl;
	}

	prewarmModel(modelId: string): void {
		if (this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLocalPrewarmOnSelect) === false) {
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
		const maxAttempts = 300;
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
			await timeout(1000);
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
		const { command, args } = getMlxLmServerCommand(modelDir, port, pythonCmd);
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
			await new Promise<void>(resolve => setTimeout(resolve, 400));
			await terminal.sendText(cmdLine, true);

			await timeout(5000);

			// The resident budget may have cancelled this launch while we waited (user selected another model).
			// Don't promote a disposed terminal into runningServers - that produced two "running" models at once.
			if (this._activeLaunchTerminals.get(modelId) !== terminal) {
				this._releaseReservedPort(port);
				this.startingServers.delete(modelId);
				this._log(`[LoCoPilot Runner] MLX launch for ${modelId} was superseded/cancelled during startup; not promoting to running.`);
				return;
			}

			const logs: string[] = [];
			this.startingServers.delete(modelId);
			this.runningServers.set(modelId, { port, terminal, kind: 'mlx', servedModelId: modelDir, logs, lastUsedAt: Date.now(), ready: false });
			this._releaseReservedPort(port); // now tracked via runningServers; reservation no longer needed
			this._onDidServerStateChange.fire(modelId);

			this._register(terminal.onLineData(line => {
				logs.push(line);
				if (logs.length > LoCoPilotLocalModelRunner.MAX_LOG_LINES) {
					logs.splice(0, logs.length - LoCoPilotLocalModelRunner.MAX_LOG_LINES);
				}
				this._onDidLogUpdate.fire(modelId);

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

			this._register(terminal.onDisposed(() => {
				this._releaseReservedPort(port);
				if (this._activeLaunchTerminals.get(modelId) === terminal) {
					this._activeLaunchTerminals.delete(modelId);
				}
				if (this.runningServers.has(modelId)) {
					this.runningServers.delete(modelId);
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
		this.startServerInTerminal(modelId);
	}

	private _log(msg: string, ...args: unknown[]): void {
		this.logService.info(msg, ...args);
		this.locopilotFileLog.log(msg, ...args);
	}
}
