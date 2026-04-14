/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { URI, UriComponents } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { CellUri } from '../../../../notebook/common/notebookCommon.js';
import { INotebookService } from '../../../../notebook/common/notebookService.js';
import { ICodeMapperService } from '../../editing/chatCodeMapperService.js';
import { ChatModel } from '../../model/chatModel.js';
import { IChatService } from '../../chatService/chatService.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolInvocationPresentation, ToolProgress } from '../languageModelToolsService.js';

export const ExtensionEditToolId = 'editFile';
export const InternalEditToolId = 'editFile_internal';
export const EditToolData: IToolData = {
	id: InternalEditToolId,
	displayName: '', // not used
	modelDescription: '', // Not used
	source: ToolDataSource.Internal,
};

export interface EditToolParams {
	uri: UriComponents;
	explanation: string;
	code: string;
}

export class EditTool implements IToolImpl {

	constructor(
		@IChatService private readonly chatService: IChatService,
		@ICodeMapperService private readonly codeMapperService: ICodeMapperService,
		@INotebookService private readonly notebookService: INotebookService,
	) { }

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		if (!invocation.context) {
			return {
				content: [{ kind: 'text', value: 'Error: This tool must be called from within a chat session. Next: Ensure you are invoking from an active chat with editing context.' }],
				toolResultError: 'Missing context'
			};
		}

		const parameters = invocation.parameters as EditToolParams;
		const fileUri = URI.revive(parameters.uri);
		const uri = CellUri.parse(fileUri)?.notebook || fileUri;

		const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel;
		const request = model.getRequests().at(-1)!;

		// Use a single undo stop id for this edit block so the editing session can correlate
		// the edit group with the undo stop and show diff colors, keep/undo, and "1 of n".
		const undoStopId = generateUuid();

		model.acceptResponseProgress(request, {
			kind: 'markdownContent',
			content: new MarkdownString('\n````\n')
		});
		model.acceptResponseProgress(request, {
			kind: 'codeblockUri',
			uri,
			isEdit: true,
			undoStopId
		});
		model.acceptResponseProgress(request, {
			kind: 'markdownContent',
			content: new MarkdownString('\n````\n')
		});
		// Signal start.
		if (this.notebookService.hasSupportedNotebooks(uri) && (this.notebookService.getNotebookTextModel(uri))) {
			model.acceptResponseProgress(request, {
				kind: 'notebookEdit',
				edits: [],
				uri
			});
		} else {
			model.acceptResponseProgress(request, {
				kind: 'textEdit',
				edits: [],
				uri
			});
		}

		const editSession = model.editingSession;
		if (!editSession) {
			return {
				content: [{ kind: 'text', value: 'Error: This tool must be called from within an editing session. Next: Start a chat in agent/edit mode with editing enabled, or use modifyFile for file edits.' }],
				toolResultError: 'No editing session'
			};
		}

		const result = await this.codeMapperService.mapCode({
			codeBlocks: [{ code: parameters.code, resource: uri, markdownBeforeBlock: parameters.explanation }],
			location: 'tool',
			chatRequestId: invocation.chatRequestId,
			chatRequestModel: invocation.modelId,
			chatSessionResource: invocation.context.sessionResource,
		}, {
			textEdit: (target, edits) => {
				model.acceptResponseProgress(request, { kind: 'textEdit', uri: target, edits });
			},
			notebookEdit(target, edits) {
				model.acceptResponseProgress(request, { kind: 'notebookEdit', uri: target, edits });
			},
		}, token);

		// Signal end.
		if (this.notebookService.hasSupportedNotebooks(uri) && (this.notebookService.getNotebookTextModel(uri))) {
			model.acceptResponseProgress(request, { kind: 'notebookEdit', uri, edits: [], done: true });
		} else {
			model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [], done: true });
		}

		if (result?.errorMessage) {
			return {
				content: [{ kind: 'text', value: `Error: ${result.errorMessage}. Next: Fix the code mapping (ensure code blocks reference valid locations), or use modifyFile with readFile for direct string edits.` }],
				toolResultError: result.errorMessage
			};
		}

		let dispose: IDisposable;
		await new Promise((resolve) => {
			// The file will not be modified until the first edits start streaming in,
			// so wait until we see that it _was_ modified before waiting for it to be done.
			let wasFileBeingModified = false;

			dispose = autorun((r) => {

				const entries = editSession.entries.read(r);
				const currentFile = entries?.find((e) => e.modifiedURI.toString() === uri.toString());
				if (currentFile) {
					if (currentFile.isCurrentlyBeingModifiedBy.read(r)) {
						wasFileBeingModified = true;
					} else if (wasFileBeingModified) {
						resolve(true);
					}
				}
			});
		}).finally(() => {
			dispose.dispose();
		});

		return {
			content: [{ kind: 'text', value: 'The file was edited successfully. Proceed to the next step or goal.' }]
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return {
			presentation: ToolInvocationPresentation.Hidden
		};
	}
}
