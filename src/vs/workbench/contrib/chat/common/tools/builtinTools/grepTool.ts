/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../../base/common/jsonSchema.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import * as path from '../../../../../../base/common/path.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ISearchService, QueryType, ITextQuery, IFileMatch, ITextSearchMatch, resultIsMatch } from '../../../../../services/search/common/search.js';
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

export const GrepToolId = 'grep';

export function createGrepToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'Regular expression pattern to search for'
			},
			path: {
				type: 'string',
				description: 'Optional: Directory to search in (workspace-relative or absolute). Defaults to workspace root.'
			},
			glob: {
				type: 'string',
				description: 'Optional: File pattern filter (e.g., "*.ts", "*.{js,tsx}"). Limits search to matching files.'
			},
			caseInsensitive: {
				type: 'boolean',
				description: 'Optional: Whether to perform case-insensitive search. Defaults to false.'
			},
			contextLines: {
				type: 'number',
				description: 'Optional: Number of lines of context to show before and after each match (0-5). Defaults to 0. Ignored unless outputMode is "content".'
			},
			outputMode: {
				type: 'string',
				enum: ['content', 'files_with_matches', 'count'],
				description: 'Optional: How to report results. "content" (default) shows matching lines with file:line. "files_with_matches" lists only the file paths that contain a match (cheap; use to locate files before reading). "count" reports the number of matches per file. Defaults to "content".'
			},
			maxResults: {
				type: 'number',
				description: 'Optional: Maximum number of results to return. Defaults to 100.'
			}
		},
		required: ['pattern']
	};

	return {
		id: GrepToolId,
		toolReferenceName: 'grep',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.search.id),
		displayName: localize('tool.grep.displayName', 'Search code with regex'),
		userDescription: localize('tool.grep.userDescription', 'Search for code patterns using regular expressions'),
		modelDescription: 'Search code using regular expressions (ripgrep-style). Find exact text patterns, function names, or complex regex matches.\n\nUse this tool to:\n- Find all occurrences of a function/class/variable\n- Search for TODO comments or specific patterns\n- Locate code that matches a regex\n- Find files containing specific text\n\nBest practices:\n- Use exact strings for simple searches (faster)\n- Use regex for complex patterns\n- Use glob to filter file types: "*.ts", "*.{js,jsx}"\n- Set maxResults to avoid overwhelming output\n- Use contextLines (1-3) to see surrounding code\n- Use outputMode="files_with_matches" to just locate files cheaply, then readFile them\n- Use outputMode="count" to gauge how widespread a pattern is\n\nOutput format (outputMode="content", default):\n- file.ts:LINE: matched line content (context lines are prefixed with "-" instead of ":")\n- Grouped by file for readability\n- Shows total matches found\n\nExamples:\n- Find function: pattern="function myFunc"\n- Find TODOs: pattern="TODO|FIXME"\n- TypeScript only: glob="*.ts"\n- Just the files: pattern="useEffect", outputMode="files_with_matches"',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface IGrepToolParams {
	pattern: string;
	path?: string;
	glob?: string;
	caseInsensitive?: boolean;
	contextLines?: number;
	outputMode?: 'content' | 'files_with_matches' | 'count';
	maxResults?: number;
}

export class GrepTool implements IToolImpl {

	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IGrepToolParams;
		const outputMode = params.outputMode ?? 'content';

		try {
			const workspace = this.workspaceService.getWorkspace();
			if (workspace.folders.length === 0) {
				return {
					content: [{ kind: 'text', value: 'Error: No workspace folder open. Next: Open a folder (File > Open Folder) and retry.' }],
					toolResultError: 'No workspace folder'
				};
			}

			progress.report({ message: `Searching for "${params.pattern}"` });

			// Build search query
			const folderUri = workspace.folders[0].uri;
			const searchPath = params.path
				? (params.path.startsWith('/') ? URI.file(params.path) : URI.joinPath(folderUri, params.path))
				: folderUri;

			const query: ITextQuery = {
				type: QueryType.Text,
				contentPattern: {
					pattern: params.pattern,
					isRegExp: true,
					isCaseSensitive: !params.caseInsensitive,
					isWordMatch: false
				},
				folderQueries: [{
					folder: searchPath,
					excludePattern: [{
						pattern: {
							'**/node_modules/**': true,
							'**/.git/**': true,
							'**/dist/**': true,
							'**/build/**': true,
							'**/*.min.js': true
						}
					}],
					includePattern: params.glob ? { [params.glob]: true } : undefined
				}],
				maxResults: params.maxResults || 100,
				surroundingContext: outputMode === 'content' ? (params.contextLines || 0) : 0
			};

			// Execute search
			const searchResult = await this.searchService.textSearch(query, token);

			if (!searchResult || searchResult.results.length === 0) {
				return {
					content: [{ kind: 'text', value: `No matches found for pattern "${params.pattern}". Next: Try a simpler or different pattern, use caseInsensitive: true, broaden the path, or use findFiles to locate files by name.` }]
				};
			}

			// Format results
			const workspaceRoot = workspace.folders[0].uri.fsPath;
			const results: string[] = [];
			let totalMatches = 0;
			let fileCount = 0;

			for (const fileMatch of searchResult.results as IFileMatch[]) {
				if (!fileMatch.results || fileMatch.results.length === 0) {
					continue;
				}

				const relativePath = path.relative(workspaceRoot, fileMatch.resource.fsPath) || fileMatch.resource.fsPath;
				// Count only real matches (context lines are not matches)
				const matchCount = fileMatch.results.filter(m => resultIsMatch(m)).length;
				totalMatches += matchCount;
				fileCount++;

				if (outputMode === 'files_with_matches') {
					results.push(relativePath);
					continue;
				}
				if (outputMode === 'count') {
					results.push(`${relativePath}: ${matchCount}`);
					continue;
				}

				// content mode (default)
				results.push(`\n${relativePath} (${matchCount} matches):`);
				for (const match of fileMatch.results) {
					if (resultIsMatch(match)) {
						const textMatch = match as ITextSearchMatch;
						const lineNum = textMatch.rangeLocations[0]?.source.startLineNumber ?? 0;
						const lineText = textMatch.previewText.trim();
						// ":" marks a matching line
						results.push(`  ${lineNum}: ${lineText}`);
					} else {
						// ITextSearchContext - "-" marks a surrounding context line
						const lineNum = (match as { lineNumber: number }).lineNumber;
						const lineText = (match as { text: string }).text.trim();
						results.push(`  ${lineNum}- ${lineText}`);
					}
				}
			}

			const summary = outputMode === 'files_with_matches'
				? `Found matches in ${fileCount} files`
				: `Found ${totalMatches} matches in ${fileCount} files`;
			const limitNote = searchResult.limitHit ? `\n\n(Search limit reached at ${params.maxResults || 100} results. Use more specific patterns to narrow results.)` : '';
			const nextHint = '\n\nProceed to the next step or goal.';

			const output = `${summary}${limitNote}\n${results.join('\n')}${nextHint}`;

			return {
				content: [{ kind: 'text', value: output }]
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ kind: 'text', value: `Error searching: ${errorMessage}. Next: Check pattern is valid regex, try a simpler pattern, or use findFiles to search by filename.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		// Read operations don't need confirmation; return undefined so tool call is shown in UI
		return undefined;
	}
}
