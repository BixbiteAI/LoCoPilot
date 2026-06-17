/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IMcpRegistry } from '../mcpRegistryTypes.js';
import { McpCollectionSortOrder, McpServerDefinition, McpServerTransportType, McpServerTrust } from '../mcpTypes.js';
import { IMcpDiscovery } from './mcpDiscovery.js';

/**
 * Servers that ship with the product. They are registered up-front so they appear in the MCP
 * servers view and the chat tool picker, but are NOT launched until the user enables/uses them
 * (the MCP server connection starts lazily on the first tool call). This is how we bundle a
 * default browser-automation server (Playwright) without spawning any process at startup.
 */
/** Stable id of the bundled Playwright (browser automation) MCP server. */
export const PLAYWRIGHT_MCP_SERVER_ID = 'bundled.playwright';

const BUNDLED_SERVERS: readonly McpServerDefinition[] = [
	{
		id: PLAYWRIGHT_MCP_SERVER_ID,
		label: 'Playwright (Browser)',
		// Bump this when the launch command changes so caches/trust are re-evaluated.
		cacheNonce: 'playwright-mcp-1',
		launch: {
			type: McpServerTransportType.Stdio,
			command: 'npx',
			args: ['-y', '@playwright/mcp@latest'],
			env: {},
			cwd: undefined,
			envFile: undefined,
		},
		presentation: {
			order: McpCollectionSortOrder.Extension,
			icon: Codicon.browser,
		},
	},
];

export class BundledMcpDiscovery extends Disposable implements IMcpDiscovery {
	public readonly fromGallery = false;

	constructor(
		@IMcpRegistry private readonly _mcpRegistry: IMcpRegistry,
	) {
		super();
	}

	public start(): void {
		this._register(this._mcpRegistry.registerCollection({
			id: 'bundled',
			label: 'Bundled',
			remoteAuthority: null,
			// Trusted-on-nonce: the user is prompted once before the bundled server first runs.
			trustBehavior: McpServerTrust.Kind.TrustedOnNonce,
			scope: StorageScope.PROFILE,
			configTarget: ConfigurationTarget.USER,
			serverDefinitions: observableValue<readonly McpServerDefinition[]>(this, BUNDLED_SERVERS),
			presentation: {
				order: McpCollectionSortOrder.Extension,
			},
		}));
	}
}
