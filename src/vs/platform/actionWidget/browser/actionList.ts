/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as dom from '../../../base/browser/dom.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import { KeybindingLabel } from '../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
import { IListEvent, IListMouseEvent, IListRenderer, IListVirtualDelegate } from '../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider, List } from '../../../base/browser/ui/list/listWidget.js';
import { IAction } from '../../../base/common/actions.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Codicon } from '../../../base/common/codicons.js';
import { ResolvedKeybinding } from '../../../base/common/keybindings.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { OS } from '../../../base/common/platform.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import './actionWidget.css';
import { localize } from '../../../nls.js';
import { IContextViewService } from '../../contextview/browser/contextView.js';
import { IKeybindingService } from '../../keybinding/common/keybinding.js';
import { defaultListStyles } from '../../theme/browser/defaultStyles.js';
import { asCssVariable } from '../../theme/common/colorRegistry.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';
import { IHoverService } from '../../hover/browser/hover.js';
import { MarkdownString } from '../../../base/common/htmlContent.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { IHoverWidget } from '../../../base/browser/ui/hover/hover.js';

export const acceptSelectedActionCommand = 'acceptSelectedCodeAction';
export const previewSelectedActionCommand = 'previewSelectedCodeAction';

export interface IActionListDelegate<T> {
	onHide(didCancel?: boolean): void;
	onSelect(action: T, preview?: boolean): void;
	onHover?(action: T, cancellationToken: CancellationToken): Promise<{ canPreview: boolean } | void>;
	onFocus?(action: T | undefined): void;
}

/**
 * Optional hover configuration shown when focusing/hovering over an action list item.
 */
export interface IActionListItemHover {
	/**
	 * Content to display in the hover.
	 */
	readonly content?: string;
}

export interface IActionListItem<T> {
	readonly item?: T;
	readonly kind: ActionListItemKind;
	readonly group?: { kind?: unknown; icon?: ThemeIcon; title: string };
	readonly disabled?: boolean;
	readonly label?: string;
	/**
	 * Optional key used to order this item in the A-Z sort instead of {@link label}.
	 * Lets a picker impose an explicit order (e.g. High/Medium/Low) without renaming the visible label.
	 */
	readonly sortText?: string;
	readonly description?: string;
	/**
	 * Optional hover configuration shown when focusing/hovering over the item.
	 */
	readonly hover?: IActionListItemHover;
	readonly keybinding?: ResolvedKeybinding;
	canPreview?: boolean | undefined;
	readonly hideIcon?: boolean;
	readonly tooltip?: string;
	/**
	 * Optional toolbar actions shown when the item is focused or hovered.
	 */
	readonly toolbarActions?: IAction[];
	/**
	 * When true, only show this item when there is an active search query.
	 */
	readonly searchOnly?: boolean;
	/**
	 * When true, the item row is styled as the currently selected option.
	 */
	readonly checked?: boolean;
}

export interface IActionListOptions {
	searchable?: boolean;
	maxVisibleItems?: number;
}

interface IActionMenuTemplateData {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly text: HTMLElement;
	readonly description?: HTMLElement;
	readonly keybinding: KeybindingLabel;
	readonly toolbar: HTMLElement;
	readonly elementDisposables: DisposableStore;
}

export const enum ActionListItemKind {
	Action = 'action',
	Header = 'header',
	Separator = 'separator'
}

interface IHeaderTemplateData {
	readonly container: HTMLElement;
	readonly text: HTMLElement;
}

class HeaderRenderer<T> implements IListRenderer<IActionListItem<T>, IHeaderTemplateData> {

	get templateId(): string { return ActionListItemKind.Header; }

	renderTemplate(container: HTMLElement): IHeaderTemplateData {
		container.classList.add('group-header');

		const text = document.createElement('span');
		container.append(text);

		return { container, text };
	}

	renderElement(element: IActionListItem<T>, _index: number, templateData: IHeaderTemplateData): void {
		templateData.text.textContent = element.group?.title ?? element.label ?? '';
	}

	disposeTemplate(_templateData: IHeaderTemplateData): void {
		// noop
	}
}

interface ISeparatorTemplateData {
	readonly container: HTMLElement;
	readonly text: HTMLElement;
}

class SeparatorRenderer<T> implements IListRenderer<IActionListItem<T>, ISeparatorTemplateData> {

	get templateId(): string { return ActionListItemKind.Separator; }

	renderTemplate(container: HTMLElement): ISeparatorTemplateData {
		container.classList.add('separator');

		const text = document.createElement('span');
		container.append(text);

		return { container, text };
	}

	renderElement(element: IActionListItem<T>, _index: number, templateData: ISeparatorTemplateData): void {
		templateData.text.textContent = element.label ?? '';
	}

	disposeTemplate(_templateData: ISeparatorTemplateData): void {
		// noop
	}
}

class ActionItemRenderer<T> implements IListRenderer<IActionListItem<T>, IActionMenuTemplateData> {

	get templateId(): string { return ActionListItemKind.Action; }

	constructor(
		private readonly _supportsPreview: boolean,
		@IKeybindingService private readonly _keybindingService: IKeybindingService
	) { }

	renderTemplate(container: HTMLElement): IActionMenuTemplateData {
		container.classList.add(this.templateId);

		const icon = document.createElement('div');
		icon.className = 'icon';
		container.append(icon);

		const text = document.createElement('span');
		text.className = 'title';
		container.append(text);

		const description = document.createElement('span');
		description.className = 'description';
		container.append(description);

		const keybinding = new KeybindingLabel(container, OS);

		const toolbar = document.createElement('div');
		toolbar.className = 'action-list-item-toolbar';
		container.append(toolbar);

		const elementDisposables = new DisposableStore();

		return { container, icon, text, description, keybinding, toolbar, elementDisposables };
	}

	renderElement(element: IActionListItem<T>, _index: number, data: IActionMenuTemplateData): void {
		// Clear previous element disposables
		data.elementDisposables.clear();

		if (element.group?.icon) {
			data.icon.className = ThemeIcon.asClassName(element.group.icon);
			if (element.group.icon.color) {
				data.icon.style.color = asCssVariable(element.group.icon.color.id);
			}
		} else {
			data.icon.className = ThemeIcon.asClassName(Codicon.lightBulb);
			data.icon.style.color = 'var(--vscode-editorLightBulb-foreground)';
		}

		if (!element.item || !element.label) {
			return;
		}

		dom.setVisibility(!element.hideIcon, data.icon);

		data.text.textContent = stripNewlines(element.label);

		// if there is a keybinding, prioritize over description for now
		if (element.keybinding) {
			data.description!.textContent = element.keybinding.getLabel();
			data.description!.style.display = 'inline';
			data.description!.style.letterSpacing = '0.5px';
		} else if (element.description) {
			data.description!.textContent = stripNewlines(element.description);
			data.description!.style.display = 'inline';
		} else {
			data.description!.textContent = '';
			data.description!.style.display = 'none';
		}

		const actionTitle = this._keybindingService.lookupKeybinding(acceptSelectedActionCommand)?.getLabel();
		const previewTitle = this._keybindingService.lookupKeybinding(previewSelectedActionCommand)?.getLabel();
		data.container.classList.toggle('option-disabled', element.disabled);
		data.container.classList.toggle('option-checked', !!element.checked);
		data.container.classList.toggle('search-only', !!element.searchOnly);
		if (element.hover !== undefined) {
			// Don't show tooltip when hover content is configured - the rich hover will show instead
			data.container.title = '';
		} else if (element.tooltip) {
			data.container.title = element.tooltip;
		} else if (element.disabled) {
			data.container.title = element.label;
		} else if (actionTitle && previewTitle) {
			if (this._supportsPreview && element.canPreview) {
				data.container.title = localize({ key: 'label-preview', comment: ['placeholders are keybindings, e.g "F2 to Apply, Shift+F2 to Preview"'] }, "{0} to Apply, {1} to Preview", actionTitle, previewTitle);
			} else {
				data.container.title = localize({ key: 'label', comment: ['placeholder is a keybinding, e.g "F2 to Apply"'] }, "{0} to Apply", actionTitle);
			}
		} else {
			data.container.title = '';
		}

		// Clear and render toolbar actions
		dom.clearNode(data.toolbar);
		data.container.classList.toggle('has-toolbar', !!element.toolbarActions?.length);
		if (element.toolbarActions?.length) {
			const actionBar = new ActionBar(data.toolbar);
			data.elementDisposables.add(actionBar);
			actionBar.push(element.toolbarActions, { icon: true, label: false });
		}
	}

	disposeTemplate(templateData: IActionMenuTemplateData): void {
		templateData.keybinding.dispose();
		templateData.elementDisposables.dispose();
	}
}

class AcceptSelectedEvent extends UIEvent {
	constructor() { super('acceptSelectedAction'); }
}

class PreviewSelectedEvent extends UIEvent {
	constructor() { super('previewSelectedAction'); }
}

function getKeyboardNavigationLabel<T>(item: IActionListItem<T>): string | undefined {
	// Filter out header vs. action vs. separator
	if (item.kind === 'action') {
		return item.label;
	}
	return undefined;
}

export class ActionList<T> extends Disposable {

	public readonly domNode: HTMLElement;

	private readonly _list: List<IActionListItem<T>>;

	private readonly _actionLineHeight = 28;
	private readonly _headerLineHeight = 28;
	private readonly _separatorLineHeight = 8;
	private readonly _searchInputHeight = 36;

	private _allMenuItems: readonly IActionListItem<T>[];
	private _visibleItems: readonly IActionListItem<T>[] = [];
	private _filterQuery: string = '';
	private _searchInput: HTMLInputElement | undefined;

	private readonly cts = this._register(new CancellationTokenSource());

	private _hover = this._register(new MutableDisposable<IHoverWidget>());

	constructor(
		user: string,
		preview: boolean,
		items: readonly IActionListItem<T>[],
		private readonly _delegate: IActionListDelegate<T>,
		accessibilityProvider: Partial<IListAccessibilityProvider<IActionListItem<T>>> | undefined,
		private readonly _listOptions: IActionListOptions | undefined,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ILayoutService private readonly _layoutService: ILayoutService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();
		this.domNode = document.createElement('div');
		this.domNode.classList.add('actionList');

		if (_listOptions?.searchable) {
			const searchContainer = dom.$('div.action-list-search-container');
			this._searchInput = dom.$('input.action-list-search-input') as HTMLInputElement;
			this._searchInput.type = 'text';
			this._searchInput.placeholder = 'Search models…';
			this._searchInput.setAttribute('autocomplete', 'off');
			this._searchInput.setAttribute('spellcheck', 'false');
			searchContainer.appendChild(this._searchInput);
			this.domNode.appendChild(searchContainer);

			this._register(dom.addDisposableListener(this._searchInput, dom.EventType.INPUT, () => {
				this._filterQuery = this._searchInput!.value;
				this._updateFilter();
			}));

			// Prevent arrow keys in search from propagating to the list widget
			this._register(dom.addDisposableListener(this._searchInput, dom.EventType.KEY_DOWN, (e) => {
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					if (e.key === 'ArrowDown') { this.focusNext(); }
					else { this.focusPrevious(); }
				} else if (e.key === 'Enter') {
					e.preventDefault();
					this.acceptSelected();
				} else if (e.key === 'Escape') {
					this.hide(true);
				}
			}));
		}
		const virtualDelegate: IListVirtualDelegate<IActionListItem<T>> = {
			getHeight: element => {
				switch (element.kind) {
					case ActionListItemKind.Header:
						return this._headerLineHeight;
					case ActionListItemKind.Separator:
						return this._separatorLineHeight;
					default:
						return this._actionLineHeight;
				}
			},
			getTemplateId: element => element.kind
		};


		this._list = this._register(new List(user, this.domNode, virtualDelegate, [
			new ActionItemRenderer<IActionListItem<T>>(preview, this._keybindingService),
			new HeaderRenderer(),
			new SeparatorRenderer(),
		], {
			keyboardSupport: false,
			typeNavigationEnabled: true,
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel },
			accessibilityProvider: {
				getAriaLabel: element => {
					if (element.kind === ActionListItemKind.Action) {
						let label = element.label ? stripNewlines(element?.label) : '';
						if (element.description) {
							label = label + ', ' + stripNewlines(element.description);
						}
						if (element.disabled) {
							label = localize({ key: 'customQuickFixWidget.labels', comment: [`Action widget labels for accessibility.`] }, "{0}, Disabled Reason: {1}", label, element.disabled);
						}
						return label;
					}
					return null;
				},
				getWidgetAriaLabel: () => localize({ key: 'customQuickFixWidget', comment: [`An action widget option`] }, "Action Widget"),
				getRole: (e) => {
					switch (e.kind) {
						case ActionListItemKind.Action:
							return 'option';
						case ActionListItemKind.Separator:
							return 'separator';
						default:
							return 'separator';
					}
				},
				getWidgetRole: () => 'listbox',
				...accessibilityProvider
			},
		}));

		this._list.style(defaultListStyles);

		this._register(this._list.onMouseClick(e => this.onListClick(e)));
		this._register(this._list.onMouseOver(e => this.onListHover(e)));
		this._register(this._list.onDidChangeFocus(() => this.onFocus()));
		this._register(this._list.onDidChangeSelection(e => this.onListSelection(e)));

		this._allMenuItems = items;
		// Without a search query, hide searchOnly items, then sort A-Z
		const initialVisible = items.filter(i => !i.searchOnly);
		this._visibleItems = this._sortItems(initialVisible as IActionListItem<T>[]);
		this._list.splice(0, this._list.length, this._visibleItems);

		if (this._list.length) {
			this._focusInitial();
		}
	}

	/**
	 * Focus the currently selected (checked) item when the list first opens, so the hover/focus highlight
	 * lands on the model the user is already using rather than the top row. Falls back to the first focusable
	 * item when nothing is checked (e.g. the first open before any selection).
	 */
	private _focusInitial(): void {
		const checkedIndex = this._visibleItems.findIndex(item => item.checked && this.focusCondition(item));
		if (checkedIndex >= 0) {
			this._list.setFocus([checkedIndex]);
			this._list.reveal(checkedIndex);
		} else {
			this.focusNext();
		}
	}

	private _sortItems(items: IActionListItem<T>[]): IActionListItem<T>[] {
		// Only sort action items; leave headers and separators in place
		return [...items].sort((a, b) => {
			if (a.kind !== ActionListItemKind.Action || b.kind !== ActionListItemKind.Action) { return 0; }
			const aKey = a.sortText ?? a.label;
			const bKey = b.sortText ?? b.label;
			if (!aKey || !bKey) { return 0; }
			return aKey.localeCompare(bKey, undefined, { sensitivity: 'base' });
		});
	}

	/**
	 * Replace the full item set and re-apply the current search filter + sort.
	 * Keeps the dropdown open; only the list contents change.
	 */
	setAllItems(items: readonly IActionListItem<T>[]): void {
		this._allMenuItems = items;
		this._updateFilter();
	}

	private _updateFilter(): void {
		const query = this._filterQuery.toLowerCase().trim();
		let filtered: IActionListItem<T>[];
		if (!query) {
			filtered = this._allMenuItems.filter(i => !i.searchOnly);
		} else {
			// In search mode: include searchOnly items, hide separators/headers, filter by label
			filtered = this._allMenuItems.filter(item => {
				if (item.kind === ActionListItemKind.Separator || item.kind === ActionListItemKind.Header) {
					return false;
				}
				return item.label?.toLowerCase().includes(query);
			});
		}
		// Always sort A-Z by label
		this._visibleItems = this._sortItems(filtered as IActionListItem<T>[]);
		this._list.splice(0, this._list.length, this._visibleItems);
		// Focus first match
		if (this._list.length) {
			this.focusNext();
		}
	}

	private focusCondition(element: IActionListItem<unknown>): boolean {
		return !element.disabled && element.kind === ActionListItemKind.Action;
	}

	hide(didCancel?: boolean): void {
		this._delegate.onHide(didCancel);
		this.cts.cancel();
		this._hover.clear();
		this._contextViewService.hideContextView();
	}

	layout(minWidth: number): number {
		const items = this._visibleItems;

		// --- Height calc (done first so we know whether the list will actually scroll) ---
		const maxVhPrecentage = 0.7;
		const containerClientHeight = this._layoutService.getContainer(dom.getWindow(this.domNode)).clientHeight;
		const numHeaders = items.filter(item => item.kind === 'header').length;
		const numSeparators = items.filter(item => item.kind === 'separator').length;
		const naturalHeight = items.length * this._actionLineHeight
			+ numHeaders * (this._headerLineHeight - this._actionLineHeight)
			+ numSeparators * (this._separatorLineHeight - this._actionLineHeight);
		let listHeight: number;
		if (this._listOptions?.maxVisibleItems) {
			// `maxVisibleItems` caps how tall the window can get (and items scroll beyond it), but when there
			// are FEWER items than that we shrink to fit instead of leaving empty space below. The dropdown is
			// anchored above its trigger, so a shorter list keeps its bottom edge pinned to the button and the
			// top edge moves down - exactly the "stick to the dropdown" behaviour we want for short lists.
			const fixedHeight = this._listOptions.maxVisibleItems * this._actionLineHeight;
			listHeight = Math.min(fixedHeight, naturalHeight, containerClientHeight * maxVhPrecentage);
		} else {
			listHeight = Math.min(naturalHeight, containerClientHeight * maxVhPrecentage);
		}
		// The list scrolls only when its content is taller than the window it's shown in.
		const willScroll = listHeight < naturalHeight - 0.5;

		// --- Width calc ---
		// Measure max content width from the currently rendered rows.
		let maxWidth = minWidth;
		if (items.length >= 50) {
			maxWidth = 380;
		} else {
			let contentWidth = minWidth;
			for (let index = 0; index < items.length; index++) {
				const element = this._getRowElement(index);
				if (element) {
					element.style.width = 'auto';
					// Math.ceil avoids sub-pixel truncation on fractional display scaling
					// (e.g. 125%/150% DPI), which otherwise clips the label with an ellipsis.
					contentWidth = Math.max(contentWidth, Math.ceil(element.getBoundingClientRect().width));
					element.style.width = '';
				}
			}
			// Horizontal chrome that sits outside the measured row content:
			//  - widget padding (4px each side) + row padding (4px each side) = 16px, always
			//  - the vertical scrollbar (~12px) only when the list actually scrolls, so short
			//    menus (reasoning / mode pickers) don't get dead space on the right.
			const horizontalChrome = 16 + (willScroll ? 12 : 0);
			maxWidth = contentWidth + horizontalChrome;
		}

		this._list.layout(listHeight, maxWidth);

		const totalHeight = listHeight + (this._searchInput ? this._searchInputHeight : 0);
		this.domNode.style.height = `${totalHeight}px`;

		if (this._searchInput) {
			this._searchInput.focus();
		} else {
			this._list.domFocus();
		}
		return maxWidth;
	}

	focusPrevious() {
		this._list.focusPrevious(1, true, undefined, this.focusCondition);
	}

	focusNext() {
		this._list.focusNext(1, true, undefined, this.focusCondition);
	}

	acceptSelected(preview?: boolean) {
		const focused = this._list.getFocus();
		if (focused.length === 0) {
			return;
		}

		const focusIndex = focused[0];
		const element = this._list.element(focusIndex);
		if (!this.focusCondition(element)) {
			return;
		}

		const event = preview ? new PreviewSelectedEvent() : new AcceptSelectedEvent();
		this._list.setSelection([focusIndex], event);
	}

	private onListSelection(e: IListEvent<IActionListItem<T>>): void {
		if (!e.elements.length) {
			return;
		}

		const element = e.elements[0];
		if (element.item && this.focusCondition(element)) {
			this._delegate.onSelect(element.item, e.browserEvent instanceof PreviewSelectedEvent);
		} else {
			this._list.setSelection([]);
		}
	}

	private onFocus() {
		const focused = this._list.getFocus();
		if (focused.length === 0) {
			return;
		}
		const focusIndex = focused[0];
		const element = this._list.element(focusIndex);
		this._delegate.onFocus?.(element.item);

		// Show hover on focus change
		this._showHoverForElement(element, focusIndex);
	}

	private _getRowElement(index: number): HTMLElement | null {
		// eslint-disable-next-line no-restricted-syntax
		return this.domNode.ownerDocument.getElementById(this._list.getElementID(index));
	}

	private _showHoverForElement(element: IActionListItem<T>, index: number): void {
		let newHover: IHoverWidget | undefined;

		// Show hover if the element has hover content
		if (element.hover?.content && this.focusCondition(element)) {
			// The List widget separates data models from DOM elements, so we need to
			// look up the actual DOM node to use as the hover target.
			const rowElement = this._getRowElement(index);
			if (rowElement) {
				const markdown = element.hover.content ? new MarkdownString(element.hover.content) : undefined;
				newHover = this._hoverService.showDelayedHover({
					content: markdown ?? '',
					target: rowElement,
					additionalClasses: ['action-widget-hover'],
					position: {
						hoverPosition: HoverPosition.LEFT,
						forcePosition: false,
					},
					appearance: {
						showPointer: true,
					},
				}, { groupId: `actionListHover` });
			}
		}

		this._hover.value = newHover;
	}

	private async onListHover(e: IListMouseEvent<IActionListItem<T>>) {
		const element = e.element;

		if (element && element.item && this.focusCondition(element)) {
			// Check if the hover target is inside a toolbar - if so, skip the splice
			// to avoid re-rendering which would destroy the toolbar mid-hover
			const isHoveringToolbar = dom.isHTMLElement(e.browserEvent.target) && e.browserEvent.target.closest('.action-list-item-toolbar') !== null;
			if (isHoveringToolbar) {
				this._list.setFocus([]);
				return;
			}

			if (this._delegate.onHover && !element.disabled && element.kind === ActionListItemKind.Action) {
				const result = await this._delegate.onHover(element.item, this.cts.token);
				element.canPreview = result ? result.canPreview : undefined;
			}
			if (e.index) {
				this._list.splice(e.index, 1, [element]);
			}

			this._list.setFocus(typeof e.index === 'number' ? [e.index] : []);
		}
	}

	private onListClick(e: IListMouseEvent<IActionListItem<T>>): void {
		if (e.element && this.focusCondition(e.element)) {
			this._list.setFocus([]);
		}
	}
}

function stripNewlines(str: string): string {
	return str.replace(/\r\n|\r|\n/g, ' ');
}
