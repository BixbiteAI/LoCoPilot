/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../base/common/jsonSchema.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import {
	CountTokensCallback,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolResult,
	ToolDataSource,
	ToolProgress,
} from '../../common/tools/languageModelToolsService.js';
import { ILoCoPilotRetrievalService } from './retrievalService.js';

export const SemanticSearchToolId = 'semanticSearch';

export function createSemanticSearchToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'A natural-language description of the code you are looking for, e.g. "where JWT tokens are validated" or "the function that parses tool calls".'
			},
			topN: {
				type: 'number',
				description: 'Optional: how many code chunks to return (1-20). Defaults to 8. Use a smaller number for focused lookups, larger to cast a wider net.'
			}
		},
		required: ['query']
	};

	return {
		id: SemanticSearchToolId,
		toolReferenceName: 'semanticSearch',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.searchFuzzy.id),
		displayName: localize('tool.semanticSearch.displayName', 'Semantic code search'),
		userDescription: localize('tool.semanticSearch.userDescription', 'Find code by meaning using a local embedding index'),
		modelDescription: 'Search the codebase by MEANING (semantic / embedding search over a local index), not by exact text. Use this FIRST for any codebase task to find the most relevant files and code regions, then readFile the regions you need.\n\nWhen to use:\n- "Where is authentication handled?" -> finds the auth code even if it never says "authentication".\n- Finding the implementation of a concept/feature when you do not know the exact symbol name.\n- Getting oriented in an unfamiliar repo before editing.\n\nUse grep instead when you know the EXACT string/symbol. Use semanticSearch for conceptual/meaning-based lookups; they complement each other.\n\nReturns up to topN chunks, each with: path:startLine-endLine, the nearest symbol, a similarity score, and the code. After this, use readFile(path, offset, limit) to read the full region before editing.\n\nNote: the index builds in the background. If it is still building or unavailable, fall back to grep/findFiles.',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface ISemanticSearchParams {
	query: string;
	topN?: number;
}

export class SemanticSearchTool implements IToolImpl {

	constructor(
		@ILoCoPilotRetrievalService private readonly retrievalService: ILoCoPilotRetrievalService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ISemanticSearchParams;
		const query = (params.query || '').trim();
		if (!query) {
			return { content: [{ kind: 'text', value: 'Error: query is required. Next: provide a natural-language description of the code you are looking for.' }], toolResultError: 'Empty query' };
		}

		const status = this.retrievalService.getStatus();
		if (status.status === 'disabled') {
			return { content: [{ kind: 'text', value: 'Semantic search is unavailable (no local embedding backend detected). Next: use grep for exact text or findFiles for filenames. (To enable semantic search, run Ollama and `ollama pull nomic-embed-text`.)' }] };
		}

		progress.report({ message: `Semantic search: "${query}"...` });

		let results;
		try {
			results = await this.retrievalService.search(query, params.topN ?? 8, token);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { content: [{ kind: 'text', value: `Error during semantic search: ${msg}. Next: fall back to grep or findFiles.` }], toolResultError: msg };
		}

		if (results.length === 0) {
			if (status.status === 'indexing') {
				return { content: [{ kind: 'text', value: 'The semantic index is still building in the background, so no results yet. Next: use grep/findFiles for now, or retry semanticSearch shortly.' }] };
			}
			return { content: [{ kind: 'text', value: `No semantically similar code found for "${query}". Next: try a different phrasing, or use grep for an exact string / findFiles for a filename.` }] };
		}

		const lines: string[] = [`Found ${results.length} relevant code region(s) for "${query}":`];
		for (const r of results) {
			const crumb = r.symbol ? ` (${r.symbol})` : '';
			lines.push(`\n--- ${r.path}:${r.startLine}-${r.endLine}${crumb} [score ${r.score.toFixed(3)}] ---`);
			lines.push(r.text.length > 1500 ? r.text.slice(0, 1500) + '\n... (truncated; use readFile for the full region)' : r.text);
		}
		lines.push('\n\nProceed to the next step or goal: readFile(path, offset, limit) to read the full region before editing.');

		return { content: [{ kind: 'text', value: lines.join('\n') }] };
	}

	async prepareToolInvocation(): Promise<undefined> {
		return undefined; // read-only, no confirmation
	}
}
