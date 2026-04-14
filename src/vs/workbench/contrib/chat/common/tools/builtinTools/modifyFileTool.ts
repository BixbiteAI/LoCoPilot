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
import { CellUri } from '../../../../notebook/common/notebookCommon.js';
import { INotebookService } from '../../../../notebook/common/notebookService.js';
import { ChatModel } from '../../model/chatModel.js';
import { IChatService } from '../../chatService/chatService.js';
import { ChatModeKind } from '../../constants.js';
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
	for (;;) {
		const i = content.indexOf(oldString, idx);
		if (i === -1) break;
		indices.push(i);
		idx = i + 1;
		if (!replaceAll) break;
	}
	const sorted = replaceAll ? [...indices].sort((a, b) => b - a) : indices;
	return sorted.map(start => ({
		range: offsetToRange(content, start, oldString.length),
		text: newString
	}));
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
			'- If file EXISTS: replaces the entire file with newString.\n\n' +
			'**When oldString is NON-EMPTY**: Same as surgical replace — oldString must match the file exactly (use readFile first and copy exact text). If multiple matches, use replaceAll: true or make oldString unique. On "String not found", use the exact hint from the error as oldString on the next turn.',
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
}

/** Short delay so language servers can publish diagnostics after file write. */
const LINT_CHECK_DELAY_MS = 150;

export class ModifyFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IChatService private readonly chatService: IChatService,
		@INotebookService private readonly notebookService: INotebookService,
		@IMarkerService private readonly markerService: IMarkerService,
	) { }

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

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IModifyFileToolParams;

		// In ask mode, do not modify files — tell the agent to provide code content in chat instead
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
				if (isEmptyOld) {
					progress.report({ message: `Creating file ${params.path}...` });
					const content = VSBuffer.fromString(params.newString);
					await this.fileService.createFile(fileUri, content, { overwrite: false });
					const lineCount = params.newString.split('\n').length;
					const successResult: IToolResult = { content: [{ kind: 'text', value: `Successfully created file "${params.path}" (${lineCount} lines). Proceed to the next step or goal.` }] };
					const lintFailure = await this.getLintFailureAfterEdit(fileUri, params.path);
					if (lintFailure) { return lintFailure; }
					return successResult;
				}
				return {
					content: [{ kind: 'text', value: `Error: File "${params.path}" does not exist. Next: Use oldString: "" and newString: "<full contents>" to create the file with modifyFile.` }],
					toolResultError: 'File does not exist'
				};
			}

			// --- File exists ---
			if (isEmptyOld) {
				// Replace entire file with newString
				progress.report({ message: `Replacing entire file ${params.path}...` });
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
						const successResult: IToolResult = { content: [{ kind: 'text', value: `Successfully replaced entire file "${params.path}". Proceed to the next step or goal.` }] };
						const lintFailure = await this.getLintFailureAfterEdit(fileUri, params.path);
						if (lintFailure) { return lintFailure; }
						return successResult;
					}
				}
				await this.fileService.writeFile(fileUri, VSBuffer.fromString(newContent));
				const successResultReplace: IToolResult = { content: [{ kind: 'text', value: `Successfully replaced entire file "${params.path}". Proceed to the next step or goal.` }] };
				const lintFailureReplace = await this.getLintFailureAfterEdit(fileUri, params.path);
				if (lintFailureReplace) { return lintFailureReplace; }
				return successResultReplace;
			}

			// --- Partial replace (oldString non-empty) ---
			progress.report({ message: `Editing ${params.path}...` });

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
					const successResultPartial: IToolResult = { content: [{ kind: 'text', value: successMessage }] };
					const lintFailurePartial = await this.getLintFailureAfterEdit(fileUri, params.path);
					if (lintFailurePartial) { return lintFailurePartial; }
					return successResultPartial;
				}
			}

			await this.fileService.writeFile(fileUri, VSBuffer.fromString(newContent));
			const successResultFinal: IToolResult = { content: [{ kind: 'text', value: successMessage }] };
			const lintFailureFinal = await this.getLintFailureAfterEdit(fileUri, params.path);
			if (lintFailureFinal) { return lintFailureFinal; }
			return successResultFinal;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ kind: 'text', value: `Error modifying file "${params.path}": ${errorMessage}. Next: Verify path exists (listDirectory/findFiles), ensure file is not locked, or use readFile then modifyFile with exact oldString.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}
