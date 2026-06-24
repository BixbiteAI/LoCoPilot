/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IToolResult } from '../languageModelToolsService.js';

/**
 * Creates a tool result with a single text content part.
 */
export function createToolSimpleTextResult(value: string): IToolResult {
	return {
		content: [{
			kind: 'text',
			value
		}]
	};
}

/**
 * Resolve a tool `path` parameter (absolute or workspace-relative) to a file URI, mirroring the
 * resolution the tools use when actually reading/writing. Returns undefined when a relative path
 * can't be resolved (no workspace folder open).
 */
export function resolveToolFileUri(path: string | undefined, workspaceService: IWorkspaceContextService): URI | undefined {
	if (!path) {
		return undefined;
	}
	if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
		return URI.file(path);
	}
	const folders = workspaceService.getWorkspace().folders;
	if (folders.length === 0) {
		return undefined;
	}
	return URI.joinPath(folders[0].uri, path);
}

/**
 * Build a tool invocation message where the file name is a clickable link that opens the file.
 * `template` must be a localized string containing a single `{0}` placeholder (e.g. "Reading {0}").
 * When the path resolves to a URI we substitute an empty-text markdown link, which the chat
 * renderer turns into an inline file widget (shows the basename, opens the file on click). When it
 * can't be resolved, we fall back to the plain file name so the message still reads correctly.
 */
export function buildFileLinkInvocationMessage(template: string, name: string, uri: URI | undefined): MarkdownString {
	if (!uri) {
		return new MarkdownString(template.replace('{0}', name));
	}
	// Empty link text -> renderFileWidgets() renders an inline, clickable file anchor.
	const link = `[](${uri.toString()})`;
	return new MarkdownString(template.replace('{0}', link), { isTrusted: true });
}
