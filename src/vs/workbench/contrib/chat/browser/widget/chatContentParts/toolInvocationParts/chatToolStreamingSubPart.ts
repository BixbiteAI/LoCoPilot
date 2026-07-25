/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/chatToolStreamingPreview.css';
import * as dom from '../../../../../../../base/browser/dom.js';
import { IMarkdownString, MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { autorun } from '../../../../../../../base/common/observable.js';
import { MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { IMarkdownRenderer } from '../../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { IChatProgressMessage, IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';
import { IChatContentPartRenderContext } from '../chatContentParts.js';
import { ChatProgressContentPart } from '../chatProgressContentPart.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/** Argument fields that hold the "content being generated" for common editing tools. */
const CONTENT_FIELD_CANDIDATES = ['newString', 'content', 'text', 'code'];

/** Max preview lines / max chars per line shown for streaming tool-call content. */
const PREVIEW_TAIL_LINES = 3;
const PREVIEW_MAX_LINE_LENGTH = 200;

/** Short tail (last few lines) of a streamed string, clipped per line. */
function tailPreview(value: string): string {
	const lines = value.replace(/\s+$/, '').split('\n');
	return lines
		.slice(-PREVIEW_TAIL_LINES)
		.map(l => l.length > PREVIEW_MAX_LINE_LENGTH ? `${l.slice(0, PREVIEW_MAX_LINE_LENGTH)}…` : l)
		.join('\n');
}

/**
 * Extract a short live tail of the content an in-flight tool call is generating (e.g. modifyFile's
 * `newString`) from its best-effort-parsed partial input, so the user sees the file being written.
 * Handles both a top-level content field (single-edit / create) and the `edits[]` multi-edit array,
 * where the currently-streaming patch's newString lives inside the LAST array element.
 */
function extractStreamingContentPreview(partialInput: unknown): string | undefined {
	if (!partialInput || typeof partialInput !== 'object') {
		return undefined;
	}
	const obj = partialInput as Record<string, unknown>;

	// Multi-edit: preview the newString (or oldString before it arrives) of the last, currently-
	// streaming patch, so the code tail shows just like it does for a single-edit newString.
	const edits = obj['edits'];
	if (Array.isArray(edits)) {
		for (let i = edits.length - 1; i >= 0; i--) {
			const e = edits[i];
			if (e && typeof e === 'object') {
				const patch = e as Record<string, unknown>;
				const ns = patch['newString'];
				if (typeof ns === 'string' && ns.trim().length > 0) {
					return tailPreview(ns);
				}
				const os = patch['oldString'];
				if (typeof os === 'string' && os.trim().length > 0) {
					return tailPreview(os);
				}
			}
		}
	}

	for (const field of CONTENT_FIELD_CANDIDATES) {
		const value = obj[field];
		if (typeof value === 'string' && value.trim().length > 0) {
			return tailPreview(value);
		}
	}
	return undefined;
}

/**
 * Sub-part for rendering a tool invocation in the streaming state.
 * This shows progress while the tool arguments are being streamed from the LM.
 */
export class ChatToolStreamingSubPart extends BaseChatToolInvocationSubPart {
	public readonly domNode: HTMLElement;

	public override readonly codeblocks: IChatCodeBlockInfo[] = [];

	constructor(
		toolInvocation: IChatToolInvocation,
		private readonly context: IChatContentPartRenderContext,
		private readonly renderer: IMarkdownRenderer,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(toolInvocation);

		this.domNode = this.createStreamingPart();
	}

	private createStreamingPart(): HTMLElement {
		const container = document.createElement('div');
		// Hook for the shimmer/preview styling in chatToolStreamingPreview.css
		container.classList.add('chat-tool-streaming-part');

		if (this.toolInvocation.kind !== 'toolInvocation') {
			return container;
		}

		const toolInvocation = this.toolInvocation;
		const state = toolInvocation.state.get();
		if (state.type !== IChatToolInvocation.StateKind.Streaming) {
			return container;
		}

		// The shimmer wave (transparent text swept by a moving CSS gradient) only animates if the
		// message element persists across streamed tokens: recreating it every tick restarts the
		// animation at 0%, freezing the text at a transparent point (so it looks blank / no wave).
		// So we keep the message part alive and only rebuild it when the message TEXT changes; the
		// live content tail below is updated independently.
		const messagePart = this._register(new MutableDisposable<ChatProgressContentPart>());
		let lastMessageText: string | undefined;
		let previewElement: HTMLElement | undefined;

		// Observe streaming message changes
		this._register(autorun(reader => {
			const currentState = toolInvocation.state.read(reader);
			if (currentState.type !== IChatToolInvocation.StateKind.Streaming) {
				// State changed - clear the container DOM before triggering re-render
				// This prevents the old streaming message from lingering
				messagePart.clear();
				lastMessageText = undefined;
				previewElement = undefined;
				dom.clearNode(container);
				this._onNeedsRerender.fire();
				return;
			}

			// Read the streaming message
			const streamingMessage = currentState.streamingMessage.read(reader);
			const displayMessage = streamingMessage ?? toolInvocation.invocationMessage;

			// Don't render anything if there's no meaningful content
			const messageText = typeof displayMessage === 'string' ? displayMessage : displayMessage.value;
			if (!messageText || messageText.trim().length === 0) {
				messagePart.clear();
				lastMessageText = undefined;
				previewElement = undefined;
				dom.clearNode(container);
				return;
			}

			// Update the message only when its text actually changes. The FIRST message builds the
			// progress part; later changes (e.g. the ticking "(N lines)" count) update the SAME element
			// in place via updateMessage, so the shimmer wave keeps running instead of restarting - and
			// the count updates live rather than only settling once the tool call completes.
			if (messageText !== lastMessageText) {
				const content: IMarkdownString = typeof displayMessage === 'string'
					? new MarkdownString().appendText(displayMessage)
					: displayMessage;

				if (messagePart.value) {
					messagePart.value.updateMessage(content);
				} else {
					const progressMessage: IChatProgressMessage = {
						kind: 'progressMessage',
						content
					};

					const part = this.instantiationService.createInstance(
						ChatProgressContentPart,
						progressMessage,
						this.renderer,
						this.context,
						undefined,
						true,
						this.getIcon(),
						toolInvocation
					);
					messagePart.value = part;
					previewElement = undefined;
					dom.reset(container, part.domNode);
				}
				lastMessageText = messageText;
			}

			// Live tail of the content being generated (e.g. the file modifyFile is writing), so long
			// generations show visible progress instead of just a static message. Update it in place
			// so the message element (and its shimmer animation) is never disturbed.
			const previewText = extractStreamingContentPreview(currentState.partialInput.read(reader));
			if (previewText) {
				if (!previewElement) {
					previewElement = document.createElement('pre');
					previewElement.classList.add('chat-tool-streaming-preview');
					container.appendChild(previewElement);
				}
				previewElement.textContent = previewText;
			} else if (previewElement) {
				previewElement.remove();
				previewElement = undefined;
			}
		}));

		return container;
	}
}
