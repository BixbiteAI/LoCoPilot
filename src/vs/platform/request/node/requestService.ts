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
	}

	async request(options: NodeRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		const { proxyUrl, strictSSL } = this;

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
		const agent = options.agent ? options.agent : await getProxyAgent(options.url || '', env, { proxyUrl, strictSSL });

		options.agent = agent;
		options.strictSSL = strictSSL;

		if (this.authorization) {
			options.headers = {
				...(options.headers || {}),
				'Proxy-Authorization': this.authorization
			};
		}

		return this.logAndRequest(options, () => nodeRequest(options, token));
	}

	async requestToFile(options: NodeRequestOptions, destinationFilePath: string, token: CancellationToken, progressRequestIdOrOnProgress?: string | RequestToFileProgressCallback): Promise<IRequestToFileResult> {
		const onProgress = typeof progressRequestIdOrOnProgress === 'function' ? progressRequestIdOrOnProgress : undefined;
		const { proxyUrl, strictSSL } = this;

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
		const agent = options.agent ? options.agent : await getProxyAgent(options.url || '', env, { proxyUrl, strictSSL });
		options.agent = agent;
		options.strictSSL = strictSSL;

		if (this.authorization) {
			options.headers = {
				...(options.headers || {}),
				'Proxy-Authorization': this.authorization
			};
		}

		// Try a multi-connection ranged download first (much faster for large model files on links where a
		// single stream is throughput-limited). It only engages for large GETs on servers that advertise byte
		// ranges; anything else - and ANY failure - falls through to the original single-stream download, so
		// behaviour never regresses and the file still downloads. macOS Apple Silicon uses the bundled hf_xet
		// path instead (in the model download service), so in practice this benefits Windows / Intel Mac / Linux.
		if ((options.type ?? 'GET') === 'GET') {
			try {
				const parallel = await nodeParallelRequestToFile(options, destinationFilePath, token, onProgress);
				if (parallel) {
					return parallel;
				}
			} catch (err) {
				if (token.isCancellationRequested) {
					throw err;
				}
				this.logService.warn(`[requestToFile] parallel download failed (${getErrorMessage(err)}); falling back to single stream.`);
			}
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
/** Number of concurrent range connections. 8 saturates most links without tripping HF's per-client rate limits. */
const PARALLEL_CONNECTIONS = 8;
/** Fixed range size per request. Small enough that peak memory (CONNECTIONS x CHUNK) stays bounded (~128MB), and each completion advances progress in visible steps. */
const PARALLEL_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * Downloads a file using multiple concurrent HTTP range requests, writing each range to its correct offset in a
 * `.part` file that is atomically renamed into place on success. This is typically several times faster than a
 * single stream on links where one connection is throughput-limited.
 *
 * Returns `undefined` (NOT an error) when the ranged path does not apply - the server doesn't honour byte ranges
 * (no `206`/`Content-Range`), the size is unknown, or the file is small - so the caller falls back to the normal
 * single-stream download. Throws only on a real failure mid-download (which the caller also turns into a
 * fallback) or on cancellation. On any throw the partial `.part` file is removed, so nothing corrupt is left.
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
	// Probe with a 1-byte range to learn the total size and confirm the server (after any redirects) serves
	// ranges. nodeRequest follows redirects and preserves our headers (auth + Range) across them.
	const probe = await nodeRequest({ ...options, type: 'GET', headers: { ...(options.headers || {}), Range: 'bytes=0-0' } }, token);
	const probeStatus = probe.res.statusCode ?? 0;
	const contentRange = probe.res.headers['content-range'];
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
	const handle = await fs.promises.open(partPath, 'w');
	let received = 0;
	try {
		await handle.truncate(total); // preallocate so concurrent positional writes land correctly
		const totalChunks = Math.ceil(total / PARALLEL_CHUNK_BYTES);
		let nextChunk = 0;

		const worker = async (): Promise<void> => {
			for (; ;) {
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
				const idx = nextChunk++;
				if (idx >= totalChunks) {
					return;
				}
				const start = idx * PARALLEL_CHUNK_BYTES;
				const end = Math.min(start + PARALLEL_CHUNK_BYTES - 1, total - 1);
				const ctx = await nodeRequest({ ...options, type: 'GET', headers: { ...(options.headers || {}), Range: `bytes=${start}-${end}` } }, token);
				// A 200 (range ignored) would hand us the WHOLE file for this chunk - writing that at an offset
				// would corrupt the output, so require an exact 206 partial and bail (to fallback) otherwise.
				if (ctx.res.statusCode !== 206) {
					throw new Error(`range request returned ${ctx.res.statusCode ?? 'no status'}`);
				}
				const buffer = await streamToBuffer(ctx.stream);
				const expected = end - start + 1;
				if (buffer.byteLength !== expected) {
					throw new Error(`range size mismatch: got ${buffer.byteLength}, expected ${expected}`);
				}
				await handle.write(buffer.buffer, 0, buffer.byteLength, start);
				received += buffer.byteLength;
				onProgress?.(received, total);
			}
		};

		const workers: Promise<void>[] = [];
		for (let i = 0; i < Math.min(PARALLEL_CONNECTIONS, totalChunks); i++) {
			workers.push(worker());
		}
		await Promise.all(workers);
		await handle.close();
		await fs.promises.rename(partPath, destinationFilePath);
		return { res: { statusCode: 200, headers: probe.res.headers as IRequestContext['res']['headers'] } };
	} catch (err) {
		try { await handle.close(); } catch { /* ignore */ }
		try { await fs.promises.unlink(partPath); } catch { /* ignore */ }
		throw err;
	}
}
