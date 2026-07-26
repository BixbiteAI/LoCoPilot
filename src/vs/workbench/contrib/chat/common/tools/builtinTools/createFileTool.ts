/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../../base/common/jsonSchema.js';
import { hasKey } from '../../../../../../base/common/types.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IMarkerService } from '../../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { ChatModel } from '../../model/chatModel.js';
import { IChatService } from '../../chatService/chatService.js';
import { ChatModeKind } from '../../constants.js';
import { INotebookService } from '../../../../notebook/common/notebookService.js';
import {
	CountTokensCallback,
	IStreamedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolInvocationStreamContext,
	IPreparedToolInvocation,
	IToolResult,
	ToolDataSource,
	ToolProgress
} from '../languageModelToolsService.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { buildFileLinkInvocationMessage, resolveToolFileUri } from './toolHelpers.js';
import { commitEdits, formatDelta, getLintFailureAfterEdit, IEditToolServices, lineCount, readContentForEdit, resolvePathToUri, revealInEditor } from './editToolShared.js';

export const CreateFileToolId = 'createFile';

/** An existing file this long ... */
const SHRINK_GUARD_MIN_LINES = 50;
/** ...overwritten with content under this fraction of its size is likely accidental truncation. */
const SHRINK_GUARD_RATIO = 0.4;

/** Extension-less names that are legitimately created without a dot. */
const KNOWN_EXTENSIONLESS = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'procfile', 'gemfile', 'rakefile', 'caddyfile', 'jenkinsfile', 'vagrantfile', 'authors', 'notice', 'codeowners']);

export function createCreateFileToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Path to the file to write (workspace-relative or absolute). Parent folders are created automatically - never create a directory as a separate step.'
			},
			content: {
				type: 'string',
				description: 'The FULL contents of the file.'
			},
			overwrite: {
				type: 'boolean',
				description: 'Optional: set true to replace an existing file with the whole new content. If the file exists and this is not set, the call is rejected (use editFile for targeted changes instead).'
			}
		},
		required: ['path', 'content']
	};

	return {
		id: CreateFileToolId,
		toolReferenceName: 'createFile',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.newFile.id),
		displayName: localize('tool.createFile.displayName', 'Create file'),
		userDescription: localize('tool.createFile.userDescription', 'Create a new file (or overwrite one) with the given contents'),
		modelDescription: 'Write a WHOLE file. Params: path, content, overwrite?.\n\n' +
			'- Create a new file: pass path + content (parent folders are created automatically - no mkdir step).\n' +
			'- To fully replace an EXISTING file: also pass overwrite: true. Without it, writing over an existing file is rejected.\n' +
			'- For SMALL/targeted changes to an existing file, do NOT use this - use editFile (change text) or insertCode (add code). Rewriting a whole file for a small change is wasteful and error-prone.',
		source: ToolDataSource.Internal,
		inputSchema,
		canRequestPreApproval: true,
		alwaysDisplayInputOutput: true
	};
}

interface ICreateFileParams {
	path: string;
	content: string;
	overwrite?: boolean;
}

export class CreateFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IChatService private readonly chatService: IChatService,
		@INotebookService private readonly notebookService: INotebookService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
	) { }

	private get services(): IEditToolServices {
		return { fileService: this.fileService, chatService: this.chatService, notebookService: this.notebookService, markerService: this.markerService, editorService: this.editorService, modelService: this.modelService };
	}

	async handleToolStream(context: IToolInvocationStreamContext, _token: CancellationToken): Promise<IStreamedToolInvocation | undefined> {
		const input = (context.rawInput ?? {}) as Partial<ICreateFileParams>;
		const path = typeof input.path === 'string' && input.path.trim().length > 0 ? input.path : undefined;
		const content = typeof input.content === 'string' ? input.content : undefined;
		if (!path) {
			return content !== undefined
				? { invocationMessage: localize('createFile.stream.prep', "Preparing file ({0} lines)", formatDelta(lineCount(content), 0)) }
				: { invocationMessage: localize('createFile.stream.prep0', "Preparing file") };
		}
		const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
		const uri = resolveToolFileUri(path, this.workspaceService);
		if (content === undefined) {
			return { invocationMessage: buildFileLinkInvocationMessage(localize('createFile.stream.writing', "Creating {0}"), name, uri) };
		}
		const tmpl = localize('createFile.stream.writingLines', "Creating {0} ({1} lines)", '{0}', formatDelta(lineCount(content), 0));
		return { invocationMessage: buildFileLinkInvocationMessage(tmpl, name, uri) };
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ICreateFileParams;
		if (typeof params.content !== 'string') { params.content = ''; }

		if (invocation.context) {
			const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
			if (model?.getRequests().at(-1)?.modeInfo?.kind === ChatModeKind.Ask) {
				return { content: [{ kind: 'text', value: `Error: You are in Ask mode. File edits are not allowed. Next: provide the file content in your response instead, or suggest Agent mode.` }], toolResultError: 'Ask mode: file edits not allowed' };
			}
		}

		const resolved = resolvePathToUri(params.path, this.workspaceService);
		if (hasKey(resolved, { error: true })) { return resolved.error; }
		const fileUri = resolved.uri;
		const fileName = params.path.split(/[/\\]/).filter(Boolean).pop() ?? params.path;

		try {
			const read = await readContentForEdit(this.services, fileUri);
			const fileExists = !(hasKey(read, { notFound: true }));
			const currentContent = hasKey(read, { content: true }) ? read.content : '';

			if (!fileExists) {
				// Guard the "creating a directory as a file" mistake: empty, extension-less, unknown name.
				const lastSegment = params.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
				if (!lastSegment.includes('.') && params.content.trim().length === 0 && !KNOWN_EXTENSIONLESS.has(lastSegment.toLowerCase())) {
					return { content: [{ kind: 'text', value: `Error: Refusing to create empty file "${params.path}" - no extension and no content looks like a directory. Next: write the real file (e.g. "${params.path}/index.html") with contents.` }], toolResultError: 'Directory-like empty file refused' };
				}
				progress.report({ message: buildFileLinkInvocationMessage(localize('createFile.creating', "Creating file {0}", '{0}'), fileName, fileUri) });
				const lines = params.content.split('\n').length;
				// Write a NEW file straight to disk. Routing a not-yet-existing file through the chat editing
				// session makes it a ModifiedDocumentEntry (in-memory), whose editor-overlay integration throws
				// "Unexpected type" and wedges the session; the file also never lands on disk for the next turn.
				// A brand-new file has nothing to diff against, so a direct write is both correct and safe.
				await this.fileService.createFile(fileUri, VSBuffer.fromString(params.content), { overwrite: false });
				revealInEditor(this.editorService, fileUri);
				const lintFailure = await getLintFailureAfterEdit(this.markerService, fileUri, params.path);
				return lintFailure ?? { content: [{ kind: 'text', value: `Successfully created file "${params.path}" (${lines} lines). Proceed to the next step or goal.` }] };
			}

			// File exists - only allowed with overwrite:true.
			if (!params.overwrite) {
				return { content: [{ kind: 'text', value: `Error: "${params.path}" already exists. Next: to change part of it use editFile (or insertCode to add code); to replace the WHOLE file, resend createFile with overwrite: true.` }], toolResultError: 'File exists' };
			}
			const currentLines = currentContent.split('\n').length;
			if (currentLines >= SHRINK_GUARD_MIN_LINES && params.content.length < currentContent.length * SHRINK_GUARD_RATIO) {
				return { content: [{ kind: 'text', value: `Error: Refusing to overwrite "${params.path}" (${currentLines} lines) with much shorter content (${params.content.split('\n').length} lines) - likely incomplete. Next: use editFile for a partial change, or resend createFile with the COMPLETE content.` }], toolResultError: 'Shrink overwrite refused' };
			}
			progress.report({ message: buildFileLinkInvocationMessage(localize('createFile.overwriting', "Replacing entire file {0}", '{0}'), fileName, fileUri) });
			const lines = currentContent.split('\n');
			const endLine = lines.length || 1;
			const lastLine = lines[lines.length - 1] ?? '';
			const fullRange = { startLineNumber: 1, startColumn: 1, endLineNumber: endLine, endColumn: lastLine.length + 1 };
			const textEdits = [{ range: fullRange, text: params.content }];
			return await commitEdits(this.services, invocation, fileUri, params.path, textEdits, params.content, `Successfully replaced entire file "${params.path}". Proceed to the next step or goal.`, false);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (/exists but is not a directory|not a directory/i.test(msg)) {
				return { content: [{ kind: 'text', value: `Error creating "${params.path}": ${msg}. A parent path component is a FILE, blocking the folder. Next: delete that file (run_in_terminal \`rm <path>\`) then retry.` }], toolResultError: msg };
			}
			return { content: [{ kind: 'text', value: `Error creating "${params.path}": ${msg}. Next: verify the path and that the file is not locked.` }], toolResultError: msg };
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const path: string | undefined = context.parameters?.path;
		const name = path ? path.split(/[/\\]/).filter(Boolean).pop() : undefined;
		if (!name) { return undefined; }
		const uri = resolveToolFileUri(path, this.workspaceService);
		return {
			invocationMessage: buildFileLinkInvocationMessage(localize('createFile.invoking', "Creating {0}", '{0}'), name, uri),
			pastTenseMessage: buildFileLinkInvocationMessage(localize('createFile.invoked', "Created {0}", '{0}'), name, uri),
		};
	}
}
