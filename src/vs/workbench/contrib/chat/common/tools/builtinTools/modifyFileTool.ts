/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../../base/common/jsonSchema.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { IRange } from '../../../../../../editor/common/core/range.js';
import { TextEdit } from '../../../../../../editor/common/languages.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IMarkerService, MarkerSeverity } from '../../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { CellUri } from '../../../../notebook/common/notebookCommon.js';
import { INotebookService } from '../../../../notebook/common/notebookService.js';
import { ChatModel } from '../../model/chatModel.js';
import { IChatService } from '../../chatService/chatService.js';
import { ChatModeKind } from '../../constants.js';
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

/** Convert a byte offset and length in content to an editor IRange (1-based line/column). */
function offsetToRange(content: string, startOffset: number, length: number): IRange {
	let line = 1, col = 1;
	for (let i = 0; i < startOffset && i < content.length; i++) {
		if (content[i] === '\n') {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	const startLine = line, startCol = col;
	for (let i = 0; i < length && (startOffset + i) < content.length; i++) {
		if (content[startOffset + i] === '\n') {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	return { startLineNumber: startLine, startColumn: startCol, endLineNumber: line, endColumn: col };
}

/** Build TextEdit[] for oldString -> newString in content; for replaceAll, edits are in reverse order (end to start). */
function buildReplaceEdits(content: string, oldString: string, newString: string, replaceAll: boolean): TextEdit[] {
	const indices: number[] = [];
	let idx = 0;
	for (; ;) {
		const i = content.indexOf(oldString, idx);
		if (i === -1) { break; }
		indices.push(i);
		idx = i + 1;
		if (!replaceAll) { break; }
	}
	const sorted = replaceAll ? [...indices].sort((a, b) => b - a) : indices;
	return sorted.map(start => ({
		range: offsetToRange(content, start, oldString.length),
		text: newString
	}));
}

/**
 * Build the live "+A / -R lines" fragment for the streaming edit card from the partial args.
 * `added` = lines in the (still-streaming) newString, `removed` = lines in oldString (the text being
 * replaced; empty for a create/full-write, so those show just "+A"). Each side is omitted when 0, so a
 * pure create reads "+12" and a targeted edit reads "+3 / -2". Falls back to "0" if somehow both empty
 * so the caller always has a non-empty count to render. Counts are on the raw args (fast, tick-friendly)
 * rather than a line-by-line diff, which can't be accurate anyway while newString is still truncated.
 */
function formatStreamLineDelta(newString: string | undefined, oldString: string | undefined): string {
	const added = typeof newString === 'string' && newString.length > 0 ? newString.split('\n').length : 0;
	const removed = typeof oldString === 'string' && oldString.length > 0 ? oldString.split('\n').length : 0;
	const parts: string[] = [];
	if (added > 0) { parts.push(`+${added}`); }
	if (removed > 0) { parts.push(`-${removed}`); }
	return parts.length > 0 ? parts.join(' / ') : '0';
}

export const ModifyFileToolId = 'modifyFile';

export function createModifyFileToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Path to the file to create or edit (workspace-relative or absolute)'
			},
			oldString: {
				type: 'string',
				description: 'Exact string to find and replace. Use EMPTY string ("") to: (1) create a new file with newString if the file does not exist, or (2) replace the entire file with newString if the file exists. For partial edits, copy the exact text from readFile (character-for-character).'
			},
			newString: {
				type: 'string',
				description: 'String to write. When oldString is empty: full file contents (create or overwrite). When oldString is non-empty: replacement for that exact substring.'
			},
			replaceAll: {
				type: 'boolean',
				description: 'Optional: When doing partial replace (oldString non-empty), if true replaces all occurrences; if false (default) only one match allowed.'
			},
			force: {
				type: 'boolean',
				description: 'Optional: Required (true) only when intentionally replacing a large existing file with much shorter content. Without it such an overwrite is rejected as likely accidental truncation.'
			}
		},
		required: ['path', 'oldString', 'newString']
	};

	return {
		id: ModifyFileToolId,
		toolReferenceName: 'modifyFile',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.edit.id),
		displayName: localize('tool.modifyFile.displayName', 'Create or modify file'),
		userDescription: localize('tool.modifyFile.userDescription', 'Create a new file or modify an existing file by string replacement or full overwrite'),
		modelDescription: 'Create or modify files in one tool. Params: path, oldString, newString, replaceAll?.\n\n' +
			'**When oldString is EMPTY ("")**:\n' +
			'- If file does NOT exist: creates the file with newString as full contents (parent dirs created automatically).\n' +
			'- If file EXISTS: replaces the entire file with newString. Replacing a large file with much shorter content is rejected unless you resend with force: true (guards against accidentally truncated rewrites - prefer targeted oldString edits for partial changes).\n\n' +
			'**When oldString is NON-EMPTY**: Same as surgical replace - oldString must match the file exactly (use readFile first and copy exact text). If multiple matches, use replaceAll: true or make oldString unique. On "String not found", use the exact hint from the error as oldString on the next turn.',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		canRequestPreApproval: true,
		alwaysDisplayInputOutput: true
	};
}

interface IModifyFileToolParams {
	path: string;
	oldString: string;
	newString: string;
	replaceAll?: boolean;
	force?: boolean;
}

/** Overwrite shrink guard: an existing file this long ... */
const SHRINK_GUARD_MIN_LINES = 50;
/** ...replaced by content under this fraction of its size is likely accidental truncation. */
const SHRINK_GUARD_RATIO = 0.4;

/** Short delay so language servers can publish diagnostics after file write. */
const LINT_CHECK_DELAY_MS = 150;

export class ModifyFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IChatService private readonly chatService: IChatService,
		@INotebookService private readonly notebookService: INotebookService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IEditorService private readonly editorService: IEditorService,
	) { }

	/**
	 * Reveal a just-created/edited file in the workbench so the user actually sees it open, not only the
	 * inline chat diff. Best-effort: `preserveFocus` keeps the caret in the chat input (so an agent turn
	 * doesn't yank focus on every write), and a non-pinned PREVIEW tab means a burst of edits across many
	 * files reuses a single tab instead of flooding the editor with one tab per file. Notebook cell URIs
	 * are normalized back to the notebook document. Any failure is swallowed - opening is a convenience and
	 * must never fail the edit itself.
	 */
	private _revealInEditor(fileUri: URI): void {
		const resource = CellUri.parse(fileUri)?.notebook ?? fileUri;
		this.editorService.openEditor({ resource, options: { preserveFocus: true, pinned: false } })
			.catch(() => { /* best-effort UX only */ });
	}

	/**
	 * After a successful file write, check for linter errors in that file only.
	 * If any errors exist, return a failure result so the LLM sees them and can fix.
	 * Warnings and clean results stay silent (return null = keep success).
	 */
	private async getLintFailureAfterEdit(fileUri: URI, displayPath: string): Promise<IToolResult | null> {
		await new Promise(resolve => setTimeout(resolve, LINT_CHECK_DELAY_MS));
		const markers = this.markerService.read({ resource: fileUri, severities: MarkerSeverity.Error });
		if (markers.length === 0) {
			return null;
		}
		markers.sort((a, b) => a.startLineNumber - b.startLineNumber);
		const lines: string[] = [];
		for (const m of markers) {
			const code = m.code ? ` [${typeof m.code === 'object' ? m.code.value : m.code}]` : '';
			const source = m.source ? ` (${m.source})` : '';
			lines.push(`  ${m.startLineNumber}:${m.startColumn} - error${code}: ${m.message}${source}`);
		}
		const message = `Successfully wrote "${displayPath}", but the following linter errors were introduced:\n\n${displayPath} (${markers.length} error(s)):\n${lines.join('\n')}\n\nNext: Fix these errors (e.g. with modifyFile or readFile).`;
		return {
			content: [{ kind: 'text', value: message }],
			toolResultError: 'Linter errors introduced'
		};
	}

	/**
	 * Live invocation message while the model is still STREAMING this call's arguments (llama.cpp
	 * streams them token by token). The schema orders fields path -> oldString -> newString, so the
	 * file name appears within the first few tokens and the message then ticks up a live line count
	 * while the content generates - instead of the chat sitting silent until the call completes.
	 * `rawInput` is a best-effort parse of the partial JSON, so every field may be missing/truncated.
	 */
	async handleToolStream(context: IToolInvocationStreamContext, _token: CancellationToken): Promise<IStreamedToolInvocation | undefined> {
		const input = (context.rawInput ?? {}) as Partial<IModifyFileToolParams>;
		const path = typeof input.path === 'string' && input.path.trim().length > 0 ? input.path : undefined;
		const newString = typeof input.newString === 'string' ? input.newString : undefined;
		if (!path) {
			// The model may stream `newString` (the file content) BEFORE `path` in the argument JSON,
			// so we can already have content to count while the file name is still unknown. Show the
			// live line count during this phase too, instead of a static "Preparing file edit", so the
			// count ticks up in real time from the very first tokens.
			if (newString !== undefined) {
				const delta = formatStreamLineDelta(newString, input.oldString);
				return { invocationMessage: localize('modifyFile.streaming.preparingLines', "Preparing file edit ({0} lines)", delta) };
			}
			return { invocationMessage: localize('modifyFile.streaming.preparing', "Preparing file edit") };
		}
		const fileName = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
		const fileUri = resolveToolFileUri(path, this.workspaceService);
		// oldString streams before newString: known-empty means full write (create/overwrite), known
		// non-empty means a targeted edit. While it's still unknown, stay neutral with "Editing".
		const isFullWrite = typeof input.oldString === 'string' && input.oldString.length === 0;
		if (newString === undefined) {
			const template = isFullWrite
				? localize('modifyFile.streaming.writing', "Writing {0}")
				: localize('modifyFile.streaming.editing', "Editing {0}");
			return { invocationMessage: buildFileLinkInvocationMessage(template, fileName, fileUri) };
		}
		// `localize` fills {1} with the live +A/-R count while the literal '{0}' survives for the file link.
		const delta = formatStreamLineDelta(newString, input.oldString);
		const template = isFullWrite
			? localize('modifyFile.streaming.writingLines', "Writing {0} ({1} lines)", '{0}', delta)
			: localize('modifyFile.streaming.editingLines', "Editing {0} ({1} lines)", '{0}', delta);
		return { invocationMessage: buildFileLinkInvocationMessage(template, fileName, fileUri) };
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IModifyFileToolParams;

		// Small/local models frequently omit oldString (or send null) when they just want to create a
		// file. Treat a missing oldString/newString as "" so those calls behave as create/overwrite
		// instead of throwing on `.length` and trapping the model in a retry loop.
		if (typeof params.oldString !== 'string') { params.oldString = ''; }
		if (typeof params.newString !== 'string') { params.newString = ''; }

		// In ask mode, do not modify files - tell the agent to provide code content in chat instead
		if (invocation.context) {
			const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
			const lastRequest = model?.getRequests().at(-1);
			if (lastRequest?.modeInfo?.kind === ChatModeKind.Ask) {
				return {
					content: [{
						kind: 'text',
						value: `Error: You are in Ask mode. File edits are not allowed in Ask mode. Next: Do not call modifyFile or editFiles. Instead, provide the code or file content directly in your response so the user can copy or apply it. For each file: list the path and show the full contents (for new/overwrite) or the exact old and new snippets (for partial edits). You may suggest the user switch to Agent mode if they want changes applied automatically.`
					}],
					toolResultError: 'Ask mode: file edits not allowed'
				};
			}
		}

		try {
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

			// Basename used for the progress messages below so they show a clickable file chip
			// (via buildFileLinkInvocationMessage) instead of the full absolute path.
			const fileName = params.path.split(/[/\\]/).filter(Boolean).pop() ?? params.path;

			const isEmptyOld = params.oldString.length === 0;
			let fileExists: boolean;
			let currentContent: string;
			try {
				const fileContent = await this.fileService.readFile(fileUri);
				currentContent = fileContent.value.toString();
				fileExists = true;
			} catch {
				fileExists = false;
				currentContent = '';
			}

			// --- File does not exist ---
			if (!fileExists) {
				// Forgiving create: when the target doesn't exist there is nothing to replace, so the only
				// sensible result is a file containing newString - REGARDLESS of whether oldString was
				// supplied. Weak models often pass the code in newString while leaving a stale/non-empty
				// oldString (or omit it); previously that returned "File does not exist" on every call and
				// trapped a perfectly valid "create X" request in a loop. We now just create the file.
				const lastSegment = params.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
				// Common extension-less files that are legitimately created without an extension.
				const KNOWN_EXTENSIONLESS = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'procfile', 'gemfile', 'rakefile', 'caddyfile', 'jenkinsfile', 'vagrantfile', 'authors', 'notice', 'codeowners']);
				// Only refuse the one genuinely harmful case: an empty, extension-less, unknown name -
				// that is the "creating a directory as a file" mistake that blocks the real folder.
				const looksLikeDir = !lastSegment.includes('.')
					&& params.newString.trim().length === 0
					&& !KNOWN_EXTENSIONLESS.has(lastSegment.toLowerCase());
				if (looksLikeDir) {
					return {
						content: [{ kind: 'text', value: `Error: Refusing to create empty file "${params.path}" - it has no extension and no content, which looks like an attempt to create a directory. Next: Do NOT create directories. Just write the file you actually want (e.g. "${params.path}/index.html") with its contents - parent folders are created automatically.` }],
						toolResultError: 'Directory-like empty file refused'
					};
				}
				progress.report({ message: buildFileLinkInvocationMessage(localize('modifyFile.creating', "Creating file {0}", '{0}'), fileName, fileUri) });
				const lineCount = params.newString.split('\n').length;
				const createSuccess: IToolResult = { content: [{ kind: 'text', value: `Successfully created file "${params.path}" (${lineCount} lines). Proceed to the next step or goal.` }] };

				// Route creation through the chat editing session (same mechanism as the overwrite /
				// partial-edit branches) so the new file becomes a tracked entry. Without this, a
				// created file bypassed the editing session entirely and "Restore Checkpoint" could
				// not remove it - only edits to pre-existing files were reverted. The editing session
				// records an empty baseline for a not-yet-existing file (NotExistBehavior.Create), so
				// restoring to before this request deletes the file.
				const createUri = CellUri.parse(fileUri)?.notebook ?? fileUri;
				const isNotebookCreate = this.notebookService.hasSupportedNotebooks(createUri) && this.notebookService.getNotebookTextModel(createUri);
				if (invocation.context && !isNotebookCreate) {
					const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
					const request = model?.getRequests().at(-1);
					const editSession = model?.editingSession;
					if (request && editSession) {
						// Insert the whole content into the (empty) new document.
						const fullRange: IRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
						const edits: TextEdit[] = [{ range: fullRange, text: params.newString }];
						const undoStopId = generateUuid();
						model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
						model.acceptResponseProgress(request, { kind: 'codeblockUri', uri: createUri, isEdit: true, undoStopId });
						model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
						model.acceptResponseProgress(request, { kind: 'textEdit', uri: createUri, edits: [] });
						model.acceptResponseProgress(request, { kind: 'textEdit', uri: createUri, edits });
						model.acceptResponseProgress(request, { kind: 'textEdit', uri: createUri, edits: [], done: true });
						this._revealInEditor(fileUri);
						const lintFailureCreate = await this.getLintFailureAfterEdit(fileUri, params.path);
						if (lintFailureCreate) { return lintFailureCreate; }
						return createSuccess;
					}
				}

				// Fallback (no editing session - e.g. non-chat context): write directly. Not
				// checkpoint-tracked, but still creates the file the caller asked for.
				await this.fileService.createFile(fileUri, VSBuffer.fromString(params.newString), { overwrite: false });
				this._revealInEditor(fileUri);
				const lintFailure = await this.getLintFailureAfterEdit(fileUri, params.path);
				if (lintFailure) { return lintFailure; }
				return createSuccess;
			}

			// --- File exists ---
			if (isEmptyOld) {
				// Shrink guard: a small model "rewriting" a big file frequently emits only a fragment
				// (truncated generation) - silently destroying the rest of the file. Require an explicit
				// force flag before replacing a large file with dramatically shorter content.
				const currentLines = currentContent.split('\n').length;
				if (!params.force
					&& currentLines >= SHRINK_GUARD_MIN_LINES
					&& params.newString.length < currentContent.length * SHRINK_GUARD_RATIO) {
					return {
						content: [{ kind: 'text', value: `Error: Refusing to replace "${params.path}" (${currentLines} lines) with much shorter content (${params.newString.split('\n').length} lines) - this usually means the new content is accidentally incomplete. Next: If you only need to change part of the file, use a targeted edit (readFile, then modifyFile with the exact oldString). If you genuinely intend to replace the whole file with this shorter content, resend the SAME call with force: true.` }],
						toolResultError: 'Large-file shrink overwrite refused (missing force)'
					};
				}
				// Replace entire file with newString
				progress.report({ message: buildFileLinkInvocationMessage(localize('modifyFile.replacingEntire', "Replacing entire file {0}", '{0}'), fileName, fileUri) });
				const newContent = params.newString;
				const uri = CellUri.parse(fileUri)?.notebook ?? fileUri;
				const isNotebook = this.notebookService.hasSupportedNotebooks(uri) && this.notebookService.getNotebookTextModel(uri);
				if (invocation.context && !isNotebook) {
					const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
					const request = model?.getRequests().at(-1);
					const editSession = model?.editingSession;
					if (request && editSession) {
						const lines = currentContent.split('\n');
						const endLine = lines.length || 1;
						const lastLine = lines[lines.length - 1] ?? '';
						const fullRange: IRange = { startLineNumber: 1, startColumn: 1, endLineNumber: endLine, endColumn: lastLine.length + 1 };
						const edits: TextEdit[] = [{ range: fullRange, text: newContent }];
						const undoStopId = generateUuid();
						model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
						model.acceptResponseProgress(request, { kind: 'codeblockUri', uri, isEdit: true, undoStopId });
						model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
						model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [] });
						model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits });
						model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [], done: true });
						this._revealInEditor(fileUri);
						const successResult: IToolResult = { content: [{ kind: 'text', value: `Successfully replaced entire file "${params.path}". Proceed to the next step or goal.` }] };
						const lintFailure = await this.getLintFailureAfterEdit(fileUri, params.path);
						if (lintFailure) { return lintFailure; }
						return successResult;
					}
				}
				await this.fileService.writeFile(fileUri, VSBuffer.fromString(newContent));
				this._revealInEditor(fileUri);
				const successResultReplace: IToolResult = { content: [{ kind: 'text', value: `Successfully replaced entire file "${params.path}". Proceed to the next step or goal.` }] };
				const lintFailureReplace = await this.getLintFailureAfterEdit(fileUri, params.path);
				if (lintFailureReplace) { return lintFailureReplace; }
				return successResultReplace;
			}

			// --- Partial replace (oldString non-empty) ---
			progress.report({ message: buildFileLinkInvocationMessage(localize('modifyFile.editing', "Editing {0}", '{0}'), fileName, fileUri) });

			if (params.oldString === params.newString) {
				return {
					content: [{ kind: 'text', value: `Error: oldString and newString are identical. No changes needed. Next: Skip this edit or provide a different newString.` }],
					toolResultError: 'Strings are identical'
				};
			}

			const occurrences = currentContent.split(params.oldString).length - 1;
			if (occurrences === 0) {
				const firstLine = currentContent.split('\n')[0] ?? '';
				const hint = firstLine.length > 0
					? `\n\nOn the next turn, call modifyFile again with oldString set to this exact value (copy character-for-character):\n${JSON.stringify(firstLine)}`
					: '';
				return {
					content: [{ kind: 'text', value: `Error: String not found in "${params.path}". oldString must match the file exactly. Next: Call readFile to get exact content, then copy it for oldString.${hint}` }],
					toolResultError: 'String not found'
				};
			}

			if (occurrences > 1 && !params.replaceAll) {
				return {
					content: [{
						kind: 'text',
						value: `Error: Found ${occurrences} occurrences. Next: Either make oldString unique (add more context) or set replaceAll=true to replace all.`
					}],
					toolResultError: 'Ambiguous match'
				};
			}

			const newContent = params.replaceAll
				? currentContent.split(params.oldString).join(params.newString)
				: currentContent.replace(params.oldString, params.newString);
			const replacementCount = params.replaceAll ? occurrences : 1;
			const successMessage = `Successfully edited "${params.path}" (replaced ${replacementCount} occurrence(s)). Proceed to the next step or goal.`;

			const uri = CellUri.parse(fileUri)?.notebook ?? fileUri;
			const isNotebook = this.notebookService.hasSupportedNotebooks(uri) && this.notebookService.getNotebookTextModel(uri);
			if (invocation.context && !isNotebook) {
				const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
				const request = model?.getRequests().at(-1);
				const editSession = model?.editingSession;
				if (request && editSession) {
					const edits = buildReplaceEdits(currentContent, params.oldString, params.newString, params.replaceAll ?? false);
					const undoStopId = generateUuid();
					model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
					model.acceptResponseProgress(request, { kind: 'codeblockUri', uri, isEdit: true, undoStopId });
					model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
					model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [] });
					model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits });
					model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [], done: true });
					this._revealInEditor(fileUri);
					const successResultPartial: IToolResult = { content: [{ kind: 'text', value: successMessage }] };
					const lintFailurePartial = await this.getLintFailureAfterEdit(fileUri, params.path);
					if (lintFailurePartial) { return lintFailurePartial; }
					return successResultPartial;
				}
			}

			await this.fileService.writeFile(fileUri, VSBuffer.fromString(newContent));
			this._revealInEditor(fileUri);
			const successResultFinal: IToolResult = { content: [{ kind: 'text', value: successMessage }] };
			const lintFailureFinal = await this.getLintFailureAfterEdit(fileUri, params.path);
			if (lintFailureFinal) { return lintFailureFinal; }
			return successResultFinal;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// Common, recoverable case: a path component the model intended as a folder already exists
			// as a FILE, so the parent folder can't be created. Give the exact fix instead of a generic hint.
			if (/exists but is not a directory|not a directory/i.test(errorMessage)) {
				return {
					content: [{ kind: 'text', value: `Error modifying file "${params.path}": ${errorMessage}. A parent path component already exists as a FILE, which blocks creating the folder. Next: delete the blocking file with run_in_terminal (e.g. \`rm <blocking-path>\`) then retry, OR write your target file directly - modifyFile creates parent folders automatically, so you never need a separate mkdir step.` }],
					toolResultError: errorMessage
				};
			}
			return {
				content: [{ kind: 'text', value: `Error modifying file "${params.path}": ${errorMessage}. Next: Verify path exists (listDirectory/findFiles), ensure file is not locked, or use readFile then modifyFile with exact oldString.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const path: string | undefined = context.parameters?.path;
		const name = path ? path.split(/[/\\]/).filter(Boolean).pop() : undefined;
		if (!name) {
			return undefined;
		}
		const uri = resolveToolFileUri(path, this.workspaceService);
		return {
			invocationMessage: buildFileLinkInvocationMessage(localize('modifyFile.invoking', "Editing {0}", '{0}'), name, uri),
			pastTenseMessage: buildFileLinkInvocationMessage(localize('modifyFile.invoked', "Edited {0}", '{0}'), name, uri),
		};
	}
}
