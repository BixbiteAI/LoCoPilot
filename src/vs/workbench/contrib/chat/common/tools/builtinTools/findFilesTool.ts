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
import { ISearchService, QueryType, IFileQuery, IFileMatch } from '../../../../../services/search/common/search.js';
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

export const FindFilesToolId = 'findFiles';

export function createFindFilesToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.test.js", "**/config.json")'
			},
			targetDirectory: {
				type: 'string',
				description: 'Optional: Directory to search in (workspace-relative or absolute). Defaults to workspace root.'
			},
			maxResults: {
				type: 'number',
				description: 'Optional: Maximum number of files to return. Defaults to 100.'
			}
		},
		required: ['pattern']
	};

	return {
		id: FindFilesToolId,
		toolReferenceName: 'findFiles',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.fileCode.id),
		displayName: localize('tool.findFiles.displayName', 'Find files by pattern'),
		userDescription: localize('tool.findFiles.userDescription', 'Find files using glob patterns'),
		modelDescription: 'Find files in the workspace using glob patterns. Quickly locate files by name patterns.\n\nUse this tool to:\n- Find all files of a specific type\n- Locate config files (package.json, tsconfig.json, etc.)\n- Find test files\n- Search for files with specific names\n\nGlob pattern syntax:\n- ** matches any directory (recursive)\n- * matches any characters in filename\n- ? matches single character\n- {a,b} matches a or b\n- [0-9] matches any digit\n\nBest practices:\n- Use ** for recursive search: "**/*.ts"\n- Combine patterns: "**/*.{js,ts}"\n- Specific paths: "src/**/*.test.ts"\n- Set maxResults to limit output\n\nExamples:\n- All TypeScript: "**/*.ts"\n- Test files: "**/*.test.js"\n- Config files: "**/tsconfig.json"\n- Component files: "src/components/**/*.tsx"',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface IFindFilesToolParams {
	pattern: string;
	targetDirectory?: string;
	maxResults?: number;
}

export class FindFilesTool implements IToolImpl {

	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IFindFilesToolParams;
		
		try {
			const workspace = this.workspaceService.getWorkspace();
			if (workspace.folders.length === 0) {
				return {
					content: [{ kind: 'text', value: 'Error: No workspace folder open. Next: Open a folder (File > Open Folder) and retry.' }],
					toolResultError: 'No workspace folder'
				};
			}

			progress.report({ message: `Finding files matching "${params.pattern}"...` });

			// Build search query
			const folderUri = workspace.folders[0].uri;
			const searchPath = params.targetDirectory 
				? (params.targetDirectory.startsWith('/') ? URI.file(params.targetDirectory) : URI.joinPath(folderUri, params.targetDirectory))
				: folderUri;

			const query: IFileQuery = {
				type: QueryType.File,
				filePattern: params.pattern,
				folderQueries: [{
					folder: searchPath,
					excludePattern: [{
						pattern: {
							'**/node_modules/**': true,
							'**/.git/**': true,
							'**/dist/**': true,
							'**/build/**': true,
							'**/.DS_Store': true
						}
					}]
				}],
				maxResults: params.maxResults || 100,
				sortByScore: true
			};

			// Execute search
			const searchResult = await this.searchService.fileSearch(query, token);

			if (!searchResult || searchResult.results.length === 0) {
				return {
					content: [{ kind: 'text', value: `No files found matching pattern "${params.pattern}". Next: Broaden the pattern (e.g. "**/*.ts"), try a different targetDirectory, or use listDirectory to explore.` }]
				};
			}

			// Format results - sort and display relative paths
			const results: string[] = [];
			
			const workspaceRoot = workspace.folders[0].uri.fsPath;
			for (const result of searchResult.results) {
				const fileMatch = result as IFileMatch;
				const relativePath = path.relative(workspaceRoot, fileMatch.resource.fsPath) || fileMatch.resource.fsPath;
				results.push(relativePath);
			}

			// Sort alphabetically for consistency
			results.sort();

			const summary = `Found ${results.length} files matching "${params.pattern}"`;
			const limitNote = searchResult.limitHit ? `\n\n(Limit of ${params.maxResults || 100} files reached. Refine pattern to narrow results.)` : '';
			const nextHint = '\n\nProceed to the next step or goal.';

			const output = `${summary}${limitNote}\n\n${results.map(r => `- ${r}`).join('\n')}${nextHint}`;

			return {
				content: [{ kind: 'text', value: output }]
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ kind: 'text', value: `Error finding files: ${errorMessage}. Next: Check glob pattern syntax (e.g. "**/*.ts"), try targetDirectory, or use listDirectory.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		// Read operations don't need confirmation; return undefined so tool call is shown in UI
		return undefined;
	}
}
