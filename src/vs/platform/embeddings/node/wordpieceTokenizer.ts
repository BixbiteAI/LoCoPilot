/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal BERT WordPiece tokenizer (uncased) - enough to drive bge/nomic-style BERT encoders
 * without pulling in a heavy tokenizer dependency. Mirrors HuggingFace BertTokenizer behaviour
 * for the common case: lowercase, strip accents, split on whitespace + punctuation, greedy
 * WordPiece with "##" continuations and [UNK] fallback.
 */
export class WordPieceTokenizer {
	private readonly vocab: Map<string, number>;
	private readonly unkId: number;
	private readonly clsId: number;
	private readonly sepId: number;
	private readonly padId: number;
	private readonly maxInputChars = 100;

	constructor(vocabText: string, private readonly maxLen = 512) {
		this.vocab = new Map();
		const lines = vocabText.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const tok = lines[i];
			if (tok.length === 0 && i === lines.length - 1) { continue; } // trailing newline
			this.vocab.set(tok, i);
		}
		this.unkId = this.vocab.get('[UNK]') ?? 100;
		this.clsId = this.vocab.get('[CLS]') ?? 101;
		this.sepId = this.vocab.get('[SEP]') ?? 102;
		this.padId = this.vocab.get('[PAD]') ?? 0;
	}

	/** Tokenize a single text into ids, with [CLS]/[SEP] and truncation to maxLen. */
	encode(text: string): number[] {
		const tokens = this.basicTokenize(text);
		const ids: number[] = [this.clsId];
		for (const tok of tokens) {
			for (const id of this.wordPiece(tok)) {
				if (ids.length >= this.maxLen - 1) { break; }
				ids.push(id);
			}
			if (ids.length >= this.maxLen - 1) { break; }
		}
		ids.push(this.sepId);
		return ids;
	}

	/**
	 * Encode a batch and right-pad to the longest sequence.
	 * Returns flat int arrays plus dims for tensor construction.
	 */
	encodeBatch(texts: string[]): { inputIds: number[][]; attentionMask: number[][]; maxLen: number } {
		const encoded = texts.map(t => this.encode(t));
		const maxLen = Math.max(1, ...encoded.map(e => e.length));
		const inputIds: number[][] = [];
		const attentionMask: number[][] = [];
		for (const e of encoded) {
			const pad = maxLen - e.length;
			inputIds.push([...e, ...new Array(pad).fill(this.padId)]);
			attentionMask.push([...new Array(e.length).fill(1), ...new Array(pad).fill(0)]);
		}
		return { inputIds, attentionMask, maxLen };
	}

	private basicTokenize(text: string): string[] {
		// Lowercase + strip accents (NFD then remove combining marks U+0300-U+036F).
		const lowered = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
		const out: string[] = [];
		let current = '';
		const flush = () => { if (current) { out.push(current); current = ''; } };
		for (const ch of lowered) {
			if (/\s/.test(ch)) { flush(); continue; }
			if (this.isPunct(ch)) { flush(); out.push(ch); continue; }
			current += ch;
		}
		flush();
		return out;
	}

	private isPunct(ch: string): boolean {
		const cp = ch.codePointAt(0)!;
		// ASCII punctuation ranges + general unicode punctuation via regex.
		if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
			return true;
		}
		return /\p{P}|\p{S}/u.test(ch);
	}

	private wordPiece(word: string): number[] {
		if (word.length > this.maxInputChars) { return [this.unkId]; }
		const ids: number[] = [];
		let start = 0;
		while (start < word.length) {
			let end = word.length;
			let cur: number | undefined;
			while (start < end) {
				const sub = (start > 0 ? '##' : '') + word.slice(start, end);
				const id = this.vocab.get(sub);
				if (id !== undefined) { cur = id; break; }
				end--;
			}
			if (cur === undefined) { return [this.unkId]; }
			ids.push(cur);
			start = end;
		}
		return ids;
	}
}
