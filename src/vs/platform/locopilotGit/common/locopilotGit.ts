/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILoCoPilotGitService = createDecorator<ILoCoPilotGitService>('locopilotGitService');

export interface IGitExecResult {
	/** Standard output (trimmed of trailing newline by callers as needed). */
	stdout: string;
	/** Standard error. */
	stderr: string;
	/** Process exit code (0 = success). */
	exitCode: number;
}

/**
 * Runs the `git` binary on the user's machine and returns its captured output. The git tools in
 * the chat agent need command output (status, diff), which the sandboxed renderer cannot produce
 * itself; this service runs in the shared (utility) process and is proxied to the renderer over IPC,
 * mirroring the bundled-embeddings service.
 *
 * Only the `git` binary is ever invoked (the binary is fixed; callers supply arguments only), so
 * this cannot be used to run arbitrary commands.
 */
export interface ILoCoPilotGitService {
	readonly _serviceBrand: undefined;

	/**
	 * Execute `git <args>` in `cwd` and capture output.
	 * Never rejects on a non-zero git exit code - inspect `exitCode`/`stderr` instead. Rejects only
	 * if the process cannot be spawned at all (e.g. git not installed).
	 */
	exec(cwd: string, args: string[], token: CancellationToken): Promise<IGitExecResult>;
}
