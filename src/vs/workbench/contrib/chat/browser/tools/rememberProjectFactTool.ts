/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../base/common/jsonSchema.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import {
	CountTokensCallback,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolResult,
	ToolDataSource,
	ToolProgress,
} from '../../common/tools/languageModelToolsService.js';
import { ILoCoPilotProjectMemoryService } from '../locopilotProjectMemoryService.js';

export const RememberProjectFactToolId = 'rememberProjectFact';

export function createRememberProjectFactToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			fact: {
				type: 'string',
				description: 'A single durable fact about THIS project worth remembering for future sessions: a convention, a build/test command, an architectural decision, a gotcha, or where something lives. Keep it to one or two sentences.'
			}
		},
		required: ['fact']
	};

	return {
		id: RememberProjectFactToolId,
		toolReferenceName: 'rememberProjectFact',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.bookmark.id),
		displayName: localize('tool.rememberProjectFact.displayName', 'Remember a project fact'),
		userDescription: localize('tool.rememberProjectFact.userDescription', 'Persist a durable fact about this project so the agent recalls it in future sessions'),
		modelDescription: 'Persist ONE durable fact about the current project so future sessions start already knowing it. The fact is stored per-workspace and injected into your PROJECT MEMORY next time.\n\nUse this when you discover something non-obvious and lasting, e.g.:\n- a build/test/run command ("tests run with `npm run test-node`")\n- a convention ("all React components live in src/components and use named exports")\n- an architectural decision and its reason\n- a gotcha that cost you time\n\nDo NOT use it for transient task state, todo items, or things already obvious from config files. One fact per call. Duplicates are de-duplicated automatically.',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface IRememberProjectFactParams {
	fact: string;
}

export class RememberProjectFactTool implements IToolImpl {

	constructor(
		@ILoCoPilotProjectMemoryService private readonly projectMemoryService: ILoCoPilotProjectMemoryService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IRememberProjectFactParams;
		const text = (params.fact ?? '').trim();
		if (!text) {
			return {
				content: [{ kind: 'text', value: 'Error: empty fact. Next: pass a non-empty `fact` describing something durable about this project.' }],
				toolResultError: 'Empty fact'
			};
		}

		const stored = this.projectMemoryService.addLearnedFact(text);
		if (!stored) {
			return {
				content: [{ kind: 'text', value: 'Error: could not store the fact (no workspace open?). Next: continue without persisting; the fact is not saved.' }],
				toolResultError: 'Not stored'
			};
		}

		const count = this.projectMemoryService.getLearnedFacts().length;
		return {
			content: [{ kind: 'text', value: `Remembered for this project (${count} fact${count === 1 ? '' : 's'} total): "${stored.text}". Proceed to the next step or goal.` }]
		};
	}
}
