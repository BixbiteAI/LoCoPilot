/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as dom from '../../../base/browser/dom.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import { IAnchor } from '../../../base/browser/ui/contextview/contextview.js';
import { IAction } from '../../../base/common/actions.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import './actionWidget.css';
import { localize, localize2 } from '../../../nls.js';
import { acceptSelectedActionCommand, ActionList, IActionListDelegate, IActionListItem, IActionListOptions, previewSelectedActionCommand } from './actionList.js';
import { Action2, registerAction2 } from '../../actions/common/actions.js';
import { IContextKeyService, RawContextKey } from '../../contextkey/common/contextkey.js';
import { IContextViewService } from '../../contextview/browser/contextView.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../keybinding/common/keybindingsRegistry.js';
import { inputActiveOptionBackground, registerColor } from '../../theme/common/colorRegistry.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IListAccessibilityProvider } from '../../../base/browser/ui/list/listWidget.js';

registerColor(
	'actionBar.toggledBackground',
	inputActiveOptionBackground,
	localize('actionBar.toggledBackground', 'Background color for toggled action items in action bar.')
);

const ActionWidgetContextKeys = {
	Visible: new RawContextKey<boolean>('codeActionMenuVisible', false, localize('codeActionMenuVisible', "Whether the action widget list is visible"))
};

export const IActionWidgetService = createDecorator<IActionWidgetService>('actionWidgetService');

export interface IActionWidgetService {
	readonly _serviceBrand: undefined;

	show<T>(user: string, supportsPreview: boolean, items: readonly IActionListItem<T>[], delegate: IActionListDelegate<T>, anchor: HTMLElement | StandardMouseEvent | IAnchor, container: HTMLElement | undefined, actionBarActions?: readonly IAction[], accessibilityProvider?: Partial<IListAccessibilityProvider<IActionListItem<T>>>, listOptions?: IActionListOptions, itemsProvider?: () => readonly IActionListItem<T>[], actionBarItemsProvider?: () => readonly IAction[]): void;

	/**
	 * Refresh the list by re-fetching items from the provider supplied to `show()`. If an action-bar items
	 * provider was supplied, the bottom action bar is rebuilt too (so toggle labels update), and the widget is
	 * re-laid-out and re-anchored. The dropdown stays open.
	 */
	refreshItems(): void;

	hide(didCancel?: boolean): void;

	readonly isVisible: boolean;
}

class ActionWidgetService extends Disposable implements IActionWidgetService {
	declare readonly _serviceBrand: undefined;

	get isVisible() {
		return ActionWidgetContextKeys.Visible.getValue(this._contextKeyService) || false;
	}

	private readonly _list = this._register(new MutableDisposable<ActionList<unknown>>());
	private _itemsProvider: (() => readonly IActionListItem<unknown>[]) | undefined;
	/** Width passed to the last list layout, reused when re-laying out on refresh so the list keeps its sizing. */
	private _cachedActionBarWidth = 0;
	/** Fresh source of bottom-bar actions, used to rebuild the action bar on refresh (so toggle labels update). */
	private _actionBarItemsProvider: (() => readonly IAction[]) | undefined;
	/** The current widget root and its rendered action bar, kept so refresh can swap the action bar in place. */
	private _widget: HTMLElement | undefined;
	private _actionBarElement: HTMLElement | undefined;
	private readonly _actionBar = this._register(new MutableDisposable<ActionBar>());

	constructor(
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();
	}

	show<T>(user: string, supportsPreview: boolean, items: readonly IActionListItem<T>[], delegate: IActionListDelegate<T>, anchor: HTMLElement | StandardMouseEvent | IAnchor, container: HTMLElement | undefined, actionBarActions?: readonly IAction[], accessibilityProvider?: Partial<IListAccessibilityProvider<IActionListItem<T>>>, listOptions?: IActionListOptions, itemsProvider?: () => readonly IActionListItem<T>[], actionBarItemsProvider?: () => readonly IAction[]): void {
		const visibleContext = ActionWidgetContextKeys.Visible.bindTo(this._contextKeyService);
		this._itemsProvider = itemsProvider as (() => readonly IActionListItem<unknown>[]) | undefined;
		this._actionBarItemsProvider = actionBarItemsProvider;

		const list = this._instantiationService.createInstance(ActionList, user, supportsPreview, items, delegate, accessibilityProvider, listOptions);
		this._contextViewService.showContextView({
			getAnchor: () => anchor,
			render: (container: HTMLElement) => {
				visibleContext.set(true);
				return this._renderWidget(container, list, actionBarActions ?? []);
			},
			onHide: (didCancel) => {
				visibleContext.reset();
				this._onWidgetClosed(didCancel);
			},
		}, container, false);
	}

	acceptSelected(preview?: boolean) {
		this._list.value?.acceptSelected(preview);
	}

	refreshItems(): void {
		if (this._itemsProvider && this._list.value) {
			const newItems = this._itemsProvider();
			this._list.value.setAllItems(newItems);
			// Rebuild the bottom action bar too, so e.g. a Show/Hide toggle's label and icon update in place.
			if (this._actionBarItemsProvider) {
				this._cachedActionBarWidth = this._renderActionBar(this._actionBarItemsProvider());
			}
			// The item count may have changed (e.g. a toggle revealed more rows), so re-run the list layout to
			// resize the window, then re-layout the context view so it stays anchored to its trigger (growing
			// upward when there's no room below) instead of overflowing or detaching from the button.
			this._list.value.layout(this._cachedActionBarWidth);
			this._contextViewService.layout();
		}
	}

	focusPrevious() {
		this._list?.value?.focusPrevious();
	}

	focusNext() {
		this._list?.value?.focusNext();
	}

	hide(didCancel?: boolean) {
		this._list.value?.hide(didCancel);
		this._list.clear();
	}

	clear() {
		this._list.clear();
	}

	private _renderWidget(element: HTMLElement, list: ActionList<unknown>, actionBarActions: readonly IAction[]): IDisposable {
		const widget = document.createElement('div');
		widget.classList.add('action-widget');
		element.appendChild(widget);

		this._list.value = list;
		if (this._list.value) {
			widget.appendChild(this._list.value.domNode);
		} else {
			throw new Error('List has no value');
		}
		const renderDisposables = new DisposableStore();

		// Invisible div to block mouse interaction in the rest of the UI
		const menuBlock = document.createElement('div');
		const block = element.appendChild(menuBlock);
		block.classList.add('context-view-block');
		renderDisposables.add(dom.addDisposableListener(block, dom.EventType.MOUSE_DOWN, e => e.stopPropagation()));

		// Invisible div to block mouse interaction with the menu
		const pointerBlockDiv = document.createElement('div');
		const pointerBlock = element.appendChild(pointerBlockDiv);
		pointerBlock.classList.add('context-view-pointerBlock');

		// Removes block on click INSIDE widget or ANY mouse movement
		renderDisposables.add(dom.addDisposableListener(pointerBlock, dom.EventType.POINTER_MOVE, () => pointerBlock.remove()));
		renderDisposables.add(dom.addDisposableListener(pointerBlock, dom.EventType.MOUSE_DOWN, () => pointerBlock.remove()));

		// Action bar (bottom). Built via a helper so refreshItems() can rebuild it in place with fresh labels.
		this._widget = widget;
		const actionBarWidth = this._renderActionBar(actionBarActions);

		this._cachedActionBarWidth = actionBarWidth;
		const width = this._list.value?.layout(actionBarWidth);
		widget.style.width = `${width}px`;

		const focusTracker = renderDisposables.add(dom.trackFocus(element));
		renderDisposables.add(focusTracker.onDidBlur(() => {
			// Don't hide if focus moved to a hover that belongs to this action widget
			const activeElement = dom.getActiveElement();
			if (activeElement?.closest('.action-widget-hover')) {
				return;
			}
			this.hide(true);
		}));

		return renderDisposables;
	}

	/**
	 * (Re)build the bottom action bar inside the current widget, replacing any existing one. Returns its width
	 * (used as the list layout's min width). Safe to call repeatedly; used on initial render and on refresh.
	 */
	private _renderActionBar(actions: readonly IAction[]): number {
		// Remove the previously rendered action bar, if any.
		this._actionBarElement?.remove();
		this._actionBarElement = undefined;
		this._actionBar.clear();

		if (!this._widget || !actions.length) {
			return 0;
		}
		const actionBar = this._createActionBar('.action-widget-action-bar', actions);
		if (!actionBar) {
			return 0;
		}
		const wrapper = actionBar.getContainer().parentElement!;
		this._widget.appendChild(wrapper);
		this._actionBarElement = wrapper;
		this._actionBar.value = actionBar;
		return actionBar.getContainer().offsetWidth;
	}

	private _createActionBar(className: string, actions: readonly IAction[]): ActionBar | undefined {
		if (!actions.length) {
			return undefined;
		}

		const container = dom.$(className);
		const actionBar = new ActionBar(container);
		actionBar.push(actions, { icon: false, label: true });
		return actionBar;
	}

	private _onWidgetClosed(didCancel?: boolean): void {
		this._list.value?.hide(didCancel);
		// Drop references to the now-removed DOM/action bar so a later refresh can't touch a stale widget.
		this._actionBar.clear();
		this._actionBarElement = undefined;
		this._widget = undefined;
		this._actionBarItemsProvider = undefined;
	}
}

registerSingleton(IActionWidgetService, ActionWidgetService, InstantiationType.Delayed);

const weight = KeybindingWeight.EditorContrib + 1000;

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'hideCodeActionWidget',
			title: localize2('hideCodeActionWidget.title', "Hide action widget"),
			precondition: ActionWidgetContextKeys.Visible,
			keybinding: {
				weight,
				primary: KeyCode.Escape,
				secondary: [KeyMod.Shift | KeyCode.Escape]
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IActionWidgetService).hide(true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'selectPrevCodeAction',
			title: localize2('selectPrevCodeAction.title', "Select previous action"),
			precondition: ActionWidgetContextKeys.Visible,
			keybinding: {
				weight,
				primary: KeyCode.UpArrow,
				secondary: [KeyMod.CtrlCmd | KeyCode.UpArrow],
				mac: { primary: KeyCode.UpArrow, secondary: [KeyMod.CtrlCmd | KeyCode.UpArrow, KeyMod.WinCtrl | KeyCode.KeyP] },
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		const widgetService = accessor.get(IActionWidgetService);
		if (widgetService instanceof ActionWidgetService) {
			widgetService.focusPrevious();
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'selectNextCodeAction',
			title: localize2('selectNextCodeAction.title', "Select next action"),
			precondition: ActionWidgetContextKeys.Visible,
			keybinding: {
				weight,
				primary: KeyCode.DownArrow,
				secondary: [KeyMod.CtrlCmd | KeyCode.DownArrow],
				mac: { primary: KeyCode.DownArrow, secondary: [KeyMod.CtrlCmd | KeyCode.DownArrow, KeyMod.WinCtrl | KeyCode.KeyN] }
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		const widgetService = accessor.get(IActionWidgetService);
		if (widgetService instanceof ActionWidgetService) {
			widgetService.focusNext();
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: acceptSelectedActionCommand,
			title: localize2('acceptSelected.title', "Accept selected action"),
			precondition: ActionWidgetContextKeys.Visible,
			keybinding: {
				weight,
				primary: KeyCode.Enter,
				secondary: [KeyMod.CtrlCmd | KeyCode.Period],
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		const widgetService = accessor.get(IActionWidgetService);
		if (widgetService instanceof ActionWidgetService) {
			widgetService.acceptSelected();
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: previewSelectedActionCommand,
			title: localize2('previewSelected.title', "Preview selected action"),
			precondition: ActionWidgetContextKeys.Visible,
			keybinding: {
				weight,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		const widgetService = accessor.get(IActionWidgetService);
		if (widgetService instanceof ActionWidgetService) {
			widgetService.acceptSelected(true);
		}
	}
});
