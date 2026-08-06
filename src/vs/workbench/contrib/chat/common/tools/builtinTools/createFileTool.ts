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
import { READ_FILE_MAX_LINES } from './readFileTool.js';

export const CreateFileToolId = 'createFile';

/**
 * Floor for rewriting a file LARGER than readFile's cap, as a fraction of the current size.
 *
 * Such a file cannot have been read in one call, so a rewrite is only safe if the model actually
 * paged through it. There is no read-tracking to prove that, but the failure mode is size-correlated:
 * a model that only saw the first READ_FILE_MAX_LINES of a 3000-line file emits roughly that many
 * lines back, not 2700+. So "came back at nearly the original size" is decent evidence it saw the
 * whole thing, and refusing a 3000-line generation outright wastes the most expensive output there is.
 *
 * One-sided on purpose: truncation only ever makes the file SHORTER, so there is no upper bound - a
 * rewrite that grows the file is not a partial-read reconstruction.
 */
const LARGE_FILE_SHRINK_FLOOR = 0.9;

/**
 * Below this fraction of the original, a replacement is called out in the tool result. Files within
 * readFile's cap are replaced unconditionally (the model could have read all of it, and the edit
 * lands in the diff/checkpoint path), but a big drop is worth surfacing so an accidentally truncated
 * rewrite gets noticed on the next turn instead of never.
 */
const NOTABLE_SHRINK_RATIO = 0.75;

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
				description: 'The FULL contents of the file. If the file already exists this REPLACES all of it, so send the complete finished file, never a fragment.'
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
		modelDescription: 'Write a WHOLE file. Params: path, content. There is no overwrite/confirm flag.\n\n' +
			'- Create a new file: pass path + content (parent folders are created automatically - no mkdir step).\n' +
			'- If the file ALREADY EXISTS this replaces it entirely, in the same call - do not check first, and do not resend anything to confirm. content must therefore be the COMPLETE finished file, never a fragment or a "..." placeholder.\n' +
			`- Best for files you can read in FULL (under ${READ_FILE_MAX_LINES} lines). Rewriting a file larger than that is accepted only if your content is about the same size or bigger; content much shorter than the original is refused, because you cannot have read it all and the missing lines would be silently deleted.\n` +
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
	/**
	 * Accepted and ignored. Both used to be gates: overwrite confirmed "yes, really replace it" and
	 * force waived the shrink guard. Neither told the tool anything it could not work out itself, and
	 * a model that omitted one paid a whole extra turn re-sending the entire file body to add a
	 * boolean - the single most expensive round trip in the tool set. Still declared (though no longer
	 * in the schema) so models that learned to send them are not punished for it.
	 */
	overwrite?: boolean;
	force?: boolean;
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
			// Something is there but unreadable: never fall through to the write. Whether this is a
			// create or a full replacement depends on the current content, and without it a "create"
			// would silently become a wholesale overwrite of a file that was never read.
			if (hasKey(read, { readError: true })) {
				return { content: [{ kind: 'text', value: `Error: "${params.path}" could not be read (${read.readError}), so it cannot be safely written - if a file is already there, writing now would replace contents you have not seen. Nothing was written. Next: check the path with listDirectory, and that it is not a directory, locked, or lacking permission.` }], toolResultError: read.readError };
			}
			const fileExists = hasKey(read, { content: true });
			const currentContent = fileExists ? read.content : '';

			if (!fileExists) {
				// Guard the "creating a directory as a file" mistake: empty, extension-less, unknown name.
				const lastSegment = params.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
				if (!lastSegment.includes('.') && params.content.trim().length === 0 && !KNOWN_EXTENSIONLESS.has(lastSegment.toLowerCase())) {
					return { content: [{ kind: 'text', value: `Error: Refusing to create empty file "${params.path}" - no extension and no content looks like a directory. Next: write the real file (e.g. "${params.path}/index.html") with contents.` }], toolResultError: 'Directory-like empty file refused' };
				}
				progress.report({ message: buildFileLinkInvocationMessage(localize('createFile.creating', "Creating file {0}", '{0}'), fileName, fileUri) });
				const lines = params.content.split('\n').length;
				const createdMessage = `Successfully created file "${params.path}" (${lines} lines). Proceed to the next step or goal.`;

				// A brand-new file goes through the chat editing session like every other edit. It was writing
				// straight to disk instead, on the grounds that a new file "has nothing to diff against" - but
				// the session is not only about the diff. Handing it a textEdit for a path that does not exist
				// makes it create the entry with ChatEditKind.Created, which sets `createdInRequestId`, and THAT
				// is what makes the file undoable: rejecting or restoring past that request DELETES the file
				// (chatEditingModifiedDocumentEntry._doReject) instead of leaving an orphan behind. It also
				// records a FileOperationType.Create in the checkpoint timeline, so the file becomes part of the
				// request's changed-file set rather than being invisible to review and restore.
				//
				// Notebooks stay on the direct write: a not-yet-existing .ipynb has no notebook model yet, so
				// commitEdits cannot detect it is a notebook and would push plain text edits at it.
				if (!this.notebookService.hasSupportedNotebooks(fileUri)) {
					const insertAtStart = [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: params.content }];
					return await commitEdits(this.services, invocation, fileUri, params.path, insertAtStart, params.content, createdMessage, true);
				}
				await this.fileService.createFile(fileUri, VSBuffer.fromString(params.content), { overwrite: false });
				revealInEditor(this.editorService, fileUri);
				const lintFailure = await getLintFailureAfterEdit(this.markerService, fileUri, params.path);
				return lintFailure ?? { content: [{ kind: 'text', value: createdMessage }] };
			}

			// --- File exists: replace it. There is no confirmation flag by design - "does this file
			// exist" is already known here, so a flag saying so carried no information and cost a full
			// round trip (re-sending the whole file body) whenever the model left it out.
			const currentLines = currentContent.split('\n').length;
			const newLines = params.content.split('\n').length;

			// A file over readFile's cap cannot have been read in one call, so a rewrite is either the
			// result of paging through it properly or a reconstruction from the part that was read. Those
			// two look very different in size: gate on the shrink only (growth is never truncation).
			if (currentLines > READ_FILE_MAX_LINES
				&& (newLines < currentLines * LARGE_FILE_SHRINK_FLOOR || params.content.length < currentContent.length * LARGE_FILE_SHRINK_FLOOR)) {
				return {
					content: [{ kind: 'text', value: `Error: "${params.path}" has ${currentLines} lines - more than readFile returns in one call (${READ_FILE_MAX_LINES}) - and your replacement is only ${newLines} lines, well short of it. That means parts of the file you never read would be deleted. Next: do NOT resend this as a whole-file write. Use outline "${params.path}" (or grep) to locate the sections to change, readFile(offset, limit) to read each one, then editFile with edits[] to change them - working through the file in batches.` }],
					toolResultError: 'Large-file rewrite refused (content much shorter than original)'
				};
			}

			progress.report({ message: buildFileLinkInvocationMessage(localize('createFile.overwriting', "Replacing entire file {0}", '{0}'), fileName, fileUri) });
			const existingLines = currentContent.split('\n');
			const endLine = existingLines.length || 1;
			const lastLine = existingLines[existingLines.length - 1] ?? '';
			const fullRange = { startLineNumber: 1, startColumn: 1, endLineNumber: endLine, endColumn: lastLine.length + 1 };
			const textEdits = [{ range: fullRange, text: params.content }];
			// Nothing blocks a shrink within readFile's cap (the model could have read the whole file, and
			// the edit lands in the diff/checkpoint path) - but say it out loud, so a rewrite that came back
			// accidentally truncated is visible on the next turn rather than silently accepted.
			const shrank = params.content.length < currentContent.length * NOTABLE_SHRINK_RATIO;
			const summary = `Successfully replaced the ENTIRE existing file "${params.path}" (was ${currentLines} lines, now ${newLines}).`;
			const message = shrank
				? `${summary} This removed most of the previous contents. If that was intended, proceed. If your content was accidentally incomplete, fix it NOW: readFile "${params.path}" and restore the parts that should still be there.`
				: `${summary} Proceed to the next step or goal.`;
			return await commitEdits(this.services, invocation, fileUri, params.path, textEdits, params.content, message, false);
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
