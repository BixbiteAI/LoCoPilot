/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { isAppleSiliconMac } from '../locopilotMlxServer.js';
import {
	formatHfCount,
	HF_SEARCH_MIN_QUERY_LENGTH,
	IHfRepoPreview,
	IHfSearchResponse,
	IHfSearchResult,
	LOCOPILOT_HF_PREVIEW_COMMAND,
	LOCOPILOT_HF_SEARCH_COMMAND,
	parseHuggingFaceRepoInput,
} from '../locopilotHfSearch.js';

const $ = DOM.$;

/** Long enough that a fast typist sends one request per word, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

let instanceCounter = 0;

/**
 * Turns the Add form's model-name box into a Hugging Face search: results drop down under the field as the user
 * types, picking one fills in the exact repo id, and a line under the field says how that repo would fit this
 * machine (quant + size + good/tight/poor) before anything is downloaded.
 *
 * The field stays a plain text box underneath - an exact `owner/repo` or a pasted huggingface.co link still
 * works without touching the results - so the search only ever adds a path, never removes one. Active only while
 * the form's provider is local Hugging Face ({@link setEnabled}); every other provider keeps its plain field.
 */
export class HuggingFaceModelSearch extends Disposable {

	private readonly resultsEl: HTMLElement;
	private readonly statusEl: HTMLElement;
	private readonly previewEl: HTMLElement;
	private readonly listId = `locopilot-hf-search-${++instanceCounter}`;
	private readonly searchScheduler = this._register(new RunOnceScheduler(() => this.runSearch(), SEARCH_DEBOUNCE_MS));
	/** Listeners of the currently rendered rows; replaced on every render. */
	private readonly rowDisposables = this._register(new DisposableStore());

	private enabled = false;
	private results: readonly IHfSearchResult[] = [];
	private activeIndex = -1;
	/** Bumped per request so a slow response for an old query never overwrites a newer one. */
	private searchSeq = 0;
	private previewSeq = 0;
	/** Set while the widget itself writes the input, so that write isn't mistaken for typing. */
	private writingInput = false;
	/** The repo the current preview describes; avoids re-previewing the same pick on blur. */
	private previewedRepo: string | undefined;

	constructor(
		field: HTMLElement,
		private readonly input: InputBox,
		private readonly getToken: () => string | undefined,
		private readonly commandService: ICommandService,
	) {
		super();
		this.resultsEl = DOM.append(field, $('.hf-search-results'));
		this.resultsEl.id = this.listId;
		this.resultsEl.setAttribute('role', 'listbox');
		this.resultsEl.setAttribute('aria-label', localize('hfSearch.resultsAria', "Hugging Face models"));
		this.statusEl = DOM.append(field, $('.hf-search-status'));
		this.statusEl.setAttribute('aria-live', 'polite');
		this.previewEl = DOM.append(field, $('.hf-search-preview'));
		this.previewEl.setAttribute('aria-live', 'polite');
		this.hideResults();

		this._register(this.input.onDidChange(() => this.onInputChanged()));
		const inputEl = this.input.inputElement;
		this._register(DOM.addDisposableListener(inputEl, DOM.EventType.KEY_DOWN, e => this.onKeyDown(e)));
		this._register(DOM.addDisposableListener(inputEl, DOM.EventType.FOCUS, () => {
			if (this.enabled && this.results.length > 0 && !this.previewedRepo) {
				this.showResults();
			}
		}));
		this._register(DOM.addDisposableListener(inputEl, DOM.EventType.BLUR, () => {
			if (!this.enabled) {
				return;
			}
			this.hideResults();
			// A typed or pasted exact repo id gets its fit line without having to pick it from the list.
			const repo = parseHuggingFaceRepoInput(this.input.value);
			if (repo && repo !== this.previewedRepo) {
				this.runPreview(repo);
			}
		}));
		// Keep focus in the input while clicking a row (or the list's scrollbar), so blur doesn't hide the list
		// out from under the click.
		this._register(DOM.addDisposableListener(this.resultsEl, DOM.EventType.MOUSE_DOWN, e => e.preventDefault()));
	}

	/** Turns the search on for local Hugging Face and off (and clears it) for every other provider. */
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		const inputEl = this.input.inputElement;
		if (enabled) {
			inputEl.setAttribute('role', 'combobox');
			inputEl.setAttribute('aria-autocomplete', 'list');
			inputEl.setAttribute('aria-controls', this.listId);
			inputEl.setAttribute('aria-expanded', 'false');
		} else {
			for (const attr of ['role', 'aria-autocomplete', 'aria-controls', 'aria-expanded', 'aria-activedescendant']) {
				inputEl.removeAttribute(attr);
			}
			this.clear();
		}
	}

	/** Drops results, status and preview - used on reset, after a successful add, and when switching provider. */
	clear(): void {
		this.searchScheduler.cancel();
		this.searchSeq++;
		this.previewSeq++;
		this.results = [];
		this.previewedRepo = undefined;
		this.hideResults();
		this.setStatus('');
		this.setPreview('');
	}

	private onInputChanged(): void {
		if (!this.enabled || this.writingInput) {
			return;
		}
		// Any edit invalidates the fit line - it described a different repo.
		this.previewSeq++;
		this.previewedRepo = undefined;
		this.setPreview('');
		if (this.input.value.trim().length < HF_SEARCH_MIN_QUERY_LENGTH) {
			this.searchScheduler.cancel();
			this.searchSeq++;
			this.results = [];
			this.hideResults();
			this.setStatus('');
			return;
		}
		this.searchScheduler.schedule();
	}

	private async runSearch(): Promise<void> {
		const raw = this.input.value.trim();
		// A pasted link searches for the repo it points at.
		const typedRepo = parseHuggingFaceRepoInput(raw);
		const query = typedRepo ?? raw;
		const seq = ++this.searchSeq;
		this.setStatus(localize('hfSearch.searching', "Searching Hugging Face..."), 'busy');

		let response: IHfSearchResponse | undefined;
		try {
			response = await this.commandService.executeCommand<IHfSearchResponse>(LOCOPILOT_HF_SEARCH_COMMAND, query, this.getToken());
		} catch {
			response = undefined;
		}
		if (seq !== this.searchSeq || !this.enabled) {
			return;
		}
		if (!response?.results) {
			this.results = [];
			this.hideResults();
			this.setStatus(localize('hfSearch.offline', "Couldn't reach Hugging Face. You can still enter an exact repo id such as owner/model-GGUF."), 'error');
			return;
		}
		this.results = response.results;
		if (this.results.length === 0) {
			this.hideResults();
			this.setStatus(isAppleSiliconMac()
				? localize('hfSearch.noneMac', "No GGUF or MLX models match \"{0}\".", query)
				: localize('hfSearch.none', "No GGUF models match \"{0}\".", query), 'warn');
			return;
		}
		this.setStatus('');
		// Typed or pasted the exact id of a result: take it, rather than making the user pick it again.
		const exact = typedRepo ? this.results.find(r => r.repoId.toLowerCase() === typedRepo.toLowerCase()) : undefined;
		if (exact) {
			this.select(exact);
			return;
		}
		this.renderResults();
		if (DOM.isActiveElement(this.input.inputElement)) {
			this.showResults();
		}
	}

	private renderResults(): void {
		this.rowDisposables.clear();
		DOM.clearNode(this.resultsEl);
		this.activeIndex = -1;
		const hasToken = !!this.getToken();
		this.results.forEach((result, index) => {
			const row = DOM.append(this.resultsEl, $('.hf-search-result'));
			row.id = `${this.listId}-${index}`;
			row.setAttribute('role', 'option');
			row.setAttribute('aria-selected', 'false');
			row.title = result.repoId;

			const name = DOM.append(row, $('.hf-search-result-name'));
			const slash = result.repoId.indexOf('/');
			DOM.append(name, $('span.hf-search-result-owner')).textContent = result.repoId.slice(0, slash + 1);
			DOM.append(name, $('span.hf-search-result-repo')).textContent = result.repoId.slice(slash + 1);

			const meta = DOM.append(row, $('.hf-search-result-meta'));
			DOM.append(meta, $('span.hf-search-badge')).textContent = result.format.toUpperCase();
			const downloads = DOM.append(meta, $('span.hf-search-stat'));
			downloads.append(renderIcon(Codicon.cloudDownload), formatHfCount(result.downloads));
			downloads.title = localize('hfSearch.downloads', "Downloads last month");
			const likes = DOM.append(meta, $('span.hf-search-stat'));
			likes.append(renderIcon(Codicon.heart), formatHfCount(result.likes));
			likes.title = localize('hfSearch.likes', "Likes");
			const modified = result.lastModified ? Date.parse(result.lastModified) : NaN;
			if (!isNaN(modified)) {
				DOM.append(meta, $('span.hf-search-stat')).textContent = localize('hfSearch.updated', "updated {0}", fromNow(modified, true));
			}
			if (result.vision) {
				DOM.append(meta, $('span.hf-search-chip')).textContent = localize('hfSearch.vision', "Vision");
			}
			if (result.gated) {
				const chip = DOM.append(meta, $('span.hf-search-chip.gated'));
				chip.textContent = hasToken ? localize('hfSearch.gated', "Gated") : localize('hfSearch.needsToken', "Needs token");
				chip.title = localize('hfSearch.gatedTitle', "Accept this model's terms on huggingface.co, then add your Hugging Face token above.");
			}

			this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => this.select(result)));
			this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.MOUSE_MOVE, () => {
				if (this.activeIndex !== index) {
					this.setActive(index, false);
				}
			}));
		});
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (!this.enabled) {
			return;
		}
		const open = this.resultsEl.style.display !== 'none' && this.results.length > 0;
		switch (e.key) {
			case 'ArrowDown':
			case 'ArrowUp': {
				if (!open) {
					if (this.results.length > 0) {
						this.showResults();
						e.preventDefault();
					}
					return;
				}
				const delta = e.key === 'ArrowDown' ? 1 : -1;
				const next = this.activeIndex < 0
					? (delta > 0 ? 0 : this.results.length - 1)
					: (this.activeIndex + delta + this.results.length) % this.results.length;
				this.setActive(next, true);
				e.preventDefault();
				return;
			}
			case 'Enter': {
				if (open && this.activeIndex >= 0) {
					this.select(this.results[this.activeIndex]);
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				const repo = parseHuggingFaceRepoInput(this.input.value);
				if (repo && repo !== this.previewedRepo) {
					this.hideResults();
					this.runPreview(repo);
				}
				return;
			}
			case 'Escape':
				if (open) {
					this.hideResults();
					e.preventDefault();
					e.stopPropagation();
				}
				return;
		}
	}

	private setActive(index: number, scroll: boolean): void {
		const rows = this.resultsEl.children;
		rows[this.activeIndex]?.classList.remove('active');
		rows[this.activeIndex]?.setAttribute('aria-selected', 'false');
		this.activeIndex = index;
		const row = rows[index] as HTMLElement | undefined;
		if (!row) {
			this.input.inputElement.removeAttribute('aria-activedescendant');
			return;
		}
		row.classList.add('active');
		row.setAttribute('aria-selected', 'true');
		this.input.inputElement.setAttribute('aria-activedescendant', row.id);
		if (scroll) {
			row.scrollIntoView({ block: 'nearest' });
		}
	}

	private select(result: IHfSearchResult): void {
		this.searchScheduler.cancel();
		this.searchSeq++;
		this.writingInput = true;
		try {
			this.input.value = result.repoId;
		} finally {
			this.writingInput = false;
		}
		this.hideResults();
		this.setStatus('');
		this.runPreview(result.repoId);
	}

	private async runPreview(repoId: string): Promise<void> {
		const seq = ++this.previewSeq;
		this.previewedRepo = repoId;
		this.setPreview(localize('hfSearch.checking', "Checking how {0} fits this computer...", repoId), 'busy');
		let preview: IHfRepoPreview | undefined;
		try {
			preview = await this.commandService.executeCommand<IHfRepoPreview>(LOCOPILOT_HF_PREVIEW_COMMAND, repoId, this.getToken());
		} catch {
			preview = undefined;
		}
		if (seq !== this.previewSeq || !this.enabled) {
			return;
		}
		if (!preview || preview.error === 'network') {
			this.setPreview(localize('hfSearch.preview.network', "Couldn't read this model's files from Hugging Face. You can still add it."), 'warn');
			return;
		}
		switch (preview.error) {
			case 'notFound':
				this.setPreview(localize('hfSearch.preview.notFound', "No model named {0} on Hugging Face. Check the name, or add your token if it's private.", repoId), 'error');
				return;
			case 'unsupported':
				this.setPreview(localize('hfSearch.preview.unsupported', "This model only has Safetensors weights, which need an Apple Silicon Mac. Search for a GGUF version instead."), 'error');
				return;
			case 'noWeights':
				this.setPreview(localize('hfSearch.preview.noWeights', "This repository has no GGUF or Safetensors weights, so it can't run locally."), 'error');
				return;
		}

		const parts: string[] = [];
		if (preview.quant) {
			parts.push(preview.quant);
		} else if (preview.format) {
			parts.push(preview.format.toUpperCase());
		}
		if (preview.sizeBytes) {
			parts.push(preview.sharded
				? localize('hfSearch.preview.sizeSharded', "{0} GB download (several files)", (preview.sizeBytes / 1e9).toFixed(1))
				: localize('hfSearch.preview.size', "{0} GB download", (preview.sizeBytes / 1e9).toFixed(1)));
		}
		const details = parts.length ? ` · ${parts.join(' · ')}` : '';
		const gatedNote = preview.gated && !this.getToken()
			? ' ' + localize('hfSearch.preview.gated', "Gated model: accept its terms on huggingface.co and add your Hugging Face token above before downloading.")
			: '';

		switch (preview.verdict) {
			case 'good':
				this.setPreview(localize('hfSearch.preview.good', "Fits well on this computer") + details + gatedNote, gatedNote ? 'warn' : 'ok');
				return;
			case 'tight':
				this.setPreview(localize('hfSearch.preview.tight', "Fits, with a smaller context window") + details + gatedNote, 'warn');
				return;
			case 'poor':
				this.setPreview(localize('hfSearch.preview.poor', "Too large to run well here - you'll be asked before it downloads") + details + gatedNote, 'error');
				return;
			default:
				this.setPreview(localize('hfSearch.preview.ready', "Ready to download") + details + gatedNote, gatedNote ? 'warn' : undefined);
		}
	}

	private showResults(): void {
		this.resultsEl.style.display = '';
		this.input.inputElement.setAttribute('aria-expanded', 'true');
	}

	private hideResults(): void {
		this.resultsEl.style.display = 'none';
		if (this.enabled) {
			this.input.inputElement.setAttribute('aria-expanded', 'false');
		}
		this.input.inputElement.removeAttribute('aria-activedescendant');
		this.resultsEl.children[this.activeIndex]?.classList.remove('active');
		this.activeIndex = -1;
	}

	private setStatus(text: string, kind?: 'ok' | 'warn' | 'error' | 'busy'): void {
		this.statusEl.textContent = text;
		this.statusEl.className = `hf-search-status${kind ? ` ${kind}` : ''}`;
		this.statusEl.style.display = text ? '' : 'none';
	}

	private setPreview(text: string, kind?: 'ok' | 'warn' | 'error' | 'busy'): void {
		this.previewEl.textContent = text;
		this.previewEl.className = `hf-search-preview${kind ? ` ${kind}` : ''}`;
		this.previewEl.style.display = text ? '' : 'none';
	}
}
