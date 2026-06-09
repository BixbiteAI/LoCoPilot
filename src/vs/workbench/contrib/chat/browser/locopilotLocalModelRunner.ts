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
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import {
	detectLlamaBackend,
	getRecommendedBackend,
	getDefaultLlamaServerPaths,
	getBundledLlamaServerPath,
	getLlamaCppServerCommand,
	getLlamaServerBaseUrl,
	getLlamaServerHealthUrl,
	LOCOPILOT_LLAMA_SERVER_PORT,
	LlamaBackend,
	type LlamaServerTuning,
	type FlashAttentionMode,
	type KvCacheType
} from './locopilotLlamaCppServer.js';
import { dirname } from '../../../../base/common/path.js';
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

export interface ILoCoPilotLocalModelRunner {
	readonly _serviceBrand: undefined;
	readonly onDidServerStateChange: Event<string>;
	readonly onDidLogUpdate: Event<string>;
	/** Fired when a server launch fails. Payload contains modelId and a human-readable reason. */
	readonly onDidServerStartFailed: Event<{ modelId: string; message: string }>;
	getBackend(): LlamaBackend;
	getBackendPriority(): LlamaBackend[];
	getServerBaseUrl(modelId: string): string | undefined;
	getServerLogs(modelId: string): string[];
	startServerInTerminal(modelId: string): Promise<void>;
	/**
	 * Ensures a local server for the model is running and ready to answer chat requests.
	 * If not running, starts it (stopping the previously active local server first when
	 * `singleActiveModel` is on) and waits until the OpenAI-compatible endpoint responds.
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
	private runningServers = new Map<string, { port: number; terminal: ITerminalInstance; kind: 'llama' | 'mlx'; logs: string[] }>();

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
	) {
		super();
		this._registerCommands();
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
	}

	/**
	 * Returns the backend that will be used (or is recommended) for running the model.
	 * Priority: GPU (CUDA) > Apple Metal > Vulkan > CPU.
	 */
	getBackend(): LlamaBackend {
		return getRecommendedBackend();
	}

	/**
	 * Returns ordered list of backends to try (best first).
	 */
	getBackendPriority(): LlamaBackend[] {
		return detectLlamaBackend();
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

	stopServer(modelId: string): void {
		const running = this.runningServers.get(modelId);
		if (running) {
			running.terminal.dispose();
			this.runningServers.delete(modelId);
			this._onDidServerStateChange.fire(modelId);
			this._log(`[LoCoPilot Runner] Stopped server for model ${modelId}`);
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
		const backend = getRecommendedBackend();
		const serverPath = this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath);
		const { command, args } = getLlamaCppServerCommand(model.localPath, backend, serverPath, LOCOPILOT_LLAMA_SERVER_PORT, this._getLlamaTuning(model));
		return { command, args, backend };
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
			threads: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppThreads),
			batchSize: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppBatchSize),
			ubatchSize: cfg.getValue<number>(ChatConfiguration.LocopilotLlamaCppUbatchSize),
			mlock: cfg.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppMlock),
			extraArgs: cfg.getValue<string>(ChatConfiguration.LocopilotLlamaCppExtraArgs),
		};
	}

	/**
	 * Best-effort warm-up: poll the server's /health until it is ready, then fire a tiny 1-token
	 * request so GPU kernels are compiled and the cache is primed before the user's first message.
	 * Fire-and-forget; all failures are swallowed (the server may simply still be loading).
	 */
	private async _warmUpLlamaServer(port: number, modelName: string): Promise<void> {
		const healthUrl = getLlamaServerHealthUrl(port);
		const token = CancellationToken.None;
		// Poll readiness for up to ~2 minutes (large models can take a while to load).
		let ready = false;
		for (let attempt = 0; attempt < 120; attempt++) {
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
		const usedPorts = new Set(Array.from(this.runningServers.values()).map(s => s.port));
		while (usedPorts.has(port)) {
			port++;
		}
		// On desktop, ask the main process to pick a 127.0.0.1 port that is not already bound (e.g. leftover mlx/llama).
		return this.instantiationService.invokeFunction((accessor) => {
			try {
				const native = accessor.get(INativeHostService);
				return native.findFreePort(port, 40, 5000, 1).then(free => (free !== 0 ? free : port));
			} catch {
				// No native host (e.g. web): keep session-local heuristic only.
				return Promise.resolve(port);
			}
		});
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
	 */
	async startServerInTerminal(modelId: string): Promise<void> {
		if (this.runningServers.has(modelId)) {
			this._log(`[LoCoPilot Runner] Server for model ${modelId} is already running.`);
			return;
		}

		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.localPath) {
			this._log(`[LoCoPilot Runner] Model ${modelId} not found or has no local path.`);
			return;
		}

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

		const serverPath = await this.resolveServerPath();
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
		const backend = getRecommendedBackend();

		const port = await this.findAvailablePort(LOCOPILOT_LLAMA_SERVER_PORT);
		const { command, args } = getLlamaCppServerCommand(modelPath, backend, serverPath, port, this._getLlamaTuning(model));
		this._log(`[LoCoPilot Runner] Starting llama.cpp server for model ${modelId} on port ${port} with backend: ${backend}`);
		// Build command line for the user's shell. Quote ANY arg containing spaces/quotes (e.g. model
		// paths under "Application Support", and --model-draft for MTP), not just the -m path.
		const shellQuote = (a: string) => (a.includes(' ') || a.includes('"')) ? `"${a.replace(/"/g, '\\"')}"` : a;
		const argsCli = args.map(shellQuote);
		const cmdLine = [shellQuote(command), ...argsCli].join(' ');

		this._log(`[LoCoPilot Runner] Executing: ${cmdLine}`);
		this._log(`[LoCoPilot Runner] Using llama-server: ${serverPath} (bundled = ${serverPath === getBundledLlamaServerPath(this._appRoot)}).`);

		this._beginStarting(modelId);
		try {
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: `Llama Server - ${model.modelName}`,
				}
			});
			await new Promise<void>(resolve => setTimeout(resolve, 400));
			await terminal.sendText(cmdLine, true);

			// Wait for the server process to initialise before switching the UI to running state.
			await timeout(5000);

			const logs: string[] = [];
			this.startingServers.delete(modelId); // running state replaces starting state
			this.runningServers.set(modelId, { port, terminal, kind: 'llama', logs });
			this._onDidServerStateChange.fire(modelId);

			this._register(terminal.onLineData(line => {
				logs.push(line);
				if (logs.length > LoCoPilotLocalModelRunner.MAX_LOG_LINES) {
					logs.splice(0, logs.length - LoCoPilotLocalModelRunner.MAX_LOG_LINES);
				}
				this._onDidLogUpdate.fire(modelId);
			}));

			// Warm up in the background so the first real message has no kernel-JIT / cache lag.
			if (this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLlamaCppWarmup) !== false) {
				this._warmUpLlamaServer(port, model.modelName);
			}

			this._register(terminal.onDisposed(() => {
				if (this.runningServers.has(modelId)) {
					this.runningServers.delete(modelId);
					this._onDidServerStateChange.fire(modelId);
					this._log(`[LoCoPilot Runner] Terminal closed for model ${modelId}`);
				}
			}));

			this._log(`[LoCoPilot Runner] Terminal started with: ${cmdLine}`);
		} catch (e) {
			this._log(`[LoCoPilot Runner] Failed to start terminal: ${e}`);
			this._endStarting(modelId, `Failed to start llama-server terminal: ${e}`);
			throw e;
		}
	}

	/**
	 * Auto-start-on-use entry point. Reuses startServerInTerminal (which picks llama.cpp or mlx-lm),
	 * but first frees memory by stopping the previously active local server when singleActiveModel is on,
	 * then waits until the server's OpenAI endpoint actually responds so the caller can send immediately.
	 */
	async ensureServerForModel(modelId: string, token: CancellationToken = CancellationToken.None): Promise<string | undefined> {
		// Already running - reuse as-is.
		const existing = this.getServerBaseUrl(modelId);
		if (existing) {
			return existing;
		}

		// Single active model: stop any other running local servers so we don't pile models into RAM/CPU.
		const singleActive = this.configurationService.getValue<boolean>(ChatConfiguration.LocopilotLocalSingleActiveModel) !== false;
		if (singleActive) {
			this.stopManagedServers(modelId);
		}

		// Launch (no-op if another caller already kicked it off; startServerInTerminal guards on runningServers).
		await this.startServerInTerminal(modelId);

		const baseUrl = this.getServerBaseUrl(modelId);
		if (!baseUrl) {
			// startServerInTerminal already surfaced the reason (missing binary, unsupported MLX, etc.).
			return undefined;
		}

		const ready = await this._waitForServerReady(baseUrl, token);
		return ready ? baseUrl : undefined;
	}

	/**
	 * Polls the OpenAI-compatible `/models` endpoint (served by both llama.cpp and mlx-lm) until it
	 * responds 200 or the timeout/cancellation hits. Engine-agnostic readiness check.
	 */
	private async _waitForServerReady(baseUrl: string, token: CancellationToken): Promise<boolean> {
		const url = `${baseUrl}/models`;
		// Large models can take a while to load; poll for up to ~2 minutes.
		for (let attempt = 0; attempt < 120; attempt++) {
			if (token.isCancellationRequested) {
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
				}
			});
			await new Promise<void>(resolve => setTimeout(resolve, 400));
			await terminal.sendText(cmdLine, true);

			await timeout(5000);

			const logs: string[] = [];
			this.startingServers.delete(modelId);
			this.runningServers.set(modelId, { port, terminal, kind: 'mlx', logs });
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
					this._log(`[LoCoPilot Runner] MLX terminal closed for model ${modelId}`);
				}
			}));
		} catch (e) {
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
				}
			});
			await new Promise<void>(resolve => setTimeout(resolve, 400));
			await terminal.sendText(cmdLine, true);

			await timeout(5000);

			const logs: string[] = [];
			this.startingServers.delete(modelId);
			// For Ollama, we don't manage the port, it's always the baseUrl port, but we track the terminal
			this.runningServers.set(modelId, { port: 11434, terminal, kind: 'llama', logs });
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
