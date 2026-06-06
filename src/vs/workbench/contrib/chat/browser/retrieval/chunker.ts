/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Structure-aware code chunking.
 *
 * Strategy (per the agreed design):
 *  - Primary: split on structural boundaries (function/class/method/def/etc.) so each chunk is a
 *    logical unit instead of an arbitrary byte window. We use a lightweight, language-agnostic
 *    boundary heuristic here so background indexing stays fast and never needs a language server
 *    loaded for every file. (Full AST via VS Code's document-symbol provider can enrich open
 *    documents later; this fallback guarantees every file type still gets indexed.)
 *  - Fallback: sliding line window with overlap for prose/unknown structure.
 *  - Each chunk is prefixed with a breadcrumb (path + nearest symbol) before embedding, which
 *    materially improves retrieval because the vector "knows" where the code lives.
 */

export interface ICodeChunk {
	/** 1-based inclusive start line. */
	startLine: number;
	/** 1-based inclusive end line. */
	endLine: number;
	/** Nearest enclosing symbol name, if detected (for the breadcrumb / display). */
	symbol?: string;
	/** Raw source text of the chunk (without the breadcrumb). */
	text: string;
}

const MAX_CHUNK_LINES = 80;     // hard cap so a huge function still splits
const TARGET_CHUNK_LINES = 60;  // preferred size
const WINDOW_OVERLAP = 10;      // overlap for the sliding-window fallback
const MAX_FILE_LINES = 6000;    // skip pathologically large files

/**
 * Matches common top-level/structural declaration starts across many languages:
 * function, class, interface, struct, enum, def, func, public/private methods, exports, etc.
 */
const BOUNDARY_RE = new RegExp(
	'^\\s*(' +
	'export\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|' +
	'function\\b|class\\b|interface\\b|struct\\b|enum\\b|trait\\b|impl\\b|' +
	'def\\b|func\\b|fn\\b|type\\b|const\\s+\\w+\\s*=\\s*(async\\s*)?\\(|' +
	'[A-Za-z_$][\\w$]*\\s*\\([^)]*\\)\\s*\\{?\\s*$' +
	')'
);

/** Extract a rough symbol name from a boundary line for the breadcrumb. */
function symbolFromLine(line: string): string | undefined {
	const m = line.match(/(?:function|class|interface|struct|enum|trait|def|func|fn|type|const|let|var)\s+([A-Za-z_$][\w$]*)/);
	if (m) { return m[1]; }
	const m2 = line.match(/([A-Za-z_$][\w$]*)\s*\(/);
	return m2 ? m2[1] : undefined;
}

/**
 * Chunk a source file. `relPath` is used only for the breadcrumb (caller stores the real path).
 */
export function chunkSource(relPath: string, content: string): ICodeChunk[] {
	const allLines = content.split(/\r?\n/);
	if (allLines.length > MAX_FILE_LINES) {
		return slidingWindow(allLines);
	}

	// Find structural boundary line indexes (0-based).
	const boundaries: number[] = [];
	for (let i = 0; i < allLines.length; i++) {
		if (BOUNDARY_RE.test(allLines[i]) && allLines[i].trim().length > 0) {
			boundaries.push(i);
		}
	}

	// Not enough structure to be useful -> sliding window.
	if (boundaries.length < 2) {
		return slidingWindow(allLines);
	}

	const chunks: ICodeChunk[] = [];
	// Lead-in (imports / header) before the first boundary.
	if (boundaries[0] > 0) {
		pushRange(chunks, allLines, 0, boundaries[0] - 1, undefined);
	}
	for (let b = 0; b < boundaries.length; b++) {
		const start = boundaries[b];
		const end = (b + 1 < boundaries.length ? boundaries[b + 1] : allLines.length) - 1;
		const symbol = symbolFromLine(allLines[start]);
		pushRange(chunks, allLines, start, end, symbol);
	}
	return chunks.filter(c => c.text.trim().length > 0);
}

/** Push a line range, splitting further if it exceeds the max chunk size. */
function pushRange(out: ICodeChunk[], lines: string[], start: number, end: number, symbol: string | undefined): void {
	const total = end - start + 1;
	if (total <= MAX_CHUNK_LINES) {
		out.push(makeChunk(lines, start, end, symbol));
		return;
	}
	for (let s = start; s <= end; s += TARGET_CHUNK_LINES) {
		const e = Math.min(s + TARGET_CHUNK_LINES - 1, end);
		out.push(makeChunk(lines, s, e, symbol));
	}
}

function makeChunk(lines: string[], start: number, end: number, symbol: string | undefined): ICodeChunk {
	return {
		startLine: start + 1,
		endLine: end + 1,
		symbol,
		text: lines.slice(start, end + 1).join('\n'),
	};
}

function slidingWindow(lines: string[]): ICodeChunk[] {
	const chunks: ICodeChunk[] = [];
	const step = TARGET_CHUNK_LINES - WINDOW_OVERLAP;
	for (let s = 0; s < lines.length; s += step) {
		const e = Math.min(s + TARGET_CHUNK_LINES - 1, lines.length - 1);
		chunks.push(makeChunk(lines, s, e, undefined));
		if (e === lines.length - 1) { break; }
	}
	return chunks.filter(c => c.text.trim().length > 0);
}

/** Build the text actually sent to the embedder: breadcrumb + code. */
export function chunkEmbeddingText(relPath: string, chunk: ICodeChunk): string {
	const crumb = chunk.symbol ? `${relPath} > ${chunk.symbol}` : relPath;
	return `${crumb}\n\n${chunk.text}`;
}
