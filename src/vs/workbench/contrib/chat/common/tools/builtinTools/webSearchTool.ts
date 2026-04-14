/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../../base/common/jsonSchema.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { asText, IRequestService } from '../../../../../../platform/request/common/request.js';
import {
	CountTokensCallback,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IPreparedToolInvocation,
	IToolResult,
	ToolDataSource,
	ToolProgress
} from '../languageModelToolsService.js';
import { ChatConfiguration } from '../../constants.js';

export const WebSearchToolId = 'webSearch';

const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
/** DuckDuckGo HTML search (no API key, no expiry, open/free). Returns plain HTML we parse for results. */
const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/';
const MAX_RESULTS_API = 20;
const MAX_FETCH_URLS = 5;
const MAX_CONTENT_LENGTH_PER_URL = 8000;

interface IWebSearchResult {
	title: string;
	url: string;
	description?: string;
}

interface IBraveWebSearchResponse {
	web?: {
		results?: Array<{ title?: string; url?: string; description?: string }>;
	};
	query?: { original?: string };
}

function stripHtmlToText(html: string): string {
	return html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Parse DuckDuckGo HTML search results (no API key). DDG uses links like
 * https://duckduckgo.com/l/?uddg=REAL_URL&rut=... so we extract real URL from uddg param.
 * Handles raw HTML with <a ... href="...uddg=...">Title</a> or markdown-style ## [Title](url).
 */
function parseDuckDuckGoHtml(html: string, maxResults: number): IWebSearchResult[] {
	const results: IWebSearchResult[] = [];
	const seen = new Set<string>();
	// Raw HTML: <a ... href="...uddg=ENCODED_URL..." ...>Title</a>
	const htmlLinkRegex = /<a\s[^>]*href="[^"]*uddg=([^"&]+)[^"]*"[^>]*>([^<]*)<\/a>/gi;
	let m: RegExpExecArray | null;
	while ((m = htmlLinkRegex.exec(html)) !== null && results.length < maxResults) {
		let url: string;
		try {
			url = decodeURIComponent(m[1].replace(/&amp;/g, '&'));
		} catch {
			continue;
		}
		if (!url.startsWith('http')) url = 'https://' + url;
		if (seen.has(url)) continue;
		seen.add(url);
		const title = m[2].trim().replace(/\s+/g, ' ');
		if (!title) continue;
		results.push({ title, url, description: undefined });
	}
	if (results.length > 0) return results;
	// Fallback: markdown-style (e.g. if response was converted)
	const blocks = html.split(/##\s*\[/);
	for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
		const block = blocks[i];
		const closeBracket = block.indexOf(']');
		if (closeBracket === -1) continue;
		const title = block.slice(0, closeBracket).trim();
		const parenStart = block.indexOf('(', closeBracket);
		if (parenStart === -1) continue;
		const uddgMatch = block.slice(parenStart).match(/uddg=([^&\s]+)/);
		if (!uddgMatch) continue;
		let url: string;
		try {
			url = decodeURIComponent(uddgMatch[1].replace(/&amp;/g, '&'));
		} catch {
			continue;
		}
		if (!url.startsWith('http')) url = 'https://' + url;
		if (seen.has(url)) continue;
		seen.add(url);
		const rest = block.slice(closeBracket + 1);
		const snippetMatch = rest.match(/\]\s*\([^)]+\)\s*\n?\s*\[([^\]]+)\]/);
		const snippet = snippetMatch ? snippetMatch[1].trim().replace(/\s+/g, ' ') : undefined;
		results.push({ title: title.replace(/\s+/g, ' ').trim(), url, description: snippet });
	}
	return results;
}

export function createWebSearchToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Search query to find relevant web pages (e.g. "React 19 release notes", "Python asyncio tutorial")'
			},
			maxResults: {
				type: 'number',
				description: 'Optional: Maximum number of search results to return (1-20). Defaults to 10.'
			},
			fetchContents: {
				type: 'boolean',
				description: 'Optional: If true, fetch full page content from the top results (up to 5) and include in the response. Use when you need detailed content; omit for just titles, URLs, and snippets.'
			}
		},
		required: ['query']
	};

	return {
		id: WebSearchToolId,
		toolReferenceName: 'webSearch',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.globe.id),
		displayName: localize('tool.webSearch.displayName', 'Search the web'),
		userDescription: localize('tool.webSearch.userDescription', 'Search the web and optionally fetch content from result URLs'),
		modelDescription: 'Search the web for current information. Returns a list of results with title, URL, and snippet. Use when you need up-to-date docs, tutorials, release notes, or general web information.\n\n**Parameters:**\n- **query** (required): Search query (e.g. "React 19 release notes", "Python asyncio best practices").\n- **maxResults** (optional): Number of results (1-20, default 10).\n- **fetchContents** (optional): If true, fetches full page content from the top results (up to 5) so you get detailed text; use when snippets are not enough. When false, only titles, URLs, and snippets are returned.\n\n**Workflow:** 1) Call webSearch(query) to find relevant links. 2) If you need full page content, call webSearch(query, maxResults, fetchContents: true) or use the fetchWebPage tool (when available) with specific URLs from the results.\n\n**No API key needed:** Web search works out of the box using DuckDuckGo (no key, no expiry). For better rate limits and quality, optionally set chat.webSearch.apiKey (Brave Search API) in Settings; get a free key at https://brave.com/search/api/.',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface IWebSearchToolParams {
	query: string;
	maxResults?: number;
	fetchContents?: boolean;
}

export class WebSearchTool implements IToolImpl {

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IWebSearchToolParams;
		const query = typeof params.query === 'string' ? params.query.trim() : '';
		if (!query) {
			return {
				content: [{ kind: 'text', value: 'Error: No search query provided. Next: Call webSearch with a non-empty query (e.g. webSearch({ query: "React 19 release notes" })).' }],
				toolResultError: 'Empty query'
			};
		}

		const apiKey = this.configurationService.getValue<string>(ChatConfiguration.WebSearchApiKey);
		const useBrave = !!(apiKey && typeof apiKey === 'string' && apiKey.trim() !== '');
		const maxResults = Math.min(MAX_RESULTS_API, Math.max(1, params.maxResults ?? 10));
		const fetchContents = params.fetchContents === true;

		try {
			progress.report({ message: `Searching the web for "${query}"...` });

			let results: IWebSearchResult[];

			if (useBrave) {
				const searchUrl = `${BRAVE_WEB_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${maxResults}`;
				const response = await this.requestService.request(
					{
						type: 'GET',
						url: searchUrl,
						headers: {
							'X-Subscription-Token': apiKey!.trim(),
							'Accept': 'application/json'
						}
					},
					token
				);

				if (response.res.statusCode !== 200) {
					const body = await asText(response) || '';
					return {
						content: [{
							kind: 'text',
							value: `Error: Web search API returned ${response.res.statusCode}. ${body ? body.slice(0, 200) : ''} Next: Check your API key (chat.webSearch.apiKey) and try again.`
						}],
						toolResultError: `API ${response.res.statusCode}`
					};
				}

				const bodyStr = await asText(response) || '{}';
				const data = JSON.parse(bodyStr) as IBraveWebSearchResponse;
				const rawResults = data.web?.results ?? [];
				results = rawResults
					.filter((r): r is { title: string; url: string; description?: string } => !!r?.url && !!r?.title)
					.map(r => ({ title: r.title, url: r.url, description: r.description }));
			} else {
				// No API key: use DuckDuckGo HTML (no key, no expiry, open/free)
				const ddgUrl = `${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(query)}`;
				const response = await this.requestService.request(
					{
						type: 'GET',
						url: ddgUrl,
						headers: {
							'Accept': 'text/html',
							'User-Agent': 'Mozilla/5.0 (compatible; LoCoPilot-WebSearch/1.0)'
						}
					},
					token
				);
				if (response.res.statusCode !== 200) {
					return {
						content: [{
							kind: 'text',
							value: `Error: Web search returned ${response.res.statusCode}. Next: Try again or set chat.webSearch.apiKey (Brave) in Settings for better results.`
						}],
						toolResultError: `HTTP ${response.res.statusCode}`
					};
				}
				const html = await asText(response) || '';
				results = parseDuckDuckGoHtml(html, maxResults);
			}

			if (results.length === 0) {
				return {
					content: [{ kind: 'text', value: `No web results found for "${query}". Next: Try a different or more general query.` }]
				};
			}

			const lines: string[] = [];
			lines.push(`Web search results for "${query}" (${results.length} result${results.length === 1 ? '' : 's'}):\n`);

			const toFetch = fetchContents ? results.slice(0, MAX_FETCH_URLS) : [];
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				lines.push(`${i + 1}. ${r.title}`);
				lines.push(`   URL: ${r.url}`);
				if (r.description) {
					lines.push(`   Snippet: ${r.description}`);
				}
				lines.push('');
			}

			if (toFetch.length > 0) {
				progress.report({ message: 'Fetching content from top results...' });
				for (let i = 0; i < toFetch.length; i++) {
					const r = toFetch[i];
					try {
						const pageResponse = await this.requestService.request(
							{ type: 'GET', url: r.url },
							token
						);
						if (pageResponse.res.statusCode === 200) {
							const html = await asText(pageResponse) || '';
							const text = stripHtmlToText(html);
							const excerpt = text.length > MAX_CONTENT_LENGTH_PER_URL
								? text.slice(0, MAX_CONTENT_LENGTH_PER_URL) + '\n[... truncated]'
								: text;
							lines.push(`--- Content from ${r.url} ---`);
							lines.push(excerpt);
							lines.push('');
						}
					} catch {
						lines.push(`(Could not fetch content from ${r.url})`);
						lines.push('');
					}
				}
			}

			lines.push('Proceed to the next step or goal.');
			return {
				content: [{ kind: 'text', value: lines.join('\n') }]
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{
					kind: 'text',
					value: `Error during web search: ${errorMessage}. Next: Check network and API key (chat.webSearch.apiKey); try a different query.`
				}],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}
