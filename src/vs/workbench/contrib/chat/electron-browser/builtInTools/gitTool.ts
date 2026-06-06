/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../base/common/jsonSchema.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILoCoPilotGitService } from '../../../../../platform/locopilotGit/common/locopilotGit.js';
import {
	CountTokensCallback,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IPreparedToolInvocation,
	IToolResult,
	ToolDataSource,
	ToolProgress
} from '../../common/tools/languageModelToolsService.js';

export const GitStatusToolId = 'gitStatus';
export const GitDiffToolId = 'gitDiff';

export function createGitStatusToolData(): IToolData {
	return {
		id: GitStatusToolId,
		toolReferenceName: 'gitStatus',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.gitMerge.id),
		displayName: localize('tool.gitStatus.displayName', 'Git status'),
		userDescription: localize('tool.gitStatus.userDescription', 'Show the current git branch and changed files'),
		modelDescription: 'Show the working tree status of the git repository: current branch and the list of staged, unstaged, and untracked files (git status, porcelain). Use this to understand what the user has changed before editing, to summarize current changes, or to decide which files to inspect with gitDiff/readFile. Returns "(not a git repository)" if the workspace is not a git repo.',
		source: ToolDataSource.Internal,
		inputSchema: { type: 'object', properties: {} },
		alwaysDisplayInputOutput: true
	};
}

export function createGitDiffToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Optional: limit the diff to a single file (workspace-relative path).'
			},
			staged: {
				type: 'boolean',
				description: 'Optional: when true, show staged changes (git diff --cached) instead of unstaged. Defaults to false.'
			}
		}
	};
	return {
		id: GitDiffToolId,
		toolReferenceName: 'gitDiff',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.diff.id),
		displayName: localize('tool.gitDiff.displayName', 'Git diff'),
		userDescription: localize('tool.gitDiff.userDescription', 'Show uncommitted changes as a diff'),
		modelDescription: 'Show uncommitted changes as a unified diff (git diff). Use this to review exactly what changed before editing further, fixing a regression, or summarizing the diff for the user. Options: path (limit to one file), staged (true = git diff --cached for staged changes, default shows unstaged working-tree changes). Returns "(no changes)" if nothing differs.',
		source: ToolDataSource.Internal,
		inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface IGitDiffParams {
	path?: string;
	staged?: boolean;
}

/** Resolve the first workspace folder's fsPath, or undefined when no folder is open. */
function workspaceCwd(workspaceService: IWorkspaceContextService): string | undefined {
	const folders = workspaceService.getWorkspace().folders;
	return folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

async function isGitRepo(gitService: ILoCoPilotGitService, cwd: string, token: CancellationToken): Promise<boolean> {
	try {
		const res = await gitService.exec(cwd, ['rev-parse', '--is-inside-work-tree'], token);
		return res.exitCode === 0 && res.stdout.trim() === 'true';
	} catch {
		return false;
	}
}

export class GitStatusTool implements IToolImpl {
	constructor(
		@ILoCoPilotGitService private readonly gitService: ILoCoPilotGitService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async invoke(_invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const cwd = workspaceCwd(this.workspaceService);
		if (!cwd) {
			return { content: [{ kind: 'text', value: 'Error: No workspace folder open. Next: Open a folder and retry.' }], toolResultError: 'No workspace folder' };
		}
		try {
			if (!await isGitRepo(this.gitService, cwd, token)) {
				return { content: [{ kind: 'text', value: '(not a git repository). Next: Use listDirectory/findFiles instead of git tools.' }] };
			}
			progress.report({ message: 'Running git status...' });
			const branchRes = await this.gitService.exec(cwd, ['branch', '--show-current'], token);
			const statusRes = await this.gitService.exec(cwd, ['status', '--porcelain=v1', '--branch'], token);
			const branch = branchRes.stdout.trim() || '(detached)';
			const body = statusRes.stdout.trim() || '(working tree clean)';
			return { content: [{ kind: 'text', value: `Branch: ${branch}\n\n${body}\n\nProceed to the next step or goal.` }] };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return { content: [{ kind: 'text', value: `Error running git: ${msg}. Next: Ensure git is installed and on PATH; otherwise use listDirectory/readFile.` }], toolResultError: msg };
		}
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

export class GitDiffTool implements IToolImpl {
	constructor(
		@ILoCoPilotGitService private readonly gitService: ILoCoPilotGitService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IGitDiffParams;
		const cwd = workspaceCwd(this.workspaceService);
		if (!cwd) {
			return { content: [{ kind: 'text', value: 'Error: No workspace folder open. Next: Open a folder and retry.' }], toolResultError: 'No workspace folder' };
		}
		try {
			if (!await isGitRepo(this.gitService, cwd, token)) {
				return { content: [{ kind: 'text', value: '(not a git repository). Next: Use readFile to inspect files instead.' }] };
			}
			progress.report({ message: 'Running git diff...' });
			const args = ['diff'];
			if (params.staged) {
				args.push('--cached');
			}
			if (params.path) {
				args.push('--', params.path);
			}
			const res = await this.gitService.exec(cwd, args, token);
			const diff = res.stdout.trim();
			if (!diff) {
				return { content: [{ kind: 'text', value: '(no changes).\n\nProceed to the next step or goal.' }] };
			}
			return { content: [{ kind: 'text', value: diff + '\n\nProceed to the next step or goal.' }] };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return { content: [{ kind: 'text', value: `Error running git diff: ${msg}. Next: Ensure git is installed; otherwise use readFile.` }], toolResultError: msg };
		}
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}
