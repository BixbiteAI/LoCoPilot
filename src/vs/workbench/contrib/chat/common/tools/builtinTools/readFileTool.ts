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

export const ReadFileToolId = 'readFile';

/** Maximum lines allowed in a single read. Files larger than this require offset and limit. */
const READ_FILE_MAX_LINES = 1000;

/** Image extensions: readFile returns image as data part so the agent can use vision. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

function getImageMimeType(ext: string): string {
	return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
}

export function createReadFileToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute or workspace-relative path to the file to read'
			},
			offset: {
				type: 'number',
				description: 'Optional: 1-based line number to start reading from. Use with limit to read a specific line range instead of the full file.'
			},
			limit: {
				type: 'number',
				description: 'Optional: Maximum number of lines to return (capped at 1000 per read). Use with offset to read a specific range.'
			}
		},
		required: ['path']
	};

	return {
		id: ReadFileToolId,
		toolReferenceName: 'readFile',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.file.id),
		displayName: localize('tool.readFile.displayName', 'Read file contents'),
		userDescription: localize('tool.readFile.userDescription', 'Read the contents of a file (raw text for use with edits)'),
		modelDescription: 'Read file contents from the workspace. Returns RAW file text (no line number prefixes) so you can copy it exactly for modifyFile oldString.\n\n**Ways to call:**\n1. **Complete file**: readFile(path) — returns the full file. Use when you need the entire contents (e.g. small config, full module). Files with more than 1000 lines cannot be read in full; the tool returns an error — use (2) for those.\n2. **Specific lines**: readFile(path, offset, limit) — returns only the requested line range. offset = 1-based start line, limit = max lines to return (capped at 1000 per read). Examples: readFile(path, 1, 200) for first 200 lines; readFile(path, 50, 100) for lines 50–149. Use when you need only a section or when the file is large; grep/readLints can give you line numbers.\n\nUse this tool to: examine file contents before edits; copy exact text for modifyFile oldString; read a specific block when you know the line range. Path can be absolute or relative to workspace root.\n\nHandles: text files (raw content); image files (png, jpg, gif, etc. — returns the image for vision so you can describe or analyze it; max 5MB); binary files (returns "[Binary file]"); missing files (clear error); files >1000 lines without offset/limit (error asking you to use offset and limit).',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface IReadFileToolParams {
	path: string;
	offset?: number;
	limit?: number;
}

export class ReadFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IReadFileToolParams;
		
		try {
			// Resolve path (support both absolute and workspace-relative)
			let fileUri: URI;
			if (params.path.startsWith('/') || params.path.match(/^[a-zA-Z]:/)) {
				// Absolute path
				fileUri = URI.file(params.path);
			} else {
				// Workspace-relative path
				const workspace = this.workspaceService.getWorkspace();
				if (workspace.folders.length === 0) {
					return {
						content: [{ kind: 'text', value: `Error: No workspace folder open. Next: Open a folder in the workspace (File > Open Folder) and retry, or use an absolute path.` }],
						toolResultError: 'No workspace folder'
					};
				}
				fileUri = URI.joinPath(workspace.folders[0].uri, params.path);
			}

			progress.report({ message: `Reading ${params.path}...` });

			// Check if file exists
			const stat = await this.fileService.stat(fileUri);
			
			// Check if it's a directory
			if (stat.isDirectory) {
				return {
					content: [{ kind: 'text', value: `Error: "${params.path}" is a directory, not a file. Next: Use listDirectory with path "${params.path}" to see its contents, or readFile with a file path inside it.` }],
					toolResultError: 'Path is a directory'
				};
			}

			// Image files: return text + data part so the agent can inject into a user message for vision
			const ext = fileUri.path.split('.').pop()?.toLowerCase();
			if (ext && IMAGE_EXTENSIONS.includes(ext)) {
				if (stat.size > MAX_IMAGE_SIZE_BYTES) {
					return {
						content: [{ kind: 'text', value: `Image file "${params.path}" is too large (${Math.round(stat.size / 1024)}KB). Max ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB. Next: Describe the image to the user or skip.` }]
					};
				}
				const fileContent = await this.fileService.readFile(fileUri, undefined, token);
				const mimeType = getImageMimeType(ext);
				return {
					content: [
						{ kind: 'text', value: `Image file: ${params.path}. Image attached below for vision — use it to describe or analyze the image.` },
						{ kind: 'data', value: { mimeType, data: fileContent.value } }
					]
				};
			}

			// Read file content (text)
			const fileContent = await this.fileService.readFile(fileUri, undefined, token);
			const content = fileContent.value.toString();

			// Check if binary file
			const isBinary = content.includes('\0');
			if (isBinary) {
				return {
					content: [{ kind: 'text', value: `File "${params.path}" is a binary file (${stat.size} bytes). Next: You cannot edit binary files with modifyFile; skip this file or inform the user.` }]
				};
			}

			// Return raw content (no line numbers) so LLM can copy exactly for modifyFile oldString
			const lines = content.split('\n');
			const totalLines = lines.length;

			// Files over READ_FILE_MAX_LINES require offset and limit; do not send entire file
			const requestedFullFile = params.offset === undefined && params.limit === undefined;
			if (totalLines > READ_FILE_MAX_LINES && requestedFullFile) {
				return {
					content: [{
						kind: 'text',
						value: `Error: File "${params.path}" has ${totalLines} lines (max ${READ_FILE_MAX_LINES} lines per read). Next: Use readFile with offset and limit to read specific lines only. Examples: readFile("${params.path}", offset: 1, limit: 200) for the first 200 lines; readFile("${params.path}", offset: 150, limit: 100) for lines 150-249. Use grep or readLints to find relevant line numbers first if needed.`
					}],
					toolResultError: 'File exceeds max lines; use offset and limit'
				};
			}

			const offset = params.offset ? Math.max(1, params.offset) : 1;
			const requestedLimit = params.limit ?? lines.length;
			const limit = Math.min(requestedLimit, READ_FILE_MAX_LINES);

			const startIndex = offset - 1;
			const endIndex = Math.min(startIndex + limit, lines.length);
			const slice = lines.slice(startIndex, endIndex);
			const result = slice.join('\n');

			// Add file metadata and optional truncation note
			let metadata = `File: ${params.path} (${totalLines} total lines`;
			if (startIndex > 0 || endIndex < totalLines) {
				metadata += `, showing lines ${offset}-${endIndex}`;
			}
			metadata += ')\n\n';

			const truncationNote =
				startIndex > 0
					? `... ${startIndex} lines not shown ...\n`
					: '';
			const truncationFooter =
				endIndex < totalLines
					? `\n... ${totalLines - endIndex} more lines ...`
					: '';

			return {
				content: [{ kind: 'text', value: metadata + truncationNote + result + truncationFooter + '\n\nProceed to the next step or goal.' }]
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ kind: 'text', value: `Error reading file "${params.path}": ${errorMessage}. Next: Verify the path exists (use listDirectory or findFiles), fix the path, or try an absolute path.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		// Read operations don't need confirmation; return undefined so tool call is shown in UI (with input/output from alwaysDisplayInputOutput)
		return undefined;
	}
}
