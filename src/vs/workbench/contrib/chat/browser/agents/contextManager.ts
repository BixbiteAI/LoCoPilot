/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { ChatMessageRole, IChatMessage, IChatMessagePart, IChatMessageTextPart, IChatMessageToolResultPart, IChatResponseToolUsePart, ILanguageModelsService, LanguageModelPartAudience } from '../../common/languageModels.js';

/**
 * Tiered context manager for the agentic loop.
 *
 * Keeps the running `conversationMessages` array inside the model's usable input budget using a
 * watermark scheme with three escalating tiers (cheapest first):
 *
 *   Tier 1  Stub large/old tool results          (free, no LLM call)
 *   Tier 2  Summarize the old "middle" into one   (one LLM call)
 *           structured summary block
 *   Tier 3  Drop oldest summarized raw messages   (free)
 *
 * Always pinned and never touched: system messages + the first user message (the task /
 * requirements). The most recent messages are always kept verbatim (the "recent window").
 */

export interface IContextBudgetConfig {
	/** Trigger compaction when usage >= this fraction of the usable budget. */
	readonly triggerFraction: number;
	/** Compact down until usage <= this fraction (low watermark). Big gap below trigger = fewer compactions. */
	readonly targetFraction: number;
	/** Fraction of usable budget kept verbatim as the most-recent window. */
	readonly recentFraction: number;
	/** Max size of the generated summary block, as a fraction of usable budget. */
	readonly summaryFraction: number;
	/**
	 * Fraction of the model's max input tokens reserved for the reply when maxOutputTokens is
	 * unknown. When maxOutputTokens IS known we reserve that instead.
	 */
	readonly reservedOutputFallbackFraction: number;
	/** Extra safety margin (fraction of max input) held back for tokenizer drift / formatting. */
	readonly safetyMarginFraction: number;
	/** Tool results (or text parts) in the middle larger than this many tokens get stubbed in Tier 1. */
	readonly stubTokenLimit: number;
}

export const DEFAULT_CONTEXT_BUDGET: IContextBudgetConfig = {
	triggerFraction: 0.75,
	targetFraction: 0.50,
	recentFraction: 0.25,
	summaryFraction: 0.15,
	reservedOutputFallbackFraction: 0.20,
	safetyMarginFraction: 0.02,
	stubTokenLimit: 800,
};

export interface ICompactionResult {
	readonly messages: IChatMessage[];
	readonly compacted: boolean;
	/** Tiers that fired this pass, for logging. */
	readonly tiers: string[];
	readonly tokensBefore: number;
	readonly tokensAfter: number;
}

type Logger = (msg: string, ...args: unknown[]) => void;

/** Extract plain text from a typed message part, or empty string for non-text parts. */
function partText(part: IChatMessagePart): string {
	if (part.type === 'text') {
		return (part as IChatMessageTextPart).value;
	}
	return '';
}

export class ContextManager {

	constructor(
		private readonly languageModelsService: ILanguageModelsService,
		private readonly log: Logger,
		private readonly config: IContextBudgetConfig = DEFAULT_CONTEXT_BUDGET,
	) { }

	/**
	 * Usable budget for history = maxInput - reservedOutput - safetyMargin.
	 * This is the "100%" the watermarks are measured against, NOT the raw context window.
	 */
	private computeUsableBudget(modelMetadata: any): number {
		const maxInput: number = modelMetadata?.maxInputTokens ?? 128000;
		const reservedOutput: number = modelMetadata?.maxOutputTokens
			?? Math.floor(maxInput * this.config.reservedOutputFallbackFraction);
		const safety = Math.floor(maxInput * this.config.safetyMarginFraction);
		return Math.max(1, maxInput - reservedOutput - safety);
	}

	private async tokensFor(modelId: string, msg: IChatMessage, token: CancellationToken): Promise<number> {
		try {
			return await this.languageModelsService.computeTokenLength(modelId, msg, token);
		} catch {
			// Fallback: ~4 chars/token over text parts.
			const text = msg.content.map(p => partText(p)).join('');
			return Math.ceil(text.length / 4);
		}
	}

	private async totalTokens(modelId: string, messages: IChatMessage[], token: CancellationToken): Promise<number> {
		let total = 0;
		for (const m of messages) {
			total += await this.tokensFor(modelId, m, token);
		}
		return total;
	}

	private isToolResultMessage(msg: IChatMessage): boolean {
		return msg.content.some(p => p.type === 'tool_result');
	}

	/**
	 * Main entry: compact `messages` to fit the budget if it has crossed the trigger watermark.
	 * Returns a (possibly) new array; the input is not mutated.
	 */
	async compactIfNeeded(
		modelId: string,
		modelMetadata: any,
		messages: IChatMessage[],
		token: CancellationToken,
	): Promise<ICompactionResult> {
		const usable = this.computeUsableBudget(modelMetadata);
		const trigger = Math.floor(usable * this.config.triggerFraction);
		const target = Math.floor(usable * this.config.targetFraction);

		const before = await this.totalTokens(modelId, messages, token);
		if (before < trigger || token.isCancellationRequested) {
			return { messages, compacted: false, tiers: [], tokensBefore: before, tokensAfter: before };
		}

		this.log(`[LoCoPilot][ctx] Trigger hit: ${before} >= ${trigger} (usable=${usable}, target=${target})`);
		const tiers: string[] = [];

		// Compute the pinned prefix (leading system messages + first user message) and the recent
		// window boundary (token-bounded from the end, snapped so it never starts on a tool_result).
		const pinnedEnd = this.computePinnedPrefixEnd(messages);
		const recentStart = await this.computeRecentStart(modelId, messages, pinnedEnd, usable, token);

		let working = messages.slice();

		// ---- Tier 1: stub large tool results / text in the middle (free) ----
		working = this.stubMiddle(working, pinnedEnd, recentStart);
		tiers.push('stub');
		let now = await this.totalTokens(modelId, working, token);
		this.log(`[LoCoPilot][ctx] After Tier 1 (stub): ${now}`);
		if (now <= target) {
			return { messages: working, compacted: true, tiers, tokensBefore: before, tokensAfter: now };
		}

		// ---- Tier 2: summarize the middle into one structured block (one LLM call) ----
		if (recentStart > pinnedEnd) {
			const middle = working.slice(pinnedEnd, recentStart);
			const summaryBudget = Math.floor(usable * this.config.summaryFraction);
			const summaryText = await this.summarizeMessages(modelId, middle, summaryBudget, token);
			if (summaryText && !token.isCancellationRequested) {
				const summaryMsg: IChatMessage = {
					role: ChatMessageRole.Assistant,
					content: [{
						type: 'text',
						value: `[Earlier context summary - older turns were compacted to save space]\n\n${summaryText}`,
						audience: [LanguageModelPartAudience.Assistant],
					} satisfies IChatMessageTextPart],
				};
				working = [
					...working.slice(0, pinnedEnd),
					summaryMsg,
					...working.slice(recentStart),
				];
				tiers.push('summarize');
				now = await this.totalTokens(modelId, working, token);
				this.log(`[LoCoPilot][ctx] After Tier 2 (summarize): ${now}`);
				if (now <= target) {
					return { messages: working, compacted: true, tiers, tokensBefore: before, tokensAfter: now };
				}
			}
		}

		// ---- Tier 3: drop oldest verbatim recent messages, pair-safe (free) ----
		working = await this.dropOldestRecent(modelId, working, target, token);
		tiers.push('drop');
		now = await this.totalTokens(modelId, working, token);
		this.log(`[LoCoPilot][ctx] After Tier 3 (drop): ${now}`);
		return { messages: working, compacted: true, tiers, tokensBefore: before, tokensAfter: now };
	}

	/** Leading block of System messages plus the first User message (the task / requirements). */
	private computePinnedPrefixEnd(messages: IChatMessage[]): number {
		let i = 0;
		while (i < messages.length && messages[i].role === ChatMessageRole.System) {
			i++;
		}
		// Pin the first user message too (original task). It may not exist yet in edge cases.
		if (i < messages.length && messages[i].role === ChatMessageRole.User) {
			i++;
		}
		return i;
	}

	/**
	 * Walk from the end accumulating tokens until we exceed the recent budget; that index is the
	 * recent-window start. Snap forward past any leading tool_result so the window never begins
	 * with an orphaned tool_result (whose tool_use would be summarized away).
	 */
	private async computeRecentStart(
		modelId: string,
		messages: IChatMessage[],
		pinnedEnd: number,
		usable: number,
		token: CancellationToken,
	): Promise<number> {
		const recentBudget = Math.floor(usable * this.config.recentFraction);
		let acc = 0;
		let start = messages.length;
		for (let i = messages.length - 1; i >= pinnedEnd; i--) {
			acc += await this.tokensFor(modelId, messages[i], token);
			if (acc > recentBudget) {
				break;
			}
			start = i;
		}
		// Snap forward past orphan tool_results at the boundary.
		while (start < messages.length && this.isToolResultMessage(messages[start])) {
			start++;
		}
		return Math.max(pinnedEnd, Math.min(start, messages.length));
	}

	/** Replace large tool_result / text content in [pinnedEnd, recentStart) with short stubs. */
	private stubMiddle(messages: IChatMessage[], pinnedEnd: number, recentStart: number): IChatMessage[] {
		const out = messages.slice();
		for (let i = pinnedEnd; i < recentStart; i++) {
			const msg = out[i];
			let changed = false;
			const newContent: IChatMessagePart[] = msg.content.map(part => {
				if (part.type === 'tool_result') {
					const toolResult = part as IChatMessageToolResultPart;
					const text = toolResult.value.map(v => v.type === 'text' ? v.value : '').join('');
					if (Math.ceil(text.length / 4) > this.config.stubTokenLimit) {
						changed = true;
						const stub: IChatMessageToolResultPart = {
							type: 'tool_result',
							toolCallId: toolResult.toolCallId,
							value: [{ type: 'text', value: `[tool result omitted to save context - ~${Math.ceil(text.length / 4)} tokens, already acted on]` }],
							isError: toolResult.isError,
						};
						return stub;
					}
				} else if (part.type === 'text') {
					const textPart = part as IChatMessageTextPart;
					if (Math.ceil((textPart.value?.length ?? 0) / 4) > this.config.stubTokenLimit) {
						changed = true;
						const stub: IChatMessageTextPart = {
							...textPart,
							value: `${textPart.value.slice(0, this.config.stubTokenLimit * 2)}\n...[truncated to save context]`,
						};
						return stub;
					}
				}
				return part;
			});
			if (changed) {
				out[i] = { role: msg.role, content: newContent };
			}
		}
		return out;
	}

	/** Drop oldest messages just after the pinned prefix until under target, keeping tool pairs intact. */
	private async dropOldestRecent(
		modelId: string,
		messages: IChatMessage[],
		target: number,
		token: CancellationToken,
	): Promise<IChatMessage[]> {
		const pinnedEnd = this.computePinnedPrefixEnd(messages);
		const working = messages.slice();
		// Remove from just after the pinned prefix (oldest non-pinned) forward.
		while (await this.totalTokens(modelId, working, token) > target && working.length > pinnedEnd + 1) {
			working.splice(pinnedEnd, 1);
			// Don't leave an orphan tool_result at the new boundary.
			while (working.length > pinnedEnd && this.isToolResultMessage(working[pinnedEnd])) {
				working.splice(pinnedEnd, 1);
			}
		}
		return working;
	}

	/** Render messages to a compact transcript for the summarizer. */
	private messagesToTranscript(messages: IChatMessage[]): string {
		const lines: string[] = [];
		for (const m of messages) {
			const role = m.role === ChatMessageRole.User ? 'User'
				: m.role === ChatMessageRole.Assistant ? 'Assistant' : 'System';
			const parts: string[] = [];
			for (const part of m.content) {
				if (part.type === 'text') {
					parts.push((part as IChatMessageTextPart).value);
				} else if (part.type === 'tool_use') {
					const tu = part as IChatResponseToolUsePart;
					parts.push(`(called tool ${tu.name} with ${JSON.stringify(tu.parameters ?? {}).slice(0, 300)})`);
				} else if (part.type === 'tool_result') {
					const tr = part as IChatMessageToolResultPart;
					const text = tr.value.map(v => v.type === 'text' ? v.value : '').join('');
					parts.push(`(tool result: ${text.slice(0, 500)})`);
				}
			}
			if (parts.length) {
				lines.push(`${role}: ${parts.join('\n')}`);
			}
		}
		return lines.join('\n\n');
	}

	/** One LLM call to compress the middle into a structured, dense summary block. */
	private async summarizeMessages(
		modelId: string,
		messages: IChatMessage[],
		maxSummaryTokens: number,
		token: CancellationToken,
	): Promise<string> {
		if (messages.length === 0) {
			return '';
		}
		const transcript = this.messagesToTranscript(messages);
		const systemPrompt = `You compress an in-progress coding agent session into a dense, structured memory block so work can continue without the full history. The summary must stay under ${maxSummaryTokens} tokens.

Output these sections (omit a section only if truly empty), as terse bullet points:
- TASK & REQUIREMENTS: the goal and constraints.
- DECISIONS: choices made and why.
- FILES CHANGED: paths + what changed.
- CURRENT STATE / TODO: what is done and what remains.
- KEY FACTS / GOTCHAS: errors hit, fixes, important discoveries.

Preserve exact file paths, identifiers, and decisions. No greetings or filler. Stay under ${maxSummaryTokens} tokens. Output only the summary.`;

		try {
			const response = await this.languageModelsService.sendChatRequest(
				modelId,
				nullExtensionDescription.identifier,
				[
					{ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt } satisfies IChatMessageTextPart] },
					{ role: ChatMessageRole.User, content: [{ type: 'text', value: `Compress this session:\n\n${transcript}` } satisfies IChatMessageTextPart] },
				],
				{},
				token,
			);
			let summary = '';
			for await (const part of response.stream) {
				const arr = Array.isArray(part) ? part : [part];
				for (const p of arr) {
					if (p.type === 'text') {
						summary += p.value;
					}
				}
			}
			await response.result;
			return summary.trim();
		} catch (e) {
			this.log(`[LoCoPilot][ctx] Summarization failed, falling back to drop tier: ${e}`);
			return '';
		}
	}
}
