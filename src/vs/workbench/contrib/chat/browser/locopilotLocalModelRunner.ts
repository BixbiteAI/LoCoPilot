/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICustomLanguageModelsService, type ICustomLanguageModel } from '../common/customLanguageModelsService.js';
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
	shouldUseBundledVulkan,
	LOCOPILOT_LLAMA_SERVER_PORT,
	LlamaBackend,
	type LlamaServerTuning,
	type FlashAttentionMode,
	type KvCacheType
} from './locopilotLlamaCppServer.js';
import { readGgufLayerCount } from './locopilotGgufMetadata.js';
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
	/** Cache of GGUF transformer-layer counts keyed by resolved model file path (for partial GPU offload). */
	private readonly _layerCountCache = new Map<string, number | undefined>();

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
	 * for users who opt into the old single-model behavior; otherwise the `maxResidentModels` budget (default 2) applies.
	 */
	private _maxResidentModels(): number {
		const singleActive = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLocalSingleActiveModel) !== false;
		if (singleActive) {
			return 1;
		}
		const configured = this.configurationService.getValue<number>(ChatConfiguration.LocopilotLocalMaxResidentModels);
		return (typeof configured === 'number' && configured >= 1) ? Math.floor(configured) : 2;
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
	 * Estimates a model's resident memory footprint in bytes: the on-disk weight size plus a 20% allowance for
	 * the KV cache and runtime overhead. Sizes are cached per model since the weights don't change at runtime.
	 * Returns 0 when the size can't be determined (e.g. Ollama models, whose weights we don't manage on disk).
	 */
	private async _estimateModelCost(modelId: string): Promise<number> {
		const cached = this._modelSizeCache.get(modelId);
		if (cached !== undefined) {
			return Math.round(cached * 1.2);
		}
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.localPath || model.provider === 'ollama') {
			this._modelSizeCache.set(modelId, 0);
			return 0;
		}
		const bytes = await this._weightBytesOnDisk(model.localPath);
		this._modelSizeCache.set(modelId, bytes);
		return Math.round(bytes * 1.2);
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
	private _reportServerCrash(modelId: string, modelName: string, serverPath: string, exitCode: number | undefined, logs: string[]): void {
		// Use a generous tail for both the diagnostic log and the heuristics below: the real fatal line is
		// often the very last thing the engine prints, and a short 12-line window can scroll it off behind
		// startup banners (device_info, system_info, tokenizer warnings, etc.).
		const tail = logs.slice(-60).join('\n');
		const lower = tail.toLowerCase();
		const code = exitCode ?? 'unknown';
		this._log(`[LoCoPilot Runner] llama-server for "${modelName}" exited before serving (exit ${code}). Last output:\n${tail}`);

		let message = `The local model engine for "${modelName}" failed to start (exit code ${code}).`;
		const actions: { label: string; run: () => void }[] = [];

		if (isWindows) {
			// Missing-DLL crashes on Windows manifest as exit 0xC0000135 (-1073741515)/0xC000007B, or a
			// "vcruntime140.dll/msvcp140.dll was not found" dialog. The llama.cpp Windows builds link
			// dynamically against the MSVC runtime, which isn't bundled.
			const looksLikeMissingRuntime = exitCode === -1073741515 || exitCode === -1073741701
				|| lower.includes('vcruntime') || lower.includes('msvcp140') || lower.includes('0xc0000135') || lower.includes('0xc000007b');
			if (looksLikeMissingRuntime || exitCode !== 0) {
				message += ' This usually means the Microsoft Visual C++ Redistributable (x64) is not installed - the bundled engine needs it. Install it, then try again.';
				actions.push({ label: 'Get VC++ Redistributable', run: () => this.openerService.open('https://aka.ms/vs/17/release/vc_redist.x64.exe') });
			}
		} else if (isMacintosh) {
			message += ' The bundled engine could not load its libraries. Try reinstalling LoCoPilot, or point "locopilot.llamaCpp.serverPath" at your own llama.cpp build.';
		} else {
			message += ' The bundled engine could not load a required system library. Check the server terminal output for the missing library name.';
		}

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
		return {
			contextSize: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppContextSize),
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

	/** Reads (and caches) the GGUF transformer-layer count for a resolved model file path. */
	private async _getLayerCount(modelPath: string): Promise<number | undefined> {
		if (this._layerCountCache.has(modelPath)) {
			return this._layerCountCache.get(modelPath);
		}
		const count = await readGgufLayerCount(this.fileService, modelPath);
		this._layerCountCache.set(modelPath, count);
		return count;
	}

	/**
	 * Augments the base (settings-derived) tuning with hardware-aware values that the user hasn't pinned:
	 *  - `--threads`: defaults to the machine's physical (performance) core count, which is generally faster
	 *    than llama.cpp's hyperthread-counting auto-detect on hybrid CPUs. Skipped if the user set threads.
	 *  - `--n-gpu-layers`: on discrete-GPU backends (CUDA/Vulkan) whose VRAM we know, offloads only as many
	 *    layers as fit when the model is larger than VRAM, instead of an all-or-nothing full offload that
	 *    would OOM the GPU. Skipped if the user pinned gpuLayers or the model fits.
	 *
	 * All steps are best-effort: any missing data leaves the base tuning untouched.
	 */
	private async _augmentTuningWithHardware(modelPath: string, backend: LlamaBackend, base: LlamaServerTuning): Promise<LlamaServerTuning> {
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

		// Partial GPU offload: only when the user left gpuLayers unset and we're on a discrete-GPU backend.
		if (tuning.gpuLayers === undefined && (backend === 'cuda' || backend === 'vulkan')) {
			const nvidia = hw.gpus.find(g => g.vendor === 'nvidia' && g.totalVramBytes > 0);
			if (nvidia) {
				const modelBytes = await this._weightBytesOnDisk(modelPath);
				const layerCount = await this._getLayerCount(modelPath);
				const layers = computeGpuLayers({ backend, modelBytes, layerCount, vramBytes: nvidia.totalVramBytes });
				if (layers !== undefined) {
					tuning.gpuLayers = layers;
					this._log(`[LoCoPilot Runner] Model (${Math.round(modelBytes / 1e9)}GB) exceeds VRAM budget on ${nvidia.name} (${Math.round(nvidia.totalVramBytes / 1e9)}GB); offloading ${layers}/${layerCount} layers to GPU, rest on CPU.`);
				}
			}
		}

		return tuning;
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
	 *   2. Bundled binary shipped inside the app (resources/bin/<platform>-<arch>/llama-server) - the
	 *      zero-setup default that ships with every package via scripts/fetch-llama-binaries.mjs.
	 *   3. Conventional install locations (~/llama.cpp/build/bin, Homebrew, etc.).
	 *   4. undefined → fall back to llama-server on PATH.
	 */
	private async resolveServerPath(): Promise<string | undefined> {
		const configured = this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath)?.trim();
		if (configured) {
			return configured;
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

	/** True if the resolved local path is a single GGUF file (Hugging Face layout). */
	private async pathResolvesToGguf(localPath: string): Promise<boolean> {
		const p = await this.resolveModelFilePath(localPath);
		return p.toLowerCase().endsWith('.gguf');
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

		const port = await this.findAvailablePort(LOCOPILOT_LLAMA_SERVER_PORT);
		const tuning = await this._augmentTuningWithHardware(modelPath, backend, this._getLlamaTuning(model));
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
				}
			});

			const logs: string[] = [];
			this._crashedBeforeReady.delete(modelId);
			this._intentionalStops.delete(modelId);

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
				this._releaseReservedPort(port); // the process is gone; free its port reservation
				const wasIntentional = this._intentionalStops.delete(modelId);
				if (this.runningServers.has(modelId)) {
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
					this._reportServerCrash(modelId, model.modelName, serverPath, exitCode, logs);
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
		// Already running - reuse as-is, and refresh its LRU/idle state so it isn't evicted while in use.
		const existing = this.getServerBaseUrl(modelId);
		if (existing) {
			this._touch(modelId);
			return existing;
		}

		// Free RAM under an LRU budget instead of killing every other server: a recently-used model stays
		// warm so switching back to it is instant. singleActiveModel forces the budget to 1 (old behavior).
		await this._enforceResidentBudget(modelId);

		// Launch (no-op if another caller already kicked it off; startServerInTerminal guards on runningServers).
		await this.startServerInTerminal(modelId);

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
		// Large models can take a while to load; poll for up to ~2 minutes.
		for (let attempt = 0; attempt < 120; attempt++) {
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
	 * Starts `mlx_lm.server` for downloaded Hugging Face MLX weights (Apple Silicon only).
	 */
	private async _startMlxServerInTerminal(modelId: string, model: ICustomLanguageModel & { localPath: string }): Promise<void> {
		const modelDir = await this.getMlxModelRootPath(model.localPath);
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
				}
			});
			await new Promise<void>(resolve => setTimeout(resolve, 400));
			await terminal.sendText(cmdLine, true);

			await timeout(5000);

			const logs: string[] = [];
			this.startingServers.delete(modelId);
			this.runningServers.set(modelId, { port, terminal, kind: 'mlx', logs, lastUsedAt: Date.now(), ready: false });
			this._releaseReservedPort(port); // now tracked via runningServers; reservation no longer needed
			this._onDidServerStateChange.fire(modelId);

			this._register(terminal.onLineData(line => {
				logs.push(line);
				if (logs.length > LoCoPilotLocalModelRunner.MAX_LOG_LINES) {
					logs.splice(0, logs.length - LoCoPilotLocalModelRunner.MAX_LOG_LINES);
				}
				this._onDidLogUpdate.fire(modelId);
			}));

			this._register(terminal.onDisposed(() => {
				this._releaseReservedPort(port);
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
