/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../../base/common/jsonSchema.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
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

export const ListDirectoryToolId = 'listDirectory';

export function createListDirectoryToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			targetDirectory: {
				type: 'string',
				description: 'Absolute or workspace-relative path to the directory to list'
			},
			ignoreGlobs: {
				type: 'array',
				description: 'Optional: Array of glob patterns to ignore (e.g., ["node_modules", "*.log"])',
				items: {
					type: 'string'
				}
			}
		},
		required: ['targetDirectory']
	};

	return {
		id: ListDirectoryToolId,
		toolReferenceName: 'listDirectory',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.folder.id),
		displayName: localize('tool.listDirectory.displayName', 'List directory contents'),
		userDescription: localize('tool.listDirectory.userDescription', 'List files and folders in a directory'),
		modelDescription: 'List contents of a directory including files and subdirectories with metadata.\n\nUse this tool to:\n- Explore project structure\n- Find files in a directory\n- Understand folder organization\n- Check if files/folders exist\n\nOutput format:\n- Directories shown with trailing slash: "folder/"\n- Files shown with size: "file.ts (1.2 KB)"\n- Hidden files (starting with .) not shown by default\n\nBest practices:\n- Use to understand project structure before making changes\n- Helps locate configuration files\n- Can filter with ignoreGlobs to exclude patterns',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface IListDirectoryToolParams {
	targetDirectory: string;
	ignoreGlobs?: string[];
}

export class ListDirectoryTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	private matchesIgnorePattern(name: string, patterns: string[]): boolean {
		for (const pattern of patterns) {
			// Simple glob matching (supports * and exact matches)
			if (pattern === name) {
				return true;
			}
			if (pattern.includes('*')) {
				const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
				if (regex.test(name)) {
					return true;
				}
			}
		}
		return false;
	}

	private formatSize(bytes: number): string {
		if (bytes < 1024) {
			return `${bytes} B`;
		} else if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)} KB`;
		} else if (bytes < 1024 * 1024 * 1024) {
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		} else {
			return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
		}
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IListDirectoryToolParams;
		
		try {
			// Resolve path (support both absolute and workspace-relative)
			let dirUri: URI;
			if (params.targetDirectory.startsWith('/') || params.targetDirectory.match(/^[a-zA-Z]:/)) {
				// Absolute path
				dirUri = URI.file(params.targetDirectory);
			} else {
				// Workspace-relative path
				const workspace = this.workspaceService.getWorkspace();
				if (workspace.folders.length === 0) {
					return {
						content: [{ kind: 'text', value: `Error: No workspace folder open. Next: Open a folder (File > Open Folder) and retry, or use an absolute path.` }],
						toolResultError: 'No workspace folder'
					};
				}
				const basePath = params.targetDirectory === '.' || params.targetDirectory === '' 
					? '' 
					: params.targetDirectory;
				dirUri = basePath ? URI.joinPath(workspace.folders[0].uri, basePath) : workspace.folders[0].uri;
			}

			progress.report({ message: `Listing ${params.targetDirectory}...` });

			// Check if directory exists
			const stat = await this.fileService.stat(dirUri);
			
			if (!stat.isDirectory) {
				return {
					content: [{ kind: 'text', value: `Error: "${params.targetDirectory}" is not a directory. Next: Use readFile to read this file, or listDirectory with a parent directory path.` }],
					toolResultError: 'Not a directory'
				};
			}

			// Read directory contents
			const entries = await this.fileService.resolve(dirUri);
			
			if (!entries.children || entries.children.length === 0) {
				return {
					content: [{ kind: 'text', value: `Directory "${params.targetDirectory}" is empty. Next: Try listing a parent directory, or use findFiles to search for files by pattern.` }]
				};
			}

			// Filter and format entries
			const ignorePatterns = params.ignoreGlobs || [];
			const results: string[] = [];
			const directories: string[] = [];
			const files: string[] = [];

			for (const entry of entries.children) {
				const name = entry.name;
				
				// Skip hidden files by default
				if (name.startsWith('.')) {
					continue;
				}

				// Check ignore patterns
				if (this.matchesIgnorePattern(name, ignorePatterns)) {
					continue;
				}

				if (entry.isDirectory) {
					directories.push(`${name}/`);
				} else {
					const size = entry.size !== undefined ? ` (${this.formatSize(entry.size)})` : '';
					files.push(`${name}${size}`);
				}
			}

			// Sort and combine (directories first, then files)
			directories.sort();
			files.sort();
			results.push(...directories, ...files);

			if (results.length === 0) {
				return {
					content: [{ kind: 'text', value: `No visible files in "${params.targetDirectory}" (hidden files/ignored patterns excluded). Next: Try without ignoreGlobs, list a different directory, or use findFiles with a glob pattern.` }]
				};
			}

			const header = `Contents of "${params.targetDirectory}" (${directories.length} directories, ${files.length} files):\n\n`;
			const listing = results.map(item => `- ${item}`).join('\n');

			return {
				content: [{ kind: 'text', value: header + listing + '\n\nProceed to the next step or goal.' }]
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ kind: 'text', value: `Error listing directory "${params.targetDirectory}": ${errorMessage}. Next: Verify the path exists, use workspace-relative path (e.g. "." for root), or try findFiles.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		// Read operations don't need confirmation; return undefined so tool call is shown in UI
		return undefined;
	}
}
