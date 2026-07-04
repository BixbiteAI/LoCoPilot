/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IReference } from '../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { resolveToolFileUri } from '../../common/tools/builtinTools/toolHelpers.js';

/** Partial modifyFile arguments as they stream in (every field may be missing or truncated). */
interface IPartialModifyFileInput {
	path?: unknown;
	oldString?: unknown;
	newString?: unknown;
}

interface ILiveEditSession {
	mode: 'create' | 'edit';
	fileUri: URI;
	/** Pinned model of the file (keeps it alive for typing/reveal). */
	modelRef?: IReference<IResolvedTextEditorModel>;
	/** Whether WE created the file on disk (so a never-invoked call can delete it again). */
	createdFile: boolean;
	/** Content already typed into the buffer. */
	written: string;
	/** Whether the edit target (oldString) has been revealed/selected already. */
	revealedTarget: boolean;
	/** Set by prepareForInvoke: no further streamed updates may touch the buffer. */
	sealed: boolean;
	closed: boolean;
	/** Serializes all async work for this session so updates/prepare/finalize never interleave. */
	queue: Promise<void>;
}

/**
 * Live "the agent is typing into the editor" preview for streaming modifyFile calls.
 *
 * CREATE (file doesn't exist): once real content starts streaming, the target file is created on
 * disk, opened, and the streamed content is typed directly into its buffer. Right before the tool
 * executes, {@link prepareForInvoke} writes the FINAL arguments into the buffer and saves it -
 * so the tool's overwrite path sees disk content that already equals its newString and takes its
 * no-op fast path instead of fighting the buffer through the editing session.
 *
 * EDIT (file exists): the file is opened and, once the call's oldString has fully streamed, the
 * exact range being replaced is revealed and selected. The buffer itself is NOT mutated while
 * streaming - the real write happens through the tool so keep/undo semantics stay intact.
 *
 * Callers must gate this off in Ask mode (the tool refuses edits there, and the preview must not
 * create files the tool would refuse to). Failures are logged and never affect the agent loop.
 */
export class LiveEditStreamer {

	private readonly _sessions = new Map<string, ILiveEditSession>();

	constructor(
		private readonly fileService: IFileService,
		private readonly textModelService: ITextModelService,
		private readonly textFileService: ITextFileService,
		private readonly editorService: IEditorService,
		private readonly codeEditorService: ICodeEditorService,
		private readonly workspaceService: IWorkspaceContextService,
		private readonly log: (msg: string) => void,
	) { }

	/**
	 * True only when the raw streamed argument text contains a fully CLOSED `"path": "..."` string.
	 * The partial-JSON repair transiently closes a truncated path (e.g. `"src/fo`), and models
	 * don't reliably emit fields in schema order, so the parsed object alone can't prove the path
	 * is complete - acting on a truncated path creates/opens the WRONG file.
	 */
	private static _hasCompletePath(rawArgsText: string): boolean {
		return /"path"\s*:\s*"(?:[^"\\]|\\.)*"/.test(rawArgsText);
	}

	/** Feed the latest best-effort-parsed partial input for a streaming modifyFile call. */
	update(toolCallId: string, input: Record<string, unknown>, rawArgsText: string, token: CancellationToken): Promise<void> {
		return this._enqueue(toolCallId, async () => {
			if (token.isCancellationRequested) {
				return;
			}
			const partial = input as IPartialModifyFileInput;
			const path = typeof partial.path === 'string' && partial.path.trim().length > 0 ? partial.path : undefined;
			if (!path || !LiveEditStreamer._hasCompletePath(rawArgsText)) {
				return;
			}

			let session = this._sessions.get(toolCallId);
			if (!session) {
				session = await this._beginSession(toolCallId, path, partial);
				if (!session) {
					return; // not enough info yet - retry on the next tick
				}
			}
			if (session.closed || session.sealed) {
				return;
			}

			if (session.mode === 'create') {
				this._typeIntoBuffer(session, typeof partial.newString === 'string' ? partial.newString : undefined);
			} else {
				this._revealEditTarget(session, partial);
			}
		});
	}

	/**
	 * Called right before the real tool call executes. For a live-typed CREATE this writes the
	 * final, authoritative arguments into the buffer and SAVES it, so the tool finds disk content
	 * identical to its newString and skips its own write (no editing-session/dirty-buffer clash).
	 * If saving fails the buffer is reverted so the tool's normal path stays correct.
	 */
	prepareForInvoke(toolCallId: string, parameters: unknown): Promise<void> {
		return this._enqueue(toolCallId, async () => {
			const session = this._sessions.get(toolCallId);
			if (!session || session.closed || session.sealed) {
				return;
			}
			session.sealed = true; // no late streamed updates may dirty the buffer after this point
			if (session.mode !== 'create') {
				return;
			}
			const params = parameters as IPartialModifyFileInput | undefined;
			// Safety net: if the final arguments target a DIFFERENT file than the previewed one
			// (any residual truncated/mangled-path case), the preview must be rolled back - saving
			// it would leave a stray duplicate file next to the one the tool is about to write.
			const finalUri = typeof params?.path === 'string' ? resolveToolFileUri(params.path, this.workspaceService) : undefined;
			if (!finalUri || finalUri.toString() !== session.fileUri.toString()) {
				this.log(`[LoCoPilot] Live edit preview path mismatch (previewed ${session.fileUri.toString()}, final ${finalUri?.toString() ?? 'unknown'}); rolling back.`);
				await this._rollbackCreate(session);
				return;
			}
			const finalContent = typeof params?.newString === 'string' ? params.newString : session.written;
			try {
				const model = session.modelRef?.object.textEditorModel;
				if (model && !model.isDisposed() && model.getValue() !== finalContent) {
					model.setValue(finalContent);
				}
				await this.textFileService.save(session.fileUri);
				this.log(`[LoCoPilot] Live edit preview saved before invoke: ${session.fileUri.toString()}`);
			} catch (e) {
				// Couldn't save: discard the preview content so the tool writes from a clean slate.
				this.log(`[LoCoPilot] Live edit preview save failed, reverting (ignored): ${e}`);
				try {
					await this.textFileService.revert(session.fileUri);
				} catch { /* best effort */ }
			}
		});
	}

	/**
	 * Close a session. `invoked: true` after the real tool call ran (the file stays; just release
	 * the model). `invoked: false` when the call was cancelled or never executed - the preview is
	 * rolled back: buffer reverted, and if WE created the file it is deleted again.
	 */
	finalize(toolCallId: string, invoked: boolean): Promise<void> {
		return this._enqueue(toolCallId, async () => {
			const session = this._sessions.get(toolCallId);
			if (!session || session.closed) {
				return;
			}
			session.closed = true;
			this._sessions.delete(toolCallId);

			try {
				if (session.mode === 'create') {
					if (!invoked) {
						// The call never ran: roll the preview back completely.
						await this._rollbackCreate(session);
					} else if (this.textFileService.isDirty(session.fileUri)) {
						// Unsaved preview content (save failed): discard it so the buffer never
						// conflicts with whatever the tool actually wrote to disk.
						await this.textFileService.revert(session.fileUri);
					}
				}
			} catch (e) {
				this.log(`[LoCoPilot] Live edit preview finalize failed (ignored): ${e}`);
			} finally {
				session.modelRef?.dispose();
				session.modelRef = undefined;
			}
		});
	}

	/**
	 * Undo everything a CREATE preview did: discard unsaved buffer content, close the tab we
	 * opened, and delete the file we created. Best-effort; never throws.
	 */
	private async _rollbackCreate(session: ILiveEditSession): Promise<void> {
		try {
			if (this.textFileService.isDirty(session.fileUri)) {
				await this.textFileService.revert(session.fileUri);
			}
			if (session.createdFile) {
				for (const editor of this.editorService.findEditors(session.fileUri)) {
					await this.editorService.closeEditor(editor, { preserveFocus: true });
				}
				await this.fileService.del(session.fileUri);
				this.log(`[LoCoPilot] Live edit preview rolled back (deleted): ${session.fileUri.toString()}`);
			}
		} catch (e) {
			this.log(`[LoCoPilot] Live edit preview rollback failed (ignored): ${e}`);
		}
	}

	/** Chain work per tool call so async updates, prepare and finalize never interleave. */
	private _enqueue(toolCallId: string, work: () => Promise<void>): Promise<void> {
		const session = this._sessions.get(toolCallId);
		const previous = session?.queue ?? Promise.resolve();
		const next = previous.then(work).catch(e => {
			this.log(`[LoCoPilot] Live edit preview error (ignored): ${e}`);
		});
		const after = this._sessions.get(toolCallId);
		if (after) {
			after.queue = next;
		}
		return next;
	}

	private async _beginSession(toolCallId: string, path: string, partial: IPartialModifyFileInput): Promise<ILiveEditSession | undefined> {
		const fileUri = resolveToolFileUri(path, this.workspaceService);
		if (!fileUri) {
			return undefined;
		}

		const exists = await this.fileService.exists(fileUri);
		let session: ILiveEditSession;
		if (exists) {
			// EDIT: open + pin the model so we can reveal the target range once oldString is known.
			session = { mode: 'edit', fileUri, createdFile: false, written: '', revealedTarget: false, sealed: false, closed: false, queue: Promise.resolve() };
			await this.editorService.openEditor({ resource: fileUri, options: { preserveFocus: true, pinned: false, revealIfOpened: true } });
			session.modelRef = await this.textModelService.createModelReference(fileUri);
		} else {
			// CREATE: only once we KNOW it's a create (oldString streamed as empty) and real content
			// has started arriving - never create an empty file the tool itself might refuse to
			// (its "looks like a directory" guard fires on empty extension-less files).
			if (typeof partial.oldString !== 'string' || partial.oldString.length > 0
				|| typeof partial.newString !== 'string' || partial.newString.length === 0) {
				return undefined;
			}
			await this.fileService.createFile(fileUri, VSBuffer.fromString(''), { overwrite: false });
			session = { mode: 'create', fileUri, createdFile: true, written: '', revealedTarget: false, sealed: false, closed: false, queue: Promise.resolve() };
			await this.editorService.openEditor({ resource: fileUri, options: { preserveFocus: true, pinned: false } });
			session.modelRef = await this.textModelService.createModelReference(fileUri);
		}

		this._sessions.set(toolCallId, session);
		this.log(`[LoCoPilot] Live edit preview started (${session.mode}): ${fileUri.toString()}`);
		return session;
	}

	/** Append the newly streamed content to the file's buffer and keep its end in view. */
	private _typeIntoBuffer(session: ILiveEditSession, newString: string | undefined): void {
		const model = session.modelRef?.object.textEditorModel;
		if (!model || model.isDisposed() || newString === undefined || newString === session.written) {
			return;
		}
		if (newString.startsWith(session.written)) {
			const delta = newString.slice(session.written.length);
			const lastLine = model.getLineCount();
			const lastColumn = model.getLineMaxColumn(lastLine);
			model.applyEdits([{ range: new Range(lastLine, lastColumn, lastLine, lastColumn), text: delta }]);
		} else {
			// The partial-JSON repair can transiently rewrite earlier text; resync wholesale.
			model.setValue(newString);
		}
		session.written = newString;

		for (const editor of this.codeEditorService.listCodeEditors()) {
			if (editor.getModel() === model) {
				editor.revealLine(model.getLineCount());
			}
		}
	}

	/** Once the target string has fully streamed (newString key appeared), reveal + select it. */
	private _revealEditTarget(session: ILiveEditSession, partial: IPartialModifyFileInput): void {
		if (session.revealedTarget || typeof partial.newString !== 'string') {
			return;
		}
		const oldString = typeof partial.oldString === 'string' ? partial.oldString : '';
		session.revealedTarget = true;
		if (oldString.length === 0) {
			return; // whole-file overwrite: nothing specific to point at
		}
		const model = session.modelRef?.object.textEditorModel;
		if (!model || model.isDisposed()) {
			return;
		}
		const startOffset = model.getValue().indexOf(oldString);
		if (startOffset < 0) {
			return;
		}
		const range = Range.fromPositions(model.getPositionAt(startOffset), model.getPositionAt(startOffset + oldString.length));
		for (const editor of this.codeEditorService.listCodeEditors()) {
			if (editor.getModel() === model) {
				editor.revealRangeInCenterIfOutsideViewport(range);
				editor.setSelection(range);
			}
		}
	}
}
