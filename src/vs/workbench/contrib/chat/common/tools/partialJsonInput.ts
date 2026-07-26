/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Best-effort parse of PARTIAL JSON tool-call arguments as they stream from an LLM.
 *
 * Local servers (llama.cpp with streamed tool calls) send `function.arguments` as incremental
 * string fragments, so at any point mid-stream we hold a prefix of a JSON object like
 * `{"path": "src/foo.ts", "oldString": "", "newString": "line1\nli`. This repairs that prefix
 * (closes the open string, drops dangling keys/values, appends missing closers) and parses it so
 * the UI can show the fields that have already arrived - including the partial text of a string
 * value that is still streaming.
 *
 * Returns `undefined` when the text is not an object prefix or cannot be repaired at this tick;
 * callers should treat that as "no update yet" (the next, longer prefix usually parses).
 */
export function parsePartialJsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}

	// Fast path: complete JSON.
	const complete = tryParseObject(trimmed);
	if (complete) {
		return complete;
	}

	// Scan outside-string structure to know what closers are missing and whether we end inside a
	// string (string content never affects the bracket stack).
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
		} else if (ch === '"') {
			inString = true;
		} else if (ch === '{') {
			stack.push('}');
		} else if (ch === '[') {
			stack.push(']');
		} else if (ch === '}' || ch === ']') {
			stack.pop();
		}
	}

	let repaired = trimmed;
	if (inString) {
		// Truncated unicode escape (`\u12`) or trailing lone backslash can't survive a re-parse;
		// drop the incomplete escape before closing the string.
		repaired = repaired.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
		if (escaped || /(?:^|[^\\])(?:\\\\)*\\$/.test(repaired)) {
			repaired = repaired.slice(0, -1);
		}
		repaired += '"';
	}
	const closers = stack.reverse().join('');

	// Try progressively stronger repairs. Order matters: earlier candidates preserve the most data
	// (e.g. a just-closed VALUE string must parse before the dangling-KEY stripper could eat it).
	const candidates = [
		repaired,
		// `"replaceAll": tru` / `"count": 12` / `"path":` -> null out the truncated literal
		repaired.replace(/:\s*[-+.\w]*\s*$/, ':null'),
		// `..., "newString"` / `..., "newString":` -> drop the dangling key
		repaired.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, ''),
	];
	for (const candidate of candidates) {
		const withoutTrailingComma = candidate.replace(/,\s*$/, '');
		const parsed = tryParseObject(withoutTrailingComma + closers);
		if (parsed) {
			return parsed;
		}
	}
	return undefined;
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Escape RAW control characters that appear INSIDE JSON string values. Small models emitting code as a
 * tool argument routinely write literal newlines/tabs (and other control chars) directly into the string
 * instead of `\n`/`\t`, which strict JSON.parse rejects ("Bad control character in string literal"). This
 * walks the text tracking string vs structure (respecting backslash escapes) and rewrites those raw chars
 * to their valid JSON escapes, leaving everything outside strings untouched.
 */
function escapeRawControlCharsInStrings(s: string): string {
	let out = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		const code = s.charCodeAt(i);
		if (inString) {
			if (escaped) { out += ch; escaped = false; continue; }
			if (ch === '\\') { out += ch; escaped = true; continue; }
			if (ch === '"') { out += ch; inString = false; continue; }
			if (code === 0x0a) { out += '\\n'; continue; }
			if (code === 0x0d) { out += '\\r'; continue; }
			if (code === 0x09) { out += '\\t'; continue; }
			if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
			out += ch;
		} else {
			if (ch === '"') { inString = true; }
			out += ch;
		}
	}
	return out;
}

/**
 * Tolerant parse of a COMPLETE tool-call `arguments` string. Strict JSON first; then repair raw control
 * chars inside strings (the dominant failure when a model emits a whole file/code blob as one argument);
 * then fall back to the streaming partial-JSON repair (handles truncation - a file cut off by the output
 * token limit). Never throws - returns `{}` only when nothing at all could be recovered. This lets a big
 * `createFile`/`editFile` payload with slightly malformed escaping still yield its `path` + content instead
 * of collapsing to an empty object (which surfaced to the model as a misleading "path is required" error).
 */
export function parseToolCallArguments(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw !== 'string' || !raw.trim()) {
		return {};
	}
	const strict = tryParseObject(raw);
	if (strict) { return strict; }

	const repaired = escapeRawControlCharsInStrings(raw);
	if (repaired !== raw) {
		const fixed = tryParseObject(repaired);
		if (fixed) { return fixed; }
	}

	return parsePartialJsonObject(raw) ?? parsePartialJsonObject(repaired) ?? {};
}
