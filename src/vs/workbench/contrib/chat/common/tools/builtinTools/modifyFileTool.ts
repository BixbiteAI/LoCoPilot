/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../../base/common/jsonSchema.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { hasKey } from '../../../../../../base/common/types.js';
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

/** An offset+length span of matched text inside the file content. */
interface IMatchRange { start: number; length: number }

/** Leading whitespace (indentation) of a single line. */
function leadingWhitespace(line: string): string {
	const m = line.match(/^[ \t]*/);
	return m ? m[0] : '';
}

/** Exact, non-overlapping occurrences of oldString in content (left to right, matching split/join semantics). */
function findExactRanges(content: string, oldString: string, replaceAll: boolean): IMatchRange[] {
	const ranges: IMatchRange[] = [];
	let idx = 0;
	for (; ;) {
		const i = content.indexOf(oldString, idx);
		if (i === -1) { break; }
		ranges.push({ start: i, length: oldString.length });
		idx = i + oldString.length;
		if (!replaceAll) { break; }
	}
	return ranges;
}

/**
 * Whitespace/indentation-tolerant fallback matcher. Small local models frequently reproduce a snippet
 * with the wrong leading indentation (or trailing spaces), so an exact indexOf fails and the model then
 * gives up and rewrites the whole file. This finds contiguous LINE blocks whose trimmed content equals
 * the trimmed oldString lines, and returns their real offsets in `content` (preserving the file's actual
 * indentation). Only whole-line blocks are matched - a fallback, not a replacement for exact matching.
 * Returns [] when oldString is only whitespace (never match "everything").
 */
function findFlexibleMatches(content: string, oldString: string): IMatchRange[] {
	if (oldString.trim().length === 0) { return []; }
	const oldLines = oldString.split('\n');
	const normOld = oldLines.map(l => l.trim());
	// Line starts: contentLines[k] begins at byte offset lineStart[k].
	const contentLines = content.split('\n');
	const lineStart: number[] = [];
	let acc = 0;
	for (const l of contentLines) {
		lineStart.push(acc);
		acc += l.length + 1; // + '\n'
	}
	const ranges: IMatchRange[] = [];
	const n = oldLines.length;
	for (let i = 0; i + n <= contentLines.length; i++) {
		let ok = true;
		for (let k = 0; k < n; k++) {
			if (contentLines[i + k].trim() !== normOld[k]) { ok = false; break; }
		}
		if (!ok) { continue; }
		const start = lineStart[i];
		const lastIdx = i + n - 1;
		const end = lineStart[lastIdx] + contentLines[lastIdx].length;
		ranges.push({ start, length: end - start });
		i = lastIdx; // don't produce overlapping blocks
	}
	return ranges;
}

/**
 * Re-base the indentation of `newString` from the model's assumed indent (leading whitespace of the
 * oldString's first line) to the file's real indent (leading whitespace of the matched block's first
 * line). Used only on a lenient (indentation-tolerant) match so the replacement lands at the file's
 * actual indentation instead of the model's guessed one, while preserving relative indentation inside
 * newString. No-op when the two indents already match.
 */
function reindentReplacement(newString: string, oldFirstLine: string, matchedFirstLine: string): string {
	const oldIndent = leadingWhitespace(oldFirstLine);
	const newIndent = leadingWhitespace(matchedFirstLine);
	if (oldIndent === newIndent) { return newString; }
	return newString.split('\n').map(line => {
		if (line.trim().length === 0) { return ''; }
		const body = line.startsWith(oldIndent) ? line.slice(oldIndent.length) : line;
		return newIndent + body;
	}).join('\n');
}

/** Build TextEdit[] from match ranges; edits are ordered end-to-start so applied offsets never shift. */
function rangesToEdits(content: string, ranges: IMatchRange[], replacement: (r: IMatchRange) => string): TextEdit[] {
	return [...ranges].sort((a, b) => b.start - a.start).map(r => ({
		range: offsetToRange(content, r.start, r.length),
		text: replacement(r)
	}));
}

/** Apply match ranges to content (end-to-start) producing the new full content. */
function applyRanges(content: string, ranges: IMatchRange[], replacement: (r: IMatchRange) => string): string {
	let out = content;
	for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
		out = out.slice(0, r.start) + replacement(r) + out.slice(r.start + r.length);
	}
	return out;
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
				description: 'PREFERRED: the exact text to find and replace (copy it character-for-character from readFile; indentation is matched leniently). Change only the lines that differ. Use EMPTY string ("") ONLY to (1) create a new file or (2) fully overwrite an existing file with newString. Do not paste the whole file here to rewrite it - use "" for a full write.'
			},
			newString: {
				type: 'string',
				description: 'Replacement text. When oldString is non-empty: the replacement for that snippet. When oldString is empty: the full file contents (create or overwrite).'
			},
			replaceAll: {
				type: 'boolean',
				description: 'Optional: When doing partial replace (oldString non-empty), if true replaces all occurrences; if false (default) only one match allowed.'
			},
			force: {
				type: 'boolean',
				description: 'Optional: Required (true) only when intentionally replacing a large existing file with much shorter content. Without it such an overwrite is rejected as likely accidental truncation.'
			},
			insertAfter: {
				type: 'string',
				description: 'To ADD code without replacing anything: a short UNIQUE existing line copied from readFile; newString is inserted on the line(s) AFTER it. Use this to add a new method/function/import between existing code - do NOT copy the surrounding block into oldString. The anchor is kept; only newString is added.'
			},
			insertBefore: {
				type: 'string',
				description: 'Like insertAfter, but newString is inserted BEFORE the anchor line. Use exactly one of insertAfter/insertBefore.'
			},
			edits: {
				type: 'array',
				description: 'Optional: apply MULTIPLE targeted edits to the SAME existing file in one call, applied in order (atomic - all must apply or the call fails). When provided, the top-level oldString/newString are ignored. The file "path" stays a TOP-LEVEL argument - do NOT put path inside a patch. Prefer this over rewriting a whole file when changing several separate places. Each item is a REPLACE patch {oldString, newString, replaceAll?} OR an INSERT patch {insertAfter|insertBefore, newString}.',
				items: {
					type: 'object',
					properties: {
						oldString: {
							type: 'string',
							description: 'REPLACE patch: exact text to replace (copied from readFile; indentation matched leniently). Omit when this patch is an insert.'
						},
						newString: {
							type: 'string',
							description: 'The replacement text (for a REPLACE patch) or the text to insert (for an INSERT patch). Required.'
						},
						replaceAll: {
							type: 'boolean',
							description: 'Optional: replace all occurrences of this oldString (default false = exactly one match).'
						},
						insertAfter: {
							type: 'string',
							description: 'INSERT patch: a short UNIQUE anchor line; newString is inserted AFTER it (anchor kept). Use to ADD code without duplicating a surrounding block.'
						},
						insertBefore: {
							type: 'string',
							description: 'INSERT patch: like insertAfter but newString is inserted BEFORE the anchor line.'
						}
					},
					required: ['newString']
				}
			}
		},
		// Only `path` is hard-required: a call may use oldString/newString OR the edits[] array. Omitted
		// oldString/newString are coerced to "" in invoke (create/overwrite), so this stays backward-safe.
		required: ['path']
	};

	return {
		id: ModifyFileToolId,
		toolReferenceName: 'modifyFile',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.edit.id),
		displayName: localize('tool.modifyFile.displayName', 'Create or modify file'),
		userDescription: localize('tool.modifyFile.userDescription', 'Create a new file or modify an existing file by string replacement or full overwrite'),
		modelDescription: 'Create or modify files in one tool. Params: path, oldString, newString, replaceAll?, or edits[].\n\n' +
			'**DEFAULT - targeted edit (PREFER THIS for any change to an existing file):** set oldString to the EXACT text to replace (copy it character-for-character from readFile, same whitespace) and newString to its replacement. Change ONLY the lines that differ and leave the rest of the file untouched. This is faster, cheaper, and far less error-prone than rewriting the whole file. Whitespace/indentation is matched leniently, so small indent differences still match. Use replaceAll: true to replace every occurrence; otherwise oldString must match exactly once. On "String not found", use the exact hint from the error as oldString on the next turn.\n\n' +
			'**ADD new code (a method/function/import) - use INSERT, do NOT duplicate a block:** set insertAfter (or insertBefore) to a short UNIQUE existing line copied from readFile, and put ONLY the new code in newString. The anchor line is kept and newString is inserted next to it. Do NOT copy the whole surrounding function into oldString just to append after it - that is error-prone. Example: insertAfter="    return a / b" with newString="\\n    def power(self, a, b):\\n        return a ** b".\n\n' +
			'**Several edits to the SAME file at once:** pass edits: [{oldString, newString, replaceAll?} | {insertAfter|insertBefore, newString}, ...] instead of the top-level fields. Each patch (replace OR insert) is applied in order against the file; prefer this over one big rewrite when you are changing multiple separate places. All patches must apply or the whole call fails (atomic).\n\n' +
			'**Create a NEW file:** set oldString to "" (empty); newString is the full contents (parent dirs created automatically).\n\n' +
			'**Full overwrite of an EXISTING file - use ONLY when MOST of the file changes:** set oldString to "" (empty) and newString to the complete new contents. Do NOT use this for small or localized changes; use a targeted edit or edits[] instead. Do NOT paste the old file into oldString to "rewrite" it - that just wastes tokens; an empty oldString already means full write. Replacing a large file with much shorter content is rejected unless you resend with force: true.',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		canRequestPreApproval: true,
		alwaysDisplayInputOutput: true
	};
}

/**
 * A single patch within an edits[] multi-edit call. Two shapes:
 *  - REPLACE: {oldString, newString} - replace matched text.
 *  - INSERT:  {insertAfter | insertBefore, newString} - insert newString relative to a short anchor line
 *    WITHOUT repeating the anchor. Use insert for ADDING code (a new method/function/import) so the model
 *    never has to duplicate a surrounding block in both oldString and newString.
 */
interface IEditPatch {
	oldString?: string;
	newString: string;
	replaceAll?: boolean;
	insertAfter?: string;
	insertBefore?: string;
}

interface IModifyFileToolParams {
	path: string;
	oldString: string;
	newString: string;
	replaceAll?: boolean;
	force?: boolean;
	edits?: IEditPatch[];
	insertAfter?: string;
	insertBefore?: string;
}

/**
 * Resolve one patch against `content`: find its match ranges (exact first, then whitespace/indent-tolerant)
 * and return the ranges plus a per-range replacement text (re-indented on a lenient match). Returns a string
 * `error` describing the failure (string-not-found / ambiguous / no-op) instead of throwing, so the caller
 * can report it verbatim to the model. `label` is prefixed to error messages for the multi-edit case.
 */
function resolvePatch(content: string, patch: IEditPatch, label: string): { ranges: IMatchRange[]; replacementFor: (r: IMatchRange) => string; lenient: boolean } | { error: string } | { skip: true; reason: string } {
	// --- INSERT patch: place newString before/after a unique anchor, keeping the anchor intact. ---
	const insertAfter = typeof patch.insertAfter === 'string' && patch.insertAfter.length > 0;
	const insertBefore = typeof patch.insertBefore === 'string' && patch.insertBefore.length > 0;
	if (insertAfter || insertBefore) {
		const anchor = (insertAfter ? patch.insertAfter : patch.insertBefore) as string;
		if (patch.newString.length === 0) {
			return { error: `${label}newString to insert is empty - provide the code to add.` };
		}
		// Idempotent insert: if the EXACT multi-line block being inserted is ALREADY present in the file
		// (line-trim tolerant), skip it instead of adding a duplicate. Weak models frequently re-issue an
		// insert they already made on a prior turn (e.g. re-adding a method), so this makes the second
		// attempt a harmless no-op. Deliberately conservative to avoid ever skipping code that IS wanted:
		//  - only whole-block EXACT matches (any differing line => no match => it inserts normally), and
		//  - only blocks of >= 2 non-blank lines, so a short/common single line (an import, a log call, a
		//    `return None`) that legitimately repeats elsewhere is never suppressed.
		const insertBody = patch.newString.trim();
		const insertBodyLineCount = insertBody.split('\n').filter(l => l.trim().length > 0).length;
		if (insertBodyLineCount >= 2 && findFlexibleMatches(content, insertBody).length > 0) {
			return { skip: true, reason: `${label}the code to insert is already present - skipped to avoid a duplicate.` };
		}
		let anchorRanges = findExactRanges(content, anchor, false);
		let anchorLenient = false;
		if (anchorRanges.length === 0) {
			const flexible = findFlexibleMatches(content, anchor);
			if (flexible.length === 0) {
				return { error: `${label}Anchor for insertion not found. Copy a short UNIQUE line from readFile as insert${insertAfter ? 'After' : 'Before'}.` };
			}
			if (flexible.length > 1) {
				return { error: `${label}Anchor matches ${flexible.length} places. Use a more unique anchor (add a distinctive line).` };
			}
			anchorRanges = [flexible[0]];
			anchorLenient = true;
		} else if (anchorRanges.length > 1) {
			return { error: `${label}Anchor matches ${anchorRanges.length} places. Use a more unique anchor (add a distinctive line).` };
		}
		const anchorFirstLine = anchor.split('\n')[0] ?? '';
		const replacementForInsert = (r: IMatchRange): string => {
			const matched = content.slice(r.start, r.start + r.length);
			const matchedFirstLine = matched.split('\n')[0] ?? '';
			const text = anchorLenient ? reindentReplacement(patch.newString, anchorFirstLine, matchedFirstLine) : patch.newString;
			return insertAfter ? `${matched}\n${text}` : `${text}\n${matched}`;
		};
		return { ranges: anchorRanges, replacementFor: replacementForInsert, lenient: anchorLenient };
	}

	// --- REPLACE patch. ---
	const oldString = patch.oldString ?? '';
	if (oldString === patch.newString) {
		return { error: `${label}oldString and newString are identical - no change.` };
	}
	if (oldString.length === 0) {
		return { error: `${label}oldString is empty. Provide the text to replace, or use insertAfter/insertBefore to ADD code; use a single modifyFile with oldString "" to create/overwrite a whole file.` };
	}
	let ranges = findExactRanges(content, oldString, patch.replaceAll ?? false);
	let lenient = false;
	if (ranges.length === 0) {
		const flexible = findFlexibleMatches(content, oldString);
		if (flexible.length === 0) {
			return { error: `${label}String not found. oldString must match the file (copy it exactly from readFile).` };
		}
		if (flexible.length > 1 && !patch.replaceAll) {
			return { error: `${label}Found ${flexible.length} places matching oldString (ignoring indentation). Add more surrounding context or set replaceAll=true.` };
		}
		ranges = patch.replaceAll ? flexible : [flexible[0]];
		lenient = true;
	} else if (ranges.length > 1 && !patch.replaceAll) {
		return { error: `${label}Found ${ranges.length} occurrences. Make oldString unique (add context) or set replaceAll=true.` };
	}
	const oldFirstLine = oldString.split('\n')[0] ?? '';
	const replacementFor = (r: IMatchRange): string => {
		if (!lenient) { return patch.newString; }
		const matchedFirstLine = content.slice(r.start).split('\n')[0] ?? '';
		return reindentReplacement(patch.newString, oldFirstLine, matchedFirstLine);
	};
	return { ranges, replacementFor, lenient };
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
	 * Apply an edits[] array to an existing file: each patch is resolved and applied in ORDER against the
	 * evolving content (a later patch can target text an earlier one produced), and the whole set is atomic -
	 * if any patch fails to match, nothing is written and the failing patch is reported so the model can fix
	 * just that one. The result is committed to the editing session as a single full-file replacement (the
	 * diff view still renders granular per-line red/green), keeping checkpoint/undo intact.
	 */
	private async _applyMultiEdit(invocation: IToolInvocation, fileUri: URI, displayPath: string, fileName: string, currentContent: string, edits: IEditPatch[], progress: ToolProgress): Promise<IToolResult> {
		progress.report({ message: buildFileLinkInvocationMessage(localize('modifyFile.editingMulti', "Editing {0}", '{0}'), fileName, fileUri) });

		let working = currentContent;
		let totalReplacements = 0;
		let lenientCount = 0;
		let skippedCount = 0;
		for (let i = 0; i < edits.length; i++) {
			const label = `Edit ${i + 1}/${edits.length}: `;
			const resolved = resolvePatch(working, edits[i], label);
			if (hasKey(resolved, { error: true })) {
				return {
					content: [{ kind: 'text', value: `Error: ${resolved.error} No changes were written (all-or-nothing). Next: readFile "${displayPath}" to get the exact current text, fix this patch's oldString, and resend the whole edits[] call.` }],
					toolResultError: 'Multi-edit patch failed'
				};
			}
			// Idempotent-insert skip: the code was already present, so this patch is a harmless no-op. Keep
			// going (don't fail the batch) - this is how a re-issued "add power/modulo" avoids duplicating.
			if (hasKey(resolved, { skip: true })) {
				skippedCount++;
				continue;
			}
			const before = working;
			working = applyRanges(working, resolved.ranges, resolved.replacementFor);
			if (working === before) {
				return {
					content: [{ kind: 'text', value: `Error: ${label}produced no change. Next: remove this patch or give it a different newString, then resend edits[].` }],
					toolResultError: 'Multi-edit patch no-op'
				};
			}
			totalReplacements += resolved.ranges.length;
			if (resolved.lenient) { lenientCount++; }
		}

		const finalContent = working;

		// Everything was already present (all patches skipped) - nothing to write. Report success so the model
		// stops re-trying instead of looping on an "already done" edit.
		if (finalContent === currentContent) {
			return {
				content: [{ kind: 'text', value: `No changes needed for "${displayPath}" - the requested edit(s) are already present (${skippedCount} skipped). Proceed to the next step or goal; do NOT re-apply them.` }]
			};
		}

		const lenientNote = lenientCount > 0 ? ` (${lenientCount} matched leniently)` : '';
		const skipNote = skippedCount > 0 ? ` (${skippedCount} already present, skipped)` : '';
		const successMessage = `Successfully applied ${edits.length - skippedCount} edit(s) to "${displayPath}" (${totalReplacements} replacement(s))${lenientNote}${skipNote}. Proceed to the next step or goal.`;

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
				const textEdits: TextEdit[] = [{ range: fullRange, text: finalContent }];
				const undoStopId = generateUuid();
				model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
				model.acceptResponseProgress(request, { kind: 'codeblockUri', uri, isEdit: true, undoStopId });
				model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
				model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [] });
				model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: textEdits });
				model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [], done: true });
				this._revealInEditor(fileUri);
				const lintFailure = await this.getLintFailureAfterEdit(fileUri, displayPath);
				if (lintFailure) { return lintFailure; }
				return { content: [{ kind: 'text', value: successMessage }] };
			}
		}

		await this.fileService.writeFile(fileUri, VSBuffer.fromString(finalContent));
		this._revealInEditor(fileUri);
		const lintFailure = await this.getLintFailureAfterEdit(fileUri, displayPath);
		if (lintFailure) { return lintFailure; }
		return { content: [{ kind: 'text', value: successMessage }] };
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

		// --- Multi-edit (edits[]) streaming --- the array grows patch by patch as the model streams it.
		// Show the file name as soon as it is known, then tick up the count of patches and the cumulative
		// +added/-removed line delta so the card updates live. IMPORTANT: a patch is either a REPLACE
		// (oldString+newString) or an INSERT (insertAfter/insertBefore + newString, NO oldString) - so we
		// count any patch that has a newString (including the one still streaming, so the count ticks up
		// token by token), and take removed lines from oldString only when present.
		if (Array.isArray(input.edits)) {
			const patches = input.edits as Array<Partial<IEditPatch>>;
			let added = 0, removed = 0, withContent = 0;
			for (const e of patches) {
				if (!e || typeof e !== 'object') { continue; }
				const ns = typeof e.newString === 'string' ? e.newString : '';
				const os = typeof e.oldString === 'string' ? e.oldString : '';
				if (ns.length > 0) { added += ns.split('\n').length; withContent++; }
				if (os.length > 0) { removed += os.split('\n').length; }
			}
			const deltaParts: string[] = [];
			if (added > 0) { deltaParts.push(`+${added}`); }
			if (removed > 0) { deltaParts.push(`-${removed}`); }
			const delta = deltaParts.length > 0 ? deltaParts.join(' / ') : '0';
			const count = String(withContent);
			if (!path) {
				return { invocationMessage: localize('modifyFile.streaming.editsPreparing', "Preparing edits ({0} applied, {1} lines)", count, delta) };
			}
			const editsFileName = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
			const editsFileUri = resolveToolFileUri(path, this.workspaceService);
			const editsTemplate = localize('modifyFile.streaming.editsProgress', "Editing {0} ({1} edits, {2} lines)", '{0}', count, delta);
			return { invocationMessage: buildFileLinkInvocationMessage(editsTemplate, editsFileName, editsFileUri) };
		}

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

		// `path` must be a non-empty string at the TOP LEVEL. Weak models sometimes nest it inside an
		// edits[] element (or omit it), which previously crashed on `params.path.startsWith(...)` with a
		// cryptic "Cannot read properties of undefined" and the file name shown as "undefined". Recover a
		// nested path if the model put one there, otherwise return a clear, actionable error.
		if (typeof params.path !== 'string' || params.path.trim().length === 0) {
			const nestedPath = Array.isArray(params.edits)
				? params.edits.map(e => (e && typeof (e as Record<string, unknown>).path === 'string') ? (e as Record<string, unknown>).path as string : undefined).find(p => typeof p === 'string' && p.trim().length > 0)
				: undefined;
			if (typeof nestedPath === 'string' && nestedPath.trim().length > 0) {
				params.path = nestedPath;
			} else {
				return {
					content: [{ kind: 'text', value: `Error: modifyFile needs "path" (the file to edit) as a TOP-LEVEL argument - e.g. modifyFile(path: "src/calc.py", edits: [{ insertAfter: "...", newString: "..." }]). Do NOT put path inside an edits[] item. Next: resend with a top-level path.` }],
					toolResultError: 'Missing path'
				};
			}
		}

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

			let isEmptyOld = params.oldString.length === 0;
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

			// Whole-file-in-oldString guard: if the model pasted the ENTIRE current file into oldString to
			// "rewrite" it (a common, wasteful mistake), treat it as a full overwrite instead of a brittle
			// exact string replace. An empty oldString already means "full write", so this normalizes the
			// wasteful form to the cheap one and routes it through the full-overwrite branch (shrink guard
			// still applies). Only when the file exists and the strings truly cover the whole file.
			if (fileExists && !isEmptyOld && params.oldString.trim() === currentContent.trim()) {
				params.oldString = '';
				isEmptyOld = true;
			}

			// --- Multi-edit (edits[] array) --- applied in order, atomically, against the existing file.
			// A top-level insertAfter/insertBefore is normalized into a single-patch edits[] so inserts and
			// the array path share one code path.
			let patchSource: IEditPatch[] | undefined = params.edits;
			if (!Array.isArray(patchSource) && (typeof params.insertAfter === 'string' || typeof params.insertBefore === 'string')) {
				patchSource = [{ insertAfter: params.insertAfter, insertBefore: params.insertBefore, newString: params.newString }];
			}
			// Accept both REPLACE patches (oldString+newString) and INSERT patches (insertAfter/insertBefore
			// + newString). newString is always required; the target is either oldString or an insert anchor.
			const editsArray: IEditPatch[] = Array.isArray(patchSource)
				? patchSource.filter((e): e is IEditPatch =>
					!!e && typeof e.newString === 'string' &&
					(typeof e.oldString === 'string' || typeof e.insertAfter === 'string' || typeof e.insertBefore === 'string'))
				: [];
			if (editsArray.length > 0) {
				if (!fileExists) {
					return {
						content: [{ kind: 'text', value: `Error: Cannot apply edits[] to "${params.path}" because it does not exist. Next: Create it first with modifyFile(path, "", fullContents), then apply targeted edits.` }],
						toolResultError: 'File does not exist'
					};
				}
				return await this._applyMultiEdit(invocation, fileUri, params.path, fileName, currentContent, editsArray, progress);
			}

			// edits[] (or an insert) was intended but NOTHING valid parsed. Do NOT fall through to the
			// create/overwrite path below - with empty top-level oldString/newString that would try to blank
			// the file and return a misleading "empty overwrite" error. Give a patch-shaped hint instead.
			if (Array.isArray(patchSource)) {
				return {
					content: [{ kind: 'text', value: `Error: You provided edits[] but no patch was valid. Each patch needs a "newString" AND either an "oldString" (to replace) or "insertAfter"/"insertBefore" (to add). Do NOT also pass top-level oldString/newString when using edits[]. Next: resend modifyFile with a well-formed edits[] array.` }],
					toolResultError: 'No valid edits'
				};
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
				// Empty-overwrite guard: a full write (oldString "") with empty newString would blank an
				// existing non-empty file. That is almost never intended (and is easy to hit now that
				// oldString/newString are optional in the schema) - refuse unless force is set.
				if (params.newString.length === 0 && currentContent.length > 0 && !params.force) {
					return {
						content: [{ kind: 'text', value: `Error: Refusing to overwrite existing file "${params.path}" with EMPTY content - this would erase it. Next: Provide the new full contents in newString, use a targeted edit/edits[] to change part of it, or resend with force: true if you truly want to empty the file.` }],
						toolResultError: 'Empty overwrite refused'
					};
				}
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

			// Find where oldString occurs. Exact match first; if none, fall back to a whitespace/indent-
			// tolerant line-block match so a small indentation slip doesn't force a whole-file rewrite.
			let matchRanges = findExactRanges(currentContent, params.oldString, params.replaceAll ?? false);
			let matchedLeniently = false;
			if (matchRanges.length === 0) {
				const flexible = findFlexibleMatches(currentContent, params.oldString);
				if (flexible.length === 0) {
					const firstLine = currentContent.split('\n')[0] ?? '';
					const hint = firstLine.length > 0
						? `\n\nOn the next turn, call modifyFile again with oldString set to this exact value (copy character-for-character):\n${JSON.stringify(firstLine)}`
						: '';
					return {
						content: [{ kind: 'text', value: `Error: String not found in "${params.path}". oldString must match the file exactly. Next: Call readFile to get exact content, then copy it for oldString.${hint}` }],
						toolResultError: 'String not found'
					};
				}
				if (flexible.length > 1 && !params.replaceAll) {
					return {
						content: [{ kind: 'text', value: `Error: Found ${flexible.length} places matching oldString (ignoring indentation) in "${params.path}". Next: Add more surrounding context to make oldString unique, or set replaceAll=true.` }],
						toolResultError: 'Ambiguous match'
					};
				}
				matchRanges = params.replaceAll ? flexible : [flexible[0]];
				matchedLeniently = true;
			} else if (matchRanges.length > 1 && !params.replaceAll) {
				return {
					content: [{
						kind: 'text',
						value: `Error: Found ${matchRanges.length} occurrences. Next: Either make oldString unique (add more context) or set replaceAll=true to replace all.`
					}],
					toolResultError: 'Ambiguous match'
				};
			}

			// On a lenient match the model's newString is indented to ITS guessed indentation; re-base each
			// replacement to the file's real indentation at that match. On an exact match, use newString as-is.
			const oldFirstLine = params.oldString.split('\n')[0] ?? '';
			const replacementFor = (r: IMatchRange): string => {
				if (!matchedLeniently) { return params.newString; }
				const matchedFirstLine = currentContent.slice(r.start).split('\n')[0] ?? '';
				return reindentReplacement(params.newString, oldFirstLine, matchedFirstLine);
			};

			const newContent = applyRanges(currentContent, matchRanges, replacementFor);
			const replacementCount = matchRanges.length;
			const lenientNote = matchedLeniently ? ' (matched leniently, adjusted for indentation)' : '';
			const successMessage = `Successfully edited "${params.path}" (replaced ${replacementCount} occurrence(s))${lenientNote}. Proceed to the next step or goal.`;

			const uri = CellUri.parse(fileUri)?.notebook ?? fileUri;
			const isNotebook = this.notebookService.hasSupportedNotebooks(uri) && this.notebookService.getNotebookTextModel(uri);
			if (invocation.context && !isNotebook) {
				const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
				const request = model?.getRequests().at(-1);
				const editSession = model?.editingSession;
				if (request && editSession) {
					const edits = rangesToEdits(currentContent, matchRanges, replacementFor);
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
