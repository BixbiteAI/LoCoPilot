/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import { sign, type SignOptions } from '@electron/osx-sign';
import { spawn } from '@malept/cross-spawn-promise';

const root = path.dirname(path.dirname(import.meta.dirname));
const baseDir = path.dirname(import.meta.dirname);
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
const helperAppBaseName = product.nameShort;
const gpuHelperAppName = helperAppBaseName + ' Helper (GPU).app';
const rendererHelperAppName = helperAppBaseName + ' Helper (Renderer).app';
const pluginHelperAppName = helperAppBaseName + ' Helper (Plugin).app';

function getElectronVersion(): string {
	const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
	const target = /^target="(.*)"$/m.exec(npmrc)![1];
	return target;
}

/**
 * The bundled MLX python environment contributes ~12k files to the app, the vast
 * majority of which (.pyc, .py, .txt, metadata) are not Mach-O and do not need to
 * be signed individually - they are covered by the enclosing bundle seal. Signing
 * them anyway means one `--timestamp` round-trip to Apple per file, which trips
 * their rate limiter ("The timestamp service is not available.") partway through.
 * So inside resources/mlx we sign only actual Mach-O images.
 */
const MACHO_MAGIC = new Set([
	0xfeedface, // 32-bit
	0xfeedfacf, // 64-bit
	0xcefaedfe, // 32-bit, byte-swapped
	0xcffaedfe, // 64-bit, byte-swapped
	0xcafebabe, // fat
	0xbebafeca, // fat, byte-swapped
]);

function isMachO(filePath: string): boolean {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, 'r');
		const buf = Buffer.alloc(4);
		if (fs.readSync(fd, buf, 0, 4, 0) < 4) {
			return false;
		}
		return MACHO_MAGIC.has(buf.readUInt32BE(0));
	} catch {
		// Unreadable/odd file - let codesign decide rather than silently skipping.
		return true;
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
	}
}

function shouldIgnoreForSigning(filePath: string): boolean {
	if (!filePath.includes(`${path.sep}resources${path.sep}mlx${path.sep}`)) {
		return false;
	}
	try {
		const stat = fs.lstatSync(filePath);
		if (!stat.isFile()) {
			return false;
		}
	} catch {
		return false;
	}
	return !isMachO(filePath);
}

function getEntitlementsForFile(filePath: string): string {
	if (filePath.includes(gpuHelperAppName)) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-gpu-entitlements.plist');
	} else if (filePath.includes(rendererHelperAppName)) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-renderer-entitlements.plist');
	} else if (filePath.includes(pluginHelperAppName)) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-plugin-entitlements.plist');
	}
	return path.join(baseDir, 'azure-pipelines', 'darwin', 'app-entitlements.plist');
}

async function retrySignOnKeychainError<T>(fn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;

			// Check if this is the specific keychain error we want to retry
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isKeychainError = errorMessage.includes('The specified item could not be found in the keychain.');
			// Apple's timestamp service rate-limits / drops requests under load. Signing is
			// idempotent (`--force`), so re-running the whole pass is safe.
			const isTimestampError = errorMessage.includes('The timestamp service is not available.');

			if ((!isKeychainError && !isTimestampError) || attempt === maxRetries) {
				throw error;
			}

			console.log(`Signing attempt ${attempt} failed with ${isTimestampError ? 'timestamp' : 'keychain'} error, retrying...`);
			console.log(`Error: ${errorMessage}`);

			// Back off harder for timestamp throttling - a second immediately is pointless.
			const delay = (isTimestampError ? 30000 : 1000) * Math.pow(2, attempt - 1);
			console.log(`Waiting ${Math.round(delay)}ms before retry ${attempt}/${maxRetries}...`);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}

	throw lastError;
}

async function main(buildDir?: string): Promise<void> {
	const tempDir = process.env['AGENT_TEMPDIRECTORY'];
	const arch = process.env['VSCODE_ARCH'];
	const identity = process.env['CODESIGN_IDENTITY'];

	if (!buildDir) {
		throw new Error('Build directory argument is required (parent of LoCoPilot-darwin-<arch>, e.g. ..)');
	}

	if (!arch) {
		throw new Error('$VSCODE_ARCH not set (e.g. arm64 or x64)');
	}

	if (!identity) {
		throw new Error('$CODESIGN_IDENTITY not set (Developer ID Application: … from `security find-identity -v -p codesigning`)');
	}

	const keychainPath = tempDir ? path.join(tempDir, 'buildagent.keychain') : undefined;

	const appRoot = path.join(buildDir, `LoCoPilot-darwin-${arch}`);
	const appName = product.nameLong + '.app';
	const infoPlistPath = path.resolve(appRoot, appName, 'Contents', 'Info.plist');

	const appOpts: SignOptions = {
		app: path.join(appRoot, appName),
		platform: 'darwin',
		optionsForFile: (filePath) => ({
			entitlements: getEntitlementsForFile(filePath),
			hardenedRuntime: true,
		}),
		ignore: shouldIgnoreForSigning,
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		...(keychainPath ? { keychain: keychainPath } : {}),
		version: getElectronVersion(),
		identity,
	};

	// Only overwrite plist entries for x64 and arm64 builds,
	// universal will get its copy from the x64 build.
	if (arch !== 'universal') {
		const longName = product.nameLong;
		await spawn('plutil', [
			'-insert',
			'NSAppleEventsUsageDescription',
			'-string',
			`An application in ${longName} wants to use AppleScript.`,
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSMicrophoneUsageDescription',
			'-string',
			`An application in ${longName} wants to use the Microphone.`,
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSCameraUsageDescription',
			'-string',
			`An application in ${longName} wants to use the Camera.`,
			`${infoPlistPath}`
		]);
	}

	await retrySignOnKeychainError(() => sign(appOpts));
}

if (import.meta.main) {
	main(process.argv[2]).catch(async err => {
		console.error(err);
		const tempDir = process.env['AGENT_TEMPDIRECTORY'];
		try {
			const keychain = tempDir ? path.join(tempDir, 'buildagent.keychain') : undefined;
			const args = keychain
				? ['find-identity', '-p', 'codesigning', '-v', keychain]
				: ['find-identity', '-v', '-p', 'codesigning'];
			const identities = await spawn('security', args);
			console.error(`Available identities:\n${identities}`);
			if (keychain) {
				const dump = await spawn('security', ['dump-keychain', keychain]);
				console.error(`Keychain dump:\n${dump}`);
			}
		} catch {
			// ignore diagnostics failures
		}
		process.exit(1);
	});
}
