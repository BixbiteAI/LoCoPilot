/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { PLAYWRIGHT_MCP_SERVER_ID } from '../common/discovery/bundledMcpDiscovery.js';
import { IMcpServer, IMcpService, McpConnectionState } from '../common/mcpTypes.js';

/** True while the bundled Playwright MCP server is starting or running. */
export const PlaywrightMcpRunningContext = new RawContextKey<boolean>('locopilotPlaywrightMcpRunning', false);

function findPlaywrightServer(servers: readonly IMcpServer[]): IMcpServer | undefined {
	return servers.find(s => s.definition.id === PLAYWRIGHT_MCP_SERVER_ID);
}

function isActive(state: McpConnectionState.Kind | undefined): boolean {
	return state === McpConnectionState.Kind.Running || state === McpConnectionState.Kind.Starting;
}

/**
 * Keeps {@link PlaywrightMcpRunningContext} in sync with the bundled server's connection state so
 * the chat-input toggle reflects whether browser automation is currently enabled.
 */
export class PlaywrightMcpStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.locopilot.playwrightMcpStatus';

	private readonly _ctx: IContextKey<boolean>;

	constructor(
		@IMcpService mcpService: IMcpService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._ctx = PlaywrightMcpRunningContext.bindTo(contextKeyService);
		this._register(autorun(reader => {
			const server = findPlaywrightServer(mcpService.servers.read(reader));
			const state = server?.connectionState.read(reader).state;
			this._ctx.set(isActive(state));
		}));
	}
}

/**
 * Chat-input toolbar toggle: one click enables the bundled Playwright browser-automation MCP
 * server (starting it on demand); clicking again stops it. Reflects live running state.
 */
export class TogglePlaywrightMcpAction extends Action2 {
	static readonly ID = 'workbench.action.chat.togglePlaywrightMcp';

	constructor() {
		super({
			id: TogglePlaywrightMcpAction.ID,
			title: localize2('togglePlaywrightMcp', "Toggle Browser Tools (Playwright)"),
			tooltip: localize('togglePlaywrightMcp.tooltip', "Enable browser automation tools (Playwright)"),
			icon: Codicon.globe,
			toggled: {
				// When this evaluates true the action label gets a `.checked` class; chat.css then
				// tints the globe icon with the theme accent color. (A `color` on a ThemeIcon is
				// ignored by the toolbar renderer, so the visual state change is done via CSS.)
				condition: PlaywrightMcpRunningContext,
				tooltip: localize('togglePlaywrightMcp.on', "Browser automation enabled - click to turn off"),
			},
			f1: true,
			precondition: ChatContextKeys.enabled,
			menu: {
				// Top attachment toolbar, immediately after the "Add Context..." button (order 3).
				id: MenuId.ChatInputAttachmentToolbar,
				group: 'navigation',
				order: 4,
				when: ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const mcpService = accessor.get(IMcpService);
		const contextKeyService = accessor.get(IContextKeyService);
		const server = findPlaywrightServer(mcpService.servers.get());
		if (!server) {
			return;
		}

		const turnOn = !isActive(server.connectionState.get().state);

		// Optimistically flip the toggle so the icon changes color immediately on click; the
		// status contribution's autorun reconciles this with the real connection state right after
		// (e.g. turns it back off if the server fails to start).
		PlaywrightMcpRunningContext.bindTo(contextKeyService).set(turnOn);

		if (turnOn) {
			await server.start();
		} else {
			await server.stop();
		}
	}
}
