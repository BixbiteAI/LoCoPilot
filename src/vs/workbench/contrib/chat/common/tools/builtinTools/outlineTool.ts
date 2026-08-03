/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../../base/common/jsonSchema.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
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
} from '../languageModelToolsService.js';

export const OutlineToolId = 'outline';

/** Files larger than this many lines are still scanned, but we cap the number of symbols returned. */
const MAX_SYMBOLS = 400;

export function createOutlineToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute or workspace-relative path to the file to outline'
			}
		},
		required: ['path']
	};

	return {
		id: OutlineToolId,
		toolReferenceName: 'outline',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.symbolClass.id),
		displayName: localize('tool.outline.displayName', 'Outline file symbols'),
		userDescription: localize('tool.outline.userDescription', 'List the top-level symbols (functions, classes, exports) of a file without reading the whole file'),
		modelDescription: 'Get a compact OUTLINE of a file: its top-level symbols (functions, classes, interfaces, types, methods, exported constants) with their line numbers - without reading the entire file. Use this FIRST on a large or unfamiliar file to understand its structure and decide which line ranges to readFile, instead of reading thousands of lines. Supports JavaScript/TypeScript, Python, Go, Java, C/C++, C#, Rust, Ruby, PHP and similar C-style languages. Output is "LINE: symbol" lines. If no symbols are detected (e.g. data files), it says so - fall back to readFile.',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface IOutlineToolParams {
	path: string;
}

/**
 * Language-agnostic, dependency-free symbol extraction by regular expression. This is intentionally
 * heuristic (not a real parser): it is fast, runs in any layer, and is good enough to give the model
 * a structural map so it can target its reads. Patterns are ordered roughly by specificity.
 */
const SYMBOL_PATTERNS: RegExp[] = [
	// JS/TS: class / interface / enum / type / namespace
	/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|namespace|type)\s+([A-Za-z_$][\w$]*)/,
	// JS/TS: function / generator / async function
	/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
	// JS/TS: exported const/let/var (often arrow functions or components)
	/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
	// JS/TS: const/let arrow function at top or class field arrow
	/^\s*(?:public|private|protected|readonly|static|\s)*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/,
	// Python: def / async def / class
	/^\s*(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/,
	// Go: func (with optional receiver)
	/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
	// Go/Rust/C#: type/struct/trait/impl/enum
	/^\s*(?:pub\s+)?(struct|trait|impl|enum)\s+([A-Za-z_][\w]*)/,
	// Rust: fn
	/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
	// Java/C#/C++: methods & types (return-type name(...)) - loose
	/^\s*(?:public|private|protected|internal|static|final|virtual|override|abstract|\s)+[\w<>\[\],.:&*\s]+?\b([A-Za-z_][\w]*)\s*\([^;{]*\)\s*\{?\s*$/,
	// C-style class/struct/interface (Java/C#/C++)
	/^\s*(?:public|private|protected|internal|abstract|final|sealed|\s)*(class|struct|interface)\s+([A-Za-z_][\w]*)/,
];

function extractSymbols(content: string): string[] {
	const lines = content.split('\n');
	const out: string[] = [];
	const seen = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip obvious comment lines to reduce noise.
		const trimmed = line.trimStart();
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#') && !trimmed.startsWith('#[')) {
			continue;
		}
		for (const re of SYMBOL_PATTERNS) {
			const m = re.exec(line);
			if (m) {
				if (seen.has(i)) {
					break;
				}
				seen.add(i);
				out.push(`${i + 1}: ${line.trim()}`);
				break;
			}
		}
		if (out.length >= MAX_SYMBOLS) {
			out.push(`... (symbol limit ${MAX_SYMBOLS} reached; file has more)`);
			break;
		}
	}
	return out;
}

export class OutlineTool implements IToolImpl {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IOutlineToolParams;

		try {
			let fileUri: URI;
			if (params.path.startsWith('/') || params.path.match(/^[a-zA-Z]:/)) {
				fileUri = URI.file(params.path);
			} else {
				const workspace = this.workspaceService.getWorkspace();
				if (workspace.folders.length === 0) {
					return {
						content: [{ kind: 'text', value: 'Error: No workspace folder open. Next: Open a folder (File > Open Folder) and retry, or use an absolute path.' }],
						toolResultError: 'No workspace folder'
					};
				}
				fileUri = URI.joinPath(workspace.folders[0].uri, params.path);
			}

			progress.report({ message: `Outlining ${params.path}` });

			const stat = await this.fileService.stat(fileUri);
			if (stat.isDirectory) {
				return {
					content: [{ kind: 'text', value: `Error: "${params.path}" is a directory, not a file. Next: Use listDirectory to see its contents.` }],
					toolResultError: 'Path is a directory'
				};
			}

			const fileContent = await this.fileService.readFile(fileUri, undefined, token);
			const content = fileContent.value.toString();
			if (content.includes('\0')) {
				return {
					content: [{ kind: 'text', value: `File "${params.path}" is binary; no outline available. Next: Skip or handle as binary.` }]
				};
			}

			const totalLines = content.split('\n').length;
			const symbols = extractSymbols(content);

			if (symbols.length === 0) {
				return {
					content: [{ kind: 'text', value: `No top-level symbols detected in "${params.path}" (${totalLines} lines). Next: Use readFile to read the contents directly.\n\nProceed to the next step or goal.` }]
				};
			}

			const header = `Outline of ${params.path} (${totalLines} lines, ${symbols.length} symbols):\n\n`;
			const footer = `\n\nNext: readFile("${params.path}", offset, limit) on the symbol you need - the numbers above are its line. This is an outline only; it may omit symbols, so grep if something you expect is missing.\n\nProceed to the next step or goal.`;
			return {
				content: [{ kind: 'text', value: header + symbols.join('\n') + footer }]
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ kind: 'text', value: `Error outlining "${params.path}": ${errorMessage}. Next: Verify the path (use findFiles or listDirectory), or use readFile.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}
