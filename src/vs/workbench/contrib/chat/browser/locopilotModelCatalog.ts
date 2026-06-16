/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICustomLanguageModel } from '../common/customLanguageModelsService.js';

/**
 * Built-in model catalog: a curated set of local (HuggingFace) models that are seeded into a fresh
 * install so the model list and chat picker are never empty. Each entry is metadata only - nothing is
 * downloaded until the user starts a download from the model list (or, later, from the chat panel).
 *
 * Catalog entries map onto regular {@link ICustomLanguageModel} `huggingface` / `local` records with no
 * `localPath`, so they render in "My Models" with a Download button + progress for free, and the existing
 * download service ({@link LoCoPilotModelDownloadService}) handles fetching, resume, cancel and metadata
 * enrichment exactly as it does for hand-added models.
 *
 * The extra fields here (size, RAM tier, vendor, recommended) are display/curation metadata used by the
 * seeding service and the UI; they are intentionally NOT persisted on the stored model so the storage
 * schema stays unchanged. Look them up by matching `repoId` + `format` via {@link findCatalogEntry}.
 *
 * Display-name note: `displayName` must be unique (addCustomModel enforces it) and on Apple Silicon both
 * the GGUF and the MLX build of a model are seeded. So GGUF entries carry NO format suffix, and only the
 * MLX twin keeps a "(MLX)" suffix - that keeps each pair unique while leaving the common GGUF names clean.
 */

export type CatalogEngine = 'gguf' | 'mlx';

export interface ICatalogModel {
	/** Stable identity, independent of the random per-model id, used to dedupe seeding and look entries up later. */
	readonly catalogId: string;
	/** Unique, user-facing label shown in the list and model picker. */
	readonly displayName: string;
	/** Maker, e.g. "Alibaba (Qwen)", "Google", used for grouping/labels. */
	readonly vendor: string;
	/** Short one-line description of what the model is good at. */
	readonly blurb: string;
	/** HuggingFace repo id (org/name): used as `modelName` and as the download source. */
	readonly repoId: string;
	/**
	 * Download format string consumed by the download service's `filterPathsByFormat`:
	 * a GGUF quantization such as 'Q4_K_M' (selects that .gguf), or 'mlx' (pulls the MLX weight set).
	 */
	readonly format: string;
	/** Inference engine the download targets. MLX is Apple-Silicon-only. */
	readonly engine: CatalogEngine;
	/** Approximate on-disk download size in bytes (display only; real size comes from HF at download time). */
	readonly approxSizeBytes: number;
	/** Minimum system RAM (GB) for a comfortable run; drives soft warnings and auto-recommend by detected RAM. */
	readonly minRamGB: number;
	/** RAM tier bucket label, e.g. "8 GB", "16 GB", "32 GB+". */
	readonly tier: string;
	/** Highlighted as the suggested default pick within its tier. */
	readonly recommended?: boolean;
	/** MLX builds run on Apple Silicon only; the seeding service skips these on other platforms. */
	readonly requiresAppleSilicon?: boolean;
	/** Context-window hint shown until post-download enrichment derives the real value from HF. */
	readonly contextWindow?: number;
	/** Tool-calling default. Reasoning-distill models start false (the runtime can still auto-disable on failure). */
	readonly useNativeTools?: boolean;
	/**
	 * Seed this entry hidden so it does NOT clutter the chat model picker (the picker excludes hidden models).
	 * It still appears in "My Models", where the user can click Show to surface it. Keeps the picker short by
	 * default while still offering the full catalog. Only a curated handful are left visible.
	 */
	readonly defaultHidden?: boolean;
	/**
	 * llama.cpp Multi-Token Prediction speculative decoding (`--spec-type mtp`). Only valid for `-MTP-GGUF`
	 * repos that ship MTP heads; set together with such a repo to seed the model with MTP enabled.
	 */
	readonly mtp?: boolean;
}

const GB = 1024 * 1024 * 1024;

/**
 * The shipped default catalog. Repo ids below were verified to exist as public HuggingFace repos.
 * To add/upgrade models without a new app build, ship an updated catalog remotely and merge it in the
 * seeding service (see {@link LoCoPilotCatalogSeedContribution}); these entries are the offline fallback.
 */
export const LOCOPILOT_DEFAULT_CATALOG: readonly ICatalogModel[] = [
	// =========================================================================================
	// Latest generation (June 2026): Gemma 4 + Qwen 3.6. Added on top of the proven set below;
	// comment out whichever you do not want to ship.
	// =========================================================================================

	// ---- Gemma 4 (Google) ----
	{
		catalogId: 'gemma4-e4b-gguf',
		displayName: 'Gemma 4 E4B',
		vendor: 'Google',
		blurb: 'Latest small Gemma (edge-class ~4B effective); tool calling + vision.',
		repoId: 'unsloth/gemma-4-E4B-it-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(3 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
	},
	{
		catalogId: 'gemma4-e4b-mlx',
		displayName: 'Gemma 4 E4B (MLX)',
		vendor: 'Google',
		blurb: 'Same edge-class Gemma 4 tuned for Apple Silicon via MLX.',
		repoId: 'unsloth/gemma-4-E4B-it-UD-MLX-4bit',
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(2.8 * GB),
		minRamGB: 8,
		tier: '8 GB',
		requiresAppleSilicon: true,
		contextWindow: 131072,
	},
	{
		catalogId: 'gemma4-12b-gguf',
		displayName: 'Gemma 4 12B',
		vendor: 'Google',
		blurb: 'Latest mid-size Gemma; native audio, tools + vision. Fits 16 GB.',
		repoId: 'unsloth/gemma-4-12b-it-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(7 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 262144,
	},
	{
		catalogId: 'gemma4-26b-a4b-gguf',
		displayName: 'Gemma 4 26B-A4B MoE',
		vendor: 'Google',
		blurb: 'Mixture-of-experts Gemma 4: 26B total, ~4B active - fast for its quality.',
		repoId: 'unsloth/gemma-4-26B-A4B-it-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(16 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
	},
	{
		catalogId: 'gemma4-31b-gguf',
		displayName: 'Gemma 4 31B',
		vendor: 'Google',
		blurb: 'Largest dense Gemma 4; top quality for 32 GB+ machines.',
		repoId: 'unsloth/gemma-4-31B-it-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(19 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
	},

	// ---- Qwen 3.6 (Alibaba) - only 27B dense + 35B-A3B MoE exist ----
	{
		catalogId: 'qwen36-27b-gguf',
		displayName: 'Qwen3.6 27B',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Latest top dense coder (77% SWE-bench class). 32 GB+ recommended.',
		repoId: 'unsloth/Qwen3.6-27B-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(16 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
	},
	{
		catalogId: 'qwen36-27b-mlx',
		displayName: 'Qwen3.6 27B (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Same Qwen3.6 27B dense coder tuned for Apple Silicon via MLX.',
		repoId: 'unsloth/Qwen3.6-27B-UD-MLX-4bit',
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(15 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 262144,
	},
	{
		catalogId: 'qwen36-35b-a3b-gguf',
		displayName: 'Qwen3.6 35B-A3B MoE',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Latest Qwen MoE: 35B total, ~3B active - fast and high quality.',
		repoId: 'unsloth/Qwen3.6-35B-A3B-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(20 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
	},
	{
		catalogId: 'qwen36-35b-a3b-mlx',
		displayName: 'Qwen3.6 35B-A3B MoE (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Same fast Qwen3.6 MoE tuned for Apple Silicon via MLX.',
		repoId: 'unsloth/Qwen3.6-35B-A3B-UD-MLX-4bit',
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(19 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 262144,
	},

	// ---- Qwen 3.5 MTP (Alibaba) - GGUF builds with Multi-Token Prediction heads (llama.cpp --spec-type mtp) ----
	{
		catalogId: 'qwen35-0_8b-mtp-gguf',
		displayName: 'Qwen3.5 0.8B (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Ultra-light MTP build; fastest speculative decoding for tiny tasks.',
		repoId: 'unsloth/Qwen3.5-0.8B-MTP-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(0.6 * GB),
		minRamGB: 8,
		tier: '8 GB',
		mtp: true,
		contextWindow: 262144,
	},
	{
		catalogId: 'qwen35-2b-mtp-gguf',
		displayName: 'Qwen3.5 2B (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Small MTP build; fast on-device assistant.',
		repoId: 'unsloth/Qwen3.5-2B-MTP-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(1.5 * GB),
		minRamGB: 8,
		tier: '8 GB',
		mtp: true,
		contextWindow: 262144,
	},
	{
		catalogId: 'qwen35-4b-mtp-gguf',
		displayName: 'Qwen3.5 4B (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Capable tiny all-rounder with MTP speculative decoding.',
		repoId: 'unsloth/Qwen3.5-4B-MTP-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.5 * GB),
		minRamGB: 8,
		tier: '8 GB',
		mtp: true,
		contextWindow: 262144,
	},
	{
		catalogId: 'qwen35-9b-mtp-gguf',
		displayName: 'Qwen3.5 9B (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Mid-small MTP build; strong quality for 16 GB machines.',
		repoId: 'unsloth/Qwen3.5-9B-MTP-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(5.5 * GB),
		minRamGB: 16,
		tier: '16 GB',
		mtp: true,
		contextWindow: 262144,
	},
	{
		catalogId: 'qwen35-27b-mtp-gguf',
		displayName: 'Qwen3.5 27B (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Dense 27B MTP build; high quality with faster decoding.',
		repoId: 'unsloth/Qwen3.5-27B-MTP-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(16 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		mtp: true,
		contextWindow: 262144,
	},
	{
		catalogId: 'qwen35-35b-a3b-mtp-gguf',
		displayName: 'Qwen3.5 35B-A3B MoE (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'MoE 35B/~3B-active MTP build; fast and high quality.',
		repoId: 'unsloth/Qwen3.5-35B-A3B-MTP-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(20 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		mtp: true,
		contextWindow: 262144,
	},

	// ---- DiffusionGemma 26B-A4B (Google) - diffusion LM, hidden until stable ----
	{
		catalogId: 'diffusiongemma-26b-a4b-gguf',
		displayName: 'DiffusionGemma 26B-A4B',
		vendor: 'Google',
		blurb: 'Diffusion-based Gemma MoE (26B total, ~4B active); experimental non-autoregressive generation.',
		repoId: 'unsloth/diffusiongemma-26B-A4B-it-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(16 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		defaultHidden: true,
		contextWindow: 262144,
	},
	{
		catalogId: 'diffusiongemma-26b-a4b-mlx',
		displayName: 'DiffusionGemma 26B-A4B (MLX)',
		vendor: 'Google',
		blurb: 'DiffusionGemma 26B-A4B tuned for Apple Silicon via MLX; experimental.',
		repoId: 'mlx-community/diffusiongemma-26B-A4B-it-4bit',
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(15 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		defaultHidden: true,
		contextWindow: 262144,
	},

	// ---- Qwen 3.6 MTP (Alibaba) - MTP heads for speculative decoding, hidden until tested ----
	{
		catalogId: 'qwen36-27b-mtp-gguf',
		displayName: 'Qwen3.6 27B (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Qwen3.6 27B dense coder with Multi-Token Prediction heads; faster decoding via llama.cpp speculative.',
		repoId: 'unsloth/Qwen3.6-27B-MTP-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(16 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		mtp: true,
		defaultHidden: true,
		contextWindow: 262144,
	},

	// =========================================================================================
	// Proven prior generation (verified working). Keep or comment out as desired.
	// =========================================================================================

	// ---- Tier 1: 8 GB (entry, runs almost anywhere) ----
	{
		catalogId: 'qwen3-4b-gguf',
		displayName: 'Qwen3 4B',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Fast, capable tiny all-rounder; great first model on low-RAM machines.',
		repoId: 'unsloth/Qwen3-4B-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.5 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 32768,
	},
	{
		catalogId: 'gemma3-4b-gguf',
		displayName: 'Gemma 3 4B',
		vendor: 'Google',
		blurb: 'Strong general chat in a tiny footprint.',
		repoId: 'unsloth/gemma-3-4b-it-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.6 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
	},
	{
		catalogId: 'phi4-mini-gguf',
		displayName: 'Phi-4 mini',
		vendor: 'Microsoft',
		blurb: 'Strong reasoning per byte; reliable always-works fallback.',
		repoId: 'unsloth/Phi-4-mini-instruct-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.5 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
	},

	// ---- Tier 2: 16 GB (sweet spot) ----
	{
		catalogId: 'qwen3-8b-gguf',
		displayName: 'Qwen3 8B',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Best small coder; the recommended default for 16 GB machines.',
		repoId: 'unsloth/Qwen3-8B-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(4.8 * GB),
		minRamGB: 16,
		tier: '16 GB',
		recommended: true,
		contextWindow: 32768,
	},
	{
		catalogId: 'qwen3-8b-mlx',
		displayName: 'Qwen3 8B (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Same model tuned for Apple Silicon via MLX - 30-50% faster on M-series chips.',
		repoId: 'mlx-community/Qwen3-8B-4bit',
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(4.6 * GB),
		minRamGB: 16,
		tier: '16 GB',
		requiresAppleSilicon: true,
		contextWindow: 32768,
	},
	{
		catalogId: 'gemma3-12b-gguf',
		displayName: 'Gemma 3 12B',
		vendor: 'Google',
		blurb: 'Most capable Gemma 3 that still fits comfortably in 16 GB.',
		repoId: 'unsloth/gemma-3-12b-it-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(6.9 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 131072,
	},
	{
		catalogId: 'deepseek-r1-distill-14b-gguf',
		displayName: 'DeepSeek-R1 Distill 14B',
		vendor: 'DeepSeek',
		blurb: 'Reasoning-focused distill; strong step-by-step problem solving.',
		repoId: 'unsloth/DeepSeek-R1-Distill-Qwen-14B-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(9 * GB),
		minRamGB: 16,
		tier: '16 GB',
		useNativeTools: false,
		contextWindow: 131072,
	},

	// ---- Tier 3: 32 GB+ (power users) ----
	{
		catalogId: 'devstral-small-24b-gguf',
		displayName: 'Devstral Small 24B',
		vendor: 'Mistral',
		blurb: 'Best agentic/coding open model in its class.',
		repoId: 'bartowski/mistralai_Devstral-Small-2507-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(14 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 131072,
	},
	{
		catalogId: 'mistral-small-24b-gguf',
		displayName: 'Mistral Small 24B',
		vendor: 'Mistral',
		blurb: 'Capable general-purpose model with a permissive license.',
		repoId: 'bartowski/Mistral-Small-24B-Instruct-2501-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(14 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 32768,
	},
	{
		catalogId: 'qwen3-32b-mlx',
		displayName: 'Qwen3 32B (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Top dense Qwen3 coder; Apple Silicon build, needs 32 GB+.',
		repoId: 'mlx-community/Qwen3-32B-4bit',
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(18 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 32768,
	},
	{
		catalogId: 'deepseek-r1-distill-32b-gguf',
		displayName: 'DeepSeek-R1 Distill 32B',
		vendor: 'DeepSeek',
		blurb: 'Strongest distilled reasoner that still runs on a single machine.',
		repoId: 'unsloth/DeepSeek-R1-Distill-Qwen-32B-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(20 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		useNativeTools: false,
		contextWindow: 131072,
	},

	// ---- Tier 4: prior-gen Qwen3 MoE (fast, only ~3B active) - both formats ----
	{
		catalogId: 'qwen3-30b-a3b-gguf',
		displayName: 'Qwen3 30B-A3B MoE',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Mixture-of-experts: 30B total, ~3B active - punches above its speed/size.',
		repoId: 'unsloth/Qwen3-30B-A3B-GGUF',
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(18 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 32768,
	},
	{
		catalogId: 'qwen3-30b-a3b-mlx',
		displayName: 'Qwen3 30B-A3B MoE (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Same fast Qwen3 MoE tuned for Apple Silicon via MLX.',
		repoId: 'mlx-community/Qwen3-30B-A3B-4bit',
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(17 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 32768,
	},
];

/** Build the stored-model record to seed from a catalog entry (a HuggingFace/local model with no localPath yet). */
export function catalogModelToSeed(entry: ICatalogModel): Omit<ICustomLanguageModel, 'id' | 'createdAt'> {
	return {
		name: entry.displayName,
		displayName: entry.displayName,
		type: 'local',
		provider: 'huggingface',
		modelName: entry.repoId,
		format: entry.format,
		contextWindow: entry.contextWindow,
		useNativeTools: entry.useNativeTools ?? true,
		mtp: entry.mtp ?? false,
		// Hidden unless explicitly curated visible, so the picker stays short. A remote entry can force
		// either state via `defaultHidden`. Users surface any hidden model with Show in "My Models".
		hidden: catalogDefaultHidden(entry),
	};
}

/**
 * The handful of catalog models shown in the chat picker out of the box (one tiny, one recommended default,
 * the latest mid-size Gemma, the latest flagship Qwen, and the best coding model). Everything else is seeded
 * hidden and can be surfaced via Show in "My Models".
 */
const DEFAULT_VISIBLE_CATALOG_IDS: ReadonlySet<string> = new Set([
	'qwen3-4b-gguf',
	'qwen3-8b-gguf',
	'gemma4-12b-gguf',
	'qwen36-27b-gguf',
	'devstral-small-24b-gguf',
	// Additional models surfaced in the picker by default.
	'qwen35-0_8b-mtp-gguf',
	'qwen35-4b-mtp-gguf',
	'qwen35-9b-mtp-gguf',
	'qwen36-35b-a3b-gguf',
	'gemma4-e4b-gguf',
	'gemma4-e4b-mlx',
]);

/**
 * Repo id of the model pre-selected in the chat picker for first-time users (smallest, runs almost anywhere).
 * Seeded models store the catalog `repoId` as their `modelName`, so the provider matches on this to flag the
 * picker default. Once a user picks a different model, their choice is persisted and wins over this default.
 */
export const DEFAULT_PICKER_MODEL_REPO_ID = 'unsloth/Qwen3-4B-GGUF';

/** Whether a catalog entry should be seeded hidden: explicit `defaultHidden` wins, else hidden unless allowlisted. */
export function catalogDefaultHidden(entry: ICatalogModel): boolean {
	return entry.defaultHidden ?? !DEFAULT_VISIBLE_CATALOG_IDS.has(entry.catalogId);
}

/**
 * How well a catalog model fits the current machine, used to badge/filter the model list:
 * - `best`        - runs comfortably AND is sized for this machine's RAM tier (the sweet spot).
 * - `ok`          - runs comfortably but is smaller than the machine could handle (fine, just not maximal).
 * - `too-big`     - needs more RAM than detected; will be slow or fail. Surfaced as a soft warning.
 * - `incompatible`- needs Apple Silicon (MLX) on a non-Apple-Silicon machine.
 * - `unknown`     - not a catalog model (custom/cloud) or RAM not detected; show no hardware hint.
 */
export type ModelSuitability = 'best' | 'ok' | 'too-big' | 'incompatible' | 'unknown';

/** Map detected system RAM (GB) to the catalog `tier` bucket that best fits it. */
export function bestTierForRam(ramGB: number): ICatalogModel['tier'] {
	if (ramGB >= 32) { return '32 GB+'; }
	if (ramGB >= 16) { return '16 GB'; }
	return '8 GB';
}

/**
 * Rate how well a catalog entry suits the current hardware. `ramGB <= 0` means RAM is unknown
 * (no startup metric yet) - we return `unknown` rather than guess. Apple-Silicon-only (MLX) builds
 * are normally not even seeded off Apple Silicon, but we still guard here for robustness.
 */
export function getCatalogSuitability(entry: ICatalogModel | undefined, ramGB: number, isAppleSilicon: boolean): ModelSuitability {
	if (!entry) { return 'unknown'; }
	if (entry.requiresAppleSilicon && !isAppleSilicon) { return 'incompatible'; }
	if (ramGB <= 0) { return 'unknown'; }
	if (ramGB < entry.minRamGB) { return 'too-big'; }
	return entry.tier === bestTierForRam(ramGB) ? 'best' : 'ok';
}

/** Find the catalog entry a stored model originated from, by matching its repo id + download format. */
export function findCatalogEntry(repoId: string | undefined, format: string | undefined): ICatalogModel | undefined {
	if (!repoId) {
		return undefined;
	}
	const fmt = (format ?? '').trim().toLowerCase();
	return LOCOPILOT_DEFAULT_CATALOG.find(e => e.repoId === repoId && e.format.toLowerCase() === fmt);
}
