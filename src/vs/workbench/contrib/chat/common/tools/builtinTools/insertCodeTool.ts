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
import { buildFileLinkInvocationMessage, resolveToolFileUri } from './toolHelpers.js';
import { applyRanges, commitEdits, formatDelta, IEditToolServices, lineCount, rangesToEdits, readContentForEdit, resolvePatch, resolvePathToUri } from './editToolShared.js';

export const InsertCodeToolId = 'insertCode';

export function createInsertCodeToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Path to the EXISTING file to add code to (workspace-relative or absolute).'
			},
			insertAfter: {
				type: 'string',
				description: 'A short UNIQUE existing line copied from readFile; newString is inserted on the line(s) AFTER it. Use exactly one of insertAfter/insertBefore.'
			},
			insertBefore: {
				type: 'string',
				description: 'A short UNIQUE existing line; newString is inserted BEFORE it. Use exactly one of insertAfter/insertBefore.'
			},
			newString: {
				type: 'string',
				description: 'The new code to insert. Do NOT repeat the anchor line here - only the new lines.'
			}
		},
		required: ['path', 'newString']
	};

	return {
		id: InsertCodeToolId,
		toolReferenceName: 'insertCode',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.insert.id),
		displayName: localize('tool.insertCode.displayName', 'Insert code'),
		userDescription: localize('tool.insertCode.userDescription', 'Add code to an existing file next to an anchor line'),
		modelDescription: 'ADD code to an EXISTING file without replacing anything. Params: path, insertAfter (or insertBefore), newString.\n\n' +
			'Set insertAfter to a short UNIQUE existing line copied from readFile, and put ONLY the new code in newString (the anchor line is kept; newString is inserted next to it). Use this to add a new method/function/import - do NOT copy the surrounding block. Use insertBefore to insert above the anchor instead.\n\n' +
			'To CHANGE existing text use editFile; to create a file use createFile.',
		source: ToolDataSource.Internal,
		inputSchema,
		canRequestPreApproval: true,
		alwaysDisplayInputOutput: true
	};
}

interface IInsertCodeParams {
	path: string;
	insertAfter?: string;
	insertBefore?: string;
	newString: string;
}

export class InsertCodeTool implements IToolImpl {

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
		const input = (context.rawInput ?? {}) as Partial<IInsertCodeParams>;
		const path = typeof input.path === 'string' && input.path.trim().length > 0 ? input.path : undefined;
		const newString = typeof input.newString === 'string' ? input.newString : undefined;
		const delta = formatDelta(lineCount(newString), 0);
		if (!path) {
			return newString !== undefined
				? { invocationMessage: localize('insertCode.stream.prepLines', "Preparing insert ({0} lines)", delta) }
				: { invocationMessage: localize('insertCode.stream.prep', "Preparing insert") };
		}
		const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
		const uri = resolveToolFileUri(path, this.workspaceService);
		if (newString === undefined) {
			return { invocationMessage: buildFileLinkInvocationMessage(localize('insertCode.stream.adding', "Adding to {0}"), name, uri) };
		}
		const tmpl = localize('insertCode.stream.addingLines', "Adding to {0} ({1} lines)", '{0}', delta);
		return { invocationMessage: buildFileLinkInvocationMessage(tmpl, name, uri) };
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IInsertCodeParams;
		if (typeof params.newString !== 'string') { params.newString = ''; }

		if (invocation.context) {
			const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
			if (model?.getRequests().at(-1)?.modeInfo?.kind === ChatModeKind.Ask) {
				return { content: [{ kind: 'text', value: `Error: You are in Ask mode. File edits are not allowed. Next: show the code and where it goes in your response, or suggest Agent mode.` }], toolResultError: 'Ask mode: file edits not allowed' };
			}
		}

		const hasAnchor = (typeof params.insertAfter === 'string' && params.insertAfter.length > 0) || (typeof params.insertBefore === 'string' && params.insertBefore.length > 0);
		if (!hasAnchor) {
			return { content: [{ kind: 'text', value: `Error: insertCode needs an anchor - set insertAfter (or insertBefore) to a short unique existing line from the file. Next: readFile "${params.path}", pick an anchor line, and resend.` }], toolResultError: 'Missing anchor' };
		}

		const resolved = resolvePathToUri(params.path, this.workspaceService);
		if (hasKey(resolved, { error: true })) { return resolved.error; }
		const fileUri = resolved.uri;
		const fileName = params.path.split(/[/\\]/).filter(Boolean).pop() ?? params.path;

		try {
			const read = await readContentForEdit(this.services, fileUri);
			if (hasKey(read, { notFound: true })) {
				return { content: [{ kind: 'text', value: `Error: "${params.path}" does not exist. Next: create it with createFile(path, content) first.` }], toolResultError: 'File does not exist' };
			}
			const currentContent = read.content;

			progress.report({ message: buildFileLinkInvocationMessage(localize('insertCode.adding', "Adding to {0}", '{0}'), fileName, fileUri) });

			const patch = resolvePatch(currentContent, { newString: params.newString, insertAfter: params.insertAfter, insertBefore: params.insertBefore }, '');
			if (hasKey(patch, { error: true })) {
				return { content: [{ kind: 'text', value: `Error: ${patch.error} Next: readFile "${params.path}" and copy an exact, unique anchor line.` }], toolResultError: 'Insert failed' };
			}
			if (hasKey(patch, { skip: true })) {
				return { content: [{ kind: 'text', value: `No change needed for "${params.path}" - ${patch.reason}` }] };
			}
			const textEdits = rangesToEdits(currentContent, patch.ranges, patch.replacementFor);
			const newContent = applyRanges(currentContent, patch.ranges, patch.replacementFor);
			const lenNote = patch.lenient ? ' (anchor matched leniently, adjusted for indentation)' : '';
			const addedLines = params.newString.split('\n').length;
			const msg = `Successfully inserted ${addedLines} line(s) into "${params.path}"${lenNote}. Proceed to the next step or goal.`;
			return await commitEdits(this.services, invocation, fileUri, params.path, textEdits, newContent, msg, false);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return { content: [{ kind: 'text', value: `Error inserting into "${params.path}": ${errorMessage}. Next: verify the path and that the file is not locked.` }], toolResultError: errorMessage };
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const path: string | undefined = context.parameters?.path;
		const name = path ? path.split(/[/\\]/).filter(Boolean).pop() : undefined;
		if (!name) { return undefined; }
		const uri = resolveToolFileUri(path, this.workspaceService);
		return {
			invocationMessage: buildFileLinkInvocationMessage(localize('insertCode.invoking', "Adding to {0}", '{0}'), name, uri),
			pastTenseMessage: buildFileLinkInvocationMessage(localize('insertCode.invoked', "Added to {0}", '{0}'), name, uri),
		};
	}
}
