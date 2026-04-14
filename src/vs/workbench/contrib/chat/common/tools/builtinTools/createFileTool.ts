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
import { VSBuffer } from '../../../../../../base/common/buffer.js';
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

export const CreateFileToolId = 'createFile';

export function createCreateFileToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Path to the file to create (workspace-relative or absolute)'
			},
			contents: {
				type: 'string',
				description: 'Contents to write to the file'
			}
		},
		required: ['path', 'contents']
	};

	return {
		id: CreateFileToolId,
		toolReferenceName: 'createFile',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.newFile.id),
		displayName: localize('tool.createFile.displayName', 'Create new file'),
		userDescription: localize('tool.createFile.userDescription', 'Create a new file with specified contents'),
		modelDescription: 'Create a NEW file only. Fails if the file already exists — do NOT use createFile to edit or overwrite. For existing files, use stringReplace.\n\nUse this tool to: create new source files, config files, new components, test files. Parent directories are created automatically.\n\nCRITICAL: If the path already exists (e.g. you read it with readFile or got "File already exists"), use stringReplace to edit — never createFile. Check with readFile(path) first if unsure.',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		canRequestPreApproval: true,
		alwaysDisplayInputOutput: true
	};
}

interface ICreateFileToolParams {
	path: string;
	contents: string;
}

export class CreateFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ICreateFileToolParams;
		
		try {
			// Resolve path
			let fileUri: URI;
			if (params.path.startsWith('/') || params.path.match(/^[a-zA-Z]:/)) {
				fileUri = URI.file(params.path);
			} else {
				const workspace = this.workspaceService.getWorkspace();
				if (workspace.folders.length === 0) {
					return {
						content: [{ kind: 'text', value: `Error: No workspace folder open. Next: Open a folder (File > Open Folder) and retry, or use an absolute path.` }],
						toolResultError: 'No workspace folder'
					};
				}
				fileUri = URI.joinPath(workspace.folders[0].uri, params.path);
			}

			progress.report({ message: `Creating file ${params.path}...` });

			// Check if file already exists
			try {
				await this.fileService.stat(fileUri);
				return {
					content: [{ kind: 'text', value: `Error: File "${params.path}" already exists. Next: Use modifyFile or stringReplace to edit; use readFile first to get current content.` }],
					toolResultError: 'File already exists'
				};
			} catch {
				// File doesn't exist, which is what we want
			}

			// Create parent directories if needed and write file
			const content = VSBuffer.fromString(params.contents);
			await this.fileService.createFile(fileUri, content, { overwrite: false });

			const lines = params.contents.split('\n').length;
			const size = content.byteLength;

			return {
				content: [{ 
					kind: 'text', 
					value: `Successfully created file "${params.path}" (${lines} lines, ${size} bytes). Proceed to the next step or goal.` 
				}]
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ kind: 'text', value: `Error creating file "${params.path}": ${errorMessage}. Next: Verify path and parent directory exist (listDirectory), or use modifyFile with oldString: "" to create.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		// Return undefined so tool call is shown in UI with input/output; confirmation is handled via canRequestPreApproval when needed
		return undefined;
	}
}
