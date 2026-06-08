/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { join as pathJoin } from '../../../../base/common/path.js';

/** Start from a different default than llama.cpp to reduce accidental port overlap. */
export const LOCOPILOT_MLX_SERVER_PORT = 38462;

/**
 * Relative location of the bundled, self-contained Python runtime (python-build-standalone with
 * mlx-lm pre-installed) inside the installed app. Only shipped in the macOS arm64 package - MLX is
 * Apple Silicon only. Produced by scripts/fetch-mlx-runtime.mjs and packaged in build/gulpfile.vscode.ts.
 */
const BUNDLED_MLX_REL = ['resources', 'mlx', 'darwin-arm64', 'python', 'bin', 'python3'];

/**
 * Full path to the bundled MLX Python interpreter, or undefined when there is no app root (web) or
 * this is not an Apple Silicon Mac. Existence is not checked here - the caller stats it before use.
 * appRootFsPath: IEnvironmentService.appRoot (INativeEnvironmentService).
 */
export function getBundledMlxPython(appRootFsPath: string | undefined): string | undefined {
	if (!appRootFsPath || !isAppleSiliconMac()) {
		return undefined;
	}
	return pathJoin(appRootFsPath, ...BUNDLED_MLX_REL);
}

/**
 * Apple Silicon Mac only. MLX inference is not supported on Intel Mac or other OSes.
 */
export function isAppleSiliconMac(): boolean {
	if (!isMacintosh || isWindows) {
		return false;
	}
	const nodeProcess = (globalThis as { vscode?: { process?: { arch?: string } }; process?: { arch?: string } }).vscode?.process
		?? (typeof (globalThis as { process?: { arch?: string } }).process !== 'undefined' ? (globalThis as { process: { arch?: string } }).process : undefined);
	const arch = nodeProcess?.arch;
	return arch === 'arm64';
}

/**
 * Base URL for mlx_lm.server (OpenAI-compatible /v1).
 */
export function getMlxServerBaseUrl(port: number): string {
	return `http://127.0.0.1:${port}/v1`;
}

/**
 * Command to run `mlx_lm.server` for a local model directory (Hugging Face-style MLX weights).
 * pythonCmd: full path or `python3` / `python` from PATH or a venv interpreter.
 */
export function getMlxLmServerCommand(modelDir: string, port: number, pythonCmd: string): { command: string; args: string[] } {
	const cmd = pythonCmd.trim() || 'python3';
	// `python -m mlx_lm server` (mlx-lm >= 0.20): `python -m mlx_lm.server` is deprecated.
	const args = ['-m', 'mlx_lm', 'server', '--model', modelDir, '--host', '127.0.0.1', '--port', String(port)];
	return { command: cmd, args };
}

/**
 * Whether to use mlx-lm HTTP server for this Hugging Face entry (vs llama.cpp + GGUF).
 * hasGguf: a .gguf file is present at localPath (file or under directory).
 */
export function shouldUseMlxServerForHfModel(
	model: { format?: string; modelName: string },
	hasGguf: boolean,
	canRunMlx: boolean
): boolean {
	if (!canRunMlx || hasGguf) {
		return false;
	}
	const fmt = (model.format || '').toLowerCase().trim();
	if (fmt.includes('gguf')) {
		return false;
	}
	if (fmt.includes('mlx')) {
		return true;
	}
	const id = model.modelName.toLowerCase();
	if (id.includes('-mlx') || id.includes('/mlx') || id.endsWith('mlx') || id.includes('mlx-')) {
		return true;
	}
	return false;
}

/**
 * True if the Hugging Face model entry is meant to be MLX (by format or repo name), before runtime checks.
 */
export function hfModelLooksLikeMlx(model: { format?: string; modelName: string }, hasGguf: boolean): boolean {
	if (hasGguf) {
		return false;
	}
	const fmt = (model.format || '').toLowerCase().trim();
	if (fmt.includes('gguf')) {
		return false;
	}
	if (fmt.includes('mlx')) {
		return true;
	}
	const id = model.modelName.toLowerCase();
	if (id.includes('-mlx') || id.includes('/mlx') || id.endsWith('mlx') || id.includes('mlx-')) {
		return true;
	}
	return false;
}
