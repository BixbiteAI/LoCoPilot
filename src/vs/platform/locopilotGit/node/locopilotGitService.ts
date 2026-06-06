/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { ILogService } from '../../log/common/log.js';
import { IGitExecResult, ILoCoPilotGitService } from '../common/locopilotGit.js';

/** Hard cap on captured output so a runaway diff can't exhaust memory. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB
/** Kill git if it runs longer than this. */
const TIMEOUT_MS = 20_000;

export class LoCoPilotGitService implements ILoCoPilotGitService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService
	) { }

	exec(cwd: string, args: string[], token: CancellationToken): Promise<IGitExecResult> {
		return new Promise<IGitExecResult>((resolve, reject) => {
			this.logService.trace(`[LoCoPilotGit] git ${args.join(' ')} (cwd=${cwd})`);

			let settled = false;
			const child = spawn('git', args, {
				cwd,
				// Disable interactive prompts (credentials/editor) so we never hang.
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
				windowsHide: true,
			});

			let stdout = '';
			let stderr = '';
			let stdoutBytes = 0;
			let truncated = false;

			const finish = (result: IGitExecResult) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				disposable.dispose();
				resolve(result);
			};

			const fail = (err: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				disposable.dispose();
				reject(err);
			};

			const timer = setTimeout(() => {
				child.kill();
				finish({ stdout, stderr: stderr + '\n[git timed out]', exitCode: 124 });
			}, TIMEOUT_MS);

			const disposable = token.onCancellationRequested(() => {
				child.kill();
				finish({ stdout, stderr: stderr + '\n[cancelled]', exitCode: 130 });
			});

			child.stdout.on('data', (chunk: Buffer) => {
				if (truncated) {
					return;
				}
				stdoutBytes += chunk.length;
				if (stdoutBytes > MAX_BUFFER_BYTES) {
					truncated = true;
					stdout += '\n[output truncated]';
					child.kill();
					return;
				}
				stdout += chunk.toString('utf8');
			});
			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf8');
			});
			child.on('error', err => fail(err));
			child.on('close', code => finish({ stdout, stderr, exitCode: code ?? 0 }));
		});
	}
}
