/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath, relativePath } from '../../../../../base/common/resources.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEmbeddingComputeService } from '../../../../../platform/embeddings/common/embeddingCompute.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEmbeddingProvider, resolveEmbeddingProvider, cosineSimilarity } from './embeddings.js';
import { chunkSource, chunkEmbeddingText, ICodeChunk } from './chunker.js';

export const ILoCoPilotRetrievalService = createDecorator<ILoCoPilotRetrievalService>('locopilotRetrievalService');

export type RetrievalStatus = 'disabled' | 'idle' | 'indexing' | 'ready';

export interface IRetrievalResult {
	path: string;        // workspace-relative path
	startLine: number;
	endLine: number;
	symbol?: string;
	text: string;
	score: number;
}

export interface IRetrievalStatusInfo {
	status: RetrievalStatus;
	indexedFiles: number;
	totalChunks: number;
}

export interface ILoCoPilotRetrievalService {
	readonly _serviceBrand: undefined;
	/** Begin (or resume) background indexing for all workspace roots. Non-blocking. */
	startIndexing(): void;
	/** Semantic search over the indexed codebase. Returns up to `topN` chunks. */
	search(query: string, topN: number, token: CancellationToken): Promise<IRetrievalResult[]>;
	/** Current status, for graceful fallback messaging in the tool. */
	getStatus(): IRetrievalStatusInfo;
}

interface IStoredChunk {
	startLine: number;
	endLine: number;
	symbol?: string;
	text: string;
	vector: number[];
}

interface IFileManifestEntry {
	hash: string;
	shard: string;
}

interface IManifest {
	version: number;
	providerId: string;
	model: string;
	dimension: number;
	files: { [relPath: string]: IFileManifestEntry };
}

const MANIFEST_VERSION = 1;
const INDEX_DIRNAME = '.locopilot';
const EMBED_BATCH = 16;

const CODE_EXTENSIONS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp',
	'hpp', 'cc', 'cs', 'swift', 'kt', 'kts', 'scala', 'm', 'mm', 'sh', 'bash', 'sql', 'json', 'yaml',
	'yml', 'toml', 'md', 'txt', 'html', 'css', 'scss', 'less', 'vue', 'svelte', 'lua', 'dart', 'r',
]);
const IGNORE_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', 'out-build', 'out-vscode', '.next', '.cache',
	'__pycache__', '.venv', 'venv', 'target', 'bin', 'obj', '.locopilot', 'coverage', '.idea', '.vscode-test',
]);
const MAX_FILE_BYTES = 512 * 1024;

function simpleHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
	return (h >>> 0).toString(36);
}

/** Per-root in-memory state. */
interface IRootState {
	root: URI;
	indexDir: URI;
	status: RetrievalStatus;
	manifest: IManifest;
	/** Flattened chunks across all files for brute-force cosine search. */
	chunks: { relPath: string; chunk: IStoredChunk }[];
}

export class LoCoPilotRetrievalService extends Disposable implements ILoCoPilotRetrievalService {
	declare readonly _serviceBrand: undefined;

	private readonly _roots = new Map<string, IRootState>();
	private _provider: IEmbeddingProvider | undefined;
	private _providerResolved = false;
	private _indexingCts: CancellationTokenSource | undefined;
	private _started = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@IEmbeddingComputeService private readonly embeddingComputeService: IEmbeddingComputeService,
	) {
		super();
		// Keep the index fresh as files change (create/edit/delete handled by manifest hash diff).
		this._register(this.fileService.onDidFilesChange(() => this._scheduleRefresh()));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.startIndexing()));
	}

	getStatus(): IRetrievalStatusInfo {
		let indexedFiles = 0, totalChunks = 0;
		let status: RetrievalStatus = this._providerResolved && !this._provider ? 'disabled' : 'idle';
		for (const st of this._roots.values()) {
			indexedFiles += Object.keys(st.manifest.files).length;
			totalChunks += st.chunks.length;
			if (st.status === 'indexing') { status = 'indexing'; }
			else if (st.status === 'ready' && status !== 'indexing') { status = 'ready'; }
		}
		return { status, indexedFiles, totalChunks };
	}

	startIndexing(): void {
		if (this._started && this._indexingCts && !this._indexingCts.token.isCancellationRequested) {
			return; // already running
		}
		this._started = true;
		this._indexingCts?.dispose(true);
		this._indexingCts = new CancellationTokenSource();
		const token = this._indexingCts.token;
		// Fire and forget: indexing must never block the UI.
		void this._runIndexing(token).catch(e => this.logService.error(`[LoCoPilot Retrieval] Indexing failed: ${e}`));
	}

	private _refreshTimer: any;
	private _scheduleRefresh(): void {
		if (!this._started) { return; }
		clearTimeout(this._refreshTimer);
		this._refreshTimer = setTimeout(() => this.startIndexing(), 1500); // debounce bursts of file events
	}

	private async _ensureProvider(token: CancellationToken): Promise<IEmbeddingProvider | undefined> {
		if (this._providerResolved) { return this._provider; }
		this._provider = await resolveEmbeddingProvider(this.configurationService, this.requestService, this.logService, token, this.embeddingComputeService);
		this._providerResolved = true;
		return this._provider;
	}

	private async _runIndexing(token: CancellationToken): Promise<void> {
		const enabled = this.configurationService.getValue('locopilot.retrieval.enabled');
		if (enabled === false) { return; }

		const provider = await this._ensureProvider(token);
		if (!provider) { return; } // no backend -> stays disabled, tool falls back to grep

		const folders = this.workspaceService.getWorkspace().folders;
		for (const folder of folders) {
			if (token.isCancellationRequested) { return; }
			await this._indexRoot(folder.uri, provider, token);
		}
	}

	private async _indexRoot(root: URI, provider: IEmbeddingProvider, token: CancellationToken): Promise<void> {
		const key = root.toString();
		let st = this._roots.get(key);
		if (!st) {
			const indexDir = joinPath(root, INDEX_DIRNAME, 'index');
			st = { root, indexDir, status: 'idle', manifest: this._emptyManifest(provider), chunks: [] };
			this._roots.set(key, st);
			await this._loadFromDisk(st, provider);
		}
		st.status = 'indexing';

		try {
			const files = await this._collectFiles(root, token);
			let processed = 0;
			let batchTexts: string[] = [];
			let batchMeta: { relPath: string; chunk: ICodeChunk; hash: string }[] = [];

			const flush = async () => {
				if (batchTexts.length === 0) { return; }
				const vectors = await provider.embedDocuments(batchTexts, token);
				// Group vectors back per file and persist shards.
				const byFile = new Map<string, { hash: string; stored: IStoredChunk[] }>();
				for (let i = 0; i < batchMeta.length; i++) {
					const m = batchMeta[i];
					const vec = vectors[i] ?? [];
					if (!vec.length) { continue; }
					let entry = byFile.get(m.relPath);
					if (!entry) { entry = { hash: m.hash, stored: [] }; byFile.set(m.relPath, entry); }
					entry.stored.push({ startLine: m.chunk.startLine, endLine: m.chunk.endLine, symbol: m.chunk.symbol, text: m.chunk.text, vector: vec });
				}
				for (const [relPath, entry] of byFile) {
					await this._writeShard(st!, relPath, entry.hash, entry.stored, provider);
				}
				batchTexts = [];
				batchMeta = [];
			};

			const seen = new Set<string>();
			for (const file of files) {
				if (token.isCancellationRequested) { break; }
				const relPath = relativePath(root, file.uri) ?? file.uri.path;
				seen.add(relPath);
				let content: string;
				try {
					const buf = await this.fileService.readFile(file.uri);
					content = buf.value.toString();
				} catch { continue; }
				const hash = simpleHash(content);
				const existing = st.manifest.files[relPath];
				if (existing && existing.hash === hash) { continue; } // unchanged -> skip (incremental)

				const chunks = chunkSource(relPath, content);
				for (const ch of chunks) {
					batchTexts.push(chunkEmbeddingText(relPath, ch));
					batchMeta.push({ relPath, chunk: ch, hash });
					if (batchTexts.length >= EMBED_BATCH) { await flush(); }
				}
				processed++;
				if (processed % 25 === 0) {
					this.logService.trace(`[LoCoPilot Retrieval] Indexed ${processed} files in ${relPath}`);
					await this._delay(0); // yield to keep UI responsive
				}
			}
			await flush();

			// Remove deleted files from the index.
			for (const relPath of Object.keys(st.manifest.files)) {
				if (!seen.has(relPath)) { await this._removeFile(st, relPath); }
			}

			await this._saveManifest(st);
			this._rebuildChunkList(st);
			st.status = 'ready';
			this.logService.info(`[LoCoPilot Retrieval] Index ready for ${root.fsPath}: ${Object.keys(st.manifest.files).length} files, ${st.chunks.length} chunks`);
		} catch (e) {
			st.status = 'ready'; // keep whatever we have; don't get stuck "indexing"
			this.logService.error(`[LoCoPilot Retrieval] Indexing error for ${root.fsPath}: ${e}`);
		}
	}

	async search(query: string, topN: number, token: CancellationToken): Promise<IRetrievalResult[]> {
		const provider = await this._ensureProvider(token);
		if (!provider) { return []; }
		const n = Math.max(1, Math.min(20, topN || 8));
		const qvec = await provider.embedQuery(query, token);
		if (!qvec.length) { return []; }

		const scored: IRetrievalResult[] = [];
		for (const st of this._roots.values()) {
			for (const { relPath, chunk } of st.chunks) {
				const score = cosineSimilarity(qvec, chunk.vector);
				scored.push({ path: relPath, startLine: chunk.startLine, endLine: chunk.endLine, symbol: chunk.symbol, text: chunk.text, score });
			}
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, n);
	}

	// ---- persistence helpers ----

	private _emptyManifest(provider: IEmbeddingProvider): IManifest {
		return { version: MANIFEST_VERSION, providerId: provider.id, model: provider.model, dimension: provider.dimension, files: {} };
	}

	private async _loadFromDisk(st: IRootState, provider: IEmbeddingProvider): Promise<void> {
		try {
			const manifestUri = joinPath(st.indexDir, 'manifest.json');
			const buf = await this.fileService.readFile(manifestUri);
			const manifest = JSON.parse(buf.value.toString()) as IManifest;
			// Invalidate if the embedding model/provider/version changed (vectors incomparable).
			if (manifest.version !== MANIFEST_VERSION || manifest.model !== provider.model || manifest.providerId !== provider.id) {
				this.logService.info('[LoCoPilot Retrieval] Index model/version changed; rebuilding.');
				return;
			}
			st.manifest = manifest;
			this._rebuildChunkListFromDisk(st);
			await this._loadShards(st);
		} catch {
			// no prior index; fresh build
		}
	}

	private _rebuildChunkListFromDisk(_st: IRootState): void { /* chunks loaded by _loadShards */ }

	private async _loadShards(st: IRootState): Promise<void> {
		st.chunks = [];
		for (const [relPath, entry] of Object.entries(st.manifest.files)) {
			try {
				const shardUri = joinPath(st.indexDir, 'shards', entry.shard);
				const buf = await this.fileService.readFile(shardUri);
				const stored = JSON.parse(buf.value.toString()) as IStoredChunk[];
				for (const c of stored) { st.chunks.push({ relPath, chunk: c }); }
			} catch { /* missing shard: will be rebuilt on next index pass */ }
		}
	}

	private _rebuildChunkList(st: IRootState): void {
		// In steady state we keep chunks in memory as we write shards; this guards consistency.
		// (No-op placeholder kept for clarity; _writeShard / _removeFile maintain st.chunks.)
	}

	private async _writeShard(st: IRootState, relPath: string, hash: string, stored: IStoredChunk[], _provider: IEmbeddingProvider): Promise<void> {
		const shardName = `${simpleHash(relPath)}.json`;
		const shardUri = joinPath(st.indexDir, 'shards', shardName);
		await this.fileService.writeFile(shardUri, VSBuffer.fromString(JSON.stringify(stored)));
		st.manifest.files[relPath] = { hash, shard: shardName };
		// Update in-memory chunk list: drop old entries for this file, add new.
		st.chunks = st.chunks.filter(c => c.relPath !== relPath);
		for (const c of stored) { st.chunks.push({ relPath, chunk: c }); }
	}

	private async _removeFile(st: IRootState, relPath: string): Promise<void> {
		const entry = st.manifest.files[relPath];
		if (entry) {
			try { await this.fileService.del(joinPath(st.indexDir, 'shards', entry.shard)); } catch { /* ignore */ }
		}
		delete st.manifest.files[relPath];
		st.chunks = st.chunks.filter(c => c.relPath !== relPath);
	}

	private async _saveManifest(st: IRootState): Promise<void> {
		const manifestUri = joinPath(st.indexDir, 'manifest.json');
		await this.fileService.writeFile(manifestUri, VSBuffer.fromString(JSON.stringify(st.manifest)));
	}

	// ---- file collection ----

	private async _collectFiles(root: URI, token: CancellationToken): Promise<{ uri: URI; size: number }[]> {
		const out: { uri: URI; size: number }[] = [];
		const walk = async (dir: URI): Promise<void> => {
			if (token.isCancellationRequested) { return; }
			let stat;
			try { stat = await this.fileService.resolve(dir, { resolveMetadata: false }); } catch { return; }
			if (!stat.children) { return; }
			for (const child of stat.children) {
				if (token.isCancellationRequested) { return; }
				if (child.isDirectory) {
					if (IGNORE_DIRS.has(child.name) || child.name.startsWith('.')) { continue; }
					await walk(child.resource);
				} else {
					const ext = child.name.includes('.') ? child.name.split('.').pop()!.toLowerCase() : '';
					if (!CODE_EXTENSIONS.has(ext)) { continue; }
					const size = (child as IFileStat & { size?: number }).size ?? 0;
					if (size && size > MAX_FILE_BYTES) { continue; }
					out.push({ uri: child.resource, size });
				}
			}
		};
		await walk(root);
		return out;
	}

	private _delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	override dispose(): void {
		this._indexingCts?.dispose(true);
		super.dispose();
	}
}

registerSingleton(ILoCoPilotRetrievalService, LoCoPilotRetrievalService, InstantiationType.Delayed);
