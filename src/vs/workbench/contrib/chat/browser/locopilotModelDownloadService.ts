/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable curly, @typescript-eslint/no-explicit-any */

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { listenStream } from '../../../../base/common/stream.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, isEqual, isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import type { IRequestToFileProgressEvent } from '../../../../platform/request/common/requestIpc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ICustomLanguageModelsService, ICustomLanguageModel, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW, getCustomModelListLabel } from '../common/customLanguageModelsService.js';
import { ILoCoPilotFileLog } from './locopilotFileLog.js';
import { ILoCoPilotOllamaService } from './locopilotOllamaService.js';
import { ILoCoPilotSystemInfoService } from '../../../../platform/locopilotSystemInfo/common/locopilotSystemInfo.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { LOCOPILOT_SETTINGS_SECTION_LIST_MODELS } from './chatManagement/locopilotSettingsEditorInput.js';
import { usableSystemMemoryBytes } from './locopilotLlamaCppServer.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../common/constants.js';
import { findDraftPairing } from './locopilotModelCatalog.js';

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

/**
 * Quality ranking of GGUF quantizations, best first. Used by {@link pickBestGgufForBudget} to choose the
 * *highest-quality* quant that still fits the machine's memory budget. Roughly tracks bits-per-weight, so
 * a bigger/fatter quant always outranks a smaller one. Anything unrecognised scores lowest.
 */
const GGUF_QUANT_QUALITY = [
	'F16', 'BF16', 'Q8_0', 'Q6_K', 'Q5_K_M', 'Q5_K_S', 'Q5_0', 'Q4_K_M', 'Q4_K_S', 'Q4_1', 'Q4_0',
	'IQ4_XS', 'IQ4_NL', 'Q3_K_L', 'Q3_K_M', 'Q3_K_S', 'IQ3_M', 'IQ3_S', 'IQ3_XXS', 'Q2_K', 'IQ2_M', 'IQ2_XS', 'IQ2_XXS'
];

/** Quality score for a GGUF filename: higher = better quality. Unknown quants score 0 (lowest). */
export function quantQualityScore(filename: string): number {
	const upper = filename.toUpperCase();
	// Longer tokens (e.g. Q4_K_M) must be matched before their prefixes (Q4_0), so iterate best->worst and
	// return on the first containment; the array order already encodes quality.
	for (let i = 0; i < GGUF_QUANT_QUALITY.length; i++) {
		if (upper.includes(GGUF_QUANT_QUALITY[i])) {
			return GGUF_QUANT_QUALITY.length - i;
		}
	}
	return 0;
}

/**
 * True for multimodal projector files (`mmproj-*.gguf`). These sit next to language weights in vision
 * GGUF repos and must NEVER be chosen as the main `-m` model - llama.cpp rejects them with
 * `unsupported model architecture: 'clip'`. Exported for the runner's directory scan.
 */
export function isMmprojGgufPath(path: string): boolean {
	return /(^|\/)mmproj[^/]*\.gguf$/i.test(path);
}

/** Weight GGUFs only (excludes mmproj / CLIP projectors). */
function isWeightGgufPath(path: string): boolean {
	return path.toLowerCase().endsWith('.gguf') && !isMmprojGgufPath(path);
}

/**
 * Picks the GGUF file to download given the machine's memory budget: the **highest-quality quant whose file
 * fits** `budgetBytes` (after a safety fraction), and when none fit, the **smallest** file so the model can
 * at least run. Returns undefined when there are no GGUF files or no sizes are known (caller falls back to
 * the static priority pick). `files` are {path,size}; entries without a size are treated as unknown and only
 * used as a last-resort smallest pick.
 *
 * Multimodal projectors (`mmproj-*.gguf`) are ignored - they are tiny and would otherwise win the
 * "smallest fallback" path on memory-tight machines, which then fails at launch as architecture `clip`.
 */
export function pickBestGgufForBudget(files: readonly { path: string; size?: number }[], budgetBytes: number): string | undefined {
	const gguf = files.filter(f => isWeightGgufPath(f.path));
	if (gguf.length === 0) {
		return undefined;
	}
	const sized = gguf.filter(f => typeof f.size === 'number' && f.size! > 0) as { path: string; size: number }[];
	if (sized.length === 0 || budgetBytes <= 0) {
		return undefined; // no sizes -> let the static picker decide
	}
	const usable = budgetBytes * 0.7; // leave headroom for the KV cache, runtime, and the OS
	const fitting = sized.filter(f => f.size <= usable);
	if (fitting.length > 0) {
		// Highest quality among those that fit; on a tie, the larger file (more bits) wins.
		fitting.sort((a, b) => (quantQualityScore(b.path) - quantQualityScore(a.path)) || (b.size - a.size));
		return fitting[0].path;
	}
	// Nothing fits -> smallest weight file so the model is at least runnable (with paging / partial offload).
	sized.sort((a, b) => a.size - b.size);
	return sized[0].path;
}

/** Model format priority list. */
const FORMAT_PRIORITY = ['gguf', 'mlx', 'transformers', 'safetensors'];

/**
 * Directory name (under `<cacheHome>/locopilot-models/`) where a HuggingFace repo's files are installed.
 * Shared with the local-model runner, which uses it to locate a paired speculative-decoding draft model
 * on disk without any stored-model record.
 */
export function modelDownloadDirName(repoId: string): string {
	return repoId.replace(/\//g, '_');
}

function pickBestGGUFFile(paths: string[], preferredQuant?: string): string | undefined {
	const gguf = paths.filter(isWeightGgufPath);
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
	// Otherwise shortest file name often indicates a specific quant (e.g. one file)
	return gguf.sort((a, b) => a.length - b.length)[0];
}

/**
 * A multimodal projector (`mmproj-*.gguf`) sits alongside the main weights in vision GGUF repos and is what
 * llama.cpp needs (`--mmproj`) to actually read images. Picks one by precision preference (F16 is the usual
 * sweet spot: full vision quality at half the size of F32), falling back to BF16, then F32, then any match.
 * Returns undefined when the repo ships no projector (i.e. the model is text-only).
 */
function pickMmprojFile(paths: string[]): string | undefined {
	const mmproj = paths.filter(isMmprojGgufPath);
	if (mmproj.length === 0) {
		return undefined;
	}
	for (const pref of ['-f16.', '-bf16.', '-f32.']) {
		const found = mmproj.find(p => p.toLowerCase().includes(pref));
		if (found) {
			return found;
		}
	}
	return mmproj[0];
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
		return best ? [best] : paths.filter(isWeightGgufPath);
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

/** Best-effort family detection from the repo id + the files we actually downloaded; used to fill `format` post-download. */
function detectFormatFamily(repoId: string, paths: string[]): string | undefined {
	const lower = paths.map(p => p.toLowerCase());
	if (lower.some(p => p.endsWith('.gguf'))) {
		return 'gguf';
	}
	// MLX repos are safetensors under the hood, so distinguish them by the conventional repo naming / tag.
	if (/(^|[-_/])mlx([-_]|$)/i.test(repoId)) {
		return 'mlx';
	}
	if (lower.some(p => p.endsWith('.safetensors') || p.endsWith('.bin'))) {
		return 'transformers';
	}
	return undefined;
}

/** Pull a context window out of an HF config.json-style object, trying the common architecture keys. */
function contextWindowFromConfig(cfg: any): number | undefined {
	const candidates = [cfg?.max_position_embeddings, cfg?.n_positions, cfg?.max_sequence_length, cfg?.n_ctx, cfg?.seq_length];
	for (const c of candidates) {
		const n = typeof c === 'number' ? c : Number(c);
		if (Number.isInteger(n) && n >= MIN_CONTEXT_WINDOW && n <= MAX_CONTEXT_WINDOW) {
			return n;
		}
	}
	return undefined;
}

/**
 * Detect image (vision) support from a HuggingFace model-info payload. Returns true when the model card's
 * `pipeline_tag` or `tags` mark it as a multimodal image-text model, otherwise undefined (we never assert
 * false from HF, since absence of a tag isn't proof a model is text-only). Used to auto-fill `supportsVision`.
 */
function detectVisionFromHf(info: any): boolean | undefined {
	const visionPipelines = new Set(['image-text-to-text', 'visual-question-answering', 'image-to-text', 'multimodal']);
	const pipeline = typeof info?.pipeline_tag === 'string' ? info.pipeline_tag.toLowerCase() : '';
	if (visionPipelines.has(pipeline)) {
		return true;
	}
	const tags: string[] = Array.isArray(info?.tags) ? info.tags.map((t: unknown) => String(t).toLowerCase()) : [];
	if (tags.some(t => visionPipelines.has(t) || t === 'vision' || t === 'vlm' || t === 'image-text-to-text')) {
		return true;
	}
	return undefined;
}

/** Validate a raw context-window number into the accepted range, or undefined if unusable. */
function sanitizeContextWindow(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isInteger(n) && n >= MIN_CONTEXT_WINDOW && n <= MAX_CONTEXT_WINDOW ? n : undefined;
}

export class LoCoPilotModelDownloadService extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'locopilot.modelDownloadService';
	static readonly MODELS_DIR = 'locopilot-models';

	/** One active download per model; Stop download cancels the token. */
	private readonly _downloadTokens = new Map<string, CancellationTokenSource>();
	/** Draft repos currently being fetched, so concurrent triggers (post-download + launch) don't double-download. */
	private readonly _draftDownloadsInFlight = new Set<string>();

	constructor(
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@IRequestService private readonly requestService: IRequestService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@ILoCoPilotFileLog private readonly locopilotFileLog: ILoCoPilotFileLog,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@ILoCoPilotOllamaService private readonly ollamaService: ILoCoPilotOllamaService,
		@ILoCoPilotSystemInfoService private readonly systemInfoService: ILoCoPilotSystemInfoService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
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
				// If already downloading this model, do nothing - the link in the chat panel
				// stays visible but is now harmless to click (won't cancel+restart the download).
				if (self._downloadTokens.has(modelId)) {
					return;
				}
				// Acknowledge the click right away so the user knows it registered, before the redirect
				// and any time it takes for the progress bar to appear.
				const startModel = self.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
				if (startModel) {
					self.notificationService.info(`Download started for "${getCustomModelListLabel(startModel)}". You can keep working - I'll let you know when it's ready.`);
				}
				// Open the model list focused on this model so the user can track download progress.
				const commandService = accessor.get(ICommandService);
				commandService.executeCommand('workbench.action.chat.openLoCoPilotSettings', {
					section: LOCOPILOT_SETTINGS_SECTION_LIST_MODELS,
					focusModelId: modelId,
				});
				await self.downloadModel(modelId);
			}
		});
		// Fired by the local-model runner when a model launches whose catalog pairing has a draft that is
		// not on disk yet (e.g. the model was downloaded before draft pairing existed). Fetches in the
		// background; the draft is picked up on the model's NEXT start.
		registerAction2(class extends Action2 {
			constructor() {
				super({ id: 'locopilot.ensureDraftModel', title: 'Ensure Speculative Draft Model' });
			}
			async run(_accessor: ServicesAccessor, mainRepoId?: string, hfToken?: string): Promise<void> {
				if (mainRepoId) {
					await self._ensureDraftForRepo(mainRepoId, hfToken);
				}
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
				super({ id: 'locopilot.removeModelDownload', title: 'Remove Model Download' });
			}
			async run(accessor: ServicesAccessor, modelId: string): Promise<void> {
				await self.removeModelDownload(modelId);
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
		const modelsRoot = joinPath(this.environmentService.cacheHome, LoCoPilotModelDownloadService.MODELS_DIR);
		let toDelete = uri;
		// localPath often points at a single GGUF file; delete the whole install folder so mmproj/sidecar
		// files are removed too (only when that folder lives under our models cache).
		try {
			const stat = await this.fileService.stat(uri);
			if (!stat.isDirectory) {
				const parent = dirname(uri);
				if (isEqualOrParent(parent, modelsRoot) && !isEqual(parent, modelsRoot)) {
					toDelete = parent;
				}
			}
		} catch {
			// Path may already be gone; still attempt delete below.
		}
		try {
			await this.fileService.del(toDelete, { recursive: true });
			this._log(`[LoCoPilot Download] Deleted local files for ${model.modelName}: ${toDelete.fsPath}`);
		} catch (e) {
			this._log(`[LoCoPilot Download] Failed to delete local files for ${model.modelName}: ${e}`);
			// Non-fatal: model will still be removed from list / marked not downloaded
		}
	}

	/**
	 * Deletes on-disk (or Ollama) weights but keeps the list entry so the user can download again.
	 * Hugging Face: clears `localPath`. Ollama: sets `ollamaPullComplete` false (URL stays in `localPath`).
	 */
	async removeModelDownload(modelId: string): Promise<void> {
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model) {
			return;
		}
		await this.deleteModelFiles(modelId);
		if (model.provider === 'ollama') {
			await this.customLanguageModelsService.updateCustomModel(modelId, {
				isDownloading: false,
				downloadProgress: undefined,
				ollamaPullComplete: false,
			});
		} else if (model.provider === 'huggingface') {
			await this.customLanguageModelsService.updateCustomModel(modelId, {
				isDownloading: false,
				downloadProgress: undefined,
				localPath: undefined,
			});
		}
		this._log(`[LoCoPilot Download] Removed download for ${model.modelName}; kept list entry.`);
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

	/**
	 * The memory budget (bytes) used to size-select a GGUF quant at download time: the larger of the machine's
	 * total system RAM and its biggest detected GPU VRAM pool. RAM is included because GGUF weights can live in
	 * system RAM (CPU/Metal backends, or partial/MoE offload), so a model that fits RAM is still runnable even
	 * without enough VRAM. Returns 0 when neither figure is available (caller then skips the downgrade).
	 */
	private async _memoryBudgetForDownload(): Promise<number> {
		let ram = 0;
		let vram = 0;
		try {
			const stats = await this.nativeHostService.getOSStatistics();
			// Usable RAM, not raw total: the OS + editor always hold a slice, so sizing the quant off raw total
			// over-states capacity and skips the downgrade on machines that can't actually run the bigger quant.
			ram = usableSystemMemoryBytes(stats.totalmem ?? 0);
		} catch { /* ignore */ }
		try {
			const hw = await this.systemInfoService.getHardwareInfo();
			vram = hw.gpus.reduce((max, g) => Math.max(max, g.totalVramBytes), 0);
		} catch { /* ignore */ }
		return Math.max(ram, vram);
	}

	/**
	 * Lists every file path in a HuggingFace repo. When `sizesOut` is provided, it is filled with each file's
	 * byte size (when the API reports one), keyed by the same full path, so callers can size-select quants.
	 */
	private async listRepoFiles(repoId: string, token: string | undefined, cancel: CancellationToken, sizesOut?: Map<string, number>): Promise<string[]> {
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
					if (sizesOut && typeof item.size === 'number' && item.size > 0) {
						sizesOut.set(fullPath, item.size);
					}
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
			// Download finished successfully (not cancelled): let the user know it's ready and offer a
			// one-click way back to chatting, so they don't have to watch the progress bar to know when
			// to send their message.
			if (!cancel.isCancellationRequested) {
				const ready = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
				if (ready && !ready.isDownloading) {
					this._notifyDownloadReady(ready);
				}
			}
		} finally {
			this._downloadTokens.delete(modelId);
			cts.dispose();
		}
	}

	cancelModelDownload(modelId: string): void {
		const token = this._downloadTokens.get(modelId);
		if (token) {
			token.cancel();
			return;
		}
		// No live download token, yet the row is showing "Stop download": the flag is stale (the download
		// wedged and its token was lost - e.g. the network dropped mid-stream, or the app was reloaded while
		// this window kept a persisted `isDownloading`). Cancel here would be a no-op, leaving the button
		// stuck forever, so self-heal the state directly and clean up any partial files. This lets the row
		// fall back to "Download" so the user can retry without restarting.
		const model = this.customLanguageModelsService.getCustomModels().find(m => m.id === modelId);
		if (!model || !model.isDownloading) {
			return;
		}
		this._log(`[LoCoPilot Download] Stop download for ${model.modelName}: no active download token; clearing stale in-progress state.`);
		void this.removeModelDownload(modelId);
	}

	/**
	 * Tell the user a model finished downloading and is ready to use, with a one-click action to jump
	 * back to the chat input. Without this, the in-chat download prompt only updates when the user
	 * re-sends, so there's no signal that the download is done.
	 */
	private _notifyDownloadReady(model: ICustomLanguageModel): void {
		const label = getCustomModelListLabel(model);
		this.notificationService.notify({
			severity: Severity.Info,
			message: `"${label}" is ready. Send your message to start chatting.`,
			actions: {
				primary: [{
					id: 'locopilot.startChattingAfterDownload',
					label: 'Start chatting',
					tooltip: '',
					class: undefined,
					enabled: true,
					run: () => this.commandService.executeCommand('workbench.action.chat.open'),
				}],
			},
		});
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

		// Make sure Ollama is installed and running before we pull. If it is missing, the service offers a
		// consent-gated install (it never installs silently) and we stop here so the user can act.
		const readiness = await this.ollamaService.ensureReady(baseUrl);
		if (readiness !== 'ready') {
			if (readiness === 'starting') {
				this.notificationService.info(`Ollama is starting up. Once it is running, click "Download" again to pull "${repoId}".`);
			}
			this._log(`[LoCoPilot Ollama] Not ready to pull ${repoId} (state: ${readiness}).`);
			return;
		}

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
						// Enrich context window + tool support from Ollama (best-effort, never blocks completion).
						await this._enrichOllamaMetadata(model, baseUrl, cancel);
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

			const sizes = new Map<string, number>();
			const allPaths = await this.listRepoFiles(repoId, token, cancel, sizes);
			let toDownload = filterPathsByFormat(allPaths, format);

			// #4 Hardware-aware quant selection: when the chosen GGUF quant is too big for this machine's memory
			// budget, fall back to the highest-quality quant that *does* fit (or the smallest if none do). Only
			// ever downgrades - a quant that already fits is left untouched - so explicit choices are respected.
			if (toDownload.length === 1 && toDownload[0].toLowerCase().endsWith('.gguf')) {
				const budget = await this._memoryBudgetForDownload();
				const chosen = toDownload[0];
				const chosenSize = sizes.get(chosen) ?? 0;
				if (budget > 0 && chosenSize > budget * 0.7) {
					const files = allPaths.map(p => ({ path: p, size: sizes.get(p) }));
					const better = pickBestGgufForBudget(files, budget);
					if (better && better !== chosen) {
						this._log(`[LoCoPilot Download] ${chosen} (${Math.round(chosenSize / 1e9)}GB) exceeds the ~${Math.round(budget / 1e9)}GB memory budget; downloading ${better} instead (hardware-aware quant).`);
						toDownload = [better];
					}
				}
			}

			if (toDownload.length === 0) {
				throw new Error(localize('locopilot.download.error.formatUnavailable', 'Model format "{0}" is not available in repository "{1}".', format || 'any', repoId));
			}

			// For vision models, also fetch the multimodal projector (mmproj-*.gguf) so the server can read images.
			// Only for GGUF (llama.cpp) downloads and only when not explicitly marked text-only; appended after the
			// quant-selection/budget logic so it never interferes with picking the main weights file.
			let mmprojRelPath: string | undefined;
			const isGgufDownload = toDownload.some(p => p.toLowerCase().endsWith('.gguf'));
			if (model.supportsVision !== false && isGgufDownload) {
				mmprojRelPath = pickMmprojFile(allPaths);
				if (mmprojRelPath && !toDownload.includes(mmprojRelPath)) {
					toDownload = [...toDownload, mmprojRelPath];
					this._log(`[LoCoPilot Download] Vision model: also downloading projector ${mmprojRelPath} for image input.`);
				}
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
				// For single GGUF download, use this file as the main model path for llama.cpp. The mmproj
				// projector is also a .gguf but must NOT be treated as the main weights, so skip it here.
				const isMmproj = isMmprojGgufPath(relPath) || relPath === mmprojRelPath;
				if (!isMmproj && total === 1 && relPath.toLowerCase().endsWith('.gguf')) {
					mainModelFileUri = fileUri;
				} else if (!isMmproj && relPath.toLowerCase().endsWith('.gguf')) {
					mainModelFileUri = mainModelFileUri ?? fileUri;
				}
				const pct = Math.round(((i + 1) / total) * 100);
				await this.customLanguageModelsService.updateCustomModel(modelId, { downloadProgress: pct });
				this._log(`[LoCoPilot Download] ${repoId} progress: ${pct}% (${i + 1}/${total})`);
			}

			// Prefer full path to a single weight GGUF so llama.cpp can load it as `-m`. Never persist an
			// mmproj path here - that launches as architecture `clip` and exits immediately.
			if (mainModelFileUri && isMmprojGgufPath(mainModelFileUri.fsPath)) {
				mainModelFileUri = undefined;
			}
			if (!mainModelFileUri && toDownload.some(isWeightGgufPath) === false) {
				throw new Error(localize(
					'locopilot.download.error.noWeightGguf',
					'No language-model GGUF was selected for "{0}" (only a vision projector was available). Try again or pick a smaller quant.',
					repoId
				));
			}
			const localPath = mainModelFileUri ? mainModelFileUri.fsPath : baseDir.fsPath;
			await this.customLanguageModelsService.updateCustomModel(modelId, {
				isDownloading: false,
				downloadProgress: 100,
				localPath,
				// A projector on disk is ground truth that this model can read images, so enable vision.
				...(mmprojRelPath ? { supportsVision: true } : {})
			});
			partialInstallDir = undefined;
			this._log(`[LoCoPilot Download] ${repoId} downloaded to ${localPath}.`);

			// Enrich format/context window from HF now that the files are on disk (best-effort, never blocks completion).
			await this._enrichHuggingFaceMetadata(model, toDownload, cancel);

			// Fetch the paired speculative-decoding draft model in the background (small, few hundred MB).
			// Fire-and-forget: the main model is fully usable without it; the runner simply enables the
			// draft on the first launch after it lands. Never blocks or fails the main download.
			this._ensureDraftForRepo(repoId, token).catch(e => this._log(`[LoCoPilot Download] Draft fetch for ${repoId} failed (ignored): ${e}`));
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

	/**
	 * Downloads the speculative-decoding draft model paired (in the catalog) with `mainRepoId`, if any.
	 * Silent and best-effort: no progress UI, no stored-model record - the draft lands in the same
	 * `locopilot-models/` layout ({@link modelDownloadDirName}) where the runner looks it up at launch.
	 * Skipped when the relevant auto setting is off, the draft is already on disk, or the machine's memory
	 * budget clearly can't hold main weights + draft together (the launch-time gate is authoritative;
	 * this only avoids downloading something that could never be used).
	 */
	private async _ensureDraftForRepo(mainRepoId: string, hfToken?: string): Promise<void> {
		const pairing = findDraftPairing(mainRepoId);
		if (!pairing) {
			return;
		}
		const isMlxDraft = pairing.draftFormat.toLowerCase() === 'mlx';
		const autoKey = isMlxDraft ? ChatConfiguration.LocopilotMlxAutoTune : ChatConfiguration.LocopilotLlamaCppAutoSpeculative;
		if (this.configurationService.getValue<boolean>(autoKey) === false) {
			return;
		}
		if (this._draftDownloadsInFlight.has(pairing.draftRepoId)) {
			return;
		}
		const draftDir = joinPath(this.environmentService.cacheHome, LoCoPilotModelDownloadService.MODELS_DIR, modelDownloadDirName(pairing.draftRepoId));
		// Already installed? (any .gguf for GGUF drafts; config.json for MLX weight dirs)
		try {
			const resolved = await this.fileService.resolve(draftDir);
			const names = (resolved.children ?? []).filter(c => c.isFile).map(c => c.name.toLowerCase());
			if (isMlxDraft ? names.includes('config.json') : names.some(n => n.endsWith('.gguf'))) {
				return;
			}
		} catch {
			// dir missing -> proceed to download
		}

		this._draftDownloadsInFlight.add(pairing.draftRepoId);
		try {
			const cancel = CancellationToken.None;
			const sizes = new Map<string, number>();
			const allPaths = await this.listRepoFiles(pairing.draftRepoId, hfToken, cancel, sizes);
			const toDownload = filterPathsByFormat(allPaths, pairing.draftFormat);
			if (toDownload.length === 0) {
				this._log(`[LoCoPilot Download] Draft ${pairing.draftRepoId}: no files match format "${pairing.draftFormat}"; skipping.`);
				return;
			}
			const draftBytes = toDownload.reduce((sum, p) => sum + (sizes.get(p) ?? 0), 0);
			const budget = await this._memoryBudgetForDownload();
			// A draft only ever runs ALONGSIDE the main weights; if it alone would eat >15% of the whole
			// budget it will never pass the launch-time fit gate, so don't waste the bandwidth/disk.
			if (budget > 0 && draftBytes > budget * 0.15) {
				this._log(`[LoCoPilot Download] Draft ${pairing.draftRepoId} (~${Math.round(draftBytes / 1e6)}MB) is too large for this machine's ~${Math.round(budget / 1e9)}GB budget; skipping.`);
				return;
			}
			this._log(`[LoCoPilot Download] Fetching speculative draft ${pairing.draftRepoId} (${pairing.draftFormat}, ~${Math.round(draftBytes / 1e6)}MB) for ${mainRepoId}.`);
			await this.fileService.createFolder(draftDir);
			const repoPathEnc = pairing.draftRepoId.split('/').map(encodeURIComponent).join('/');
			for (const relPath of toDownload) {
				const filePathEnc = relPath.split('/').map(encodeURIComponent).join('/');
				const fileUrl = `${HF_RESOLVE}/${repoPathEnc}/resolve/main/${filePathEnc}`;
				const headers: Record<string, string> = {};
				if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;
				const segments = relPath.split('/').filter(Boolean);
				const fileUri = segments.length > 1 ? joinPath(draftDir, ...segments) : joinPath(draftDir, relPath);
				if (segments.length > 1) {
					await this.fileService.createFolder(joinPath(draftDir, ...segments.slice(0, -1)));
				}
				if (this.requestService.requestToFile) {
					const res = await this.requestService.requestToFile({ type: 'GET', url: fileUrl, headers }, fileUri.fsPath, cancel, generateUuid());
					if (res.res.statusCode !== 200) {
						throw new Error(`Draft download failed for ${relPath}: ${res.res.statusCode}`);
					}
				} else {
					const res = await this.requestService.request({ type: 'GET', url: fileUrl, headers }, cancel);
					if (res.res.statusCode !== 200) {
						throw new Error(`Draft download failed for ${relPath}: ${res.res.statusCode}`);
					}
					await this.fileService.writeFile(fileUri, res.stream);
				}
			}
			this._log(`[LoCoPilot Download] Speculative draft ${pairing.draftRepoId} ready in ${draftDir.fsPath}; it will be used on the next start of ${mainRepoId}.`);
		} catch (e) {
			// Best-effort: remove a partial draft install so the next trigger retries cleanly.
			this._log(`[LoCoPilot Download] Draft ${pairing.draftRepoId} download failed: ${e}`);
			try {
				await this.fileService.del(draftDir, { recursive: true });
			} catch { /* ignore */ }
		} finally {
			this._draftDownloadsInFlight.delete(pairing.draftRepoId);
		}
	}

	/** GET a URL and parse the body as JSON, or undefined on any non-200 / parse error. Best-effort; never throws. */
	private async _getJson(url: string, headers: Record<string, string>, cancel: CancellationToken): Promise<any | undefined> {
		try {
			const res = await this.requestService.request({ type: 'GET', url, headers: { Accept: 'application/json', ...headers } }, cancel);
			if (res.res.statusCode !== 200) {
				return undefined;
			}
			const raw = await streamToBuffer(res.stream).then(b => b.toString());
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	/**
	 * Derive `format` and `contextWindow` from HuggingFace and write them via applyDerivedMetadata
	 * (which skips any field the user has overridden). Best-effort: failures are logged and ignored,
	 * leaving the model on its defaults.
	 */
	private async _enrichHuggingFaceMetadata(model: ICustomLanguageModel, downloadedPaths: string[], cancel: CancellationToken): Promise<void> {
		try {
			const repoId = model.modelName.trim();
			const repoPath = repoId.split('/').map(encodeURIComponent).join('/');
			const headers: Record<string, string> = {};
			if (model.token) {
				headers['Authorization'] = `Bearer ${model.token}`;
			}

			const format = detectFormatFamily(repoId, downloadedPaths);

			// 1) Model info: for GGUF repos this carries `gguf.context_length` directly.
			let contextWindow: number | undefined;
			let supportsVision: boolean | undefined;
			const info = await this._getJson(`${HF_API_BASE}/api/models/${repoPath}`, headers, cancel);
			if (info) {
				contextWindow = sanitizeContextWindow(info.gguf?.context_length) ?? contextWindowFromConfig(info.config);
				supportsVision = detectVisionFromHf(info);
			}
			// 2) Fall back to config.json (transformers/MLX repos expose max_position_embeddings there).
			if (contextWindow === undefined) {
				const cfg = await this._getJson(`${HF_RESOLVE}/${repoPath}/resolve/main/config.json`, headers, cancel);
				contextWindow = contextWindowFromConfig(cfg);
			}

			if (format === undefined && contextWindow === undefined && supportsVision === undefined) {
				return;
			}
			await this.customLanguageModelsService.applyDerivedMetadata(model.id, { format, contextWindow, supportsVision });
			this._log(`[LoCoPilot Download] Enriched ${repoId} metadata (format=${format ?? 'n/a'}, contextWindow=${contextWindow ?? 'n/a'}, vision=${supportsVision ?? 'n/a'}).`);
		} catch (e) {
			this._log(`[LoCoPilot Download] Metadata enrichment failed for ${model.modelName} (non-fatal): ${e}`);
		}
	}

	/**
	 * Derive `contextWindow` and tool-calling support from Ollama's /api/show (authoritative `capabilities`),
	 * and write them via applyDerivedMetadata. Best-effort; failures are logged and ignored.
	 */
	private async _enrichOllamaMetadata(model: ICustomLanguageModel, baseUrl: string, cancel: CancellationToken): Promise<void> {
		try {
			const repoId = model.modelName.trim();
			const res = await this.requestService.request({
				type: 'POST',
				url: `${baseUrl}/api/show`,
				data: JSON.stringify({ name: repoId })
			}, cancel);
			if (res.res.statusCode !== 200) {
				return;
			}
			const raw = await streamToBuffer(res.stream).then(b => b.toString());
			const info = JSON.parse(raw) as { capabilities?: string[]; model_info?: Record<string, unknown> };

			let contextWindow: number | undefined;
			const modelInfo = info.model_info ?? {};
			for (const [key, value] of Object.entries(modelInfo)) {
				if (key.endsWith('.context_length')) {
					contextWindow = sanitizeContextWindow(value);
					break;
				}
			}
			// `capabilities` is the ground truth for tool/vision support; if absent we leave the optimistic default.
			const useNativeTools = Array.isArray(info.capabilities) ? info.capabilities.includes('tools') : undefined;
			const supportsVision = Array.isArray(info.capabilities) ? info.capabilities.includes('vision') : undefined;

			if (contextWindow === undefined && useNativeTools === undefined && supportsVision === undefined) {
				return;
			}
			await this.customLanguageModelsService.applyDerivedMetadata(model.id, { contextWindow, useNativeTools, supportsVision });
			this._log(`[LoCoPilot Ollama] Enriched ${repoId} metadata (contextWindow=${contextWindow ?? 'n/a'}, tools=${useNativeTools ?? 'n/a'}, vision=${supportsVision ?? 'n/a'}).`);
		} catch (e) {
			this._log(`[LoCoPilot Ollama] Metadata enrichment failed for ${model.modelName} (non-fatal): ${e}`);
		}
	}

	private _log(msg: string, ...args: unknown[]): void {
		this.logService.info(msg, ...args);
		this.locopilotFileLog.log(msg, ...args);
	}
}
