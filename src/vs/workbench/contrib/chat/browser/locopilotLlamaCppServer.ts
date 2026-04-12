/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { join as pathJoin } from '../../../../base/common/path.js';

export type LlamaBackend = 'cuda' | 'metal' | 'vulkan' | 'cpu';

/** Binary name for llama.cpp server on non-Windows. */
const LLAMA_SERVER_BIN = 'llama-server';
/** Binary name for llama.cpp server on Windows. */
const LLAMA_SERVER_BIN_WIN = 'llama-server.exe';

/** Subpath under user home for conventional llama.cpp build (build/bin or build/bin/llama-server). */
const LLAMA_CPP_REL_BIN = ['llama.cpp', 'build', 'bin'];

/** Priority order for backends: first available is used. */
const BACKEND_PRIORITY: LlamaBackend[] = ['cuda', 'metal', 'vulkan', 'cpu'];

/**
 * Returns conventional paths to try for the llama-server binary (when user has not set a path).
 * First entry: full path to binary. Second entry: directory containing the binary.
 * Uses userHomeFsPath (e.g. from pathService.userHome() then .fsPath).
 */
export function getDefaultLlamaServerPaths(userHomeFsPath: string): string[] {
	const binName = isWindows ? LLAMA_SERVER_BIN_WIN : LLAMA_SERVER_BIN;
	const dirPath = pathJoin(userHomeFsPath, ...LLAMA_CPP_REL_BIN);
	const binaryPath = pathJoin(dirPath, binName);
	
	const paths = [binaryPath, dirPath];
	
	if (isMacintosh) {
		paths.push('/opt/homebrew/bin/' + binName); // Apple Silicon Homebrew
		paths.push('/usr/local/bin/' + binName);    // Intel Mac Homebrew
		paths.push('/opt/local/bin/' + binName);    // MacPorts
	} else if (!isWindows) {
		paths.push('/usr/local/bin/' + binName);    // Linux common
		paths.push('/usr/bin/' + binName);          // Linux system
	}
	
	return paths;
}

/**
 * Detects the best available backend for running GGUF models.
 * Order: GPU (CUDA) > Apple Metal > Vulkan > CPU.
 * In renderer we use heuristics (e.g. macOS => Metal); for full detection a native/main process would be needed.
 */
export function detectLlamaBackend(): LlamaBackend[] {
	const order: LlamaBackend[] = [];
	if (isMacintosh) {
		// Apple Silicon or Intel Mac: Metal is the preferred GPU backend
		order.push('metal');
	}
	// CUDA is typical on Linux/Windows with NVIDIA GPU (we cannot detect from renderer; user may have it)
	order.push('cuda');
	order.push('vulkan');
	order.push('cpu');
	// Dedupe and preserve priority
	return BACKEND_PRIORITY.filter(b => order.includes(b));
}

/**
 * Returns the recommended backend to try first (best performance).
 */
export function getRecommendedBackend(): LlamaBackend {
	const ordered = detectLlamaBackend();
	return ordered[0] ?? 'cpu';
}

/**
 * Resolves the llama-server command from an optional configured path.
 * serverPath: empty = use binary from PATH; otherwise full path to binary or directory containing it.
 * Works on Mac, Windows, and Linux regardless of where llama.cpp is installed.
 */
export function resolveLlamaServerCommand(serverPath: string | undefined): string {
	const raw = (serverPath ?? '').trim();
	if (!raw) {
		return isWindows ? LLAMA_SERVER_BIN_WIN : LLAMA_SERVER_BIN;
	}
	const binName = isWindows ? LLAMA_SERVER_BIN_WIN : LLAMA_SERVER_BIN;
	if (raw.endsWith(binName) || raw.endsWith(LLAMA_SERVER_BIN)) {
		return raw;
	}
	return pathJoin(raw, binName);
}

/**
 * Builds the llama.cpp server command and args for the given model path and backend.
 * serverPath: optional path from settings (locopilot.llamaCpp.serverPath). Empty = use binary from PATH.
 * User can install via: https://github.com/ggerganov/llama.cpp or pip install llama-cpp-python (server).
 */
export function getLlamaCppServerCommand(modelPath: string, backend: LlamaBackend, serverPath?: string, port: number = LOCOPILOT_LLAMA_SERVER_PORT): { command: string; args: string[] } {
	const args: string[] = ['-m', modelPath, '-c', '32768', '--host', '127.0.0.1', '--port', port.toString()];
	switch (backend) {
		case 'cuda':
			args.push('--n-gpu-layers', '999');
			break;
		case 'metal':
			args.push('--n-gpu-layers', '999');
			break;
		case 'vulkan':
			args.push('--n-gpu-layers', '999');
			break;
		case 'cpu':
			args.push('--n-gpu-layers', '0');
			break;
		default:
			args.push('--n-gpu-layers', '0');
	}
	const command = resolveLlamaServerCommand(serverPath);
	return { command, args };
}

/**
 * Default port for the local llama server (OpenAI-compatible endpoint).
 */
export const LOCOPILOT_LLAMA_SERVER_PORT = 38452;

export function getLlamaServerBaseUrl(port: number = LOCOPILOT_LLAMA_SERVER_PORT): string {
	return `http://127.0.0.1:${port}/v1`;
}
