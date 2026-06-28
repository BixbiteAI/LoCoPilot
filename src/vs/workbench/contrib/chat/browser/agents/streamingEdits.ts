/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Streaming-edits mode (Cursor/Aider-style).
 *
 * WHY: local inference servers (llama.cpp, MLX, Ollama) buffer a tool call's `arguments` and only emit them in
 * one chunk at the end of generation, so routing a whole file through `modifyFile(newString=...)` can never
 * stream - the file body appears all at once. The model's *content* stream, however, DOES stream token by
 * token on every backend. So instead of putting file content inside tool-call arguments, we ask the model to
 * write edits as plain text in a parseable SEARCH/REPLACE format, parse that text live as it streams, render it
 * as a diff in real time, and apply it on the fly. This is how Cursor et al. get the live "typing" effect with
 * local models.
 *
 * REVERTING: flip `STREAMING_EDITS_ENABLED` to false. Everything in this file is then dormant and the agent
 * falls back to the normal `modifyFile` tool-call path (which renders a client-chunked card).
 */

/**
 * Master switch for streaming-edits mode. When true: the `modifyFile` tool is hidden from the model, the
 * SEARCH/REPLACE protocol below is appended to the system prompt, and the agent routes the content stream
 * through `StreamingEditFilter`. Flip to false to fully revert to the tool-call path.
 */
export const STREAMING_EDITS_ENABLED = true;

/**
 * Appended to the agent system prompt when streaming edits are enabled. Teaches the model to express every
 * file write as one or more SEARCH/REPLACE blocks instead of calling an edit tool. Kept short and concrete -
 * weaker local models follow simple, example-driven formats best.
 */
export const STREAMING_EDITS_PROTOCOL_PROMPT = `

# WRITING FILES (SEARCH/REPLACE - this replaces any edit tool)
You do NOT have a modifyFile/editFiles tool. To create or change a file, write a SEARCH/REPLACE block directly in your reply, in EXACTLY this format:

<<<<<<< SEARCH file=relative/path/to/file.ext
[exact existing lines to find and replace - copy them character-for-character]
=======
[the new lines that replace them]
>>>>>>> REPLACE

Rules:
- To CREATE a new file or OVERWRITE a whole file: leave the SEARCH section EMPTY and put the full file contents in the REPLACE section.
- To EDIT part of a file: \`readFile\` it first, then put the EXACT text you copied (same whitespace) in the SEARCH section. The SEARCH text must match the file exactly, or the edit is rejected.
- Always put the workspace-relative path on the SEARCH line as \`file=...\`. Parent folders are created automatically - never create directories separately.
- You may include several SEARCH/REPLACE blocks in one reply (for multiple files or multiple edits); each is applied in order as you write it.
- Write normal explanatory prose before/after the blocks as usual - only the text between the markers is treated as an edit.
- Reading tools (readFile, grep, findFiles, listDirectory, etc.) are still normal tool calls; ONLY file writes use this block format.

Example - create a file:
<<<<<<< SEARCH file=src/util/add.py
=======
def add(a, b):
	return a + b
>>>>>>> REPLACE`;

/** Sink callbacks the filter uses to drive the UI and apply edits. */
export interface IStreamingEditSink {
	/** Render text that is OUTSIDE any edit block (normal assistant prose) - emit as markdown. */
	prose: (text: string) => void;
	/** A new edit block began. `isWholeFile` (empty SEARCH = create/overwrite) lets the UI pick a card vs a diff. */
	blockStart: (path: string, isWholeFile: boolean) => void;
	/** A buffered SEARCH (to-be-removed) line, emitted once per line after blockStart. Only for partial edits. */
	blockDeletion: (line: string) => void;
	/** A REPLACE (new) line, streamed live as it arrives. */
	blockReplaceLine: (line: string) => void;
	/** The current edit block finished streaming (close the card/diff). */
	blockEnd: () => void;
	/** Apply a completed edit. `search` empty => create/overwrite with `replace`. Resolved before finalize() returns. */
	apply: (path: string, search: string, replace: string) => Promise<void>;
}

type FilterState = 'out' | 'search' | 'replace';

const RE_SEARCH = /^<{5,}\s*SEARCH(?:\s+file\s*=\s*(.+?))?\s*$/;
const RE_DIVIDER = /^={5,}\s*$/;
const RE_REPLACE = /^>{5,}\s*REPLACE\s*$/;

/**
 * Line-oriented state machine that filters the model's streaming text into (a) normal prose and (b) live diff
 * rendering, and fires `apply` for each completed SEARCH/REPLACE block. Feed it raw text deltas via `push`; it
 * buffers a partial trailing line until the next newline, so markers are never split mid-token. Call `finalize`
 * once the stream ends to flush the last line and await any in-flight applies.
 */
export class StreamingEditFilter {
	private buf = '';
	private state: FilterState = 'out';
	private path = '';
	private search: string[] = [];
	private replace: string[] = [];
	/** Last non-empty prose line seen - used as a fallback path if the model omits `file=` on the SEARCH line. */
	private lastProseLine = '';
	/** Whether the current block's header + opening fence has been emitted yet. */
	private headerEmitted = false;
	/** Chains applies so they run in document order even though each is async. */
	private applyChain: Promise<void> = Promise.resolve();

	constructor(private readonly sink: IStreamingEditSink) { }

	push(delta: string): void {
		this.buf += delta;
		let nl: number;
		while ((nl = this.buf.indexOf('\n')) >= 0) {
			const line = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		const trimmed = line.trimStart();

		if (this.state === 'out') {
			const m = RE_SEARCH.exec(trimmed);
			if (m) {
				this.path = (m[1] ?? this.lastProseLine).trim();
				this.search = [];
				this.replace = [];
				this.headerEmitted = false;
				this.state = 'search';
				return;
			}
			this.sink.prose(line + '\n');
			if (line.trim().length > 0) { this.lastProseLine = line.trim(); }
			return;
		}

		if (this.state === 'search') {
			if (RE_DIVIDER.test(trimmed)) {
				// We now know whether SEARCH was empty (create) or not (edit), so open the block + flush the
				// buffered deletions before the REPLACE additions start streaming.
				this.openBlock();
				this.state = 'replace';
				return;
			}
			// Buffer SEARCH lines (usually small) rather than streaming them - we need the full SEARCH to know
			// whole-file vs partial before opening the block.
			this.search.push(line);
			return;
		}

		// state === 'replace'
		if (RE_REPLACE.test(trimmed)) {
			if (!this.headerEmitted) { this.openBlock(); }
			this.sink.blockEnd();
			const path = this.path;
			const search = this.search.join('\n');
			const replace = this.replace.join('\n');
			this.state = 'out';
			this.headerEmitted = false;
			this.applyChain = this.applyChain.then(() => this.sink.apply(path, search, replace));
			return;
		}
		this.replace.push(line);
		this.sink.blockReplaceLine(line);
	}

	/** Open the current block (card or diff) and flush its buffered SEARCH lines as deletions. */
	private openBlock(): void {
		if (this.headerEmitted) { return; }
		this.headerEmitted = true;
		this.sink.blockStart(this.path || '(unknown file)', this.search.length === 0);
		for (const l of this.search) { this.sink.blockDeletion(l); }
	}

	/** True while inside a SEARCH/REPLACE block (so the caller can avoid treating partial markers as prose). */
	get isInsideBlock(): boolean {
		return this.state !== 'out';
	}

	async finalize(): Promise<void> {
		// Flush a partial trailing line (a final block with no trailing newline still gets processed).
		if (this.buf.length > 0) {
			const last = this.buf;
			this.buf = '';
			this.handleLine(last);
		}
		// If the stream ended mid-block, close it so the transcript isn't left open. A block that never reached
		// its REPLACE terminator is incomplete and intentionally NOT applied.
		if (this.state !== 'out') {
			if (!this.headerEmitted) { this.openBlock(); }
			this.sink.blockEnd();
			this.state = 'out';
			this.headerEmitted = false;
		}
		await this.applyChain;
	}
}
