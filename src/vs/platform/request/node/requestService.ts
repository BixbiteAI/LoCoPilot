/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import type * as https from 'https';
import * as fs from 'fs';
import { parse as parseUrl } from 'url';
import { Promises } from '../../../base/common/async.js';
import { streamToBuffer, streamToBufferReadableStream } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError, getErrorMessage } from '../../../base/common/errors.js';
import * as streams from '../../../base/common/stream.js';
import { isBoolean, isNumber } from '../../../base/common/types.js';
import { IRequestContext, IRequestOptions } from '../../../base/parts/request/common/request.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { ILogService } from '../../log/common/log.js';
import { AbstractRequestService, AuthInfo, Credentials, IRequestService, IRequestToFileResult, systemCertificatesNodeDefault } from '../common/request.js';
import { Agent, getProxyAgent } from './proxy.js';
import { createGunzip } from 'zlib';

export interface IRawRequestFunction {
	(options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void): http.ClientRequest;
}

export interface NodeRequestOptions extends IRequestOptions {
	agent?: Agent;
	strictSSL?: boolean;
	isChromiumNetwork?: boolean;
	getRawRequest?(options: IRequestOptions): IRawRequestFunction;
}

/**
 * This service exposes the `request` API, while using the global
 * or configured proxy settings.
 */
export class RequestService extends AbstractRequestService implements IRequestService {

	declare readonly _serviceBrand: undefined;

	private proxyUrl?: string;
	private strictSSL: boolean | undefined;
	private authorization?: string;
	private noProxy?: string;
	private shellEnvErrorLogged?: boolean;

	constructor(
		private readonly machine: 'local' | 'remote',
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@ILogService logService: ILogService,
	) {
		super(logService);
		this.configure();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('http')) {
				this.configure();
			}
		}));
	}

	private configure() {
		this.proxyUrl = this.getConfigValue<string>('http.proxy');
		this.strictSSL = !!this.getConfigValue<boolean>('http.proxyStrictSSL');
		this.authorization = this.getConfigValue<string>('http.proxyAuthorization');
		// `http.noProxy` is a string[] setting. It was already honoured for Electron's session proxy (see
		// windowImpl.ts) but never read on this path, so configuring it had no effect on requests made through
		// the request service. Joined the same way here so one setting governs both.
		this.noProxy = (this.getConfigValue<string[]>('http.noProxy') || []).map(item => item.trim()).filter(Boolean).join(',') || undefined;
	}

	async request(options: NodeRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		const { proxyUrl, strictSSL, noProxy } = this;

		let shellEnv: typeof process.env | undefined = undefined;
		try {
			shellEnv = await getResolvedShellEnv(this.configurationService, this.logService, this.environmentService.args, process.env);
		} catch (error) {
			if (!this.shellEnvErrorLogged) {
				this.shellEnvErrorLogged = true;
				this.logService.error(`resolving shell environment failed`, getErrorMessage(error));
			}
		}

		const env = {
			...process.env,
			...shellEnv
		};
		const agent = options.agent ? options.agent : await getProxyAgent(options.url || '', env, { proxyUrl, strictSSL, noProxy });

		options.agent = agent;
		options.strictSSL = strictSSL;

		// Only when the request actually goes THROUGH the proxy. A bypassed request (loopback, LAN, or a
		// no_proxy match) would otherwise hand the user's proxy credentials to a server that is not the proxy.
		if (this.authorization && agent) {
			options.headers = {
				...(options.headers || {}),
				'Proxy-Authorization': this.authorization
			};
		}

		return this.logAndRequest(options, () => nodeRequest(options, token));
	}

	async requestToFile(options: NodeRequestOptions, destinationFilePath: string, token: CancellationToken, progressRequestIdOrOnProgress?: string | RequestToFileProgressCallback): Promise<IRequestToFileResult> {
		const onProgress = typeof progressRequestIdOrOnProgress === 'function' ? progressRequestIdOrOnProgress : undefined;
		const { proxyUrl, strictSSL, noProxy } = this;

		let shellEnv: typeof process.env | undefined = undefined;
		try {
			shellEnv = await getResolvedShellEnv(this.configurationService, this.logService, this.environmentService.args, process.env);
		} catch (error) {
			if (!this.shellEnvErrorLogged) {
				this.shellEnvErrorLogged = true;
				this.logService.error(`resolving shell environment failed`, getErrorMessage(error));
			}
		}

		const env = { ...process.env, ...shellEnv };
		const agent = options.agent ? options.agent : await getProxyAgent(options.url || '', env, { proxyUrl, strictSSL, noProxy });
		options.agent = agent;
		options.strictSSL = strictSSL;

		// Only when the request actually goes THROUGH the proxy. A bypassed request (loopback, LAN, or a
		// no_proxy match) would otherwise hand the user's proxy credentials to a server that is not the proxy.
		if (this.authorization && agent) {
			options.headers = {
				...(options.headers || {}),
				'Proxy-Authorization': this.authorization
			};
		}

		// Try a multi-connection, resumable ranged download first (much faster for large model files on links
		// where a single stream is throughput-limited, and able to continue a stopped/crashed download instead
		// of restarting). It only engages for large GETs on servers that advertise byte ranges: when ranges are
		// NOT supported it returns undefined and we fall through to the original single-stream download, so
		// behaviour never regresses. A real mid-download FAILURE is propagated (not silently restarted from 0):
		// the partial is preserved on disk so the caller can resume it. macOS Apple Silicon uses the bundled
		// hf_xet path instead (in the model download service), so this mainly benefits Windows / Intel Mac / Linux.
		if ((options.type ?? 'GET') === 'GET') {
			const parallel = await nodeParallelRequestToFile(options, destinationFilePath, token, onProgress);
			if (parallel) {
				return parallel;
			}
			this.logService.info(`[requestToFile] ranged/resumable download unavailable for ${options.url} (server did not honour byte ranges); using single stream.`);
		}

		return nodeRequestToFile(options, destinationFilePath, token, onProgress);
	}

	async resolveProxy(url: string): Promise<string | undefined> {
		return undefined; // currently not implemented in node
	}

	async lookupAuthorization(authInfo: AuthInfo): Promise<Credentials | undefined> {
		return undefined; // currently not implemented in node
	}

	async lookupKerberosAuthorization(urlStr: string): Promise<string | undefined> {
		try {
			const spnConfig = this.getConfigValue<string>('http.proxyKerberosServicePrincipal');
			const response = await lookupKerberosAuthorization(urlStr, spnConfig, this.logService, 'RequestService#lookupKerberosAuthorization');
			return 'Negotiate ' + response;
		} catch (err) {
			this.logService.debug('RequestService#lookupKerberosAuthorization Kerberos authentication failed', err);
			return undefined;
		}
	}

	async loadCertificates(): Promise<string[]> {
		const proxyAgent = await import('@vscode/proxy-agent');
		return proxyAgent.loadSystemCertificates({
			loadSystemCertificatesFromNode: () => this.getConfigValue<boolean>('http.systemCertificatesNode', systemCertificatesNodeDefault),
			log: this.logService,
		});
	}

	private getConfigValue<T>(key: string, fallback?: T): T | undefined {
		if (this.machine === 'remote') {
			return this.configurationService.getValue<T>(key);
		}
		const values = this.configurationService.inspect<T>(key);
		return values.userLocalValue ?? values.defaultValue ?? fallback;
	}
}

export async function lookupKerberosAuthorization(urlStr: string, spnConfig: string | undefined, logService: ILogService, logPrefix: string) {
	const importKerberos = await import('kerberos');
	const kerberos = importKerberos.default || importKerberos;
	const url = new URL(urlStr);
	const spn = spnConfig
		|| (process.platform === 'win32' ? `HTTP/${url.hostname}` : `HTTP@${url.hostname}`);
	logService.debug(`${logPrefix} Kerberos authentication lookup`, `proxyURL:${url}`, `spn:${spn}`);
	const client = await kerberos.initializeClient(spn);
	return client.step('');
}

async function getNodeRequest(options: IRequestOptions): Promise<IRawRequestFunction> {
	const endpoint = parseUrl(options.url!);
	const module = endpoint.protocol === 'https:' ? await import('https') : await import('http');

	return module.request;
}

export async function nodeRequest(options: NodeRequestOptions, token: CancellationToken): Promise<IRequestContext> {
	return Promises.withAsyncBody<IRequestContext>(async (resolve, reject) => {
		const endpoint = parseUrl(options.url!);
		const rawRequest = options.getRawRequest
			? options.getRawRequest(options)
			: await getNodeRequest(options);

		const opts: https.RequestOptions & { cache?: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached' } = {
			hostname: endpoint.hostname,
			port: endpoint.port ? parseInt(endpoint.port) : (endpoint.protocol === 'https:' ? 443 : 80),
			protocol: endpoint.protocol,
			path: endpoint.path,
			method: options.type || 'GET',
			headers: options.headers,
			agent: options.agent,
			rejectUnauthorized: isBoolean(options.strictSSL) ? options.strictSSL : true
		};

		if (options.user && options.password) {
			opts.auth = options.user + ':' + options.password;
		}

		if (options.disableCache) {
			opts.cache = 'no-store';
		}

		const req = rawRequest(opts, (res: http.IncomingMessage) => {
			const followRedirects: number = isNumber(options.followRedirects) ? options.followRedirects : 3;
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && followRedirects > 0 && res.headers['location']) {
				nodeRequest({
					...options,
					url: res.headers['location'],
					followRedirects: followRedirects - 1
				}, token).then(resolve, reject);
			} else {
				let stream: streams.ReadableStreamEvents<Uint8Array> = res;

				// Responses from Electron net module should be treated as response
				// from browser, which will apply gzip filter and decompress the response
				// using zlib before passing the result to us. Following step can be bypassed
				// in this case and proceed further.
				// Refs https://source.chromium.org/chromium/chromium/src/+/main:net/url_request/url_request_http_job.cc;l=1266-1318
				if (!options.isChromiumNetwork && res.headers['content-encoding'] === 'gzip') {
					stream = res.pipe(createGunzip());
				}

				resolve({ res, stream: streamToBufferReadableStream(stream) } satisfies IRequestContext);
			}
		});

		req.on('error', reject);

		// Handle timeout
		if (options.timeout) {
			// Chromium network requests do not support the `timeout` option
			if (options.isChromiumNetwork) {
				// Use Node's setTimeout for Chromium network requests
				const timeout = setTimeout(() => {
					req.abort();
					reject(new Error(`Request timeout after ${options.timeout}ms`));
				}, options.timeout);

				// Clear timeout when request completes
				req.on('response', () => clearTimeout(timeout));
				req.on('error', () => clearTimeout(timeout));
				req.on('abort', () => clearTimeout(timeout));
			} else {
				req.setTimeout(options.timeout);
			}
		}

		// Chromium will abort the request if forbidden headers are set.
		// Ref https://source.chromium.org/chromium/chromium/src/+/main:services/network/public/cpp/header_util.cc;l=14-48;
		// for additional context.
		if (options.isChromiumNetwork) {
			req.removeHeader('Content-Length');
		}

		if (options.data) {
			if (typeof options.data === 'string') {
				req.write(options.data);
			}
		}

		req.end();

		token.onCancellationRequested(() => {
			req.abort();

			reject(new CancellationError());
		});
	});
}

export type RequestToFileProgressCallback = (bytesReceived: number, contentLength: number | undefined) => void;

/**
 * Performs an HTTP request and pipes the response body directly to a file.
 * Avoids loading the entire response into memory (for large downloads).
 * Optionally reports progress via onProgress(bytesReceived, contentLength).
 */
export async function nodeRequestToFile(
	options: NodeRequestOptions,
	destinationFilePath: string,
	token: CancellationToken,
	onProgress?: RequestToFileProgressCallback
): Promise<IRequestToFileResult> {
	return Promises.withAsyncBody<IRequestToFileResult>(async (resolve, reject) => {
		const endpoint = parseUrl(options.url!);
		const rawRequest = options.getRawRequest
			? options.getRawRequest(options)
			: await getNodeRequest(options);

		const opts: https.RequestOptions & { cache?: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached' } = {
			hostname: endpoint.hostname,
			port: endpoint.port ? parseInt(endpoint.port) : (endpoint.protocol === 'https:' ? 443 : 80),
			protocol: endpoint.protocol,
			path: endpoint.path,
			method: options.type || 'GET',
			headers: options.headers,
			agent: options.agent,
			rejectUnauthorized: isBoolean(options.strictSSL) ? options.strictSSL : true
		};

		if (options.user && options.password) {
			opts.auth = options.user + ':' + options.password;
		}

		if (options.disableCache) {
			opts.cache = 'no-store';
		}

		const req = rawRequest(opts, (res: http.IncomingMessage) => {
			const followRedirects: number = isNumber(options.followRedirects) ? options.followRedirects : 3;
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && followRedirects > 0 && res.headers['location']) {
				nodeRequestToFile(
					{ ...options, url: res.headers['location'], followRedirects: followRedirects - 1 },
					destinationFilePath,
					token,
					onProgress
				).then(resolve, reject);
				return;
			}

			let stream: NodeJS.ReadableStream = res;
			if (!options.isChromiumNetwork && res.headers['content-encoding'] === 'gzip') {
				stream = res.pipe(createGunzip());
			}

			const contentLengthHeader = res.headers['content-length'];
			const contentLength = contentLengthHeader !== undefined ? parseInt(contentLengthHeader, 10) : undefined;
			let bytesReceived = 0;
			if (onProgress) {
				stream.on('data', (chunk: Buffer | Uint8Array) => {
					bytesReceived += chunk.length;
					onProgress(bytesReceived, Number.isNaN(contentLength as number) ? undefined : contentLength);
				});
			}

			const fileStream = fs.createWriteStream(destinationFilePath);
			stream.pipe(fileStream);

			fileStream.on('finish', () => {
				fileStream.close(() => {
					resolve({
						res: { statusCode: res.statusCode, headers: res.headers as IRequestContext['res']['headers'] }
					});
				});
			});
			fileStream.on('error', (err) => {
				res.destroy();
				fs.unlink(destinationFilePath, () => { });
				reject(err);
			});
			stream.on('error', (err) => {
				fileStream.destroy();
				fs.unlink(destinationFilePath, () => { });
				reject(err);
			});
		});

		req.on('error', reject);

		if (options.timeout) {
			if (options.isChromiumNetwork) {
				const timeout = setTimeout(() => {
					req.abort();
					reject(new Error(`Request timeout after ${options.timeout}ms`));
				}, options.timeout);
				req.on('response', () => clearTimeout(timeout));
				req.on('error', () => clearTimeout(timeout));
				req.on('abort', () => clearTimeout(timeout));
			} else {
				req.setTimeout(options.timeout);
			}
		}

		if (options.isChromiumNetwork) {
			req.removeHeader('Content-Length');
		}

		if (options.data && typeof options.data === 'string') {
			req.write(options.data);
		}

		req.end();

		token.onCancellationRequested(() => {
			req.abort();
			reject(new CancellationError());
		});
	});
}

/** Only parallelize downloads at least this large; below it, one stream is already fast enough and the extra probe isn't worth it. */
const PARALLEL_MIN_TOTAL_BYTES = 64 * 1024 * 1024;
/** Number of concurrent range connections. 32 pushes throughput close to hf_xet on higher-bandwidth links while staying under HF's per-client rate limits. */
const PARALLEL_CONNECTIONS = 32;
/** Fixed range size per request. Kept at 16MB (peak memory ~512MB at 32 conns) so existing resume manifests - which record this chunk size - stay valid across the connection-count bump. */
const PARALLEL_CHUNK_BYTES = 16 * 1024 * 1024;
/** Per-range-request retry attempts before the chunk (and the whole download) gives up, so transient drops self-heal. */
const PARALLEL_CHUNK_MAX_ATTEMPTS = 5;
/** Base backoff between chunk retries; grows exponentially with jitter. */
const PARALLEL_CHUNK_RETRY_BASE_MS = 1000;
/** Per-range-request timeout. A range that makes no progress within this window is treated as stuck and retried. */
const PARALLEL_RANGE_TIMEOUT_MS = 120_000;

/** On-disk resume manifest written next to the `.part` file, recording which fixed-size chunks are already fetched. */
interface IParallelDownloadManifest {
	v: 1;
	/** Server ETag at the time the partial was written; a mismatch on resume means the remote changed -> restart. */
	etag: string | undefined;
	/** Full file size in bytes; guards against resuming against a different file. */
	total: number;
	/** Chunk size the `done` indices are measured in; a change (e.g. new app version) invalidates resume. */
	chunk: number;
	/** Indices of fully-downloaded chunks. */
	done: number[];
}

async function readDownloadManifest(manifestPath: string): Promise<IParallelDownloadManifest | undefined> {
	try {
		const raw = await fs.promises.readFile(manifestPath, 'utf8');
		const parsed = JSON.parse(raw) as IParallelDownloadManifest;
		if (parsed && parsed.v === 1 && Array.isArray(parsed.done) && typeof parsed.total === 'number' && typeof parsed.chunk === 'number') {
			return parsed;
		}
	} catch { /* missing or corrupt manifest -> start fresh */ }
	return undefined;
}

/**
 * Downloads a file using multiple concurrent HTTP range requests, writing each range to its correct offset in a
 * `.part` file that is atomically renamed into place on success. Typically several times faster than a single
 * stream on links where one connection is throughput-limited.
 *
 * RESUMABLE + SELF-HEALING:
 * - Progress is tracked in a `<dest>.part.json` manifest of completed chunks. A later call (retry, or a fresh app
 *   session) reuses the existing `.part` and skips the chunks already recorded, so a stopped/crashed download
 *   continues where it left off instead of restarting from 0. Resume is only accepted when the server ETag and
 *   total size still match; otherwise the stale partial is discarded and it starts clean.
 * - Each range request is retried with exponential backoff, and a range that stalls past
 *   {@link PARALLEL_RANGE_TIMEOUT_MS} is aborted and retried, so transient drops / stuck connections recover.
 * - On failure or cancellation the `.part` and its manifest are DELIBERATELY KEPT (not deleted) so the next
 *   attempt resumes. Only an explicit delete by the caller removes them.
 *
 * Returns `undefined` (NOT an error) when the ranged path does not apply - the server doesn't honour byte ranges
 * (no `206`/`Content-Range`), the size is unknown, or the file is small - so the caller falls back to the normal
 * single-stream download.
 *
 * Memory is bounded to about `PARALLEL_CONNECTIONS * PARALLEL_CHUNK_BYTES`: a fixed pool of workers each buffers
 * at most one chunk before writing it positionally.
 */
export async function nodeParallelRequestToFile(
	options: NodeRequestOptions,
	destinationFilePath: string,
	token: CancellationToken,
	onProgress?: RequestToFileProgressCallback
): Promise<IRequestToFileResult | undefined> {
	// Force Node's own https (manual redirect handling) instead of Electron's `net` for the ranged requests:
	// Chromium's stack drops the `Range` header across HuggingFace's cross-origin redirect (huggingface.co ->
	// CDN), so range requests come back as a full `200` and this whole path would (correctly) bail to the slow
	// single-stream download. Node re-issues the redirect ourselves with the header intact and returns `206`.
	// The proxy `agent` set by the caller is preserved, so proxy users still work.
	const rangeOptions: NodeRequestOptions = { ...options, getRawRequest: undefined, isChromiumNetwork: false };

	// Probe with a 1-byte range to learn the total size + ETag and confirm the server (after any redirects) serves
	// ranges. nodeRequest follows redirects and preserves our headers (auth + Range) across them. If the probe
	// itself fails (e.g. a corporate proxy / custom CA that Node's https can't negotiate but Electron's net can),
	// return undefined so the caller falls back to the normal single-stream download instead of hard-failing.
	let probe: IRequestContext;
	try {
		probe = await nodeRequest({ ...rangeOptions, type: 'GET', headers: { ...(options.headers || {}), Range: 'bytes=0-0' } }, token);
	} catch (err) {
		if (token.isCancellationRequested || err instanceof CancellationError) {
			throw err;
		}
		return undefined;
	}
	const probeStatus = probe.res.statusCode ?? 0;
	const contentRange = probe.res.headers['content-range'];
	const etag = typeof probe.res.headers['etag'] === 'string' ? probe.res.headers['etag'] : undefined;
	try { await streamToBuffer(probe.stream); } catch { /* drain the tiny probe body; ignore */ }
	if (probeStatus !== 206 || typeof contentRange !== 'string') {
		return undefined; // ranges not supported -> caller falls back to single stream
	}
	const totalMatch = /\/(\d+)\s*$/.exec(contentRange); // "bytes 0-0/<total>"
	const total = totalMatch ? parseInt(totalMatch[1], 10) : NaN;
	if (!Number.isFinite(total) || total < PARALLEL_MIN_TOTAL_BYTES) {
		return undefined; // unknown or small -> not worth parallelizing
	}

	const partPath = destinationFilePath + '.part';
	const manifestPath = destinationFilePath + '.part.json';
	const totalChunks = Math.ceil(total / PARALLEL_CHUNK_BYTES);

	// Resume: adopt an existing partial only when it clearly belongs to the same remote file (same ETag when
	// known, same size, same chunking). Otherwise wipe it and start clean so we never stitch mismatched bytes.
	const done = new Set<number>();
	const existing = await readDownloadManifest(manifestPath);
	let partExists = false;
	try { partExists = (await fs.promises.stat(partPath)).size === total; } catch { partExists = false; }
	const canResume = !!existing && partExists && existing.total === total && existing.chunk === PARALLEL_CHUNK_BYTES
		&& (existing.etag === undefined || etag === undefined || existing.etag === etag);
	if (canResume) {
		for (const idx of existing!.done) {
			if (idx >= 0 && idx < totalChunks) { done.add(idx); }
		}
	} else {
		try { await fs.promises.unlink(partPath); } catch { /* ignore */ }
		try { await fs.promises.unlink(manifestPath); } catch { /* ignore */ }
	}

	const handle = await fs.promises.open(partPath, canResume ? 'r+' : 'w');
	let received = done.size * PARALLEL_CHUNK_BYTES; // approximate resumed byte count for the progress meter
	let nextChunk = 0;

	// Debounced manifest flush: workers just mark dirty; a single timer serializes writes so concurrent workers
	// never race on the file, and disk churn stays low even with many small chunks.
	let manifestDirty = false;
	let flushing = false;
	const flushManifest = async (): Promise<void> => {
		if (flushing) { manifestDirty = true; return; }
		flushing = true;
		try {
			while (manifestDirty) {
				manifestDirty = false;
				const data: IParallelDownloadManifest = { v: 1, etag, total, chunk: PARALLEL_CHUNK_BYTES, done: [...done] };
				await fs.promises.writeFile(manifestPath, JSON.stringify(data));
			}
		} catch { /* best-effort; a missed manifest write just re-downloads a chunk on resume */ } finally {
			flushing = false;
		}
	};

	try {
		if (!canResume) {
			await handle.truncate(total); // preallocate so concurrent positional writes land correctly
		}

		const worker = async (): Promise<void> => {
			for (; ;) {
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
				const idx = nextChunk++;
				if (idx >= totalChunks) {
					return;
				}
				if (done.has(idx)) {
					continue; // already fetched in a previous run
				}
				const start = idx * PARALLEL_CHUNK_BYTES;
				const end = Math.min(start + PARALLEL_CHUNK_BYTES - 1, total - 1);
				const expected = end - start + 1;

				let attempt = 0;
				for (; ;) {
					if (token.isCancellationRequested) {
						throw new CancellationError();
					}
					try {
						const ctx = await nodeRequest({ ...rangeOptions, type: 'GET', timeout: PARALLEL_RANGE_TIMEOUT_MS, headers: { ...(options.headers || {}), Range: `bytes=${start}-${end}` } }, token);
						// A 200 (range ignored) would hand us the WHOLE file for this chunk - writing that at an
						// offset would corrupt the output, so require an exact 206 partial.
						if (ctx.res.statusCode !== 206) {
							throw new Error(`range request returned ${ctx.res.statusCode ?? 'no status'}`);
						}
						const buffer = await streamToBuffer(ctx.stream);
						if (buffer.byteLength !== expected) {
							throw new Error(`range size mismatch: got ${buffer.byteLength}, expected ${expected}`);
						}
						await handle.write(buffer.buffer, 0, buffer.byteLength, start);
						break;
					} catch (err) {
						if (token.isCancellationRequested || err instanceof CancellationError) {
							throw err;
						}
						if (++attempt >= PARALLEL_CHUNK_MAX_ATTEMPTS) {
							throw err; // exhausted retries -> partial is kept for a later resume
						}
						const backoff = PARALLEL_CHUNK_RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
						await new Promise<void>(resolve => setTimeout(resolve, backoff));
					}
				}

				done.add(idx);
				received += expected;
				manifestDirty = true;
				void flushManifest();
				onProgress?.(Math.min(received, total), total);
			}
		};

		const workers: Promise<void>[] = [];
		for (let i = 0; i < Math.min(PARALLEL_CONNECTIONS, totalChunks); i++) {
			workers.push(worker());
		}
		await Promise.all(workers);

		manifestDirty = true;
		await flushManifest();
		await handle.close();
		await fs.promises.rename(partPath, destinationFilePath);
		try { await fs.promises.unlink(manifestPath); } catch { /* ignore */ }
		return { res: { statusCode: 200, headers: probe.res.headers as IRequestContext['res']['headers'] } };
	} catch (err) {
		// Persist progress and KEEP the partial + manifest so the next attempt resumes from here.
		manifestDirty = true;
		try { await flushManifest(); } catch { /* ignore */ }
		try { await handle.close(); } catch { /* ignore */ }
		throw err;
	}
}
