/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared helpers for the split edit tools (createFile / editFile / insertCode). All the fiddly bits -
 * whitespace-tolerant matching, patch resolution, applying an edits[] batch, committing to the chat
 * editing session (so the diff/keep-undo UI works), post-edit lint reporting, and streaming line counts -
 * live here so each tool file stays a thin, single-purpose wrapper with a fixed, unambiguous signature.
 */

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { hasKey } from '../../../../../../base/common/types.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IRange } from '../../../../../../editor/common/core/range.js';
import { TextEdit } from '../../../../../../editor/common/languages.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IMarkerService, MarkerSeverity } from '../../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { CellUri } from '../../../../notebook/common/notebookCommon.js';
import { INotebookService } from '../../../../notebook/common/notebookService.js';
import { ChatModel } from '../../model/chatModel.js';
import { IChatService } from '../../chatService/chatService.js';
import { IToolInvocation, IToolResult } from '../languageModelToolsService.js';

// ---------------------------------------------------------------------------------------------------
// Matching primitives
// ---------------------------------------------------------------------------------------------------

/** An offset+length span of matched text inside the file content. */
export interface IMatchRange { start: number; length: number }

/**
 * A single patch within an edits[] batch. Two shapes:
 *  - REPLACE: {oldString, newString} - replace matched text.
 *  - INSERT:  {insertAfter | insertBefore, newString} - insert relative to a short anchor line.
 */
export interface IEditPatch {
	oldString?: string;
	newString: string;
	replaceAll?: boolean;
	insertAfter?: string;
	insertBefore?: string;
}

/** Convert a byte offset and length in content to an editor IRange (1-based line/column). */
export function offsetToRange(content: string, startOffset: number, length: number): IRange {
	let line = 1, col = 1;
	for (let i = 0; i < startOffset && i < content.length; i++) {
		if (content[i] === '\n') { line++; col = 1; } else { col++; }
	}
	const startLine = line, startCol = col;
	for (let i = 0; i < length && (startOffset + i) < content.length; i++) {
		if (content[startOffset + i] === '\n') { line++; col = 1; } else { col++; }
	}
	return { startLineNumber: startLine, startColumn: startCol, endLineNumber: line, endColumn: col };
}

/** Leading whitespace (indentation) of a single line. */
function leadingWhitespace(line: string): string {
	const m = line.match(/^[ \t]*/);
	return m ? m[0] : '';
}

/** Exact, non-overlapping occurrences of oldString in content (left to right, matching split/join semantics). */
export function findExactRanges(content: string, oldString: string, replaceAll: boolean): IMatchRange[] {
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
 * Whitespace/indentation-tolerant fallback matcher. Finds contiguous LINE blocks whose trimmed content
 * equals the trimmed oldString lines, and returns their real offsets in `content` (preserving the file's
 * actual indentation). Only whole-line blocks; returns [] for whitespace-only input.
 */
export function findFlexibleMatches(content: string, oldString: string): IMatchRange[] {
	if (oldString.trim().length === 0) { return []; }
	const oldLines = oldString.split('\n');
	const normOld = oldLines.map(l => l.trim());
	const contentLines = content.split('\n');
	const lineStart: number[] = [];
	let acc = 0;
	for (const l of contentLines) { lineStart.push(acc); acc += l.length + 1; }
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
		i = lastIdx;
	}
	return ranges;
}

/** Re-base the indentation of `newString` from the model's guessed indent to the file's real indent. */
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

/** Build TextEdit[] from match ranges; ordered end-to-start so applied offsets never shift. */
export function rangesToEdits(content: string, ranges: IMatchRange[], replacement: (r: IMatchRange) => string): TextEdit[] {
	return [...ranges].sort((a, b) => b.start - a.start).map(r => ({
		range: offsetToRange(content, r.start, r.length),
		text: replacement(r)
	}));
}

/** Apply match ranges to content (end-to-start) producing the new full content. */
export function applyRanges(content: string, ranges: IMatchRange[], replacement: (r: IMatchRange) => string): string {
	let out = content;
	for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
		out = out.slice(0, r.start) + replacement(r) + out.slice(r.start + r.length);
	}
	return out;
}

export type ResolvedPatch =
	| { ranges: IMatchRange[]; replacementFor: (r: IMatchRange) => string; lenient: boolean }
	| { error: string }
	| { skip: true; reason: string };

/**
 * Resolve one patch (REPLACE or INSERT) against `content`: find match ranges (exact first, then
 * whitespace/indent-tolerant) and return per-range replacement text. Returns `error` for a failed match
 * or `skip` for an idempotent insert whose block is already present. `label` prefixes error text.
 */
export function resolvePatch(content: string, patch: IEditPatch, label: string): ResolvedPatch {
	const insertAfter = typeof patch.insertAfter === 'string' && patch.insertAfter.length > 0;
	const insertBefore = typeof patch.insertBefore === 'string' && patch.insertBefore.length > 0;
	if (insertAfter || insertBefore) {
		const anchor = (insertAfter ? patch.insertAfter : patch.insertBefore) as string;
		if (patch.newString.length === 0) {
			return { error: `${label}newString to insert is empty - provide the code to add.` };
		}
		// Idempotent insert: skip an EXACT multi-line block that is already present (weak models re-issue an
		// insert they already made). Conservative: only >= 2 non-blank lines, and any differing line means
		// no match so it inserts normally - a short/common single line is never suppressed.
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

	const oldString = patch.oldString ?? '';
	if (oldString === patch.newString) {
		return { error: `${label}oldString and newString are identical - no change.` };
	}
	if (oldString.length === 0) {
		return { error: `${label}oldString is empty. Provide the text to replace, or use insertAfter/insertBefore to ADD code.` };
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

/** Result of applying a whole edits[] batch to file content. */
export type BatchResult =
	| { finalContent: string; applied: number; replacements: number; lenientCount: number; skippedCount: number }
	| { error: string };

/**
 * Apply an edits[] batch in ORDER against evolving content (a later patch may target text an earlier one
 * produced). Atomic: a failed patch aborts the whole batch. Idempotent inserts are skipped, not failed.
 */
export function applyPatchBatch(currentContent: string, patches: IEditPatch[]): BatchResult {
	let working = currentContent;
	let replacements = 0;
	let lenientCount = 0;
	let skippedCount = 0;
	for (let i = 0; i < patches.length; i++) {
		const label = `Edit ${i + 1}/${patches.length}: `;
		const resolved = resolvePatch(working, patches[i], label);
		if (hasKey(resolved, { error: true })) { return { error: resolved.error }; }
		if (hasKey(resolved, { skip: true })) { skippedCount++; continue; }
		const before = working;
		working = applyRanges(working, resolved.ranges, resolved.replacementFor);
		if (working === before) { return { error: `${label}produced no change. Remove this patch or give it a different newString.` }; }
		replacements += resolved.ranges.length;
		if (resolved.lenient) { lenientCount++; }
	}
	return { finalContent: working, applied: patches.length - skippedCount, replacements, lenientCount, skippedCount };
}

// ---------------------------------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------------------------------

/** Resolve a workspace-relative or absolute path to a URI, or return an error IToolResult. */
export function resolvePathToUri(path: string | undefined, workspaceService: IWorkspaceContextService): { uri: URI } | { error: IToolResult } {
	if (typeof path !== 'string' || path.trim().length === 0) {
		return { error: { content: [{ kind: 'text', value: `Error: "path" (the file to act on) is required as a top-level argument. Next: resend with a valid path.` }], toolResultError: 'Missing path' } };
	}
	if (path.startsWith('/') || path.match(/^[a-zA-Z]:/)) {
		return { uri: URI.file(path) };
	}
	const workspace = workspaceService.getWorkspace();
	if (workspace.folders.length === 0) {
		return { error: { content: [{ kind: 'text', value: `Error: No workspace folder open. Next: Open a folder (File > Open Folder) and retry, or use an absolute path.` }], toolResultError: 'No workspace folder' } };
	}
	return { uri: URI.joinPath(workspace.folders[0].uri, path) };
}

// ---------------------------------------------------------------------------------------------------
// Commit + lint + reveal (the chat-editing-session dance)
// ---------------------------------------------------------------------------------------------------

/** Services the commit helper needs; tools pass their injected instances. */
export interface IEditToolServices {
	readonly fileService: IFileService;
	readonly chatService: IChatService;
	readonly notebookService: INotebookService;
	readonly markerService: IMarkerService;
	readonly editorService: IEditorService;
	readonly modelService: IModelService;
}

/**
 * Read the file's CURRENT content for editing. Critically, when a chat editing session has an in-memory
 * text model for this file (because a previous edit THIS turn is applied to the model but not yet flushed
 * to disk), we must read from that live model - not `fileService.readFile`, which returns the stale on-disk
 * bytes. Reading disk while writing through the session makes sequential edits in one turn diverge, so
 * later oldStrings stop matching ("String not found") even though the model shows the expected text.
 */
export async function readContentForEdit(services: IEditToolServices, fileUri: URI): Promise<{ content: string } | { notFound: true }> {
	const model = services.modelService.getModel(fileUri);
	if (model && !model.isDisposed()) {
		return { content: model.getValue() };
	}
	try {
		return { content: (await services.fileService.readFile(fileUri)).value.toString() };
	} catch {
		return { notFound: true };
	}
}

const LINT_CHECK_DELAY_MS = 150;

/** Reveal a just-created/edited file (best-effort, non-focus-stealing preview tab). */
export function revealInEditor(editorService: IEditorService, fileUri: URI): void {
	const resource = CellUri.parse(fileUri)?.notebook ?? fileUri;
	editorService.openEditor({ resource, options: { preserveFocus: true, pinned: false } }).catch(() => { });
}

/** After a write, surface any NEW error-severity lint markers so the model can fix them. */
export async function getLintFailureAfterEdit(markerService: IMarkerService, fileUri: URI, displayPath: string): Promise<IToolResult | null> {
	await new Promise(resolve => setTimeout(resolve, LINT_CHECK_DELAY_MS));
	const markers = markerService.read({ resource: fileUri, severities: MarkerSeverity.Error });
	if (markers.length === 0) { return null; }
	markers.sort((a, b) => a.startLineNumber - b.startLineNumber);
	const lines: string[] = [];
	for (const m of markers) {
		const code = m.code ? ` [${typeof m.code === 'object' ? m.code.value : m.code}]` : '';
		const source = m.source ? ` (${m.source})` : '';
		lines.push(`  ${m.startLineNumber}:${m.startColumn} - error${code}: ${m.message}${source}`);
	}
	const message = `Successfully wrote "${displayPath}", but the following linter errors were introduced:\n\n${displayPath} (${markers.length} error(s)):\n${lines.join('\n')}\n\nNext: Fix these errors.`;
	return { content: [{ kind: 'text', value: message }], toolResultError: 'Linter errors introduced' };
}

/**
 * Commit `textEdits` (computed against the file's current content) to the file. When a chat editing session
 * is active and the file is not a notebook, route through it so the UI shows the diff / keep-undo / "1 of n".
 * Otherwise write `newContent` straight to disk. Then reveal + lint. `create` picks the disk fallback
 * (createFile vs writeFile) and is harmless when a session handles the write.
 */
export async function commitEdits(
	services: IEditToolServices,
	invocation: IToolInvocation,
	fileUri: URI,
	displayPath: string,
	textEdits: TextEdit[],
	newContent: string,
	successMessage: string,
	create: boolean
): Promise<IToolResult> {
	const uri = CellUri.parse(fileUri)?.notebook ?? fileUri;
	const isNotebook = services.notebookService.hasSupportedNotebooks(uri) && services.notebookService.getNotebookTextModel(uri);
	if (invocation.context && !isNotebook) {
		const model = services.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
		const request = model?.getRequests().at(-1);
		const editSession = model?.editingSession;
		if (model && request && editSession) {
			const undoStopId = generateUuid();
			model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
			model.acceptResponseProgress(request, { kind: 'codeblockUri', uri, isEdit: true, undoStopId });
			model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString('\n````\n') });
			model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [] });
			model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: textEdits });
			model.acceptResponseProgress(request, { kind: 'textEdit', uri, edits: [], done: true });
			revealInEditor(services.editorService, fileUri);
			const lintFailure = await getLintFailureAfterEdit(services.markerService, fileUri, displayPath);
			return lintFailure ?? { content: [{ kind: 'text', value: successMessage }] };
		}
	}
	if (create) {
		await services.fileService.createFile(fileUri, VSBuffer.fromString(newContent), { overwrite: true });
	} else {
		await services.fileService.writeFile(fileUri, VSBuffer.fromString(newContent));
	}
	revealInEditor(services.editorService, fileUri);
	const lintFailure = await getLintFailureAfterEdit(services.markerService, fileUri, displayPath);
	return lintFailure ?? { content: [{ kind: 'text', value: successMessage }] };
}

// ---------------------------------------------------------------------------------------------------
// Streaming line-count helpers (for handleToolStream cards)
// ---------------------------------------------------------------------------------------------------

/** "+A / -R" fragment from added/removed line counts (each omitted when 0; "0" when both empty). */
export function formatDelta(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0) { parts.push(`+${added}`); }
	if (removed > 0) { parts.push(`-${removed}`); }
	return parts.length > 0 ? parts.join(' / ') : '0';
}

/** Line count of a string (0 for empty/non-string). */
export function lineCount(s: string | undefined): number {
	return typeof s === 'string' && s.length > 0 ? s.split('\n').length : 0;
}

/** Cumulative +added/-removed and count-with-content across a (possibly partial) edits[] array. */
export function summarizeEditsStream(patches: Array<Partial<IEditPatch>>): { added: number; removed: number; withContent: number } {
	let added = 0, removed = 0, withContent = 0;
	for (const e of patches) {
		if (!e || typeof e !== 'object') { continue; }
		const ns = typeof e.newString === 'string' ? e.newString : '';
		const os = typeof e.oldString === 'string' ? e.oldString : '';
		if (ns.length > 0) { added += ns.split('\n').length; withContent++; }
		if (os.length > 0) { removed += os.split('\n').length; }
	}
	return { added, removed, withContent };
}
