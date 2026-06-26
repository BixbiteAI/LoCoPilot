/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extname } from '../../../../base/common/resources.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { DEFAULT_EDITOR_ASSOCIATION, EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService, IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWebviewService, WebviewInitInfo, IOverlayWebview } from '../../webview/browser/webview.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { WebviewInput, WebviewInputInitInfo } from '../../webviewPanel/browser/webviewEditorInput.js';
import { asWebviewUri } from '../../webview/common/webview.js';
import { DEFAULT_MARKDOWN_STYLES, renderMarkdownDocument } from '../../markdown/browser/markdownDocumentRenderer.js';

/** File extensions (without dot, lower-case) that the preview toggle can render. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn']);
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);

export const TOGGLE_PREVIEW_COMMAND_ID = 'locopilot.preview.toggle';

/**
 * The `editorId` (a.k.a. webview viewType) used by our preview editor. Kept in
 * sync with the matching constant in `breadcrumbsControl.ts` so the breadcrumbs
 * toggle can tell whether the active editor is a preview.
 */
export const PREVIEW_EDITOR_VIEW_TYPE = 'locopilot.preview';

export type PreviewKind = 'markdown' | 'html';

/**
 * Returns the kind of preview available for a resource, or undefined when the
 * resource is a regular (code) file that we do not render.
 */
export function getPreviewKind(resource: URI | undefined): PreviewKind | undefined {
	if (!resource) {
		return undefined;
	}
	const ext = extname(resource).replace(/^\./, '').toLowerCase();
	if (MARKDOWN_EXTENSIONS.has(ext)) {
		return 'markdown';
	}
	if (HTML_EXTENSIONS.has(ext)) {
		return 'html';
	}
	return undefined;
}

/**
 * A webview editor input that reports the *source file's* URI as its resource.
 * That keeps the breadcrumbs row (and our toggle button) visible while the
 * rendered preview is showing, so the user can flip straight back to the source.
 */
class PreviewWebviewInput extends WebviewInput {

	public override get editorId(): string {
		return PREVIEW_EDITOR_VIEW_TYPE;
	}

	get previewResource(): URI {
		return this._previewResource;
	}

	override get resource(): URI {
		return this._previewResource;
	}

	constructor(
		private readonly _previewResource: URI,
		readonly previewKind: PreviewKind,
		init: WebviewInputInitInfo,
		webview: IOverlayWebview,
		@IThemeService themeService: IThemeService,
	) {
		super(init, webview, themeService);
	}
}

/**
 * Owns the in-place "render this file" preview toggle that lives at the far
 * right of the breadcrumbs row. Markdown is rendered with the in-core markdown
 * renderer and HTML is shown as-is; both replace the source editor in the same
 * tab so the user sees only the preview, and the toggle flips them back.
 */
class HtmlPreviewContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.htmlPreview';

	/** Live previews keyed by source resource, so we can re-render on save. */
	private readonly _previews = new Map<string, { input: PreviewWebviewInput; disposables: DisposableStore }>();

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand(TOGGLE_PREVIEW_COMMAND_ID, (_accessor: ServicesAccessor, arg?: URI) => {
			return this.togglePreview(arg);
		}));
	}

	private async togglePreview(arg?: URI): Promise<void> {
		const group = this._editorService.activeEditorPane?.group ?? this._editorGroupService.activeGroup;
		const current = group.activeEditor;

		// Already previewing → go back to the source file in the same tab.
		if (current instanceof PreviewWebviewInput) {
			await this._editorService.replaceEditors([{
				editor: current,
				replacement: { resource: current.previewResource, options: { override: DEFAULT_EDITOR_ASSOCIATION.id, pinned: true } }
			}], group);
			return;
		}

		const resource = arg ?? EditorResourceAccessor.getOriginalUri(current, { supportSideBySide: SideBySideEditor.PRIMARY });
		const kind = getPreviewKind(resource);
		if (!resource || !kind || !current) {
			return;
		}

		await this.openPreview(resource, kind, group, current);
	}

	private async openPreview(resource: URI, kind: PreviewKind, group: IEditorGroup, replace: EditorInput): Promise<void> {
		const title = localize('previewTitle', "Preview {0}", basename(resource));
		const base = dirname(resource);

		const webviewInitInfo: WebviewInitInfo = {
			title,
			options: { tryRestoreScrollPosition: true, enableFindWidget: true, retainContextWhenHidden: true },
			contentOptions: { localResourceRoots: [base], allowScripts: true },
			extension: undefined,
		};
		const webview = this._webviewService.createWebviewOverlay(webviewInitInfo);
		const input = this._instantiationService.createInstance(
			PreviewWebviewInput,
			resource,
			kind,
			{ viewType: PREVIEW_EDITOR_VIEW_TYPE, name: title, providedId: PREVIEW_EDITOR_VIEW_TYPE, iconPath: undefined } satisfies WebviewInputInitInfo,
			webview,
		);

		const disposables = new DisposableStore();
		const key = resource.toString();
		disposables.add(input.onWillDispose(() => {
			if (this._previews.get(key)?.input === input) {
				this._previews.delete(key);
			}
			disposables.dispose();
		}));
		// Keep the preview in sync with edits to the source file.
		disposables.add(this._fileService.watch(resource));
		disposables.add(this._fileService.onDidFilesChange(e => {
			if (e.contains(resource)) {
				this.render(input, resource, kind, base);
			}
		}));
		this._previews.set(key, { input, disposables });

		// Replace the source editor in place so only the preview is shown.
		await group.replaceEditors([{ editor: replace, replacement: input, options: { pinned: true } }]);
		await this.render(input, resource, kind, base);
	}

	private async render(input: PreviewWebviewInput, resource: URI, kind: PreviewKind, base: URI): Promise<void> {
		let html: string;
		try {
			const content = (await this._fileService.readFile(resource)).value.toString();
			html = kind === 'markdown'
				? await this.renderMarkdown(content, base)
				: this.injectBaseHref(content, base);
		} catch {
			html = `<!DOCTYPE html><html><body><p>${localize('previewReadError', "Unable to read file.")}</p></body></html>`;
		}
		input.webview.setHtml(html);
	}

	private async renderMarkdown(content: string, base: URI): Promise<string> {
		const body = await renderMarkdownDocument(content, this._extensionService, this._languageService, { sanitizerConfig: { allowRelativeMediaPaths: true } });
		const baseHref = asWebviewUri(base).toString(true) + '/';
		return `<!DOCTYPE html><html><head>
			<base href="${baseHref}">
			<style>${DEFAULT_MARKDOWN_STYLES}</style>
		</head><body class="markdown-body">${body}</body></html>`;
	}

	/**
	 * Inject a `<base href>` that points at the webview-mapped source directory so
	 * relative links to stylesheets, scripts and images resolve correctly.
	 */
	private injectBaseHref(content: string, base: URI): string {
		const baseHref = asWebviewUri(base).toString(true) + '/';
		const baseTag = `<base href="${baseHref}">`;
		if (/<head[^>]*>/i.test(content)) {
			return content.replace(/<head[^>]*>/i, match => `${match}\n${baseTag}`);
		}
		if (/<html[^>]*>/i.test(content)) {
			return content.replace(/<html[^>]*>/i, match => `${match}\n<head>${baseTag}</head>`);
		}
		return `<!DOCTYPE html><html><head>${baseTag}</head><body>${content}</body></html>`;
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(HtmlPreviewContribution, LifecyclePhase.Restored);
