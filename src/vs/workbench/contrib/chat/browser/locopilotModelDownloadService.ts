/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable curly, @typescript-eslint/no-explicit-any */

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { listenStream } from '../../../../base/common/stream.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import type { IRequestToFileProgressEvent } from '../../../../platform/request/common/requestIpc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ICustomLanguageModelsService, ICustomLanguageModel } from '../common/customLanguageModelsService.js';
import { ILoCoPilotFileLog } from './locopilotFileLog.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';

const HF_API_BASE = 'https://huggingface.co';
const HF_RESOLVE = `${HF_API_BASE}`;

/** GGUF quantization preference (best quality/size tradeoff first). */
const GGUF_QUANT_PRIORITY = [
	'Q4_K_M', 'Q5_K_M', 'Q8_0', 'Q4_0', 'Q5_0', 'Q3_K_M', 'IQ4_XS', 'Q2_K', 'F16',
	'Q4_K_S', 'Q5_K_S', 'Q6_K', 'Q3_K_S', 'Q3_K_L', 'Q2_K_S', 'Q4_1', 'Q4_0_4_4', 'Q4_0_4_8', 'Q4_0_8_8'
];

interface HFTreeItem {
	path: string;
	type: 'file' | 'dir';
	size?: number;
}

/** Model format priority list. */
const FORMAT_PRIORITY = ['gguf', 'mlx', 'transformers', 'safetensors'];

function pickBestGGUFFile(paths: string[], preferredQuant?: string): string | undefined {
	const gguf = paths.filter(p => p.toLowerCase().endsWith('.gguf'));
	if (gguf.length === 0) return undefined;

	// If user specified a specific quantization (e.g. "Q4_K_M")
	if (preferredQuant) {
		const upperQuant = preferredQuant.toUpperCase();
		const found = gguf.find(f => f.toUpperCase().includes(upperQuant));
		if (found) return found;
	}

	// Prefer file that matches best quantization from our priority list
	for (const q of GGUF_QUANT_PRIORITY) {
		const found = gguf.find(f => f.includes(q) || f.toUpperCase().includes(q));
		if (found) return found;
	}
	// Otherwise smallest file name often indicates a specific quant (e.g. one file)
	return gguf.sort((a, b) => a.length - b.length)[0];
}

function filterPathsByFormat(paths: string[], format: string): string[] {
	const f = (format || '').toLowerCase().trim();

	// If format is empty, use priority list to choose one format
	if (!f) {
		for (const priorityFormat of FORMAT_PRIORITY) {
			const filtered = filterPathsByFormat(paths, priorityFormat);
			if (filtered.length > 0) return filtered;
		}
		return paths;
	}

	// If user provided a specific GGUF quantization
	if (GGUF_QUANT_PRIORITY.some(q => f.toUpperCase().includes(q)) || f.includes('gguf')) {
		const best = pickBestGGUFFile(paths, f.includes('gguf') ? undefined : f);
		return best ? [best] : paths.filter(p => p.toLowerCase().endsWith('.gguf'));
	}

	if (f === 'safetensors') {
		return paths.filter(p => p.toLowerCase().endsWith('.safetensors'));
	}
	if (f === 'transformers') {
		return paths.filter(p => /\.(bin|safetensors)$/i.test(p) || /config\.(json|json\.model)$/i.test(p));
	}

	// Apple MLX (mlx-lm): weights + tokenizers (transformers subset + common extra files)
	if (f === 'mlx') {
		const tr = filterPathsByFormat(paths, 'transformers');
		const extra = paths.filter(p => {
			const l = p.toLowerCase();
			if (l.endsWith('.gguf') || l.endsWith('.onnx') || l.endsWith('.onnx_data')) {
				return false;
			}
			if (tr.includes(p)) {
				return false;
			}
			return /(vocab|merges|tokenizer|special_tokens|added_tokens|tiktoken|chat_template|processor|preprocessor|spiece)/i.test(p)
				&& /\.(json|txt|model|jinja2?|yaml|yml|bin|safetensors)$/i.test(p);
		});
		return Array.from(new Set([...tr, ...extra]));
	}

	// Check if the format matches any file exactly or as a substring
	const exactMatch = paths.filter(p => p.toLowerCase().includes(f));
	if (exactMatch.length > 0) return exactMatch;

	return [];
}

export class LoCoPilotModelDownloadService extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'locopilot.modelDownloadService';
	static readonly MODELS_DIR = 'locopilot-models';

	/** One active download per model; Stop download cancels the token. */
	private readonly _downloadTokens = new Map<string, CancellationTokenSource>();

	constructor(
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@IRequestService private readonly requestService: IRequestService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@ILoCoPilotFileLog private readonly locopilotFileLog: ILoCoPilotFileLog,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._registerCommands();
	}

	private _registerCommands(): void {
		const self = this;
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.downloadModel', title: 'Download Model' });
			}
			async run(accessor: ServicesAccessor, modelId: string): Promise<void> {
				await self.downloadModel(modelId);
			}
		});
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.checkDiskSpace', title: 'Check Disk Space' });
			}
			async run(accessor: ServicesAccessor): Promise<boolean> {
				return self.checkDiskSpace();
			}
		});
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.deleteModelFiles', title: 'Delete Model Files' });
			}
			async run(accessor: ServicesAccessor, modelId: string): Promise<void> {
				await self.deleteModelFiles(modelId);
			}
		});
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.cancelModelDownload', title: 'Stop download' });
			}
			run(accessor: ServicesAccessor, modelId: string): void {
				self.cancelModelDownload(modelId);
			}
		});
	}

	/**
	 * Deletes the local files for a model (e.g. downloaded HuggingFace files).
	 * Call before removeCustomModel so we have the model's localPath. No-op if model has no localPath.
	 */
	async deleteModelFiles(modelId: string): Promise<void> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model) {
			return;
		}

		if (model.provider === 'ollama') {
			const baseUrl = (model.localPath || 'http://localhost:11434').replace(/\/$/, '');
			const repoId = model.modelName.trim();
			this._log(`[LoCoPilot Ollama] Deleting model ${repoId} from Ollama at ${baseUrl}`);
			try {
				const url = `${baseUrl}/api/delete`;
				const body = JSON.stringify({ name: repoId });
				const response = await this.requestService.request({
					type: 'DELETE',
					url,
					data: body
				}, CancellationToken.None);

				if (response.res.statusCode !== 200 && response.res.statusCode !== 404) {
					const errorBody = await streamToBuffer(response.stream).then(b => b.toString());
					this._log(`[LoCoPilot Ollama] Failed to delete model from Ollama: ${errorBody}`);
				}
			} catch (e) {
				this._log(`[LoCoPilot Ollama] Error deleting model from Ollama: ${e}`);
			}
			return;
		}

		if (!model.localPath) {
			return;
		}
		const uri = URI.file(model.localPath);
		try {
			await this.fileService.del(uri, { recursive: true });
			this._log(`[LoCoPilot Download] Deleted local files for ${model.modelName}: ${model.localPath}`);
		} catch (e) {
			this._log(`[LoCoPilot Download] Failed to delete local files for ${model.modelName}: ${e}`);
			// Non-fatal: model will still be removed from list
		}
	}

	async checkDiskSpace(): Promise<boolean> {
		this._log('[LoCoPilot Download] Checking disk space (best-effort).');
		try {
			const base = joinPath(this.environmentService.cacheHome, LoCoPilotModelDownloadService.MODELS_DIR);
			await this.fileService.createFolder(base);
			return true;
		} catch {
			return false;
		}
	}

	private async listRepoFiles(repoId: string, token: string | undefined, cancel: CancellationToken): Promise<string[]> {
		const out: string[] = [];
		const queue: string[] = [''];
		// Use path segment encoding so "org/repo" becomes "org/repo" in path (HF expects slash in path)
		const repoPath = repoId.split('/').map(encodeURIComponent).join('/');
		while (queue.length > 0) {
			const path = queue.shift()!;
			const url = path
				? `${HF_API_BASE}/api/models/${repoPath}/tree/main?path=${encodeURIComponent(path)}`
				: `${HF_API_BASE}/api/models/${repoPath}/tree/main`;
			const headers: Record<string, string> = { Accept: 'application/json' };
			if (token) headers['Authorization'] = `Bearer ${token}`;
			const res = await this.requestService.request({ type: 'GET', url, headers }, cancel);
			if (res.res.statusCode !== 200) {
				const body = await streamToBuffer(res.stream).then(b => b.toString());
				throw new Error(`HF API error ${res.res.statusCode}: ${body || ''}`);
			}
			const raw = await streamToBuffer(res.stream).then(b => b.toString());
			const items = JSON.parse(raw) as HFTreeItem[];
			for (const item of items) {
				const fullPath = path ? `${path}/${item.path}` : item.path;
				if (item.type === 'file') {
					out.push(fullPath);
				} else if (item.type === 'dir') {
					queue.push(fullPath);
				}
			}
		}
		return out;
	}

	async downloadModel(modelId: string): Promise<void> {
		const prev = this._downloadTokens.get(modelId);
		if (prev) {
			prev.cancel();
			prev.dispose();
			this._downloadTokens.delete(modelId);
		}

		const cts = new CancellationTokenSource();
		this._downloadTokens.set(modelId, cts);
		const cancel = cts.token;
		try {
			const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
			if (!model) {
				return;
			}
			if (model.provider === 'huggingface') {
				await this._downloadHuggingFaceModel(model, cancel);
			} else if (model.provider === 'ollama') {
				await this._pullOllamaModel(model, cancel);
			}
		} finally {
			this._downloadTokens.delete(modelId);
			cts.dispose();
		}
	}

	cancelModelDownload(modelId: string): void {
		this._downloadTokens.get(modelId)?.cancel();
	}

	private async _deleteIncompleteHfFolder(uri: URI): Promise<void> {
		try {
			await this.fileService.del(uri, { recursive: true });
			this._log(`[LoCoPilot Download] Removed partial install under ${uri.fsPath}`);
		} catch (e) {
			this._log(`[LoCoPilot Download] Could not remove partial install under ${uri.fsPath}: ${e}`);
		}
	}

	private async _pullOllamaModel(model: ICustomLanguageModel, cancel: CancellationToken): Promise<void> {
		const modelId = model.id;
		const repoId = model.modelName.trim();
		const baseUrl = (model.localPath || 'http://localhost:11434').replace(/\/$/, '');

		this._log(`[LoCoPilot Ollama] Starting pull for ${repoId} at ${baseUrl}`);
		try {
			// UI shows an indeterminate spinner while pulling (no percentage).
			await this.customLanguageModelsService.updateCustomModel(modelId, { isDownloading: true });

			const url = `${baseUrl}/api/pull`;
			const body = JSON.stringify({ name: repoId, stream: true });

			const response = await this.requestService.request({
				type: 'POST',
				url,
				data: body
			}, cancel);

			if (response.res.statusCode !== 200) {
				const errorBody = await streamToBuffer(response.stream).then(b => b.toString());
				throw new Error(`Ollama API error ${response.res.statusCode}: ${errorBody || `Make sure Ollama is running at ${baseUrl}.`}`);
			}

			await new Promise<void>((resolve, reject) => {
				if (cancel.isCancellationRequested) {
					reject(new CancellationError());
					return;
				}

				const cancelListener = cancel.onCancellationRequested(() => {
					cancelListener.dispose();
					reject(new CancellationError());
				});

				let buffer = '';

				listenStream(response.stream, {
					onData: (chunk: any) => {
						buffer += chunk.toString();
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';

						for (const line of lines) {
							if (!line.trim()) continue;
							try {
								const json = JSON.parse(line) as { status?: string; completed?: number; total?: number };
								if (json.status) {
									this._log(`[LoCoPilot Ollama] Pull status: ${json.status}${typeof json.completed === 'number' && typeof json.total === 'number' ? ` (${json.completed}/${json.total})` : ''}`);
								}
							} catch (e) {
								// Ignore parse errors for partial lines
							}
						}
					},
					onError: (error: any) => {
						cancelListener.dispose();
						reject(error);
					},
					onEnd: async () => {
						cancelListener.dispose();
						if (cancel.isCancellationRequested) {
							reject(new CancellationError());
							return;
						}
						await this.customLanguageModelsService.updateCustomModel(modelId, {
							isDownloading: false,
							ollamaPullComplete: true
							// localPath still holds the Base URL
						});
						this._log(`[LoCoPilot Ollama] ${repoId} pulled successfully.`);
						resolve();
					}
				}, cancel);
			});
		} catch (e) {
			this._log(`[LoCoPilot Ollama] Error pulling ${repoId}: ${e}`);
			await this.customLanguageModelsService.updateCustomModel(modelId, { isDownloading: false, ollamaPullComplete: false });

			const userCancelled = cancel.isCancellationRequested || isCancellationError(e);
			if (userCancelled) {
				this._log(`[LoCoPilot Ollama] Pull cancelled; removing partial layers from Ollama if present.`);
				await this.deleteModelFiles(model.id);
				return;
			}

			const message = toErrorMessage(e);
			this.notificationService.error(
				`Failed to pull Ollama model "${repoId}": ${message}. Make sure Ollama is installed and running at ${baseUrl}.`
			);
			throw e;
		}
	}

	private async _downloadHuggingFaceModel(model: ICustomLanguageModel, cancel: CancellationToken): Promise<void> {
		const modelId = model.id;
		const token = model.token;
		const repoId = model.modelName.trim();
		if (!repoId) {
			this._log('[LoCoPilot Download] Model name (repo id) is empty.');
			return;
		}
		const format = (model.format || '').trim();

		this._log(`[LoCoPilot Download] Starting download for ${repoId} (Format: ${format || 'Auto-select'})`);
		let partialInstallDir: URI | undefined;

		try {
			await this.customLanguageModelsService.updateCustomModel(modelId, { isDownloading: true, downloadProgress: 0 });

			const allPaths = await this.listRepoFiles(repoId, token, cancel);
			const toDownload = filterPathsByFormat(allPaths, format);

			if (toDownload.length === 0) {
				throw new Error(localize('locopilot.download.error.formatUnavailable', 'Model format "{0}" is not available in repository "{1}".', format || 'any', repoId));
			}

			const baseDir = joinPath(
				this.environmentService.cacheHome,
				LoCoPilotModelDownloadService.MODELS_DIR,
				repoId.replace(/\//g, '_')
			);
			await this.fileService.createFolder(baseDir);
			partialInstallDir = baseDir;

			const total = toDownload.length;
			let mainModelFileUri: URI | undefined;
			for (let i = 0; i < toDownload.length; i++) {
				const relPath = toDownload[i];
				// Use path segment encoding so "org/repo" stays as org/repo in URL path (HF CDN expects it)
				const repoPathEnc = repoId.split('/').map(encodeURIComponent).join('/');
				const filePathEnc = relPath.split('/').map(encodeURIComponent).join('/');
				const fileUrl = `${HF_RESOLVE}/${repoPathEnc}/resolve/main/${filePathEnc}`;
				const headers: Record<string, string> = {};
				if (token) headers['Authorization'] = `Bearer ${token}`;
				const segments = relPath.split('/').filter(Boolean);
				const fileUri = segments.length > 1 ? joinPath(baseDir, ...segments) : joinPath(baseDir, relPath);
				const parentPath = segments.slice(0, -1);
				if (parentPath.length > 0) {
					await this.fileService.createFolder(joinPath(baseDir, ...parentPath));
				}
				// Use requestToFile when available to stream directly to disk and avoid OOM for large model files
				if (this.requestService.requestToFile) {
					const progressRequestId = generateUuid();
					let lastPct = -1;
					const progressEvent = this.requestService.getRequestToFileProgressEvent?.(progressRequestId);
					const progressDisposable = progressEvent
						? progressEvent((evt: IRequestToFileProgressEvent) => {
							const contentLength = evt.contentLength;
							const filePct = contentLength && contentLength > 0
								? Math.min(100, Math.round((evt.bytesReceived / contentLength) * 100))
								: 0;
							// Overall progress: completed files + current file progress
							const pct = total <= 1
								? filePct
								: Math.min(99, Math.round((i / total) * 100 + (filePct / 100) * (1 / total) * 100));
							if (pct !== lastPct && pct >= 0) {
								lastPct = pct;
								this.customLanguageModelsService.updateCustomModel(modelId, { downloadProgress: pct });
							}
						})
						: undefined;
					try {
						const res = await this.requestService.requestToFile({ type: 'GET', url: fileUrl, headers }, fileUri.fsPath, cancel, progressRequestId);
						if (res.res.statusCode !== 200) {
							throw new Error(`Download failed for ${relPath}: ${res.res.statusCode}`);
						}
					} finally {
						progressDisposable?.dispose();
					}
				} else {
					const res = await this.requestService.request({ type: 'GET', url: fileUrl, headers }, cancel);
					if (res.res.statusCode !== 200) {
						throw new Error(`Download failed for ${relPath}: ${res.res.statusCode}`);
					}
					await this.fileService.writeFile(fileUri, res.stream);
				}
				// For single GGUF download, use this file as the main model path for llama.cpp
				if (total === 1 && relPath.toLowerCase().endsWith('.gguf')) {
					mainModelFileUri = fileUri;
				} else if (relPath.toLowerCase().endsWith('.gguf')) {
					mainModelFileUri = mainModelFileUri ?? fileUri;
				}
				const pct = Math.round(((i + 1) / total) * 100);
				await this.customLanguageModelsService.updateCustomModel(modelId, { downloadProgress: pct });
				this._log(`[LoCoPilot Download] ${repoId} progress: ${pct}% (${i + 1}/${total})`);
			}

			// Prefer full path to a single GGUF file so llama.cpp server can load it directly; otherwise store directory
			const localPath = mainModelFileUri ? mainModelFileUri.fsPath : baseDir.fsPath;
			await this.customLanguageModelsService.updateCustomModel(modelId, {
				isDownloading: false,
				downloadProgress: 100,
				localPath
			});
			partialInstallDir = undefined;
			this._log(`[LoCoPilot Download] ${repoId} downloaded to ${localPath}.`);
		} catch (e) {
			this._log(`[LoCoPilot Download] Error downloading ${repoId}: ${e}`);
			await this.customLanguageModelsService.updateCustomModel(modelId, { isDownloading: false });

			const userCancelled = cancel.isCancellationRequested || isCancellationError(e);
			if (userCancelled) {
				this._log(`[LoCoPilot Download] Download cancelled for ${repoId}.`);
				if (partialInstallDir) {
					await this._deleteIncompleteHfFolder(partialInstallDir);
				}
				return;
			}

			const message = toErrorMessage(e);
			this.notificationService.error(
				`Failed to download model "${repoId}": ${message}. Check the model name (use format org/model-name), token for gated repos, and network.`
			);
			throw e;
		}
	}

	private _log(msg: string, ...args: unknown[]): void {
		this.logService.info(msg, ...args);
		this.locopilotFileLog.log(msg, ...args);
	}
}
