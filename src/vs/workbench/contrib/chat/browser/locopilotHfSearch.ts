/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Hugging Face model search for the Add Model form: turns what the user types into a repo id the download
 * service can fetch, so nobody has to know the exact `owner/repo` spelling up front.
 *
 * Pure helpers only (URL building, response parsing, merging) - the network calls live in the download service,
 * which already owns HF auth headers and the request layer, and the UI lives in huggingFaceModelSearch.ts.
 */

/** Weight formats LoCoPilot can actually run from a downloaded HF repo. */
export type HfSearchFormat = 'gguf' | 'mlx';

/** Command ids the download service registers; the Add forms call them rather than importing the service. */
export const LOCOPILOT_HF_SEARCH_COMMAND = 'locopilot.searchHuggingFaceModels';
export const LOCOPILOT_HF_PREVIEW_COMMAND = 'locopilot.previewHuggingFaceModel';

/** Below this the query matches half of the Hub and the request is wasted. */
export const HF_SEARCH_MIN_QUERY_LENGTH = 2;
/** Rows shown in the dropdown. More than this and nobody reads them - they refine the query instead. */
export const HF_SEARCH_RESULT_LIMIT = 20;

export interface IHfSearchResult {
	readonly repoId: string;
	readonly format: HfSearchFormat;
	readonly downloads: number;
	readonly likes: number;
	/** ISO timestamp of the last commit, when HF reported one. */
	readonly lastModified?: string;
	/** Gated repos download only with a token whose owner accepted the model's terms. */
	readonly gated: boolean;
	/** From `pipeline_tag`/tags - a hint only; the real capability is detected from the files after download. */
	readonly vision: boolean;
}

/** What {@link LOCOPILOT_HF_SEARCH_COMMAND} returns: undefined results means Hugging Face could not be reached. */
export interface IHfSearchResponse {
	readonly results: readonly IHfSearchResult[] | undefined;
}

export type HfPreviewError = 'notFound' | 'network' | 'unsupported' | 'noWeights';

/** How a picked repo would land on THIS machine, shown under the field before anything downloads. */
export interface IHfRepoPreview {
	readonly repoId: string;
	readonly format?: HfSearchFormat;
	/** Same verdicts the download planner uses; undefined when the repo's files can't be sized or ranked. */
	readonly verdict?: 'good' | 'tight' | 'poor';
	/** Quant the planner would pick (GGUF), e.g. `Q4_K_M`. */
	readonly quant?: string;
	/** Total download size of the weights that would be fetched. */
	readonly sizeBytes?: number;
	readonly sharded?: boolean;
	readonly gated?: boolean;
	readonly error?: HfPreviewError;
}

const VISION_PIPELINES = new Set(['image-text-to-text', 'visual-question-answering', 'image-to-text', 'multimodal']);

/**
 * Accepts a bare repo id or anything pasted from the browser (`https://huggingface.co/owner/repo/tree/main`,
 * `hf.co/owner/repo`, a `/blob/main/file.gguf` link) and returns `owner/repo`, or undefined when the text is not
 * shaped like a model repo. Dataset and Space links are rejected - they are not downloadable models.
 */
export function parseHuggingFaceRepoInput(text: string): string | undefined {
	let value = text.trim();
	const url = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/(.*)$/i.exec(value);
	if (url) {
		const segments = url[1].split(/[?#]/)[0].split('/').filter(Boolean);
		if (segments[0] === 'models') {
			segments.shift();
		}
		if (segments.length < 2 || segments[0] === 'datasets' || segments[0] === 'spaces') {
			return undefined;
		}
		value = `${segments[0]}/${segments[1]}`;
	}
	return /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(value) ? value : undefined;
}

/** Search URL for one format. Sorted by downloads, which is the best available proxy for "the one people use". */
export function buildHfSearchUrl(apiBase: string, query: string, format: HfSearchFormat, limit = HF_SEARCH_RESULT_LIMIT): string {
	const params = [
		`search=${encodeURIComponent(query.trim())}`,
		`filter=${format}`,
		'sort=downloads',
		'direction=-1',
		`limit=${limit}`,
		// `expand` replaces the default field set, so every field the row renders has to be named here.
		...['downloads', 'likes', 'lastModified', 'gated', 'private', 'pipeline_tag', 'tags'].map(f => `expand[]=${f}`),
	];
	return `${apiBase}/api/models?${params.join('&')}`;
}

/** Parses one `/api/models` response. Tolerant: anything malformed is skipped, never thrown. */
export function parseHfSearchResults(raw: unknown, format: HfSearchFormat): IHfSearchResult[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: IHfSearchResult[] = [];
	for (const item of raw) {
		const repoId = typeof item?.id === 'string' ? item.id : (typeof item?.modelId === 'string' ? item.modelId : undefined);
		if (!repoId || !repoId.includes('/') || item?.private === true) {
			continue;
		}
		const tags: string[] = Array.isArray(item?.tags) ? item.tags.map((t: unknown) => String(t).toLowerCase()) : [];
		const pipeline = typeof item?.pipeline_tag === 'string' ? item.pipeline_tag.toLowerCase() : '';
		out.push({
			repoId,
			format,
			downloads: Number.isFinite(item?.downloads) ? item.downloads : 0,
			likes: Number.isFinite(item?.likes) ? item.likes : 0,
			lastModified: typeof item?.lastModified === 'string' ? item.lastModified : undefined,
			// HF reports `false`, or the gating mode ("auto" / "manual") when gated.
			gated: !!item?.gated,
			vision: VISION_PIPELINES.has(pipeline) || tags.some(t => VISION_PIPELINES.has(t) || t === 'vision'),
		});
	}
	return out;
}

/**
 * Merges the per-format lists into one ranking. A repo that carries both tags appears once, as GGUF (the engine
 * every platform has); the rest are ordered by downloads so the MLX and GGUF builds of a model sit together.
 */
export function mergeHfSearchResults(lists: readonly (readonly IHfSearchResult[])[], limit = HF_SEARCH_RESULT_LIMIT): IHfSearchResult[] {
	const byRepo = new Map<string, IHfSearchResult>();
	for (const list of lists) {
		for (const result of list) {
			const key = result.repoId.toLowerCase();
			const existing = byRepo.get(key);
			if (!existing || (existing.format !== 'gguf' && result.format === 'gguf')) {
				byRepo.set(key, result);
			}
		}
	}
	return [...byRepo.values()].sort((a, b) => b.downloads - a.downloads).slice(0, limit);
}

/** `12752716` -> `12.8M`, `1029` -> `1.0K`. */
export function formatHfCount(n: number): string {
	if (n >= 1e9) {
		return `${(n / 1e9).toFixed(1)}B`;
	}
	if (n >= 1e6) {
		return `${(n / 1e6).toFixed(1)}M`;
	}
	if (n >= 1e3) {
		return `${(n / 1e3).toFixed(1)}K`;
	}
	return String(n);
}
