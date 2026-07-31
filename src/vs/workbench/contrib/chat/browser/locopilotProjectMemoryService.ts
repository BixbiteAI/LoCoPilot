/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { hash } from '../../../../base/common/hash.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

export const ILoCoPilotProjectMemoryService = createDecorator<ILoCoPilotProjectMemoryService>('locopilotProjectMemoryService');

/**
 * Per-project ("project-wise") memory for the agent.
 *
 * When a user opens a project, the agent should already know what the project is about instead of
 * re-discovering it from scratch every session. This service assembles a compact PROJECT MEMORY
 * block that is injected into the agent system prompt. It has four layers (cheapest/most-authoritative
 * first), each independently optional:
 *
 *   Phase 1  Project memory file   - a human-authored AGENTS.md / LOCOPILOT.md at the workspace root.
 *   Phase 2  Auto project profile  - detected language/framework/scripts, generated once and cached
 *                                     per-workspace; regenerated only when key files change.
 *   Phase 3  Workspace instructions - per-workspace custom system prompt the user sets (vs the global one).
 *   Phase 4  Learned facts          - durable discoveries the agent persists across sessions via the
 *                                     `rememberProjectFact` tool.
 *
 * The block is size-capped so it never floods a small/local model's context window.
 */
export interface ILoCoPilotProjectMemoryService {
	readonly _serviceBrand: undefined;

	/**
	 * Assemble the STABLE PROJECT MEMORY block (memory file, auto profile without the directory tree,
	 * workspace instructions, learned facts) for injection into the system prompt. The result is frozen
	 * per workspace for the lifetime of the window so that mid-session changes (new learned facts, a
	 * profile rebuild, file edits) never rewrite the cached system-prompt prefix and force the local
	 * server to re-process the whole conversation. Volatile structure lives in {@link getWorkspaceStructureTree}.
	 */
	getProjectMemoryBlock(token: CancellationToken): Promise<string | undefined>;

	/**
	 * Volatile 2-level directory sketch for injection into the CURRENT USER TURN (never the cached system
	 * prefix). Rebuilt each turn on purpose: the tree changes whenever the agent creates/edits/deletes
	 * files, and keeping it out of the system prompt is what stops those changes from busting the local
	 * server's prompt cache. Returns undefined when there is no readable workspace tree.
	 */
	getWorkspaceStructureTree(token: CancellationToken): Promise<string | undefined>;

	/** True when a workspace folder is open (so per-workspace settings can be stored). */
	hasWorkspace(): boolean;

	/** Phase 3: per-workspace custom instructions (empty string = none). */
	getWorkspaceInstructions(): string;
	setWorkspaceInstructions(value: string): void;

	/** Phase 4: durable learned facts for the current workspace. */
	getLearnedFacts(): ILearnedFact[];
	addLearnedFact(text: string): ILearnedFact | undefined;
	clearLearnedFacts(): void;

	/** Phase 2: force the cached auto-profile to be regenerated on next request. */
	invalidateProfileCache(): void;
}

export interface ILearnedFact {
	readonly text: string;
	/** ms epoch when the fact was recorded. */
	readonly at: number;
}

interface ICachedProfile {
	/** Hash of the key project files this profile was derived from. */
	readonly sig: number;
	readonly profile: string;
}

/** Phase 1: candidate memory-file names at the workspace root, in priority order. */
const PROJECT_MEMORY_FILES = ['LOCOPILOT.md', 'AGENTS.md', '.locopilot/context.md', 'CLAUDE.md', '.cursorrules'];

/** Config files used to detect project type and to compute the profile cache signature. */
const PROJECT_SIGNAL_FILES = [
	'package.json', 'tsconfig.json', 'requirements.txt', 'pyproject.toml', 'setup.py',
	'pom.xml', 'build.gradle', 'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile',
	'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json',
];

const STORAGE_KEY_WORKSPACE_PROMPT = 'locopilot.projectMemory.workspaceInstructions';
const STORAGE_KEY_LEARNED_FACTS = 'locopilot.projectMemory.learnedFacts';
const STORAGE_KEY_PROFILE_CACHE = 'locopilot.projectMemory.profileCache';

/** Directories that are build artifacts / dependencies - never shown in the structure tree. */
const TREE_IGNORE_NAMES = new Set([
	'node_modules', 'dist', 'coverage', 'tmp', 'temp', '__pycache__', 'venv', '.venv',
	'target', 'bin', 'obj', 'Pods', 'DerivedData', 'vendor',
]);
/** Name prefixes to skip in the tree (out/, out-build/, out-vscode-min/, ...). */
const TREE_IGNORE_PREFIXES = ['out'];

/** Hard caps so the injected block stays small for local models. */
const MAX_MEMORY_FILE_CHARS = 6000;
const MAX_PROFILE_CHARS = 3600;
const MAX_TREE_CHARS = 1200;
const MAX_TREE_TOP_ENTRIES = 30;
const MAX_TREE_CHILD_ENTRIES = 8;
/** How many top-level child dirs to probe when the root itself has no project files. */
const MAX_NESTED_PROBE_DIRS = 15;
const MAX_WORKSPACE_INSTRUCTIONS_CHARS = 4000;
const MAX_FACTS = 50;
const MAX_FACT_CHARS = 500;
const MAX_FACTS_BLOCK_CHARS = 4000;

export class LoCoPilotProjectMemoryService implements ILoCoPilotProjectMemoryService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) { }

	/**
	 * In-memory freeze of the assembled STABLE project-memory block, keyed by workspace root. Computed once
	 * per workspace and reused for the window's lifetime so that a learned fact added mid-session, a profile
	 * rebuild, or a file edit does NOT change the system-prompt prefix and invalidate the local server's KV
	 * cache. Cleared by {@link invalidateProfileCache} for an explicit refresh.
	 */
	private _stableBlockCache: { rootKey: string; block: string | undefined } | undefined;

	private get workspaceRoot(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private log(msg: string): void {
		this.logService.info(`[LoCoPilot][projectMemory] ${msg}`);
	}

	async getProjectMemoryBlock(token: CancellationToken): Promise<string | undefined> {
		const root = this.workspaceRoot;
		if (!root) {
			return undefined;
		}

		// Freeze per workspace: this block is the cached system-prompt prefix, so it must be byte-stable for
		// the whole session. Recomputing it each turn (and picking up a new learned fact or a changed tree)
		// is exactly what invalidated the local server's prompt cache and forced a full re-process.
		const rootKey = root.toString();
		if (this._stableBlockCache?.rootKey === rootKey) {
			return this._stableBlockCache.block;
		}

		const sections: string[] = [];

		// Phase 1: human-authored memory file (most authoritative).
		const memoryFile = await this.readProjectMemoryFile(root);
		if (memoryFile) {
			sections.push(`## Project guide (from ${memoryFile.name})\n${memoryFile.content}`);
		}

		// Phase 2: auto-generated, cached project profile.
		const profile = await this.getOrBuildProfile(root, token);
		if (profile) {
			sections.push(`## Auto-detected project profile\n${profile}`);
		}

		// Phase 3: per-workspace custom instructions.
		const wsInstructions = this.getWorkspaceInstructions().trim();
		if (wsInstructions) {
			sections.push(`## Workspace instructions (set by the user for this project)\n${wsInstructions.slice(0, MAX_WORKSPACE_INSTRUCTIONS_CHARS)}`);
		}

		// Phase 4: durable learned facts.
		const factsBlock = this.renderFacts();
		if (factsBlock) {
			sections.push(`## Learned facts (remembered from earlier sessions)\n${factsBlock}`);
		}

		const block = sections.length === 0
			? undefined
			: `# PROJECT MEMORY\nWhat you already know about THIS project. Trust this over re-discovery, but verify against the live code before acting on anything that may be stale.\n\n${sections.join('\n\n')}`;
		this._stableBlockCache = { rootKey, block };
		return block;
	}

	async getWorkspaceStructureTree(token: CancellationToken): Promise<string | undefined> {
		const root = this.workspaceRoot;
		if (!root) {
			return undefined;
		}
		// Mirror the profile's nested-root resolution so the tree points at where the code actually lives
		// (a wrapper folder whose single subdirectory is the real project).
		let treeRoot = root;
		const present = await this.detectSignalFiles(root);
		if (present.length === 0) {
			const nested = await this.findNestedProject(root, token);
			if (nested) {
				treeRoot = nested.uri;
			}
		}
		const tree = await this.buildDirectoryTree(treeRoot);
		if (!tree) {
			return undefined;
		}
		// Deliberately not a markdown heading: this block is nested inside the turn's <editor_context>
		// wrapper, and an H1 in there reads as a new top-level section to a small model.
		return `**Workspace structure** (live view - reflects the latest files; may change as you edit):\n\`\`\`\n${tree}\n\`\`\``;
	}

	// ---- Phase 1: memory file ------------------------------------------------

	private async readProjectMemoryFile(root: URI): Promise<{ name: string; content: string } | undefined> {
		for (const name of PROJECT_MEMORY_FILES) {
			try {
				const uri = URI.joinPath(root, name);
				const stat = await this.fileService.stat(uri);
				if (!stat.isDirectory) {
					const buf = await this.fileService.readFile(uri);
					let content = buf.value.toString().trim();
					if (content.length === 0) {
						continue;
					}
					if (content.length > MAX_MEMORY_FILE_CHARS) {
						content = content.slice(0, MAX_MEMORY_FILE_CHARS) + '\n...[truncated]';
					}
					this.log(`Loaded project memory file: ${name}`);
					return { name, content };
				}
			} catch {
				// not present, try next
			}
		}
		return undefined;
	}

	// ---- Phase 2: auto profile (cached) -------------------------------------

	invalidateProfileCache(): void {
		this.storageService.remove(STORAGE_KEY_PROFILE_CACHE, StorageScope.WORKSPACE);
		this._stableBlockCache = undefined; // force the frozen system-prompt block to be reassembled
	}

	private async getOrBuildProfile(root: URI, token: CancellationToken): Promise<string | undefined> {
		// The profile is the STABLE half of project memory (stack/framework/scripts) and lives in the cached
		// system prompt, so the volatile directory tree is deliberately NOT part of it anymore - it moved to
		// the current user turn (getWorkspaceStructureTree). The profile therefore depends only on the signal
		// files, so it no longer rebuilds every time a file is added/removed.

		// Signal files at the workspace root - or, when the root is just a wrapper folder
		// (e.g. the real project lives in a single subdirectory), at the nested project root.
		let profileRoot = root;
		let nestedDir: string | undefined;
		let present = await this.detectSignalFiles(root);
		if (present.length === 0) {
			const nested = await this.findNestedProject(root, token);
			if (nested) {
				profileRoot = nested.uri;
				nestedDir = nested.name;
				present = nested.present;
			}
		}
		if (present.length === 0) {
			return undefined;
		}
		const sig = await this.computeSignature(profileRoot, present, token);

		const cachedRaw = this.storageService.get(STORAGE_KEY_PROFILE_CACHE, StorageScope.WORKSPACE);
		if (cachedRaw) {
			try {
				const cached = JSON.parse(cachedRaw) as ICachedProfile;
				if (cached.sig === sig && cached.profile) {
					return cached.profile;
				}
			} catch {
				// fall through to rebuild
			}
		}

		const profile = await this.buildProfile(profileRoot, present, nestedDir);
		if (profile) {
			const toStore: ICachedProfile = { sig, profile };
			this.storageService.store(STORAGE_KEY_PROFILE_CACHE, JSON.stringify(toStore), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this.log('Rebuilt project profile cache');
		}
		return profile;
	}

	private async detectSignalFiles(root: URI): Promise<string[]> {
		const found: string[] = [];
		for (const name of PROJECT_SIGNAL_FILES) {
			try {
				await this.fileService.stat(URI.joinPath(root, name));
				found.push(name);
			} catch {
				// absent
			}
		}
		return found;
	}

	/**
	 * Signature = hash of the contents of the present signal files, so the profile cache busts when a
	 * project config changes. The directory tree is intentionally NOT part of the signature anymore: it
	 * lives in the volatile per-turn structure block, so the stable profile must not rebuild just because
	 * a file was added or removed.
	 */
	private async computeSignature(root: URI, present: string[], token: CancellationToken): Promise<number> {
		const parts: string[] = [];
		for (const name of present) {
			if (token.isCancellationRequested) {
				break;
			}
			try {
				const buf = await this.fileService.readFile(URI.joinPath(root, name));
				parts.push(`${name}:${buf.value.toString()}`);
			} catch {
				parts.push(`${name}:?`);
			}
		}
		return hash(parts.join(' '));
	}

	// ---- Phase 2: directory structure tree -----------------------------------

	private isTreeVisible(name: string): boolean {
		if (name.startsWith('.')) {
			return false;
		}
		if (TREE_IGNORE_NAMES.has(name)) {
			return false;
		}
		return !TREE_IGNORE_PREFIXES.some(p => name === p || name.startsWith(`${p}-`) || name.startsWith(`${p}_`) || name.startsWith(`${p}.`));
	}

	/**
	 * Compact 2-level directory sketch of the workspace root. Dirs first, artifacts filtered,
	 * hard-capped at MAX_TREE_CHARS so it stays ~300 tokens even on huge repos.
	 */
	private async buildDirectoryTree(root: URI): Promise<string | undefined> {
		let top;
		try {
			top = await this.fileService.resolve(root);
		} catch {
			return undefined;
		}
		const sortEntries = (entries: { name: string; isDirectory: boolean }[]) =>
			entries.filter(e => this.isTreeVisible(e.name))
				.sort((a, b) => (a.isDirectory === b.isDirectory) ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1));

		const topEntries = sortEntries(top.children ?? []);
		if (topEntries.length === 0) {
			return undefined;
		}

		const lines: string[] = [];
		let chars = 0;
		const push = (line: string): boolean => {
			if (chars + line.length + 1 > MAX_TREE_CHARS) {
				return false;
			}
			lines.push(line);
			chars += line.length + 1;
			return true;
		};

		let shown = 0;
		for (const entry of topEntries) {
			if (shown >= MAX_TREE_TOP_ENTRIES || !push(entry.isDirectory ? `${entry.name}/` : entry.name)) {
				push(`... +${topEntries.length - shown} more`);
				break;
			}
			shown++;
			if (!entry.isDirectory) {
				continue;
			}
			// Second level: a few children per dir, so the model sees where the code lives.
			try {
				const sub = await this.fileService.resolve(URI.joinPath(root, entry.name));
				const subEntries = sortEntries(sub.children ?? []);
				for (let i = 0; i < subEntries.length && i < MAX_TREE_CHILD_ENTRIES; i++) {
					const e = subEntries[i];
					if (!push(`  ${e.name}${e.isDirectory ? '/' : ''}`)) {
						break;
					}
				}
				if (subEntries.length > MAX_TREE_CHILD_ENTRIES) {
					push(`  ... +${subEntries.length - MAX_TREE_CHILD_ENTRIES} more`);
				}
			} catch {
				// unreadable dir - show it without children
			}
		}
		return lines.length ? lines.join('\n') : undefined;
	}

	/**
	 * When the workspace root itself has no project config (a wrapper folder), probe the immediate
	 * child directories and treat the first one holding signal files as the real project root.
	 */
	private async findNestedProject(root: URI, token: CancellationToken): Promise<{ name: string; uri: URI; present: string[] } | undefined> {
		let top;
		try {
			top = await this.fileService.resolve(root);
		} catch {
			return undefined;
		}
		const candidates = (top.children ?? [])
			.filter(c => c.isDirectory && this.isTreeVisible(c.name))
			.slice(0, MAX_NESTED_PROBE_DIRS);
		let best: { name: string; uri: URI; present: string[] } | undefined;
		for (const child of candidates) {
			if (token.isCancellationRequested) {
				break;
			}
			const present = await this.detectSignalFiles(child.resource);
			if (present.length > (best?.present.length ?? 0)) {
				best = { name: child.name, uri: child.resource, present };
			}
		}
		if (best) {
			this.log(`Nested project detected in subfolder: ${best.name}/`);
		}
		return best;
	}

	private async buildProfile(root: URI, present: string[], nestedDir: string | undefined): Promise<string | undefined> {
		const lines: string[] = [];

		if (nestedDir) {
			lines.push(`- **Project root:** \`${nestedDir}/\` - the workspace root itself has no project config; treat this subfolder as the main project (paths below are relative to it).`);
		}

		const langs = new Set<string>();
		if (present.includes('package.json')) { langs.add('JavaScript/TypeScript (Node.js)'); }
		if (present.includes('tsconfig.json')) { langs.add('TypeScript'); }
		if (present.some(f => ['requirements.txt', 'pyproject.toml', 'setup.py'].includes(f))) { langs.add('Python'); }
		if (present.some(f => ['pom.xml', 'build.gradle'].includes(f))) { langs.add('Java/JVM'); }
		if (present.includes('Cargo.toml')) { langs.add('Rust'); }
		if (present.includes('go.mod')) { langs.add('Go'); }
		if (present.includes('composer.json')) { langs.add('PHP'); }
		if (present.includes('Gemfile')) { langs.add('Ruby'); }
		if (langs.size > 0) {
			lines.push(`- **Stack:** ${Array.from(langs).join(', ')}`);
		}
		lines.push(`- **Project files:** ${present.join(', ')}`);

		// Enrich from package.json when available.
		if (present.includes('package.json')) {
			try {
				const pkg = JSON.parse((await this.fileService.readFile(URI.joinPath(root, 'package.json'))).value.toString());
				if (pkg.name) { lines.push(`- **Name:** ${pkg.name}${pkg.version ? ` v${pkg.version}` : ''}`); }
				if (pkg.description) { lines.push(`- **Description:** ${String(pkg.description).slice(0, 240)}`); }
				const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
				const framework = this.guessFramework(deps);
				if (framework) { lines.push(`- **Framework:** ${framework}`); }
				if (pkg.scripts && typeof pkg.scripts === 'object') {
					const names = Object.keys(pkg.scripts).slice(0, 12);
					if (names.length) { lines.push(`- **npm scripts:** ${names.join(', ')}`); }
				}
				const pm = present.includes('pnpm-lock.yaml') ? 'pnpm'
					: present.includes('yarn.lock') ? 'yarn'
						: present.includes('package-lock.json') ? 'npm' : undefined;
				if (pm) { lines.push(`- **Package manager:** ${pm}`); }
			} catch {
				// malformed package.json - skip enrichment
			}
		}

		// NOTE: the directory-structure tree used to be appended here, but it is volatile (changes as files
		// are edited) and this profile is the cached system-prompt prefix. The tree now lives in the current
		// user turn via getWorkspaceStructureTree, so file changes no longer bust the prompt cache.

		if (lines.length === 0) {
			return undefined;
		}
		let profile = lines.join('\n');
		if (profile.length > MAX_PROFILE_CHARS) {
			profile = profile.slice(0, MAX_PROFILE_CHARS) + '\n...[truncated]';
		}
		return profile;
	}

	private guessFramework(deps: Record<string, unknown>): string | undefined {
		const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
		if (has('next')) { return 'Next.js'; }
		if (has('@angular/core')) { return 'Angular'; }
		if (has('@nestjs/core')) { return 'NestJS'; }
		if (has('vue')) { return 'Vue'; }
		if (has('svelte')) { return 'Svelte'; }
		if (has('expo') || has('react-native')) { return 'React Native / Expo'; }
		if (has('react')) { return 'React'; }
		if (has('express')) { return 'Express'; }
		if (has('electron')) { return 'Electron'; }
		return undefined;
	}

	// ---- Phase 3: per-workspace instructions --------------------------------

	hasWorkspace(): boolean {
		return !!this.workspaceRoot;
	}

	getWorkspaceInstructions(): string {
		return this.storageService.get(STORAGE_KEY_WORKSPACE_PROMPT, StorageScope.WORKSPACE) ?? '';
	}

	setWorkspaceInstructions(value: string): void {
		this.storageService.store(STORAGE_KEY_WORKSPACE_PROMPT, value ?? '', StorageScope.WORKSPACE, StorageTarget.USER);
	}

	// ---- Phase 4: learned facts ---------------------------------------------

	getLearnedFacts(): ILearnedFact[] {
		const raw = this.storageService.get(STORAGE_KEY_LEARNED_FACTS, StorageScope.WORKSPACE);
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed as ILearnedFact[] : [];
		} catch {
			return [];
		}
	}

	addLearnedFact(text: string): ILearnedFact | undefined {
		const trimmed = (text ?? '').trim();
		if (!trimmed) {
			return undefined;
		}
		const fact: ILearnedFact = { text: trimmed.slice(0, MAX_FACT_CHARS), at: Date.now() };
		const facts = this.getLearnedFacts();
		// De-dup on identical text (case-insensitive); refresh timestamp by moving to the end.
		const existingIdx = facts.findIndex(f => f.text.toLowerCase() === fact.text.toLowerCase());
		if (existingIdx >= 0) {
			facts.splice(existingIdx, 1);
		}
		facts.push(fact);
		// Keep newest MAX_FACTS.
		const trimmedFacts = facts.slice(-MAX_FACTS);
		this.storageService.store(STORAGE_KEY_LEARNED_FACTS, JSON.stringify(trimmedFacts), StorageScope.WORKSPACE, StorageTarget.USER);
		this.log(`Stored learned fact (${trimmedFacts.length} total)`);
		return fact;
	}

	clearLearnedFacts(): void {
		this.storageService.remove(STORAGE_KEY_LEARNED_FACTS, StorageScope.WORKSPACE);
	}

	private renderFacts(): string | undefined {
		const facts = this.getLearnedFacts();
		if (facts.length === 0) {
			return undefined;
		}
		const lines: string[] = [];
		let total = 0;
		// Newest first, but stop before blowing the block budget.
		for (let i = facts.length - 1; i >= 0; i--) {
			const line = `- ${facts[i].text}`;
			if (total + line.length > MAX_FACTS_BLOCK_CHARS) {
				break;
			}
			lines.push(line);
			total += line.length;
		}
		return lines.length ? lines.join('\n') : undefined;
	}
}
