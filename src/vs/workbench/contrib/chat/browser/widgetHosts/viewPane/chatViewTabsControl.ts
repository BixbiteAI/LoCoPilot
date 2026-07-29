/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Note: styles live in `media/chatViewPane.css` (imported by the view pane) on
// purpose: a newly added CSS file is only picked up by the dev-time CSS import
// map after a full app restart, not a window reload.
import { $, addDisposableListener, append, EventHelper, EventType } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';

export interface IChatViewTab {
	readonly resource: URI;
	readonly label: string;
}

export interface IChatViewTabsDelegate {
	openTab(resource: URI): void;
	closeTab(resource: URI): void;
	newTab(): void;
}

/**
 * Renders the chat sessions that are currently open as a row of tabs
 * (including a `+` button to start a new one), similar to editor tabs.
 */
export class ChatViewTabsControl extends Disposable {

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	private readonly container: HTMLElement;
	private readonly tabsContainer: HTMLElement;

	private readonly tabDisposables = this._register(new MutableDisposable<DisposableStore>());

	private tabs: IChatViewTab[] = [];
	private activeResource: URI | undefined;

	private lastKnownHeight = 0;

	private readonly actionsToolbar: MenuWorkbenchToolBar;

	constructor(
		parent: HTMLElement,
		private readonly delegate: IChatViewTabsDelegate,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this.container = append(parent, $('.chat-view-tabs-container'));
		this.tabsContainer = append(this.container, $('.chat-view-tabs'));

		// New tab button
		const newTabButton = append(this.container, $('.chat-view-tabs-new-tab.codicon.codicon-add'));
		newTabButton.title = localize('chat.newTab', "New Chat Tab");
		newTabButton.setAttribute('role', 'button');
		this._register(addDisposableListener(newTabButton, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.delegate.newTab();
		}));

		// Actions (e.g. show the sessions history sidebar), previously
		// rendered by the chat view title control
		const actionsToolbarContainer = append(this.container, $('.chat-view-tabs-actions-toolbar'));
		this.actionsToolbar = this._register(instantiationService.createInstance(MenuWorkbenchToolBar, actionsToolbarContainer, MenuId.ChatViewSessionTitleToolbar, {
			menuOptions: { shouldForwardArgs: true },
			hiddenItemStrategy: HiddenItemStrategy.NoHide
		}));

		this.render();
	}

	setTabs(tabs: IChatViewTab[], activeResource: URI | undefined, actionsContext: unknown): void {
		this.tabs = tabs;
		this.activeResource = activeResource;
		this.actionsToolbar.context = actionsContext;

		this.render();
	}

	private render(): void {
		const disposables = this.tabDisposables.value = new DisposableStore();

		this.tabsContainer.textContent = '';

		// The row always stays visible: it also hosts the new tab button
		// and the actions that used to live in the chat title row
		this.container.classList.add('visible');

		for (const tab of this.tabs) {
			const isActive = !!this.activeResource && tab.resource.toString() === this.activeResource.toString();

			const tabElement = append(this.tabsContainer, $('.chat-view-tab'));
			tabElement.classList.toggle('active', isActive);
			tabElement.title = tab.label;
			tabElement.setAttribute('role', 'tab');
			tabElement.setAttribute('aria-selected', String(isActive));

			// Same icon the chat response avatar uses for the default agent
			append(tabElement, $(ThemeIcon.asCSSSelector(Codicon.chatSparkle) + '.chat-view-tab-icon'));

			const label = append(tabElement, $('span.chat-view-tab-label'));
			label.textContent = tab.label;

			const closeButton = append(tabElement, $('span.chat-view-tab-close.codicon.codicon-close'));
			closeButton.title = localize('chat.closeTab', "Close Chat Tab");
			closeButton.setAttribute('role', 'button');

			disposables.add(addDisposableListener(tabElement, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				if (!isActive) {
					this.delegate.openTab(tab.resource);
				}
			}));

			disposables.add(addDisposableListener(tabElement, EventType.AUXCLICK, e => {
				if (e.button === 1 /* middle click */) {
					EventHelper.stop(e, true);
					this.delegate.closeTab(tab.resource);
				}
			}));

			disposables.add(addDisposableListener(closeButton, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				this.delegate.closeTab(tab.resource);
			}));
		}

		this.checkHeight();
	}

	private checkHeight(): void {
		const currentHeight = this.getHeight();
		if (currentHeight !== this.lastKnownHeight) {
			this.lastKnownHeight = currentHeight;

			this._onDidChangeHeight.fire();
		}
	}

	getHeight(): number {
		return this.container.offsetHeight;
	}

	override dispose(): void {
		this.container.remove();

		super.dispose();
	}
}
