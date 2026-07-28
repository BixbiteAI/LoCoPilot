/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { timeout } from '../../../../base/common/async.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { showTransientNotification } from './locopilotNotify.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ITerminalService, ITerminalGroupService } from '../../terminal/browser/terminal.js';
import { ILoCoPilotFileLog } from './locopilotFileLog.js';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const OLLAMA_DOWNLOAD_PAGE = 'https://ollama.com/download';

/** Outcome of ensuring Ollama is ready to serve a pull/run request. */
export type OllamaReadiness =
	/** The server is reachable now - safe to pull/run immediately. */
	| 'ready'
	/** An installed Ollama was found and `ollama serve` was started, but it is not reachable yet. Retry shortly. */
	| 'starting'
	/** Ollama is not installed; the user was offered an install path. Retry after they install. */
	| 'needs-install';

export const ILoCoPilotOllamaService = createDecorator<ILoCoPilotOllamaService>('locopilotOllamaService');

export interface ILoCoPilotOllamaService {
	readonly _serviceBrand: undefined;
	/** True if an Ollama server answers at baseUrl right now. */
	isReachable(baseUrl: string): Promise<boolean>;
	/**
	 * Ensures Ollama can serve a request at baseUrl. Probes the server; if down, tries to start an
	 * installed Ollama; if not installed, offers a consent-gated install. Never installs silently.
	 */
	ensureReady(baseUrl: string): Promise<OllamaReadiness>;
}

export class LoCoPilotOllamaService extends Disposable implements ILoCoPilotOllamaService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ILogService private readonly logService: ILogService,
		@ILoCoPilotFileLog private readonly locopilotFileLog: ILoCoPilotFileLog,
	) {
		super();
	}

	async isReachable(baseUrl: string): Promise<boolean> {
		const url = `${baseUrl.replace(/\/$/, '')}/api/version`;
		const cts = new CancellationTokenSource();
		const timer = setTimeout(() => cts.cancel(), 1500);
		try {
			const res = await this.requestService.request({ type: 'GET', url }, cts.token);
			return (res.res.statusCode ?? 0) === 200;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
	}

	async ensureReady(baseUrl: string): Promise<OllamaReadiness> {
		const base = baseUrl.replace(/\/$/, '');

		if (await this.isReachable(base)) {
			return 'ready';
		}

		// Only manage a LOCAL Ollama. A custom/remote host that is down is the user's to fix.
		if (!this._isLocal(base)) {
			this.notificationService.notify({
				severity: Severity.Error,
				message: `Ollama is not reachable at ${base}. Make sure your Ollama server is running and the URL is correct.`,
			});
			return 'needs-install';
		}

		const binary = await this._findOllamaBinary();
		if (binary) {
			this._log(`[LoCoPilot Ollama] Found Ollama at ${binary}; starting "ollama serve".`);
			await this._startServeInTerminal(binary, base);
			// Give the server a moment to come up so the caller can proceed without a manual retry.
			for (let i = 0; i < 10; i++) {
				await timeout(1000);
				if (await this.isReachable(base)) {
					return 'ready';
				}
			}
			return 'starting';
		}

		this._promptInstall();
		return 'needs-install';
	}

	/** True when the base URL points at this machine (localhost / 127.0.0.1 / ::1). */
	private _isLocal(base: string): boolean {
		try {
			const host = new URL(base).hostname.toLowerCase();
			return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
		} catch {
			return false;
		}
	}

	/** Conventional install locations for the `ollama` binary (no PATH execution from the renderer). */
	private async _findOllamaBinary(): Promise<string | undefined> {
		const candidates: string[] = [];
		if (isWindows) {
			const localAppData = (globalThis as { vscode?: { process?: { env?: Record<string, string> } }; process?: { env?: Record<string, string> } })
				.vscode?.process?.env?.LOCALAPPDATA
				?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.LOCALAPPDATA;
			if (localAppData) {
				candidates.push(`${localAppData}\\Programs\\Ollama\\ollama.exe`);
			}
			candidates.push('C:\\Program Files\\Ollama\\ollama.exe');
		} else if (isMacintosh) {
			candidates.push('/opt/homebrew/bin/ollama');             // Apple Silicon Homebrew
			candidates.push('/usr/local/bin/ollama');                // Intel Homebrew / manual
			candidates.push('/Applications/Ollama.app/Contents/Resources/ollama'); // .app install
			try {
				const home = (await this.pathService.userHome()).fsPath;
				candidates.push(`${home}/.local/bin/ollama`);
			} catch { /* ignore */ }
		} else {
			candidates.push('/usr/local/bin/ollama');
			candidates.push('/usr/bin/ollama');
			try {
				const home = (await this.pathService.userHome()).fsPath;
				candidates.push(`${home}/.local/bin/ollama`);
			} catch { /* ignore */ }
		}

		for (const p of candidates) {
			try {
				const stat = await this.fileService.stat(URI.file(p));
				if (stat.isFile) {
					return p;
				}
			} catch {
				// not here
			}
		}
		return undefined;
	}

	private async _startServeInTerminal(binary: string, base: string): Promise<void> {
		const quote = (p: string) => (p.includes(' ') ? `"${p}"` : p);
		const hostEnv = base !== DEFAULT_OLLAMA_BASE_URL ? `OLLAMA_HOST=${base.replace(/^https?:\/\//, '')} ` : '';
		const cmdLine = `${hostEnv}${quote(binary)} serve`;
		try {
			const terminal = await this.terminalService.createTerminal({ config: { name: 'Ollama' } });
			this.terminalService.setActiveInstance(terminal);
			await this.terminalGroupService.showPanel(true);
			await timeout(400);
			await terminal.sendText(cmdLine, true);
			this._log(`[LoCoPilot Ollama] Started: ${cmdLine}`);
		} catch (e) {
			this._log(`[LoCoPilot Ollama] Failed to start "ollama serve": ${e}`);
		}
	}

	/**
	 * Offers to install Ollama - always with explicit user consent, never silently. On macOS/Windows
	 * without a known package manager we open the official download page rather than running a
	 * system-level installer on the user's behalf.
	 */
	private _promptInstall(): void {
		const actions: { label: string; run: () => void }[] = [];

		const install = this._installCommand();
		if (install) {
			actions.push({
				label: install.label,
				run: () => this._runInstallInTerminal(install.cmd),
			});
		}
		actions.push({
			label: 'Open Download Page',
			run: () => { this.openerService.open(URI.parse(OLLAMA_DOWNLOAD_PAGE)); },
		});

		this.notificationService.prompt(
			Severity.Info,
			'Ollama is not installed. Install it to download and run Ollama models locally.',
			actions,
		);
	}

	/**
	 * Returns a consent-gated install command for platforms with a reliable CLI installer, or
	 * undefined when we should just open the download page (e.g. macOS .app, no package manager).
	 * The command is shown to the user and only runs after they click - it is never auto-executed.
	 */
	private _installCommand(): { label: string; cmd: string } | undefined {
		if (isWindows) {
			// winget is present on Windows 10/11 by default; if missing the command no-ops and the user
			// can fall back to the download page.
			return { label: 'Install with winget', cmd: 'winget install --id Ollama.Ollama -e --source winget' };
		}
		if (!isMacintosh) {
			// Linux: the official one-line installer.
			return { label: 'Install (official script)', cmd: 'curl -fsSL https://ollama.com/install.sh | sh' };
		}
		// macOS ships as a .app; there is no official CLI installer, so prefer the download page unless
		// Homebrew is available (checked lazily at click time would be better, but keep it simple/honest).
		return { label: 'Install with Homebrew', cmd: 'brew install ollama' };
	}

	private async _runInstallInTerminal(cmd: string): Promise<void> {
		try {
			const terminal = await this.terminalService.createTerminal({ config: { name: 'Install Ollama' } });
			this.terminalService.setActiveInstance(terminal);
			await this.terminalGroupService.showPanel(true);
			await timeout(400);
			await terminal.sendText(cmd, true);
			showTransientNotification(this.notificationService, Severity.Info, 'Installing Ollama in the terminal. When it finishes, click "Download" / "Run model" again to pull your model.');
		} catch (e) {
			this._log(`[LoCoPilot Ollama] Failed to launch installer: ${e}`);
			this.openerService.open(URI.parse(OLLAMA_DOWNLOAD_PAGE));
		}
	}

	private _log(msg: string, ...args: unknown[]): void {
		this.logService.info(msg, ...args);
		this.locopilotFileLog.log(msg, ...args);
	}
}
