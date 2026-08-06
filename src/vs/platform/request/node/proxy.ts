/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse as parseUrl, Url } from 'url';
import { isBoolean } from '../../../base/common/types.js';

export type Agent = any;

function getSystemProxyURI(requestURL: Url, env: typeof process.env): string | null {
	if (requestURL.protocol === 'http:') {
		return env.HTTP_PROXY || env.http_proxy || null;
	} else if (requestURL.protocol === 'https:') {
		return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null;
	}

	return null;
}

export interface IOptions {
	proxyUrl?: string;
	strictSSL?: boolean;
	/**
	 * Comma-separated proxy bypass list, in the conventional `no_proxy` syntax. Callers should pass the
	 * `http.noProxy` setting joined with commas, falling back to the `no_proxy`/`NO_PROXY` environment
	 * variables - the same resolution {@link https://github.com/microsoft/vscode Electron's session proxy}
	 * uses in `windowImpl.ts`, so both request paths honour one configuration.
	 */
	noProxy?: string;
}

/** Parses an IPv4 literal into a 32-bit number, or undefined when `host` is not one. */
function parseIPv4(host: string): number | undefined {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) {
		return undefined;
	}
	let value = 0;
	for (let i = 1; i <= 4; i++) {
		const octet = Number(m[i]);
		if (octet > 255) {
			return undefined;
		}
		value = (value * 256) + octet;
	}
	return value >>> 0;
}

/**
 * True for addresses that are, by definition, not reachable through an external proxy: loopback, RFC1918
 * private ranges, and link-local.
 *
 * Sending these to a proxy cannot work - the proxy would resolve them against ITS OWN network, not the
 * user's - so a request to `http://192.168.1.50:8080` either fails confusingly or, worse, hands the full
 * request body to a third party that was never the intended recipient. Chromium already bypasses loopback by
 * default for the Electron request path; this keeps the Node path consistent and extends the same reasoning
 * to the rest of the private space.
 */
function isPrivateOrLoopbackHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1') {
		return true;
	}
	// IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
	if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
		return true;
	}
	const ip = parseIPv4(host);
	if (ip === undefined) {
		return false;
	}
	return (ip >>> 24) === 10                        // 10.0.0.0/8
		|| (ip >>> 24) === 127                       // 127.0.0.0/8 loopback
		|| (ip >>> 20) === ((172 << 4) | 1)          // 172.16.0.0/12
		|| (ip >>> 16) === ((192 << 8) | 168)        // 192.168.0.0/16
		|| (ip >>> 16) === ((169 << 8) | 254);       // 169.254.0.0/16 link-local
}

/** Matches one `no_proxy` entry against the request host/port. Supports `*`, host, `.suffix`, `host:port` and IPv4 CIDR. */
function matchesNoProxyEntry(entry: string, hostname: string, port: number | undefined): boolean {
	let rule = entry.trim().toLowerCase();
	if (!rule) {
		return false;
	}
	if (rule === '*') {
		return true;
	}
	// Optional port suffix: `example.com:8080` only bypasses that port. Skip IPv6 literals, whose colons are
	// part of the address rather than a port separator.
	if (!rule.includes('[') && (rule.match(/:/g) || []).length === 1) {
		const [rulehost, ruleport] = rule.split(':');
		if (/^\d+$/.test(ruleport)) {
			if (port !== undefined && port !== Number(ruleport)) {
				return false;
			}
			rule = rulehost;
		}
	}
	// CIDR, e.g. 192.168.0.0/16
	const slash = rule.indexOf('/');
	if (slash > 0) {
		const bits = Number(rule.slice(slash + 1));
		const base = parseIPv4(rule.slice(0, slash));
		const ip = parseIPv4(hostname);
		if (base !== undefined && ip !== undefined && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
			// A /0 shifts by 32, which JS treats as a no-op shift; handle it as "match everything".
			const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
			return (ip & mask) === (base & mask);
		}
		return false;
	}
	// A leading dot means "subdomains of"; conventionally the bare domain matches too.
	const bare = rule.startsWith('.') ? rule.slice(1) : rule;
	return hostname === bare || hostname.endsWith(`.${bare}`);
}

/**
 * Whether a request must skip the proxy entirely.
 *
 * Without this, an exported `HTTP_PROXY` (which VS Code picks up from the user's resolved shell environment)
 * silently captured EVERY request, including ones to the user's own machine or LAN. `http.noProxy` was already
 * a registered setting and was already applied to Electron's session, so it was reasonable to expect it to
 * work here too - it simply was not read on this path.
 */
export function shouldBypassProxy(rawRequestURL: string, noProxy: string | undefined): boolean {
	const requestURL = parseUrl(rawRequestURL);
	const hostname = (requestURL.hostname || '').toLowerCase();
	if (!hostname) {
		return false;
	}
	if (isPrivateOrLoopbackHost(hostname)) {
		return true;
	}
	if (!noProxy) {
		return false;
	}
	const port = requestURL.port ? Number(requestURL.port) : undefined;
	return noProxy.split(',').some(entry => matchesNoProxyEntry(entry, hostname, port));
}

export async function getProxyAgent(rawRequestURL: string, env: typeof process.env, options: IOptions = {}): Promise<Agent> {
	const requestURL = parseUrl(rawRequestURL);
	const noProxy = options.noProxy || env.no_proxy || env.NO_PROXY || undefined;
	if (shouldBypassProxy(rawRequestURL, noProxy)) {
		return null;
	}
	const proxyURL = options.proxyUrl || getSystemProxyURI(requestURL, env);

	if (!proxyURL) {
		return null;
	}

	const proxyEndpoint = parseUrl(proxyURL);

	if (!/^https?:$/.test(proxyEndpoint.protocol || '')) {
		return null;
	}

	const opts = {
		host: proxyEndpoint.hostname || '',
		port: (proxyEndpoint.port ? +proxyEndpoint.port : 0) || (proxyEndpoint.protocol === 'https' ? 443 : 80),
		auth: proxyEndpoint.auth,
		rejectUnauthorized: isBoolean(options.strictSSL) ? options.strictSSL : true,
	};

	if (requestURL.protocol === 'http:') {
		const { default: mod } = await import('http-proxy-agent');
		return new mod.HttpProxyAgent(proxyURL, opts);
	} else {
		const { default: mod } = await import('https-proxy-agent');
		return new mod.HttpsProxyAgent(proxyURL, opts);
	}
}
