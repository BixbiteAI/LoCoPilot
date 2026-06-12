/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { createRememberProjectFactToolData, RememberProjectFactTool } from './rememberProjectFactTool.js';

/**
 * Registers the project-memory tools (currently `rememberProjectFact`) so the agent can persist
 * durable per-project knowledge across sessions. Lives in the browser layer because the tool
 * depends on the browser-side ILoCoPilotProjectMemoryService.
 */
export class LoCoPilotProjectMemoryToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.locopilotProjectMemoryTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const tool = instantiationService.createInstance(RememberProjectFactTool);
		this._register(toolsService.registerTool(createRememberProjectFactToolData(), tool));
	}
}
