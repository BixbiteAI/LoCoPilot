/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/chatToolStreamingPreview.css';
import * as dom from '../../../../../../../base/browser/dom.js';
import { IMarkdownString, MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { autorun } from '../../../../../../../base/common/observable.js';
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

/**
 * Extract a short live tail of the content an in-flight tool call is generating (e.g. modifyFile's
 * `newString`) from its best-effort-parsed partial input, so the user sees the file being written.
 */
function extractStreamingContentPreview(partialInput: unknown): string | undefined {
	if (!partialInput || typeof partialInput !== 'object') {
		return undefined;
	}
	for (const field of CONTENT_FIELD_CANDIDATES) {
		const value = (partialInput as Record<string, unknown>)[field];
		if (typeof value === 'string' && value.trim().length > 0) {
			const lines = value.replace(/\s+$/, '').split('\n');
			return lines
				.slice(-PREVIEW_TAIL_LINES)
				.map(l => l.length > PREVIEW_MAX_LINE_LENGTH ? `${l.slice(0, PREVIEW_MAX_LINE_LENGTH)}…` : l)
				.join('\n');
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

		// Observe streaming message changes
		this._register(autorun(reader => {
			const currentState = toolInvocation.state.read(reader);
			if (currentState.type !== IChatToolInvocation.StateKind.Streaming) {
				// State changed - clear the container DOM before triggering re-render
				// This prevents the old streaming message from lingering
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
				dom.clearNode(container);
				return;
			}

			const content: IMarkdownString = typeof displayMessage === 'string'
				? new MarkdownString().appendText(displayMessage)
				: displayMessage;

			const progressMessage: IChatProgressMessage = {
				kind: 'progressMessage',
				content
			};

			const part = reader.store.add(this.instantiationService.createInstance(
				ChatProgressContentPart,
				progressMessage,
				this.renderer,
				this.context,
				undefined,
				true,
				this.getIcon(),
				toolInvocation
			));

			// Live tail of the content being generated (e.g. the file modifyFile is writing), so long
			// generations show visible progress instead of just a static message.
			const previewText = extractStreamingContentPreview(currentState.partialInput.read(reader));
			if (previewText) {
				const preview = document.createElement('pre');
				preview.classList.add('chat-tool-streaming-preview');
				preview.textContent = previewText;
				dom.reset(container, part.domNode, preview);
			} else {
				dom.reset(container, part.domNode);
			}
		}));

		return container;
	}
}
