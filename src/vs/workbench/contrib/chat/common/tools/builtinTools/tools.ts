/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { ILanguageModelToolsService } from '../languageModelToolsService.js';
import { ConfirmationTool, ConfirmationToolData } from './confirmationTool.js';
import { EditTool, EditToolData } from './editFileTool.js';
import { createManageTodoListToolData, ManageTodoListTool } from './manageTodoListTool.js';
import { RunSubagentTool } from './runSubagentTool.js';
import { createReadFileToolData, ReadFileTool } from './readFileTool.js';
import { createListDirectoryToolData, ListDirectoryTool } from './listDirectoryTool.js';
import { createReadLintsToolData, ReadLintsTool } from './readLintsTool.js';
import { createGrepToolData, GrepTool } from './grepTool.js';
import { createFindFilesToolData, FindFilesTool } from './findFilesTool.js';
// Enable createFile for more tools if desired (LLM does not see it when commented out)
// import { createCreateFileToolData, CreateFileTool } from './createFileTool.js';
// import { createStringReplaceToolData, StringReplaceTool } from './stringReplaceTool.js';
import { createModifyFileToolData, ModifyFileTool } from './modifyFileTool.js';
import { createWebSearchToolData, WebSearchTool } from './webSearchTool.js';

export class BuiltinToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chat.builtinTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// Register read tools (no confirmation needed)
		const readFileTool = instantiationService.createInstance(ReadFileTool);
		this._register(toolsService.registerTool(createReadFileToolData(), readFileTool));

		const listDirectoryTool = instantiationService.createInstance(ListDirectoryTool);
		this._register(toolsService.registerTool(createListDirectoryToolData(), listDirectoryTool));

		const readLintsTool = instantiationService.createInstance(ReadLintsTool);
		this._register(toolsService.registerTool(createReadLintsToolData(), readLintsTool));

		// Register search tools
		const grepTool = instantiationService.createInstance(GrepTool);
		this._register(toolsService.registerTool(createGrepToolData(), grepTool));

		const findFilesTool = instantiationService.createInstance(FindFilesTool);
		this._register(toolsService.registerTool(createFindFilesToolData(), findFilesTool));

		// Register web search tool (requires chat.webSearch.apiKey in settings)
		const webSearchTool = instantiationService.createInstance(WebSearchTool);
		this._register(toolsService.registerTool(createWebSearchToolData(), webSearchTool));

		// Register write/edit tools — modifyFile handles create + full replace + partial replace
		// createFile: commented out so LLM uses modifyFile(path, "", contents) to create files
		// const createFileTool = instantiationService.createInstance(CreateFileTool);
		// this._register(toolsService.registerTool(createCreateFileToolData(), createFileTool));
		// stringReplace: commented out so LLM uses modifyFile for all edits
		// const stringReplaceTool = instantiationService.createInstance(StringReplaceTool);
		// this._register(toolsService.registerTool(createStringReplaceToolData(), stringReplaceTool));
		const modifyFileTool = instantiationService.createInstance(ModifyFileTool);
		this._register(toolsService.registerTool(createModifyFileToolData(), modifyFileTool));

		const editTool = instantiationService.createInstance(EditTool);
		this._register(toolsService.registerTool(EditToolData, editTool));

		const todoToolData = createManageTodoListToolData();
		const manageTodoListTool = this._register(instantiationService.createInstance(ManageTodoListTool));
		this._register(toolsService.registerTool(todoToolData, manageTodoListTool));

		// Register the confirmation tool
		const confirmationTool = instantiationService.createInstance(ConfirmationTool);
		this._register(toolsService.registerTool(ConfirmationToolData, confirmationTool));

		const runSubagentTool = this._register(instantiationService.createInstance(RunSubagentTool));

		let runSubagentRegistration: IDisposable | undefined;
		let toolSetRegistration: IDisposable | undefined;
		const registerRunSubagentTool = () => {
			runSubagentRegistration?.dispose();
			toolSetRegistration?.dispose();
			toolsService.flushToolUpdates();
			const runSubagentToolData = runSubagentTool.getToolData();
			runSubagentRegistration = toolsService.registerTool(runSubagentToolData, runSubagentTool);
			toolSetRegistration = toolsService.agentToolSet.addTool(runSubagentToolData);
		};
		registerRunSubagentTool();
		this._register(runSubagentTool.onDidUpdateToolData(registerRunSubagentTool));
		this._register({
			dispose: () => {
				runSubagentRegistration?.dispose();
				toolSetRegistration?.dispose();
			}
		});


	}
}

export const InternalFetchWebPageToolId = 'fetchWebPage_internal';
