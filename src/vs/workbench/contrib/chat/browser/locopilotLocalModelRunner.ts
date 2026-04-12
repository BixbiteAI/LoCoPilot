/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICustomLanguageModelsService } from '../common/customLanguageModelsService.js';
import { ChatConfiguration } from '../common/constants.js';
import { ILoCoPilotFileLog } from './locopilotFileLog.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { detectLlamaBackend,
	getRecommendedBackend,
	getDefaultLlamaServerPaths,
	getLlamaCppServerCommand,
	getLlamaServerBaseUrl,
	LOCOPILOT_LLAMA_SERVER_PORT,
	LlamaBackend
} from './locopilotLlamaCppServer.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ITerminalService, ITerminalInstance, ITerminalGroupService } from '../../terminal/browser/terminal.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { LOCOPILOT_SETTINGS_SECTION_AGENT_SETTINGS } from './chatManagement/locopilotSettingsEditorInput.js';

export const ILoCoPilotLocalModelRunner = createDecorator<ILoCoPilotLocalModelRunner>('locopilotLocalModelRunner');

export interface ILoCoPilotLocalModelRunner {
	readonly _serviceBrand: undefined;
	readonly onDidServerStateChange: Event<string>;
	getBackend(): LlamaBackend;
	getBackendPriority(): LlamaBackend[];
	getServerBaseUrl(modelId: string): string | undefined;
	startServerInTerminal(modelId: string): Promise<void>;
	stopServer(modelId: string): void;
	runOllamaModelInTerminal(modelId: string): Promise<void>;
	isServerRunning(modelId: string): boolean;
}

export class LoCoPilotLocalModelRunner extends Disposable implements ILoCoPilotLocalModelRunner {
	declare readonly _serviceBrand: undefined;
	static readonly ID = 'locopilot.localModelRunner';

	private readonly _onDidServerStateChange = this._register(new Emitter<string>());
	readonly onDidServerStateChange = this._onDidServerStateChange.event;

	private runningServers = new Map<string, { port: number, terminal: ITerminalInstance }>();

	constructor(
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
		@ILoCoPilotFileLog private readonly locopilotFileLog: ILoCoPilotFileLog,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
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
	 * Base URL for the local llama server (OpenAI-compatible). Use this when sending chat requests.
	 */
	getServerBaseUrl(modelId: string): string | undefined {
		const running = this.runningServers.get(modelId);
		if (running) {
			return getLlamaServerBaseUrl(running.port);
		}
		return undefined;
	}

	isServerRunning(modelId: string): boolean {
		return this.runningServers.has(modelId);
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
		const { command, args } = getLlamaCppServerCommand(model.localPath, backend, serverPath);
		return { command, args, backend };
	}

	/**
	 * Resolves the path to use for llama-server: configured path, or first conventional path that exists (~/llama.cpp/build/bin), or undefined (use PATH).
	 */
	private async resolveServerPath(): Promise<string | undefined> {
		const configured = this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath)?.trim();
		if (configured) {
			return configured;
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

	private async findAvailablePort(startPort: number): Promise<number> {
		// A simple heuristic for now. In a real scenario, we'd bind to port 0 to get an OS-assigned port,
		// or test if the port is in use. Since we're in the renderer, we can just pick an unused port from our registry
		// and assume it's free. We'll increment from LOCOPILOT_LLAMA_SERVER_PORT.
		let port = startPort;
		const usedPorts = new Set(Array.from(this.runningServers.values()).map(s => s.port));
		while (usedPorts.has(port)) {
			port++;
		}
		return port;
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

		const serverPath = await this.resolveServerPath();
		if (!serverPath) {
			this.notificationService.prompt(
				Severity.Error,
				'llama.cpp server was not found. Please clone and build it from https://github.com/ggerganov/llama.cpp, then set the path in Agent Settings (e.g., ~/llama.cpp/build/bin/llama-server).',
				[
					{
						label: 'Open Agent Settings',
						run: () => {
							this.commandService.executeCommand('workbench.action.chat.openLoCoPilotSettings', { section: LOCOPILOT_SETTINGS_SECTION_AGENT_SETTINGS });
						}
					},
					{
						label: 'Get llama.cpp',
						run: () => {
							this.openerService.open('https://github.com/ggerganov/llama.cpp');
						}
					}
				]
			);
			return;
		}

		const modelPath = await this.resolveModelFilePath(model.localPath);
		const backend = getRecommendedBackend();
		
		const port = await this.findAvailablePort(LOCOPILOT_LLAMA_SERVER_PORT);
		const { command, args } = getLlamaCppServerCommand(modelPath, backend, serverPath, port);
		this._log(`[LoCoPilot Runner] Starting llama.cpp server for model ${modelId} on port ${port} with backend: ${backend}`);
		// Build command line for the user's shell (path with spaces/quotes escaped)
		const modelPathArg = args[args.indexOf('-m') + 1];
		const escapedPath = modelPathArg && (modelPathArg.includes(' ') || modelPathArg.includes('"'))
			? `"${modelPathArg.replace(/"/g, '\\"')}"`
			: modelPathArg;
		const argsCli = [...args];
		const mIdx = argsCli.indexOf('-m');
		if (mIdx >= 0 && argsCli[mIdx + 1] !== undefined) {
			argsCli[mIdx + 1] = escapedPath ?? argsCli[mIdx + 1];
		}
		const cmdLine = [command, ...argsCli].join(' ');
		
		this._log(`[LoCoPilot Runner] Executing: ${cmdLine}`);
		if (!serverPath) {
			this._log(`[LoCoPilot Runner] Note: If this fails, install llama.cpp (e.g. clone and build to ~/llama.cpp) or set the path in LoCoPilot Settings → Agent Settings → Llama.cpp server path.`);
		}
		
		try {
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: `Llama Server - ${model.modelName}`,
				}
			});
			this.terminalService.setActiveInstance(terminal);
			await this.terminalGroupService.showPanel(true);
			await new Promise<void>(resolve => setTimeout(resolve, 400));
			await terminal.sendText(cmdLine, true);

			this.runningServers.set(modelId, { port, terminal });
			this._onDidServerStateChange.fire(modelId);

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
		const cmdLine = `${hostEnv}ollama run ${model.modelName}`;
		this._log(`[LoCoPilot Runner] Running Ollama model: ${cmdLine}`);
		try {
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: `Ollama - ${model.modelName}`,
				}
			});
			this.terminalService.setActiveInstance(terminal);
			await this.terminalGroupService.showPanel(true);
			await new Promise<void>(resolve => setTimeout(resolve, 400));
			await terminal.sendText(cmdLine, true);

			// For Ollama, we don't manage the port, it's always the baseUrl port, but we track the terminal
			this.runningServers.set(modelId, { port: 11434, terminal });
			this._onDidServerStateChange.fire(modelId);

			this._register(terminal.onDisposed(() => {
				if (this.runningServers.has(modelId)) {
					this.runningServers.delete(modelId);
					this._onDidServerStateChange.fire(modelId);
					this._log(`[LoCoPilot Runner] Terminal closed for Ollama model ${modelId}`);
				}
			}));
		} catch (e) {
			this._log(`[LoCoPilot Runner] Failed to run Ollama in terminal: ${e}`);
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
