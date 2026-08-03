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
// outline: re-enabled. It was disabled as "a regex scraper the model can reproduce with grep", but that
// assumes the model knows to build a good multi-language symbol regex - small local models mostly don't,
// and a one-arg tool is far more reliable for them. Its line numbers come straight from the file, so the
// failure mode is a missed or noisy symbol, never a misdirected read. Symbol extraction should move to the
// bundled tree-sitter grammars (@vscode/tree-sitter-wasm) later; that's an internal upgrade, same interface.
import { createOutlineToolData, OutlineTool } from './outlineTool.js';
// stringReplace: superseded by the split editFile tool below (kept for reference, not registered).
// import { createStringReplaceToolData, StringReplaceTool } from './stringReplaceTool.js';
// modifyFile: the old single mega-tool (create + overwrite + replace + insert + multi-edit in one). It
// was split into the three focused tools below (createFile / editFile / insertCode) so small local models
// get one fixed signature per action instead of an 8-param, 4-mode schema. Kept + importable so it can be
// re-enabled by uncommenting the import + registration if the single-tool approach is wanted again.
// import { createModifyFileToolData, ModifyFileTool } from './modifyFileTool.js';
import { createCreateFileToolData, CreateFileTool } from './createFileTool.js';
import { createEditFileToolData, EditFileTool } from './fileEditTool.js';
import { createInsertCodeToolData, InsertCodeTool } from './insertCodeTool.js';
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

		// Outline tool: compact symbol map (symbol + line number) so the model can target its reads on a
		// large file instead of paging through it blindly. This is the main navigation aid for files over
		// readFile's 1000-line cap, which can never be read in one call.
		const outlineTool = instantiationService.createInstance(OutlineTool);
		this._register(toolsService.registerTool(createOutlineToolData(), outlineTool));

		// Register web search tool (works out of the box via DuckDuckGo; optional Brave API key)
		const webSearchTool = instantiationService.createInstance(WebSearchTool);
		this._register(toolsService.registerTool(createWebSearchToolData(), webSearchTool));

		// Register write/edit tools - split into three focused, fixed-signature tools:
		//   createFile  -> write a whole file (create / overwrite)
		//   editFile    -> change text in an existing file (single replace OR atomic multi-edit batch)
		//   insertCode  -> add code next to an anchor line (no replacement)
		// To go back to the single mega-tool, comment these three out and uncomment modifyFile (import above).
		const createFileTool = instantiationService.createInstance(CreateFileTool);
		this._register(toolsService.registerTool(createCreateFileToolData(), createFileTool));
		const editFileTool = instantiationService.createInstance(EditFileTool);
		this._register(toolsService.registerTool(createEditFileToolData(), editFileTool));
		const insertCodeTool = instantiationService.createInstance(InsertCodeTool);
		this._register(toolsService.registerTool(createInsertCodeToolData(), insertCodeTool));
		// const modifyFileTool = instantiationService.createInstance(ModifyFileTool);
		// this._register(toolsService.registerTool(createModifyFileToolData(), modifyFileTool));

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
