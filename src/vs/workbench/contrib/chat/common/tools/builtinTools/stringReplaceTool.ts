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
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { CellUri } from '../../../../notebook/common/notebookCommon.js';
import { INotebookService } from '../../../../notebook/common/notebookService.js';
import { ChatModel } from '../../model/chatModel.js';
import { IChatService } from '../../chatService/chatService.js';
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
	// Apply from end to start so positions don't shift
	const sorted = replaceAll ? [...indices].sort((a, b) => b - a) : indices;
	return sorted.map(start => ({
		range: offsetToRange(content, start, oldString.length),
		text: newString
	}));
}

export const StringReplaceToolId = 'stringReplace';

export function createStringReplaceToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Path to the file to edit (workspace-relative or absolute)'
			},
			oldString: {
				type: 'string',
				description: 'Exact string to find and replace. Must match exactly (including whitespace; no extra or missing characters).'
			},
			newString: {
				type: 'string',
				description: 'String to replace with. Must be different from oldString.'
			},
			replaceAll: {
				type: 'boolean',
				description: 'Optional: If true, replaces all occurrences. If false (default), only replaces if there is exactly one match.'
			}
		},
		required: ['path', 'oldString', 'newString']
	};

	return {
		id: StringReplaceToolId,
		toolReferenceName: 'stringReplace',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.edit.id),
		displayName: localize('tool.stringReplace.displayName', 'Edit file by string replacement'),
		userDescription: localize('tool.stringReplace.userDescription', 'Edit a file by replacing an exact string'),
		modelDescription: 'Edit EXISTING files by replacing an exact string. Call readFile(path) first and copy the exact text for oldString (character-for-character). If you get "String not found", the error includes "First line of file" — use that exact string for oldString on the next turn (check for typos like extra } or missing space). For new files use createFile.',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		canRequestPreApproval: true,
		alwaysDisplayInputOutput: true
	};
}

interface IStringReplaceToolParams {
	path: string;
	oldString: string;
	newString: string;
	replaceAll?: boolean;
}

export class StringReplaceTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IChatService private readonly chatService: IChatService,
		@INotebookService private readonly notebookService: INotebookService,
	) { }

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IStringReplaceToolParams;
		
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

			progress.report({ message: `Editing ${params.path}...` });

			// Read current file content
			const fileContent = await this.fileService.readFile(fileUri);
			const currentContent = fileContent.value.toString();

			if (params.oldString.length === 0) {
				return {
					content: [{ kind: 'text', value: `Error: oldString cannot be empty. Next: Use readFile to get exact content, then provide a non-empty oldString (or use modifyFile with oldString: "" to overwrite the whole file).` }],
					toolResultError: 'Empty oldString'
				};
			}

			if (params.oldString === params.newString) {
				return {
					content: [{ kind: 'text', value: `Error: oldString and newString are identical. No changes needed. Next: Skip this edit or provide a different newString.` }],
					toolResultError: 'Strings are identical'
				};
			}

			// Count occurrences of oldString
			const occurrences = currentContent.split(params.oldString).length - 1;

			if (occurrences === 0) {
				// Include exact file start so agent can use it for oldString on the next turn
				const firstLine = currentContent.split('\n')[0] ?? '';
				const hint = firstLine.length > 0
					? `\n\nOn the next turn, call stringReplace again with oldString set to this exact value (copy character-for-character; check for typos like extra } or missing space):\n${JSON.stringify(firstLine)}`
					: '';
				return {
					content: [{ kind: 'text', value: `Error: String not found in "${params.path}". oldString must match the file exactly (including whitespace; no extra or missing characters). Next: Call readFile to get exact content, then copy it for oldString.${hint}` }],
					toolResultError: 'String not found'
				};
			}

			if (occurrences > 1 && !params.replaceAll) {
				return {
					content: [{ 
						kind: 'text', 
						value: `Error: Found ${occurrences} occurrences of the string in "${params.path}". Next: Either include more context to make oldString unique (match only once) or set replaceAll=true to replace all ${occurrences} occurrences.` 
					}],
					toolResultError: 'Ambiguous match'
				};
			}

			// Perform replacement (compute newContent for success message; edits applied via session or disk)
			const newContent = params.replaceAll
				? currentContent.split(params.oldString).join(params.newString)
				: currentContent.replace(params.oldString, params.newString);

			const replacementCount = params.replaceAll ? occurrences : 1;
			const oldLines = params.oldString.split('\n').length;
			const newLines = params.newString.split('\n').length;
			const lineDiff = newLines - oldLines;
			const diffText = lineDiff > 0 ? `+${lineDiff}` : lineDiff < 0 ? `${lineDiff}` : '±0';
			const successMessage = `Successfully edited "${params.path}"\n- Replaced ${replacementCount} occurrence(s)\n- Lines changed: ${diffText}\n- Old: ${oldLines} lines → New: ${newLines} lines\n\nProceed to the next step or goal.`;

			// When there is a chat editing session and this is a regular (non-notebook) file,
			// report edits through it so the UI shows diff colors, keep/undo, "1 of n"
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

					return { content: [{ kind: 'text', value: successMessage }] };
				}
			}

			// No editing session: write directly to disk
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(newContent));
			return { content: [{ kind: 'text', value: successMessage }] };

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ kind: 'text', value: `Error editing file "${params.path}": ${errorMessage}. Next: Verify path exists (readFile/listDirectory), ensure file is not locked, or use readFile then stringReplace with exact oldString.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		// Return undefined so tool call is shown in UI with input/output; confirmation is handled via canRequestPreApproval when needed
		return undefined;
	}
}
