/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, clearNode, hide } from '../../../../../../base/browser/dom.js';
import { alert } from '../../../../../../base/browser/ui/aria/aria.js';
import { DomScrollableElement } from '../../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../../../base/common/scrollable.js';
import { IChatMarkdownContent, IChatThinkingPart, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../common/chatService/chatService.js';
import { IChatContentPartRenderContext, IChatContentPart } from './chatContentParts.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatConfiguration, ThinkingDisplayMode } from '../../../common/constants.js';
import { ChatTreeItem } from '../../chat.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { IRenderedMarkdown } from '../../../../../../base/browser/markdownRenderer.js';
import { IMarkdownRenderer } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { extractCodeblockUrisFromText } from '../../../common/widget/annotations.js';
import { basename } from '../../../../../../base/common/resources.js';
import { ChatCollapsibleContentPart } from './chatCollapsibleContentPart.js';
import { localize } from '../../../../../../nls.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { Lazy } from '../../../../../../base/common/lazy.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IChatMarkdownAnchorService } from './chatMarkdownAnchorService.js';
import { ChatMessageRole, ILanguageModelsService } from '../../../common/languageModels.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import './media/chatThinkingContent.css';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';


function extractTextFromPart(content: IChatThinkingPart): string {
	const raw = Array.isArray(content.value) ? content.value.join('') : (content.value || '');
	return raw.trim();
}

export function getToolInvocationIcon(toolId: string): ThemeIcon {
	const lowerToolId = toolId.toLowerCase();

	if (
		lowerToolId.includes('search') ||
		lowerToolId.includes('grep') ||
		lowerToolId.includes('find') ||
		lowerToolId.includes('list') ||
		lowerToolId.includes('semantic') ||
		lowerToolId.includes('changes') ||
		lowerToolId.includes('codebase')
	) {
		return Codicon.search;
	}

	if (
		lowerToolId.includes('read') ||
		lowerToolId.includes('get_file') ||
		lowerToolId.includes('problems')
	) {
		return Codicon.book;
	}

	if (
		lowerToolId.includes('edit') ||
		lowerToolId.includes('create')
	) {
		return Codicon.pencil;
	}

	if (
		lowerToolId.includes('terminal')
	) {
		return Codicon.terminal;
	}

	// default to generic tool icon
	return Codicon.tools;
}

export function createThinkingIcon(icon: ThemeIcon): HTMLElement {
	const iconElement = $('span.chat-thinking-icon');
	iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
	return iconElement;
}

function extractTitleFromThinkingContent(content: string): string | undefined {
	const headerMatch = content.match(/^\*\*([^*]+)\*\*/);
	return headerMatch ? headerMatch[1] : undefined;
}

/**
 * Strip trailing dot/ellipsis runs (e.g. "Reading ....", "Working…") and trailing whitespace
 * from a label. Tool progress messages often append "..." as a fake spinner; we render our own
 * animation, so the static dots are redundant noise.
 */
function stripTrailingDots(text: string): string {
	return text.replace(/[\s.…]+$/, '').trimEnd();
}

interface ILazyToolItem {
	kind: 'tool';
	lazy: Lazy<{ domNode: HTMLElement; disposable?: IDisposable }>;
	toolInvocationId?: string;
	toolInvocationOrMarkdown?: IChatToolInvocation | IChatToolInvocationSerialized | IChatMarkdownContent;
	originalParent?: HTMLElement;
}

interface ILazyThinkingItem {
	kind: 'thinking';
	textContainer: HTMLElement;
	content: IChatThinkingPart;
}

type ILazyItem = ILazyToolItem | ILazyThinkingItem;
const THINKING_SCROLL_MAX_HEIGHT = 200;

export class ChatThinkingContentPart extends ChatCollapsibleContentPart implements IChatContentPart {
	public readonly codeblocks: undefined;
	public readonly codeblocksPartId: undefined;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());

	private id: string | undefined;
	private content: IChatThinkingPart;
	private currentThinkingValue: string;
	private currentTitle: string;
	private defaultTitle = localize('chat.thinking.header', 'Working');
	private thinkingTitle = localize('chat.thinking.reasoning', 'Thinking');
	private textContainer!: HTMLElement;
	private markdownResult: IRenderedMarkdown | undefined;
	private wrapper!: HTMLElement;
	private fixedScrollingMode: boolean = false;
	private autoCollapseMode: boolean = false;
	private autoScrollEnabled: boolean = true;
	private scrollableElement: DomScrollableElement | undefined;
	private lastExtractedTitle: string | undefined;
	private extractedTitles: string[] = [];
	private toolInvocationCount: number = 0;
	private appendedItemCount: number = 0;
	private isActive: boolean = true;
	private toolInvocations: (IChatToolInvocation | IChatToolInvocationSerialized)[] = [];
	private singleItemInfo: { element: HTMLElement; originalParent: HTMLElement; originalNextSibling: Node | null } | undefined;
	private lazyItems: ILazyItem[] = [];
	private hasExpandedOnce: boolean = false;

	constructor(
		content: IChatThinkingPart,
		context: IChatContentPartRenderContext,
		private readonly chatContentMarkdownRenderer: IMarkdownRenderer,
		private streamingCompleted: boolean,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatMarkdownAnchorService private readonly chatMarkdownAnchorService: IChatMarkdownAnchorService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IHoverService hoverService: IHoverService,
	) {
		const initialText = extractTextFromPart(content);
		const extractedHeader = extractTitleFromThinkingContent(initialText);
		// No literal "..." here: the animated ellipsis (rendered separately) provides the motion,
		// and a static "Working..." string would otherwise stick as the finished title.
		const extractedTitle = extractedHeader ?? localize('chat.thinking.initial', 'Thinking');

		super(extractedTitle, context, undefined, hoverService);

		this.id = content.id;
		this.content = content;
		const configuredMode = this.configurationService.getValue<ThinkingDisplayMode>('chat.agent.thinkingStyle') ?? ThinkingDisplayMode.FixedScrolling;

		this.fixedScrollingMode = configuredMode === ThinkingDisplayMode.FixedScrolling;
		this.autoCollapseMode = configuredMode === ThinkingDisplayMode.AutoCollapse;

		this.currentTitle = extractedTitle;
		if (extractedHeader) {
			this.lastExtractedTitle = extractedHeader;
		}
		this.currentThinkingValue = initialText;

		// Alert screen reader users that thinking has started
		alert(localize('chat.thinking.started', 'Thinking'));

		if (configuredMode === ThinkingDisplayMode.Collapsed) {
			this.setExpanded(false);
		} else if (configuredMode === ThinkingDisplayMode.CollapsedPreview) {
			// Start expanded if still in progress
			// Use streamingCompleted to support look-ahead completion: when we know
			// this thinking part is done (based on subsequent non-pinnable parts)
			// even though the overall response is not complete
			this.setExpanded(!this.streamingCompleted && !this.element.isComplete);
		} else if (configuredMode === ThinkingDisplayMode.AutoCollapse) {
			// Expand while the model is thinking; auto-collapse once done
			this.setExpanded(!this.streamingCompleted && !this.element.isComplete);
		} else if (configuredMode === ThinkingDisplayMode.FixedScrolling) {
			this.setExpanded(true);
		} else {
			this.setExpanded(false);
		}

		const node = this.domNode;
		node.classList.add('chat-thinking-box');
		// While the thinking part is active (still streaming/working), mark it so the
		// "Working..." title shimmers. Removed once the part finalizes/goes inactive.
		node.classList.toggle('chat-thinking-active', this.isActive && !this.element.isComplete);
		node.tabIndex = 0;

		if (this.fixedScrollingMode) {
			node.classList.add('chat-thinking-fixed-mode');
			this.refreshActiveTitle();
			if (this._collapseButton && !this.element.isComplete) {
				this._setLoadingIcon();
			}
		}

		// override for codicon chevron in the collapsible part
		this._register(autorun(r => {
			this.expanded.read(r);
			if (this._collapseButton && this.wrapper) {
				if (this.wrapper.classList.contains('chat-thinking-streaming') && !this.element.isComplete) {
					this._setLoadingIcon();
				} else {
					this._clearLoadingIcon();
					this._collapseButton.icon = Codicon.check;
				}
			}
		}));

		this._register(autorun(r => {
			// Materialize lazy items when first expanded
			if (this._isExpanded.read(r) && !this.hasExpandedOnce && this.lazyItems.length > 0) {
				this.hasExpandedOnce = true;
				for (const item of this.lazyItems) {
					this.materializeLazyItem(item);
				}
			}
			// Fire when expanded/collapsed
			this._onDidChangeHeight.fire();
		}));

		if (this._collapseButton && !this.streamingCompleted && !this.element.isComplete) {
			this._setLoadingIcon();
		}

		const label = this.lastExtractedTitle ?? '';
		if (!this.fixedScrollingMode && !this._isExpanded.get()) {
			this.setTitle(label);
		}

		if (this._collapseButton) {
			this._register(this._collapseButton.onDidClick(() => {
				if (this.streamingCompleted || this.fixedScrollingMode) {
					return;
				}

				const expanded = this.isExpanded();
				if (expanded) {
					this.setTitle(this.defaultTitle, true);
					this.currentTitle = this.defaultTitle;
				} else if (this.lastExtractedTitle) {
					const collapsedLabel = this.lastExtractedTitle ?? '';
					this.setTitle(collapsedLabel);
					this.currentTitle = collapsedLabel;
				}
			}));
		}
	}

	protected override shouldInitEarly(): boolean {
		return this.fixedScrollingMode && !this.streamingCompleted;
	}

	// @TODO: @justschen Convert to template for each setting?
	protected override initContent(): HTMLElement {
		this.wrapper = $('.chat-used-context-list.chat-thinking-collapsible');
		if (!this.streamingCompleted) {
			this.wrapper.classList.add('chat-thinking-streaming');
		}

		// Only create textContainer here if there's no pending lazy thinking item.
		// If there's a lazy thinking item, it will be rendered via materializeLazyItem
		// with the latest streaming content.
		const hasLazyThinkingItems = this.lazyItems.some(item => item.kind === 'thinking');
		if (this.currentThinkingValue && !hasLazyThinkingItems) {
			this.textContainer = $('.chat-thinking-item.markdown-content');
			this.wrapper.appendChild(this.textContainer);
			this.renderMarkdown(this.currentThinkingValue);
		}

		// wrap content in scrollable element for fixed scrolling mode
		if (this.fixedScrollingMode) {
			this.scrollableElement = this._register(new DomScrollableElement(this.wrapper, {
				vertical: ScrollbarVisibility.Auto,
				horizontal: ScrollbarVisibility.Hidden,
				handleMouseWheel: true,
				alwaysConsumeMouseWheel: false
			}));
			this._register(this.scrollableElement.onScroll(e => this.handleScroll(e.scrollTop)));

			this._register(this._onDidChangeHeight.event(() => {
				setTimeout(() => this.scrollToBottomIfEnabled(), 0);
			}));

			setTimeout(() => this.scrollToBottomIfEnabled(), 0);

			this.updateDropdownClickability();
			return this.scrollableElement.getDomNode();
		}

		// In the non-fixed modes the wrapper is a plain CSS-capped scroll container. The
		// surrounding chat list (monaco-list) otherwise swallows the wheel event, so the page
		// scrolls instead of the box. Keep the wheel inside the box until it reaches an edge,
		// then let it bubble so the conversation continues scrolling naturally.
		this._register(addDisposableListener(this.wrapper, 'wheel', (e: WheelEvent) => {
			const el = this.wrapper;
			if (!el || el.scrollHeight <= el.clientHeight) {
				return;
			}
			const atTop = el.scrollTop <= 0 && e.deltaY < 0;
			const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight && e.deltaY > 0;
			if (!atTop && !atBottom) {
				e.stopPropagation();
			}
		}));

		this.updateDropdownClickability();
		return this.wrapper;
	}

	private handleScroll(scrollTop: number): void {
		if (!this.scrollableElement) {
			return;
		}

		const scrollDimensions = this.scrollableElement.getScrollDimensions();
		const maxScrollTop = scrollDimensions.scrollHeight - scrollDimensions.height;
		const isAtBottom = maxScrollTop <= 0 || scrollTop >= maxScrollTop - 10;

		if (isAtBottom) {
			this.autoScrollEnabled = true;
		} else {
			this.autoScrollEnabled = false;
		}
	}

	/**
	 * Pin the active reasoning view to its latest content. In fixed mode this defers to the
	 * DomScrollableElement; in the other modes (AutoCollapse / CollapsedPreview / plain
	 * expanded) the wrapper itself is the scroll container (capped via CSS), so both streaming
	 * reasoning text and appended tool-call items keep it scrolled to the bottom.
	 */
	private scrollActiveViewToBottom(): void {
		if (this.fixedScrollingMode && this.scrollableElement) {
			setTimeout(() => this.scrollToBottomIfEnabled(), 0);
			return;
		}
		if (!this.wrapper) {
			return;
		}
		setTimeout(() => {
			if (this.wrapper) {
				this.wrapper.scrollTop = this.wrapper.scrollHeight;
			}
		}, 0);
	}

	private scrollToBottomIfEnabled(): void {
		if (!this.scrollableElement || !this.autoScrollEnabled) {
			return;
		}

		// Constrain to the fixed window while actively streaming (whether the block is
		// expanded or collapsed). The expanded fixed-scrolling view starts expanded, so a
		// collapsed-only guard would let it grow unbounded as reasoning streams in.
		const isStreaming = this.fixedScrollingMode && !this.streamingCompleted;
		const isCollapsed = this.domNode.classList.contains('chat-used-context-collapsed');
		if (!isStreaming && !isCollapsed) {
			return;
		}

		const contentHeight = this.wrapper.scrollHeight;
		const viewportHeight = Math.min(contentHeight, THINKING_SCROLL_MAX_HEIGHT);

		this.scrollableElement.setScrollDimensions({
			width: this.scrollableElement.getDomNode().clientWidth,
			scrollWidth: this.wrapper.scrollWidth,
			height: viewportHeight,
			scrollHeight: contentHeight
		});

		if (contentHeight > viewportHeight) {
			this.scrollableElement.setScrollPosition({ scrollTop: contentHeight - viewportHeight });
		}
	}

	/**
	 * updates scroll dimensions when streaming is complete.
	 */
	private updateScrollDimensionsForCompletion(): void {
		if (!this.scrollableElement || !this.fixedScrollingMode) {
			return;
		}

		const contentHeight = this.wrapper.scrollHeight;
		const viewportHeight = Math.min(contentHeight, THINKING_SCROLL_MAX_HEIGHT);

		this.scrollableElement.setScrollDimensions({
			width: this.scrollableElement.getDomNode().clientWidth,
			scrollWidth: this.wrapper.scrollWidth,
			height: viewportHeight,
			scrollHeight: contentHeight
		});

		if (contentHeight <= THINKING_SCROLL_MAX_HEIGHT) {
			this.scrollableElement.setScrollPosition({ scrollTop: 0 });
		}
	}

	private renderMarkdown(content: string, reuseExisting?: boolean): void {
		// Guard against rendering after disposal to avoid leaking disposables
		if (this._store.isDisposed) {
			return;
		}
		const cleanedContent = content.trim();
		if (!cleanedContent) {
			if (this.markdownResult) {
				this.markdownResult.dispose();
				this.markdownResult = undefined;
			}
			// Lazily create textContainer if initContent() ran before any thinking content arrived
			if (!this.textContainer && this.wrapper) {
				this.textContainer = $('.chat-thinking-item.markdown-content');
				this.wrapper.appendChild(this.textContainer);
			}
			if (this.textContainer) {
				clearNode(this.textContainer);
				this.textContainer.appendChild(createThinkingIcon(Codicon.circleFilled));
				const placeholder = $('span.chat-thinking-placeholder');
				placeholder.textContent = 'Thinking...';
				this.textContainer.appendChild(placeholder);
			}
			return;
		}

		// If the entire content is bolded, strip the bold markers for rendering
		let contentToRender = cleanedContent;
		if (cleanedContent.startsWith('**') && cleanedContent.endsWith('**')) {
			contentToRender = cleanedContent.slice(2, -2);
		}

		const target = reuseExisting ? this.markdownResult?.element : undefined;
		if (this.markdownResult) {
			this.markdownResult.dispose();
			this.markdownResult = undefined;
		}

		const rendered = this._register(this.chatContentMarkdownRenderer.render(new MarkdownString(contentToRender), {
			fillInIncompleteTokens: true,
			asyncRenderCallback: () => this._onDidChangeHeight.fire(),
			codeBlockRendererSync: (_languageId, text, raw) => {
				const codeElement = $('code');
				codeElement.textContent = text;
				return codeElement;
			}
		}, target));
		this.markdownResult = rendered;
		if (!target) {
			// Lazily create textContainer if initContent() ran before any thinking content arrived
			if (!this.textContainer && this.wrapper) {
				this.textContainer = $('.chat-thinking-item.markdown-content');
				this.wrapper.appendChild(this.textContainer);
			}
			if (this.textContainer) {
				clearNode(this.textContainer);
				this.textContainer.appendChild(createThinkingIcon(Codicon.circleFilled));
				this.textContainer.appendChild(rendered.element);
			}
		}
	}

	private setDropdownClickable(clickable: boolean): void {
		if (this._collapseButton) {
			this._collapseButton.element.style.pointerEvents = clickable ? 'auto' : 'none';
		}

		if (!clickable && this.streamingCompleted) {
			super.setTitle(this.lastExtractedTitle ?? this.currentTitle);
		}
	}

	private updateDropdownClickability(): void {
		if (!this.wrapper) {
			return;
		}

		if (this.wrapper.children.length > 1 || this.toolInvocationCount > 0) {
			this.setDropdownClickable(true);
			return;
		}

		const contentWithoutTitle = this.currentThinkingValue.trim();
		const titleToCompare = this.lastExtractedTitle ?? this.currentTitle;

		const stripMarkdown = (text: string) => {
			return text
				.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1').trim();
		};

		const strippedContent = stripMarkdown(contentWithoutTitle);
		const shouldDisable = !strippedContent || strippedContent === titleToCompare;
		this.setDropdownClickable(!shouldDisable);
	}

	public resetId(): void {
		this.id = undefined;
	}

	public collapseContent(): void {
		this.setExpanded(false);
	}

	public updateThinking(content: IChatThinkingPart): void {
		// If disposed, ignore late updates coming from renderer diffing
		if (this._store.isDisposed) {
			return;
		}
		this.content = content;

		// Update any pending lazy thinking item with matching ID so that
		// when materialized, it will have the latest streaming content
		for (const lazyItem of this.lazyItems) {
			if (lazyItem.kind === 'thinking' && lazyItem.content.id === content.id) {
				lazyItem.content = content;
				break;
			}
		}

		const raw = extractTextFromPart(content);
		const next = raw;
		if (next === this.currentThinkingValue) {
			return;
		}
		const previousValue = this.currentThinkingValue;
		const reuseExisting = !!(this.markdownResult && next.startsWith(previousValue) && next.length > previousValue.length);
		this.currentThinkingValue = next;
		this.renderMarkdown(next, reuseExisting);

		this.scrollActiveViewToBottom();

		// Keep the header context-aware as reasoning streams in (e.g. "Thinking…" before any
		// tool runs). The extracted-title path below handles richer labels when available.
		this.refreshActiveTitle();

		const extractedTitle = extractTitleFromThinkingContent(raw);
		if (extractedTitle && extractedTitle !== this.currentTitle) {
			if (!this.extractedTitles.includes(extractedTitle)) {
				this.extractedTitles.push(extractedTitle);
			}
			this.lastExtractedTitle = extractedTitle;
		}

		if (!extractedTitle || extractedTitle === this.currentTitle) {
			return;
		}

		const label = this.lastExtractedTitle ?? '';
		if (!this.fixedScrollingMode && !this._isExpanded.get()) {
			this.setTitle(label);
		}

		this.updateDropdownClickability();
	}

	public getIsActive(): boolean {
		return this.isActive;
	}

	public markAsInactive(): void {
		this.isActive = false;
		this.domNode.classList.remove('chat-thinking-active');
	}

	public finalizeTitleIfDefault(): void {
		// With lazy rendering, wrapper may not be created yet if content hasn't been expanded
		if (this.wrapper) {
			this.wrapper.classList.remove('chat-thinking-streaming');
		}
		this.streamingCompleted = true;
		this.domNode.classList.remove('chat-thinking-active');

		if (this._collapseButton) {
			this._collapseButton.icon = Codicon.check;
		}

		// Auto-collapse when streaming finishes in autoCollapse mode
		if (this.autoCollapseMode) {
			this.setExpanded(false);
		}

		// Update scroll dimensions now that streaming is complete
		// This removes unnecessary scrollbar when content fits
		this.updateScrollDimensionsForCompletion();

		this.updateDropdownClickability();

		if (this.content.generatedTitle) {
			this.currentTitle = this.content.generatedTitle;
			super.setTitle(this.content.generatedTitle);
			return;
		}

		const existingToolTitle = this.toolInvocations.find(t => t.generatedTitle)?.generatedTitle;
		if (existingToolTitle) {
			this.currentTitle = existingToolTitle;
			this.content.generatedTitle = existingToolTitle;
			super.setTitle(existingToolTitle);
			return;
		}

		// case where we only have one item (tool or edit) in the thinking container and no thinking parts, we want to move it back to its original position
		if (this.appendedItemCount === 1 && this.currentThinkingValue.trim() === '' && this.singleItemInfo) {
			this.restoreSingleItemToOriginalPosition();
			return;
		}

		// if exactly one actual extracted title and no tool invocations, use that as the final title.
		if (this.extractedTitles.length === 1 && this.toolInvocationCount === 0) {
			const title = this.extractedTitles[0];
			this.currentTitle = title;
			this.content.generatedTitle = title;
			super.setTitle(title);
			return;
		}

		const generateTitles = this.configurationService.getValue<boolean>(ChatConfiguration.ThinkingGenerateTitles) ?? true;
		if (!generateTitles) {
			this.setFallbackTitle();
			return;
		}

		this.generateTitleViaLLM();
	}

	private setGeneratedTitleOnToolInvocations(title: string): void {
		for (const toolInvocation of this.toolInvocations) {
			toolInvocation.generatedTitle = title;
		}
	}

	private async generateTitleViaLLM(): Promise<void> {
		try {
			let models = await this.languageModelsService.selectLanguageModels({ vendor: 'copilot', id: 'copilot-fast' });
			if (!models.length) {
				models = await this.languageModelsService.selectLanguageModels({ vendor: 'copilot', family: 'gpt-4o-mini' });
			}
			if (!models.length) {
				this.setFallbackTitle();
				return;
			}

			let context: string;
			if (this.extractedTitles.length > 0) {
				context = this.extractedTitles.join(', ');
			} else {
				context = this.currentThinkingValue.substring(0, 1000);
			}

			const prompt = `Summarize the following content in a SINGLE sentence (under 10 words) using past tense. Follow these rules strictly:

			OUTPUT FORMAT:
			- MUST be a single sentence
			- MUST be under 10 words
			- No quotes, no trailing punctuation

			GENERAL:
			- The content may include tool invocations (file edits, reads, searches, terminal commands), reasoning headers, or raw thinking text
			- For reasoning headers or thinking text (no tool calls), summarize WHAT was considered/analyzed, NOT that thinking occurred
			- For thinking-only summaries, use phrases like: "Considered...", "Planned...", "Analyzed...", "Reviewed..."

			TOOL NAME FILTERING:
			- NEVER include tool names like "Replace String in File", "Multi Replace String in File", "Create File", "Read File", etc. in the output
			- If an action says "Edited X and used Replace String in File", output ONLY the action on X
			- Tool names describe HOW something was done, not WHAT was done - always omit them

			VOCABULARY - Use varied synonyms for natural-sounding summaries:
			- For edits: "Updated", "Modified", "Changed", "Refactored", "Fixed", "Adjusted"
			- For reads: "Reviewed", "Examined", "Checked", "Inspected", "Analyzed", "Explored"
			- For creates: "Created", "Added", "Generated"
			- For searches: "Searched for", "Looked up", "Investigated"
			- For terminal: "Ran command", "Executed"
			- For reasoning/thinking: "Considered", "Planned", "Analyzed", "Reviewed", "Evaluated"
			- Choose the synonym that best fits the context

			RULES FOR TOOL CALLS:
			1. If the SAME file was both edited AND read: Use a combined phrase like "Reviewed and updated <filename>"
			2. If exactly ONE file was edited: Start with an edit synonym + "<filename>" (include actual filename)
			3. If exactly ONE file was read: Start with a read synonym + "<filename>" (include actual filename)
			4. If MULTIPLE files were edited: Start with an edit synonym + "X files"
			5. If MULTIPLE files were read: Start with a read synonym + "X files"
			6. If BOTH edits AND reads occurred on DIFFERENT files: Combine them naturally
			7. For searches: Say "searched for <term>" or "looked up <term>" with the actual search term, NOT "searched for files"
			8. After the file info, you may add a brief summary of other actions if space permits
			9. NEVER say "1 file" - always use the actual filename when there's only one file

			RULES FOR REASONING HEADERS (no tool calls):
			1. If the input contains reasoning/analysis headers without actual tool invocations, summarize the main topic and what was considered
			2. Use past tense verbs that indicate thinking, not doing: "Considered", "Planned", "Analyzed", "Evaluated"
			3. Focus on WHAT was being thought about, not that thinking occurred

			RULES FOR RAW THINKING TEXT:
			1. Extract the main topic or question being considered from the text
			2. Identify any specific files, functions, or concepts mentioned
			3. Summarize as "Analyzed <topic>" or "Considered <specific thing>"
			4. If discussing code structure: "Reviewed <component/architecture>"
			5. If discussing a problem: "Analyzed <problem description>"
			6. If discussing implementation: "Planned <feature/change>"

			EXAMPLES WITH TOOLS:
			- "Read HomePage.tsx, Edited HomePage.tsx" → "Reviewed and updated HomePage.tsx"
			- "Edited HomePage.tsx" → "Updated HomePage.tsx"
			- "Edited config.css and used Replace String in File" → "Modified config.css"
			- "Edited App.tsx, used Multi Replace String in File" → "Refactored App.tsx"
			- "Read config.json, Read package.json" → "Reviewed 2 files"
			- "Edited App.tsx, Read utils.ts" → "Updated App.tsx and checked utils.ts"
			- "Edited App.tsx, Read utils.ts, Read types.ts" → "Updated App.tsx and reviewed 2 files"
			- "Edited index.ts, Edited styles.css, Ran terminal command" → "Modified 2 files and ran command"
			- "Read README.md, Searched for AuthService" → "Checked README.md and searched for AuthService"
			- "Searched for login, Searched for authentication" → "Searched for login and authentication"
			- "Edited api.ts, Edited models.ts, Read schema.json" → "Updated 2 files and reviewed schema.json"
			- "Edited Button.tsx, Edited Button.css, Edited index.ts" → "Modified 3 files"
			- "Searched codebase for error handling" → "Looked up error handling"

			EXAMPLES WITH REASONING HEADERS (no tools):
			- "Analyzing component architecture" → "Considered component architecture"
			- "Planning refactor strategy" → "Planned refactor strategy"
			- "Reviewing error handling approach, Considering edge cases" → "Analyzed error handling approach"
			- "Understanding the codebase structure" → "Reviewed codebase structure"
			- "Thinking about implementation options" → "Considered implementation options"

			EXAMPLES WITH RAW THINKING TEXT:
			- "I need to understand how the authentication flow works in this app..." → "Analyzed authentication flow"
			- "Let me think about how to refactor this component to be more maintainable..." → "Planned component refactoring"
			- "The error seems to be coming from the database connection..." → "Investigated database connection issue"
			- "Looking at the UserService class, I see it handles..." → "Reviewed UserService implementation"

			Content: ${context}`;

			const response = await this.languageModelsService.sendChatRequest(
				models[0],
				new ExtensionIdentifier('core'),
				[{ role: ChatMessageRole.User, content: [{ type: 'text', value: prompt }] }],
				{},
				CancellationToken.None
			);

			let generatedTitle = '';
			for await (const part of response.stream) {
				if (Array.isArray(part)) {
					for (const p of part) {
						if (p.type === 'text') {
							generatedTitle += p.value;
						}
					}
				} else if (part.type === 'text') {
					generatedTitle += part.value;
				}
			}

			await response.result;
			generatedTitle = generatedTitle.trim();

			if (generatedTitle.includes('can\'t assist with that')) {
				this.setFallbackTitle();
				return;
			}

			if (generatedTitle && !this._store.isDisposed) {
				this.currentTitle = generatedTitle;
				if (this._collapseButton) {
					this._collapseButton.label = generatedTitle;
				}
				this.content.generatedTitle = generatedTitle;
				this.setGeneratedTitleOnToolInvocations(generatedTitle);
				return;
			}
		} catch (error) {
			// fall through to default title
		}

		this.setFallbackTitle();
	}

	private restoreSingleItemToOriginalPosition(): void {
		if (!this.singleItemInfo) {
			return;
		}

		const { element, originalParent, originalNextSibling } = this.singleItemInfo;

		// don't restore it to original position - it contains multiple rendered elements
		if (element.childElementCount > 1) {
			this.singleItemInfo = undefined;
			return;
		}

		if (originalNextSibling && originalNextSibling.parentNode === originalParent) {
			originalParent.insertBefore(element, originalNextSibling);
		} else {
			originalParent.appendChild(element);
		}

		hide(this.domNode);
		this.singleItemInfo = undefined;
	}

	/**
	 * The label to show while the block is still active. Prefers the most recent concrete
	 * action (tool message / extracted reasoning header). Falls back to "Thinking…" when
	 * there is reasoning text but no action yet, and "Working…" otherwise.
	 */
	private computeActiveTitle(): string {
		if (this.lastExtractedTitle) {
			return stripTrailingDots(this.lastExtractedTitle);
		}
		// This is a thinking/reasoning block, so default to "Thinking" (not "Working") even
		// before any reasoning text has streamed in.
		return this.thinkingTitle;
	}

	/**
	 * Drive the collapsible header with a context-aware label while streaming. This also
	 * handles fixed-scrolling mode, where the header would otherwise stay pinned to "Working…".
	 */
	private refreshActiveTitle(): void {
		if (this.streamingCompleted || this.element.isComplete) {
			return;
		}
		// In non-fixed mode the expanded view manages its own title; only drive it here when
		// collapsed. In fixed mode we always drive it (the content scrolls below the header).
		if (this.fixedScrollingMode || !this._isExpanded.get()) {
			const title = this.computeActiveTitle();
			this.currentTitle = title;
			super.setTitle(title);
		}
	}

	/**
	 * Build a concise, context-aware "finished" summary from the actions tracked during the
	 * block. Used when LLM title generation isn't available (e.g. local-only model setups),
	 * replacing the generic "Finished working and invoked N tools".
	 */
	private buildFinishedSummary(): string {
		const titles = this.extractedTitles;
		let edited = 0;
		let read = 0;
		let searched = 0;
		let ran = 0;
		let lastEditedFile: string | undefined;

		// Only treat a token as a filename if it actually looks like one (has an extension or a
		// path separator) so we never surface tool names like "modifyFile" as the edited file.
		const findFileName = (raw: string): string | undefined => {
			const candidates = [
				raw.match(/`([^`]+)`/)?.[1],
				...(raw.match(/[\w\-./\\]+\.[a-zA-Z0-9]+/g) ?? [])
			].filter((c): c is string => !!c);
			for (const c of candidates) {
				const cleaned = c.replace(/[)\].,]+$/, '');
				if (/[./\\]/.test(cleaned) && /\.[a-zA-Z0-9]+$/.test(cleaned)) {
					return cleaned.split(/[/\\]/).pop();
				}
			}
			return undefined;
		};

		for (const raw of titles) {
			const t = raw.toLowerCase();
			if (/\b(edit|edited|editing|updat|modif|chang|refactor|creat|wrote|writing|replac)/.test(t)) {
				edited++;
				const file = findFileName(raw);
				if (file) {
					lastEditedFile = file;
				}
			} else if (/\b(search|searching|grep|look(ed|ing)?\s+up|find|finding)/.test(t)) {
				searched++;
			} else if (/\b(ran|running|execut|terminal|command|\$)/.test(t)) {
				ran++;
			} else if (/\b(read|reading|review|examin|inspect|check)/.test(t)) {
				read++;
			}
		}

		const parts: string[] = [];
		if (edited === 1 && lastEditedFile) {
			parts.push(localize('chat.thinking.summary.editedOne', 'Edited {0}', lastEditedFile));
		} else if (edited === 1) {
			parts.push(localize('chat.thinking.summary.editedFile', 'Edited a file'));
		} else if (edited > 1) {
			parts.push(localize('chat.thinking.summary.editedMany', 'Edited {0} files', edited));
		}
		if (read === 1) {
			parts.push(localize('chat.thinking.summary.readOne', 'reviewed a file'));
		} else if (read > 1) {
			parts.push(localize('chat.thinking.summary.readMany', 'reviewed {0} files', read));
		}
		if (searched > 0) {
			parts.push(localize('chat.thinking.summary.searched', 'searched the codebase'));
		}
		if (ran === 1) {
			parts.push(localize('chat.thinking.summary.ranOne', 'ran a command'));
		} else if (ran > 1) {
			parts.push(localize('chat.thinking.summary.ranMany', 'ran {0} commands', ran));
		}

		if (parts.length > 0) {
			// Capitalize and join naturally: "A", "A and B", "A, B and C".
			let summary: string;
			if (parts.length === 1) {
				summary = parts[0];
			} else {
				summary = parts.slice(0, -1).join(', ') + localize('chat.thinking.summary.and', ' and ') + parts[parts.length - 1];
			}
			return summary.charAt(0).toUpperCase() + summary.slice(1);
		}

		// No recognizable tool actions.
		if (this.toolInvocationCount > 0) {
			return localize('chat.thinking.finished.withTools', 'Finished working and invoked {0} tool{1}', this.toolInvocationCount, this.toolInvocationCount === 1 ? '' : 's');
		}
		if (this.lastExtractedTitle) {
			return this.lastExtractedTitle;
		}
		return localize('chat.thinking.finishedThinking', 'Finished thinking');
	}

	private setFallbackTitle(): void {
		const finalLabel = this.buildFinishedSummary();

		this.currentTitle = finalLabel;
		// With lazy rendering, wrapper may not be created yet if content hasn't been expanded
		if (this.wrapper) {
			this.wrapper.classList.remove('chat-thinking-streaming');
		}
		this.streamingCompleted = true;

		if (this._collapseButton) {
			this._collapseButton.icon = Codicon.check;
			this._collapseButton.label = finalLabel;
		}

		// Auto-collapse when streaming finishes in autoCollapse mode
		if (this.autoCollapseMode) {
			this.setExpanded(false);
		}

		this.updateDropdownClickability();
	}

	/**
	 * Appends a tool invocation or content item to the thinking group.
	 * The factory is called lazily - only when the thinking section is expanded.
	 * If already expanded, the factory is called immediately.
	 */
	public appendItem(
		factory: () => { domNode: HTMLElement; disposable?: IDisposable },
		toolInvocationId?: string,
		toolInvocationOrMarkdown?: IChatToolInvocation | IChatToolInvocationSerialized | IChatMarkdownContent,
		originalParent?: HTMLElement
	): void {
		// Track tool invocation metadata immediately (for title generation)
		this.trackToolMetadata(toolInvocationId, toolInvocationOrMarkdown);
		this.appendedItemCount++;

		// If expanded or has been expanded once, render immediately
		if (this.isExpanded() || this.hasExpandedOnce || (this.fixedScrollingMode && !this.streamingCompleted)) {
			const result = factory();
			this.appendItemToDOM(result.domNode, toolInvocationId, toolInvocationOrMarkdown, originalParent);
			if (result.disposable) {
				this._register(result.disposable);
			}
		} else {
			// Defer rendering until expanded
			const item: ILazyToolItem = {
				kind: 'tool',
				lazy: new Lazy(factory),
				toolInvocationId,
				toolInvocationOrMarkdown,
				originalParent
			};
			this.lazyItems.push(item);
		}

		this.updateDropdownClickability();
	}

	/**
	 * removes/re-establishes a lazy item from the thinking container
	 * this is needed so we can check if there are confirmations still needed
	 */
	public removeLazyItem(toolInvocationId: string): boolean {
		const index = this.lazyItems.findIndex(item => item.kind === 'tool' && item.toolInvocationId === toolInvocationId);
		if (index === -1) {
			return false;
		}

		this.lazyItems.splice(index, 1);
		this.appendedItemCount--;
		this.toolInvocationCount--;

		const toolInvocationsIndex = this.toolInvocations.findIndex(t =>
			(t.kind === 'toolInvocation' || t.kind === 'toolInvocationSerialized') && t.toolId === toolInvocationId
		);
		if (toolInvocationsIndex !== -1) {
			this.toolInvocations.splice(toolInvocationsIndex, 1);
		}

		this.updateDropdownClickability();
		return true;
	}

	private trackToolMetadata(
		toolInvocationId?: string,
		toolInvocationOrMarkdown?: IChatToolInvocation | IChatToolInvocationSerialized | IChatMarkdownContent
	): void {
		if (!toolInvocationId) {
			return;
		}

		this.toolInvocationCount++;
		let toolCallLabel: string;

		const isToolInvocation = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized');
		if (isToolInvocation && toolInvocationOrMarkdown.invocationMessage) {
			const message = typeof toolInvocationOrMarkdown.invocationMessage === 'string' ? toolInvocationOrMarkdown.invocationMessage : toolInvocationOrMarkdown.invocationMessage.value;
			toolCallLabel = message;

			this.toolInvocations.push(toolInvocationOrMarkdown);

			// track state for live/still streaming tools, excluding serialized tools
			if (toolInvocationOrMarkdown.kind === 'toolInvocation') {
				let currentToolLabel = toolCallLabel;
				let isComplete = false;

				const updateTitle = (updatedMessage: string) => {
					if (updatedMessage && updatedMessage !== currentToolLabel) {
						// replace old title if exists, otherwise add new
						const oldIndex = this.extractedTitles.indexOf(currentToolLabel);
						const updatedIndex = this.extractedTitles.indexOf(updatedMessage);

						if (oldIndex !== -1) {
							if (updatedIndex !== -1 && updatedIndex !== oldIndex) {
								this.extractedTitles.splice(oldIndex, 1);
							} else {
								this.extractedTitles[oldIndex] = updatedMessage;
							}
						} else if (updatedIndex === -1) {
							this.extractedTitles.push(updatedMessage);
						}
						currentToolLabel = updatedMessage;
						this.lastExtractedTitle = updatedMessage;

						// Drive the header with the current tool action. refreshActiveTitle handles
						// both fixed mode and the collapsed non-fixed view (and skips when expanded).
						this.refreshActiveTitle();
					}
				};

				this._register(autorun(reader => {
					if (isComplete) {
						return;
					}

					const currentState = toolInvocationOrMarkdown.state.read(reader);

					if (currentState.type === IChatToolInvocation.StateKind.Completed ||
						currentState.type === IChatToolInvocation.StateKind.Cancelled) {
						isComplete = true;
						return;
					}

					// streaming
					if (currentState.type === IChatToolInvocation.StateKind.Streaming) {
						const streamingMessage = currentState.streamingMessage.read(reader);
						if (streamingMessage) {
							const updatedMessage = typeof streamingMessage === 'string' ? streamingMessage : streamingMessage.value;
							updateTitle(updatedMessage);
						}
						return;
					}

					// executing (something like `Replacing 67 lines.....`)
					if (currentState.type === IChatToolInvocation.StateKind.Executing) {
						const progressData = currentState.progress.read(reader);
						if (progressData.message) {
							const updatedMessage = typeof progressData.message === 'string' ? progressData.message : progressData.message.value;
							updateTitle(updatedMessage);
						} else {
							const invocationMsg = toolInvocationOrMarkdown.invocationMessage;
							if (invocationMsg) {
								const updatedMessage = typeof invocationMsg === 'string' ? invocationMsg : invocationMsg.value;
								updateTitle(updatedMessage);
							}
						}
						return;
					}

					// confirmations, failures, completed, other, etc
					const invocationMsg = toolInvocationOrMarkdown.invocationMessage;
					if (invocationMsg) {
						const updatedMessage = typeof invocationMsg === 'string' ? invocationMsg : invocationMsg.value;
						updateTitle(updatedMessage);
					}
				}));
			}
		} else if (toolInvocationOrMarkdown?.kind === 'markdownContent') {
			const codeblockInfo = extractCodeblockUrisFromText(toolInvocationOrMarkdown.content.value);
			if (codeblockInfo?.uri) {
				const filename = basename(codeblockInfo.uri);
				toolCallLabel = localize('chat.thinking.editedFile', 'Edited {0}', filename);
			} else {
				toolCallLabel = localize('chat.thinking.editingFile', 'Edited file');
			}
		} else {
			toolCallLabel = `Invoked \`${toolInvocationId}\``;
		}

		// Add tool call to extracted titles for LLM title generation
		if (!this.extractedTitles.includes(toolCallLabel)) {
			this.extractedTitles.push(toolCallLabel);
		}

		this.lastExtractedTitle = toolCallLabel;

		if (!this.fixedScrollingMode && !this._isExpanded.get()) {
			this.setTitle(toolCallLabel);
		}
	}

	private appendItemToDOM(
		content: HTMLElement,
		toolInvocationId?: string,
		toolInvocationOrMarkdown?: IChatToolInvocation | IChatToolInvocationSerialized | IChatMarkdownContent,
		originalParent?: HTMLElement
	): void {
		if (!content.hasChildNodes() || content.textContent?.trim() === '') {
			return;
		}

		// Save the first item info for potential restoration later
		if (this.appendedItemCount === 1 && originalParent) {
			this.singleItemInfo = {
				element: content,
				originalParent,
				originalNextSibling: this.domNode
			};
		} else {
			this.singleItemInfo = undefined;
		}

		const itemWrapper = $('.chat-thinking-tool-wrapper');
		const isMarkdownEdit = toolInvocationOrMarkdown?.kind === 'markdownContent';
		const isTerminalTool = toolInvocationOrMarkdown && (toolInvocationOrMarkdown.kind === 'toolInvocation' || toolInvocationOrMarkdown.kind === 'toolInvocationSerialized') && toolInvocationOrMarkdown.toolSpecificData?.kind === 'terminal';

		let icon: ThemeIcon;
		if (isMarkdownEdit) {
			icon = Codicon.pencil;
		} else if (isTerminalTool) {
			const terminalData = (toolInvocationOrMarkdown as IChatToolInvocation | IChatToolInvocationSerialized).toolSpecificData as { kind: 'terminal'; terminalCommandState?: { exitCode?: number } };
			const exitCode = terminalData?.terminalCommandState?.exitCode;
			icon = exitCode !== undefined && exitCode !== 0 ? Codicon.error : Codicon.terminal;
		} else {
			icon = toolInvocationId ? getToolInvocationIcon(toolInvocationId) : Codicon.tools;
		}

		const iconElement = createThinkingIcon(icon);
		itemWrapper.appendChild(iconElement);
		itemWrapper.appendChild(content);

		// With lazy rendering, wrapper may not be created yet if content hasn't been expanded
		if (!this.wrapper) {
			return;
		}

		this.wrapper.appendChild(itemWrapper);

		// Keep the thinking block pinned to the newest item (tool call / edit) as it streams in.
		this.scrollActiveViewToBottom();
	}

	private materializeLazyItem(item: ILazyItem): void {
		if (item.kind === 'thinking') {
			// Materialize thinking container
			if (this.wrapper) {
				this.wrapper.appendChild(item.textContainer);
			}
			// Store reference to textContainer for updateThinking calls
			this.textContainer = item.textContainer;
			this.id = item.content.id;
			// Use item.content which is kept up-to-date during streaming via updateThinking
			this.updateThinking(item.content);
			return;
		}

		// Handle tool items
		if (item.lazy.hasValue) {
			return; // Already materialized
		}

		const result = item.lazy.value;
		this.appendItemToDOM(result.domNode, item.toolInvocationId, item.toolInvocationOrMarkdown, item.originalParent);

		if (result.disposable) {
			this._register(result.disposable);
		}
	}

	// makes a new text container. when we update, we now update this container.
	public setupThinkingContainer(content: IChatThinkingPart) {
		// Avoid creating new containers after disposal
		if (this._store.isDisposed) {
			return;
		}
		this.textContainer = $('.chat-thinking-item.markdown-content');
		if (content.value) {
			// Use lazy rendering when collapsed to preserve order with tool items
			if (this.isExpanded() || this.hasExpandedOnce || (this.fixedScrollingMode && !this.streamingCompleted)) {
				// Render immediately when expanded
				if (this.wrapper) {
					this.wrapper.appendChild(this.textContainer);
				}
				this.id = content.id;
				this.updateThinking(content);
			} else {
				// Update this.content and this.id so that subsequent updateThinking calls
				// or materializeLazyItem will use the correct content for this section
				this.content = content;
				this.id = content.id;
				// Defer rendering until expanded to preserve order
				const lazyThinking: ILazyThinkingItem = {
					kind: 'thinking',
					textContainer: this.textContainer,
					content
				};
				this.lazyItems.push(lazyThinking);
			}
		}
		this.updateDropdownClickability();
	}

	protected override setTitle(title: string, omitPrefix?: boolean): void {
		if (!title || this.element.isComplete) {
			return;
		}

		if (omitPrefix) {
			this.setTitleWithWidgets(new MarkdownString(title), this.instantiationService, this.chatMarkdownAnchorService, this.chatContentMarkdownRenderer);
			this.currentTitle = title;
			return;
		}
		const thinkingLabel = `Working: ${title}`;
		this.lastExtractedTitle = title;
		this.currentTitle = thinkingLabel;
		this.setTitleWithWidgets(new MarkdownString(thinkingLabel), this.instantiationService, this.chatMarkdownAnchorService, this.chatContentMarkdownRenderer);
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind === 'toolInvocation' || other.kind === 'toolInvocationSerialized' || other.kind === 'markdownContent') {
			return true;
		}

		if (other.kind !== 'thinking') {
			return false;
		}

		return other?.id !== this.id;
	}

	override dispose(): void {
		if (this.markdownResult) {
			this.markdownResult.dispose();
			this.markdownResult = undefined;
		}
		super.dispose();
	}
}
