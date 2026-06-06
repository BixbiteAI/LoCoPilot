/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { ILoCoPilotRetrievalService } from './retrievalService.js';
import { createSemanticSearchToolData, SemanticSearchTool } from './semanticSearchTool.js';

/**
 * Registers the semanticSearch tool and starts background codebase indexing.
 * Indexing is non-blocking and invisible to the user; it runs only when retrieval is enabled
 * (default) and a local embedding backend is detected.
 */
export class LoCoPilotRetrievalContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.locopilotRetrieval';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILoCoPilotRetrievalService retrievalService: ILoCoPilotRetrievalService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();

		// Register the semantic search tool so the agent can call it.
		const tool = instantiationService.createInstance(SemanticSearchTool);
		this._register(toolsService.registerTool(createSemanticSearchToolData(), tool));

		// Kick off background indexing (no-op if disabled or no backend).
		if (configurationService.getValue('locopilot.retrieval.enabled') !== false) {
			retrievalService.startIndexing();
		}
	}
}
