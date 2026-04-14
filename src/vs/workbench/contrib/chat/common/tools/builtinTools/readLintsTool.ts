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
import { IMarkerService, MarkerSeverity } from '../../../../../../platform/markers/common/markers.js';
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

export const ReadLintsToolId = 'readLints';

export function createReadLintsToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			paths: {
				type: 'array',
				description: 'Optional: Array of file or directory paths to check for linter errors. If not provided, returns diagnostics for recently edited files.',
				items: {
					type: 'string'
				}
			}
		}
	};

	return {
		id: ReadLintsToolId,
		toolReferenceName: 'readLints',
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.warning.id),
		displayName: localize('tool.readLints.displayName', 'Read linter errors and warnings'),
		userDescription: localize('tool.readLints.userDescription', 'Get linter diagnostics, errors, and warnings'),
		modelDescription: 'Read linter errors, warnings, and diagnostics from the IDE.\n\nUse this tool to:\n- Check for errors after editing files\n- Verify code changes don\'t introduce issues\n- Find specific problems to fix\n- Understand code quality issues\n\nOutput includes:\n- Error severity (error, warning, info)\n- File path and line numbers\n- Error messages and codes\n- Grouped by file for clarity\n\nBest practices:\n- Always check lints after making edits\n- Use to verify fixes worked\n- Can filter to specific files/directories\n- Helps ensure code quality',
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
		alwaysDisplayInputOutput: true
	};
}

interface IReadLintsToolParams {
	paths?: string[];
}

export class ReadLintsTool implements IToolImpl {

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) { }

	private getSeverityLabel(severity: MarkerSeverity): string {
		switch (severity) {
			case MarkerSeverity.Error:
				return 'error';
			case MarkerSeverity.Warning:
				return 'warning';
			case MarkerSeverity.Info:
				return 'info';
			case MarkerSeverity.Hint:
				return 'hint';
			default:
				return 'unknown';
		}
	}

	private resolveUri(path: string, workspaceUri: URI): URI {
		if (path.startsWith('/') || path.match(/^[a-zA-Z]:/)) {
			return URI.file(path);
		}
		return URI.joinPath(workspaceUri, path);
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IReadLintsToolParams;
		
		try {
			progress.report({ message: 'Checking for errors...' });

			const workspace = this.workspaceService.getWorkspace();
			const workspaceUri = workspace.folders.length > 0 ? workspace.folders[0].uri : URI.file('/');

			let markers;
			
			if (params.paths && params.paths.length > 0) {
				// Get markers for specific paths
				const allMarkers = [];
				for (const path of params.paths) {
					const uri = this.resolveUri(path, workspaceUri);
					const fileMarkers = this.markerService.read({ resource: uri, severities: MarkerSeverity.Error | MarkerSeverity.Warning | MarkerSeverity.Info });
					allMarkers.push(...fileMarkers);
				}
				markers = allMarkers;
			} else {
				// Get all markers in workspace
				markers = this.markerService.read({ severities: MarkerSeverity.Error | MarkerSeverity.Warning | MarkerSeverity.Info });
			}

			if (markers.length === 0) {
				return {
					content: [{ kind: 'text', value: 'No linter errors or warnings found! Proceed to the next step or goal.' }]
				};
			}

			// Group markers by file
			const markersByFile = new Map<string, typeof markers>();
			for (const marker of markers) {
				const path = marker.resource.fsPath;
				if (!markersByFile.has(path)) {
					markersByFile.set(path, []);
				}
				markersByFile.get(path)!.push(marker);
			}

			// Format output
			const results: string[] = [];
			let errorCount = 0;
			let warningCount = 0;
			let infoCount = 0;

			for (const [filePath, fileMarkers] of markersByFile) {
				// Get relative path for display
				let displayPath = filePath;
				if (workspace.folders.length > 0) {
					const wsPath = workspace.folders[0].uri.fsPath;
					if (filePath.startsWith(wsPath)) {
						displayPath = filePath.substring(wsPath.length + 1);
					}
				}

				results.push(`\n${displayPath} (${fileMarkers.length} issues):`);

				// Sort by line number
				fileMarkers.sort((a, b) => a.startLineNumber - b.startLineNumber);

				for (const marker of fileMarkers) {
					const severity = this.getSeverityLabel(marker.severity);
					const line = marker.startLineNumber;
					const col = marker.startColumn;
					const code = marker.code ? ` [${typeof marker.code === 'object' ? marker.code.value : marker.code}]` : '';
					const source = marker.source ? ` (${marker.source})` : '';
					
					results.push(`  ${line}:${col} - ${severity}${code}: ${marker.message}${source}`);

					// Count by severity
					if (marker.severity === MarkerSeverity.Error) {
						errorCount++;
					} else if (marker.severity === MarkerSeverity.Warning) {
						warningCount++;
					} else {
						infoCount++;
					}
				}
			}

			const summary = `Found ${errorCount} errors, ${warningCount} warnings, ${infoCount} info messages in ${markersByFile.size} files`;
			const nextHint = '\n\nProceed to the next step or goal.';
			const output = `${summary}${nextHint}\n${results.join('\n')}`;

			return {
				content: [{ kind: 'text', value: output }]
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ kind: 'text', value: `Error reading lints: ${errorMessage}. Next: Ensure paths exist (listDirectory/readFile), or omit paths to get workspace-wide diagnostics.` }],
				toolResultError: errorMessage
			};
		}
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		// Read operations don't need confirmation; return undefined so tool call is shown in UI
		return undefined;
	}
}
