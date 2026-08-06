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
import { applyPatchBatch, applyRanges, commitEdits, formatDelta, IEditPatch, IEditToolServices, lineCount, rangesToEdits, readContentForEdit, resolvePatch, resolvePathToUri, summarizeEditsStream } from './editToolShared.js';

export const EditFileToolId = 'editFile';

export function createEditFileToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Path to the EXISTING file to edit (workspace-relative or absolute).'
			},
			oldString: {
				type: 'string',
				description: 'The exact text to replace (copy it character-for-character from readFile; indentation is matched leniently). For ONE change.'
			},
			newString: {
				type: 'string',
				description: 'The replacement text for oldString. Change only what differs. Use an empty string ("") to DELETE the matched text (whole matched lines are removed, leaving no blank line behind).'
			},
			replaceAll: {
				type: 'boolean',
				description: 'Optional: replace every occurrence of oldString (default false = exactly one match). Works across the WHOLE file at any size, without reading it all first.'
			},
			edits: {
				type: 'array',
				description: 'Optional: apply MULTIPLE changes to this file in ONE atomic call (all apply or none). Use EITHER edits[] OR top-level oldString/newString - never both in the same call. Each item is a REPLACE {oldString, newString, replaceAll?} or an INSERT {insertAfter|insertBefore, newString}. Patches apply IN ORDER, each against the file as the previous patches left it, so they must target separate, non-overlapping places. The file "path" stays top-level - do NOT put path in a patch.',
				items: {
					type: 'object',
					properties: {
						oldString: { type: 'string', description: 'REPLACE: exact text to replace (from readFile). Omit for an insert patch.' },
						newString: { type: 'string', description: 'Replacement text, or the text to insert. Required.' },
						replaceAll: { type: 'boolean', description: 'Optional: replace all occurrences of this oldString.' },
						insertAfter: { type: 'string', description: 'INSERT: a short unique anchor line; newString is inserted AFTER it.' },
						insertBefore: { type: 'string', description: 'INSERT: like insertAfter but newString is inserted BEFORE the anchor line.' }
					},
					required: ['newString']
				}
			}
		},
		required: ['path']
	};

	return {
		id: EditFileToolId,
		toolReferenceName: 'editFile',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.edit.id),
		displayName: localize('tool.editFile.displayName', 'Edit file'),
		userDescription: localize('tool.editFile.userDescription', 'Edit an existing file by replacing text (one change or several at once)'),
		modelDescription: 'Change text in an EXISTING file. Params: path, oldString, newString, replaceAll?, or edits[]. Works on a file of ANY size - it never has to be read in full first.\n\n' +
			'- ONE change: set oldString to the exact text from readFile and newString to its replacement. Change only the lines that differ.\n' +
			'- SEVERAL changes at once (atomic): pass edits: [{oldString, newString} | {insertAfter|insertBefore, newString}, ...]. Applied in order; all must apply or none do. Send EITHER edits[] OR top-level oldString/newString, never both. Keep path at the TOP LEVEL.\n' +
			'- RENAME/replace something everywhere: one call with replaceAll: true. This covers the whole file however large it is - do NOT walk it section by section for this.\n' +
			'- DELETE a block or line range: oldString = the text to remove, newString = "". The whole matched lines are removed.\n' +
			'- To CREATE a file use createFile. To ADD code: a single insert is insertCode; use an insert patch inside edits[] only to mix inserts and replaces in one atomic call.\n' +
			'- On "String not found": readFile and copy the exact current text - never retry the same oldString. If the change may already have been applied, readFile and check before retrying at all.',
		source: ToolDataSource.Internal,
		inputSchema,
		canRequestPreApproval: true,
		alwaysDisplayInputOutput: true
	};
}

interface IEditFileParams {
	path: string;
	oldString?: string;
	newString?: string;
	replaceAll?: boolean;
	edits?: IEditPatch[];
}

export class EditFileTool implements IToolImpl {

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
		const input = (context.rawInput ?? {}) as Partial<IEditFileParams>;
		const path = typeof input.path === 'string' && input.path.trim().length > 0 ? input.path : undefined;

		if (Array.isArray(input.edits)) {
			const { added, removed, withContent } = summarizeEditsStream(input.edits as Array<Partial<IEditPatch>>);
			const delta = formatDelta(added, removed);
			const count = String(withContent);
			if (!path) {
				return { invocationMessage: localize('editFile.stream.editsPrep', "Preparing edits ({0} applied, {1} lines)", count, delta) };
			}
			const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
			const uri = resolveToolFileUri(path, this.workspaceService);
			const tmpl = localize('editFile.stream.editsProgress', "Editing {0} ({1} edits, {2} lines)", '{0}', count, delta);
			return { invocationMessage: buildFileLinkInvocationMessage(tmpl, name, uri) };
		}

		const newString = typeof input.newString === 'string' ? input.newString : undefined;
		const delta = formatDelta(lineCount(newString), lineCount(input.oldString));
		if (!path) {
			return newString !== undefined
				? { invocationMessage: localize('editFile.stream.prepLines', "Preparing edit ({0} lines)", delta) }
				: { invocationMessage: localize('editFile.stream.prep', "Preparing edit") };
		}
		const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
		const uri = resolveToolFileUri(path, this.workspaceService);
		if (newString === undefined) {
			return { invocationMessage: buildFileLinkInvocationMessage(localize('editFile.stream.editing', "Editing {0}"), name, uri) };
		}
		const tmpl = localize('editFile.stream.editingLines', "Editing {0} ({1} lines)", '{0}', delta);
		return { invocationMessage: buildFileLinkInvocationMessage(tmpl, name, uri) };
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IEditFileParams;
		// Forgiving on a MISSING newString: treat it as "" so a lone oldString means "delete that text"
		// (a legitimate edit) instead of erroring. oldString stays strict - an empty oldString is rejected.
		if (typeof params.newString !== 'string') { params.newString = ''; }

		if (invocation.context) {
			const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
			if (model?.getRequests().at(-1)?.modeInfo?.kind === ChatModeKind.Ask) {
				return { content: [{ kind: 'text', value: `Error: You are in Ask mode. File edits are not allowed. Next: provide the old and new snippets in your response, or suggest Agent mode.` }], toolResultError: 'Ask mode: file edits not allowed' };
			}
		}

		const resolved = resolvePathToUri(params.path, this.workspaceService);
		if (hasKey(resolved, { error: true })) { return resolved.error; }
		const fileUri = resolved.uri;
		const fileName = params.path.split(/[/\\]/).filter(Boolean).pop() ?? params.path;

		try {
			const read = await readContentForEdit(this.services, fileUri);
			if (hasKey(read, { readError: true })) {
				return { content: [{ kind: 'text', value: `Error: "${params.path}" exists but could not be read (${read.readError}). Nothing was written. Next: check it is not a directory, locked, or lacking permission - do NOT recreate it with createFile, which would replace contents you have not seen.` }], toolResultError: read.readError };
			}
			if (hasKey(read, { notFound: true })) {
				// The path being wrong is at least as likely as the file being missing, so verify BEFORE
				// suggesting createFile - a typo'd path sent straight to createFile just leaves a stray file.
				return { content: [{ kind: 'text', value: `Error: "${params.path}" does not exist, so there is nothing to edit. Next: check the path first - findFiles or listDirectory to locate the real file, then edit that. Only if the file genuinely should not exist yet, create it with createFile(path, content).` }], toolResultError: 'File does not exist' };
			}
			const currentContent = read.content;

			progress.report({ message: buildFileLinkInvocationMessage(localize('editFile.editing', "Editing {0}", '{0}'), fileName, fileUri) });

			// --- Multi-edit batch --- keep any patch that has a TARGET (oldString or an insert anchor);
			// a missing newString is coerced to "" (delete for a replace patch; an insert with "" is then
			// rejected by resolvePatch, which is correct - there is nothing to insert).
			const editsArray: IEditPatch[] = Array.isArray(params.edits)
				? params.edits
					.filter((e): e is IEditPatch => !!e && (typeof e.oldString === 'string' || typeof e.insertAfter === 'string' || typeof e.insertBefore === 'string'))
					.map(e => ({ ...e, newString: typeof e.newString === 'string' ? e.newString : '' }))
				: [];
			if (Array.isArray(params.edits) && editsArray.length === 0) {
				return { content: [{ kind: 'text', value: `Error: You provided edits[] but no patch was valid. Each patch needs "newString" AND either "oldString" (replace) or "insertAfter"/"insertBefore" (add). Next: resend a well-formed edits[].` }], toolResultError: 'No valid edits' };
			}
			if (editsArray.length > 0) {
				// Both call shapes at once. This used to silently drop the top-level pair and then report
				// "Successfully applied N edit(s)" - a false success for a change that was never made, which
				// is the worst outcome available here: the model believes it landed and moves on. Absorb it
				// when it is merely a duplicate of a patch already in the batch (the common, harmless case);
				// otherwise write nothing and make the model resolve the ambiguity.
				if (typeof params.oldString === 'string' && params.oldString.length > 0) {
					const duplicated = editsArray.some(e => e.oldString === params.oldString && e.newString === params.newString);
					if (!duplicated) {
						return { content: [{ kind: 'text', value: `Error: You sent BOTH a top-level oldString/newString AND edits[] for "${params.path}". Nothing was written, because it is unclear whether the top-level change is a separate edit or a duplicate of one in edits[]. Next: resend ONE call - either put every change in edits[] (including this one), or send the single oldString/newString with no edits[].` }], toolResultError: 'Both single edit and edits[] provided' };
					}
				}
				const batch = applyPatchBatch(currentContent, editsArray);
				if (hasKey(batch, { error: true })) {
					return { content: [{ kind: 'text', value: `Error: ${batch.error} No changes were written (all-or-nothing). Next: readFile "${params.path}" to get the exact current text, fix that patch, and resend the whole edits[] call.` }], toolResultError: 'Multi-edit patch failed' };
				}
				if (batch.finalContent === currentContent) {
					return { content: [{ kind: 'text', value: `No changes needed for "${params.path}" - the requested edit(s) are already present (${batch.skippedCount} skipped). Proceed; do NOT re-apply them.` }] };
				}
				const lines = currentContent.split('\n');
				const fullRange = { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length || 1, endColumn: (lines[lines.length - 1] ?? '').length + 1 };
				const skipNote = batch.skippedCount > 0 ? ` (${batch.skippedCount} already present, skipped)` : '';
				const lenNote = batch.lenientCount > 0 ? ` (${batch.lenientCount} matched leniently)` : '';
				const msg = `Successfully applied ${batch.applied} edit(s) to "${params.path}" (${batch.replacements} replacement(s))${lenNote}${skipNote}. Proceed to the next step or goal.`;
				return await commitEdits(this.services, invocation, fileUri, params.path, [{ range: fullRange, text: batch.finalContent }], batch.finalContent, msg, false);
			}

			// --- Single replace ---
			const single = resolvePatch(currentContent, { oldString: params.oldString, newString: params.newString, replaceAll: params.replaceAll }, '');
			if (hasKey(single, { error: true })) {
				const firstLine = currentContent.split('\n')[0] ?? '';
				const hint = firstLine.length > 0 ? `\n\nExact first line of the file (copy for oldString if unsure):\n${JSON.stringify(firstLine)}` : '';
				return { content: [{ kind: 'text', value: `Error: ${single.error} Next: readFile "${params.path}" and copy the exact text for oldString.${hint}` }], toolResultError: 'Edit failed' };
			}
			if (hasKey(single, { skip: true })) {
				return { content: [{ kind: 'text', value: `No change needed for "${params.path}" - ${single.reason}` }] };
			}
			const textEdits = rangesToEdits(currentContent, single.ranges, single.replacementFor);
			const newContent = applyRanges(currentContent, single.ranges, single.replacementFor);
			const lenNote = single.lenient ? ' (matched leniently, adjusted for indentation)' : '';
			const msg = `Successfully edited "${params.path}" (replaced ${single.ranges.length} occurrence(s))${lenNote}. Proceed to the next step or goal.`;
			return await commitEdits(this.services, invocation, fileUri, params.path, textEdits, newContent, msg, false);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return { content: [{ kind: 'text', value: `Error editing "${params.path}": ${errorMessage}. Next: verify the path (readFile/listDirectory) and that the file is not locked.` }], toolResultError: errorMessage };
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const path: string | undefined = context.parameters?.path;
		const name = path ? path.split(/[/\\]/).filter(Boolean).pop() : undefined;
		if (!name) { return undefined; }
		const uri = resolveToolFileUri(path, this.workspaceService);
		return {
			invocationMessage: buildFileLinkInvocationMessage(localize('editFile.invoking', "Editing {0}", '{0}'), name, uri),
			pastTenseMessage: buildFileLinkInvocationMessage(localize('editFile.invoked', "Edited {0}", '{0}'), name, uri),
		};
	}
}
