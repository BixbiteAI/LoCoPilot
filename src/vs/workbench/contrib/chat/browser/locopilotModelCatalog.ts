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
	/**
	 * True for architecturally multimodal checkpoints (e.g. Gemma 3/4, Qwen3.6 image-text-to-text). Seeds the
	 * model's `supportsVision` so the chat picker offers image attach. NOTE: a GGUF run via llama.cpp still
	 * needs an `mmproj` projector loaded for images to actually work; until the runner loads one the first
	 * image is rejected and the runtime auto-disables vision (the user can re-enable it from the toggle).
	 */
	readonly supportsVision?: boolean;
	/**
	 * HuggingFace repo of a small same-family model used as the **speculative-decoding draft** for this entry
	 * (llama.cpp `--model-draft`, mlx-lm `--draft-model`). The draft is downloaded silently alongside the main
	 * weights and enabled automatically when the machine's memory budget fits both; when it doesn't (or the
	 * pairing is absent) the runner falls back to n-gram speculation, so a pairing is an upgrade, never a
	 * requirement. PAIR ONLY VOCAB-COMPATIBLE FAMILIES: llama.cpp refuses to start when the draft's tokenizer
	 * does not match the target's (the runner then self-heals by relaunching without the draft, but the pairing
	 * is wasted). Prefer drafts <= ~1.5 GB; below ~8x target/draft size ratio the speedup stops being worth the RAM.
	 * MTP entries need no pairing - their draft head is embedded (self-draft), which beats an external draft.
	 */
	readonly draftRepoId?: string;
	/** Download format for the draft (GGUF quant like 'Q8_0', or 'mlx'). Must match the draft repo's contents. */
	readonly draftFormat?: string;
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
		catalogId: 'gemma4-e2b-gguf',
		displayName: 'Gemma 4 E2B',
		vendor: 'Google',
		blurb: 'Smallest Gemma 4 (edge-class ~2B effective); tool calling + vision. Runs on 8 GB.',
		repoId: 'unsloth/gemma-4-E2B-it-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.9 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
	},
	{
		catalogId: 'gemma4-e4b-gguf',
		displayName: 'Gemma 4 E4B',
		vendor: 'Google',
		blurb: 'Latest small Gemma (edge-class ~4B effective); tool calling + vision.',
		repoId: 'unsloth/gemma-4-E4B-it-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(3 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
	},
	// NOTE: No MLX twin for Gemma 4 E4B. It is a multimodal checkpoint (vision/audio towers, weights
	// prefixed `language_model.*`), which the text-only MLX engine (mlx-lm) cannot load - it errors with
	// "Received N parameters not in model" and the server hangs. The GGUF build above runs fine on
	// llama.cpp (text), so Apple Silicon users get Gemma 4 E4B via that entry. Re-add an MLX twin only
	// once a text-only MLX build (or mlx-vlm support) is available.
	{
		catalogId: 'gemma4-12b-gguf',
		displayName: 'Gemma 4 12B',
		vendor: 'Google',
		blurb: 'Latest mid-size Gemma; native audio, tools + vision. Fits 16 GB.',
		repoId: 'unsloth/gemma-4-12b-it-GGUF',
		supportsVision: true,
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
		supportsVision: true,
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
		supportsVision: true,
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
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(16 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
	},
	// NOTE: No MLX twin for Qwen3.6 27B - the MLX build (unsloth/Qwen3.6-27B-UD-MLX-4bit) is a multimodal
	// (image-text-to-text) checkpoint, which the text-only MLX engine (mlx-lm) cannot load. The GGUF build
	// above runs on llama.cpp instead.
	{
		catalogId: 'qwen36-35b-a3b-gguf',
		displayName: 'Qwen3.6 35B-A3B MoE',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Latest Qwen MoE: 35B total, ~3B active - fast and high quality.',
		repoId: 'unsloth/Qwen3.6-35B-A3B-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(20 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
	},
	// NOTE: No MLX twin for Qwen3.6 35B-A3B - the MLX build (unsloth/Qwen3.6-35B-A3B-UD-MLX-4bit) is a
	// multimodal (image-text-to-text) checkpoint that mlx-lm cannot load. Use the GGUF build above.

	// ---- Qwen 3.5 MTP (Alibaba) - GGUF builds with Multi-Token Prediction heads (llama.cpp --spec-type mtp) ----
	// NOTE on minRamGB/tier for MTP entries: these are sized for the BASE model (single weight copy), NOT the
	// doubled footprint MTP briefly needs. The current llama.cpp MTP path loads a second full weight copy for the
	// draft context, but the runner auto-drops MTP -> zero-memory n-gram drafting when that copy won't fit (see the
	// MTP fit gate in locopilotLocalModelRunner), so the model always RUNS at its base-model tier - it just skips the
	// MTP speedup on machines too small for the draft. So do NOT raise these to cover the doubling: that would falsely
	// mark a perfectly-runnable model 'too-big' and hide it from Auto. The runtime gate, not minRamGB, guards the OOM.
	{
		catalogId: 'qwen35-0_8b-mtp-gguf',
		displayName: 'Qwen3.5 0.8B (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Ultra-light MTP build; fastest speculative decoding for tiny tasks.',
		repoId: 'unsloth/Qwen3.5-0.8B-MTP-GGUF',
		supportsVision: true,
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
		supportsVision: true,
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
		supportsVision: true,
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
		supportsVision: true,
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
		supportsVision: true,
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
		supportsVision: true,
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
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(16 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		defaultHidden: true,
		contextWindow: 262144,
	},
	// NOTE: No MLX twin for DiffusionGemma - it is a diffusion (non-autoregressive) model that mlx-lm
	// cannot run. The experimental GGUF build above is the only entry.

	// ---- Qwen 3.6 MTP (Alibaba) - MTP heads for speculative decoding, hidden until tested ----
	{
		catalogId: 'qwen36-27b-mtp-gguf',
		displayName: 'Qwen3.6 27B (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Qwen3.6 27B dense coder with Multi-Token Prediction heads; faster decoding via llama.cpp speculative.',
		repoId: 'unsloth/Qwen3.6-27B-MTP-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(16 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		mtp: true,
		defaultHidden: true,
		contextWindow: 262144,
	},
	{
		catalogId: 'qwen36-35b-a3b-mtp-gguf',
		displayName: 'Qwen3.6 35B-A3B MoE (MTP)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Qwen3.6 MoE (35B total, ~3B active) with Multi-Token Prediction heads; faster decoding via llama.cpp speculative.',
		repoId: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(21 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		mtp: true,
		defaultHidden: true,
		contextWindow: 262144,
	},

	// =========================================================================================
	// June 2026 additions: cross-platform GGUF coder + extra current-gen small models.
	// =========================================================================================
	{
		catalogId: 'qwen3-coder-30b-a3b-gguf',
		displayName: 'Qwen3 Coder 30B-A3B',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Top MoE coder (30B total, ~3B active - fast); GGUF build runs on any platform via llama.cpp.',
		repoId: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(17 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
		// Qwen3 tokenizer family: the 0.6B sibling is the canonical draft (Q8_0 ~0.6 GB, ~50x size ratio).
		draftRepoId: 'unsloth/Qwen3-0.6B-GGUF',
		draftFormat: 'Q8_0',
	},
	{
		catalogId: 'granite-4_1-8b-gguf',
		displayName: 'Granite 4.1 8B',
		vendor: 'IBM',
		blurb: 'IBM Granite 4.1; strong tool-calling and enterprise tasks. Fits 16 GB.',
		repoId: 'unsloth/granite-4.1-8b-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(5 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 131072,
	},
	{
		catalogId: 'lfm2_5-8b-a1b-gguf',
		displayName: 'LFM2.5 8B-A1B MoE',
		vendor: 'Liquid AI',
		blurb: 'Liquid Foundation MoE (8B total, ~1B active) - very fast on modest hardware.',
		repoId: 'unsloth/LFM2.5-8B-A1B-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(5 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 131072,
	},
	{
		catalogId: 'gpt-oss-20b-gguf',
		displayName: 'GPT-OSS 20B',
		vendor: 'OpenAI',
		blurb: 'OpenAI open-weight 20B MoE (~3.6B active - fast); GGUF build runs on any platform via llama.cpp.',
		repoId: 'unsloth/gpt-oss-20b-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(11 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 131072,
	},

	// =========================================================================================
	// Proven prior generation (verified working). Keep or comment out as desired.
	// =========================================================================================

	// ---- Tier 1: 8 GB (entry, runs almost anywhere) ----
	// SUPERSEDED (commented out 2026-06): Qwen3 4B -> Qwen3.5 4B (MTP); Gemma 3 4B -> Gemma 4 E2B/E4B.
	// Uncomment to bring either back.
	/*
	{
		catalogId: 'qwen3-4b-gguf',
		displayName: 'Qwen3 4B',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Fast, capable tiny all-rounder; great first model on low-RAM machines.',
		repoId: 'unsloth/Qwen3-4B-GGUF',
		supportsVision: false,
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
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.6 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
	},
	*/
	{
		catalogId: 'phi4-mini-gguf',
		displayName: 'Phi-4 mini',
		vendor: 'Microsoft',
		blurb: 'Strong reasoning per byte; reliable always-works fallback.',
		repoId: 'unsloth/Phi-4-mini-instruct-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.5 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
	},

	// ---- Tier 2: 16 GB (sweet spot) ----
	// SUPERSEDED (commented out 2026-06): Qwen3 8B (GGUF + MLX) -> Qwen3.5 9B (MTP);
	// Gemma 3 12B -> Gemma 4 12B. Uncomment to bring any back. (DeepSeek R1 distill kept below.)
	/*
	{
		catalogId: 'qwen3-8b-gguf',
		displayName: 'Qwen3 8B',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Best small coder; the recommended default for 16 GB machines.',
		repoId: 'unsloth/Qwen3-8B-GGUF',
		supportsVision: false,
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
		supportsVision: false,
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
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(6.9 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 131072,
	},
	*/
	{
		catalogId: 'deepseek-r1-distill-14b-gguf',
		displayName: 'DeepSeek-R1 Distill 14B',
		vendor: 'DeepSeek',
		blurb: 'Reasoning-focused distill; strong step-by-step problem solving.',
		repoId: 'unsloth/DeepSeek-R1-Distill-Qwen-14B-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(9 * GB),
		minRamGB: 16,
		tier: '16 GB',
		useNativeTools: false,
		contextWindow: 131072,
		// Same distill family (Qwen2.5 tokenizer): the 1.5B distill drafts for the 14B/32B targets.
		draftRepoId: 'unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF',
		draftFormat: 'Q4_K_M',
	},

	// ---- Tier 3: 32 GB+ (power users) ----
	{
		catalogId: 'devstral-small-24b-gguf',
		displayName: 'Devstral Small 24B',
		vendor: 'Mistral',
		blurb: 'Best agentic/coding open model in its class.',
		repoId: 'bartowski/mistralai_Devstral-Small-2507-GGUF',
		supportsVision: true,
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
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(14 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 32768,
	},
	// SUPERSEDED (commented out 2026-06): Qwen3 32B (MLX) -> Qwen3.6 27B. Uncomment to restore.
	/*
	{
		catalogId: 'qwen3-32b-mlx',
		displayName: 'Qwen3 32B (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Top dense Qwen3 coder; Apple Silicon build, needs 32 GB+.',
		repoId: 'mlx-community/Qwen3-32B-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(18 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 32768,
	},
	*/
	{
		catalogId: 'deepseek-r1-distill-32b-gguf',
		displayName: 'DeepSeek-R1 Distill 32B',
		vendor: 'DeepSeek',
		blurb: 'Strongest distilled reasoner that still runs on a single machine.',
		repoId: 'unsloth/DeepSeek-R1-Distill-Qwen-32B-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(20 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		useNativeTools: false,
		contextWindow: 131072,
		draftRepoId: 'unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF',
		draftFormat: 'Q4_K_M',
	},

	// ---- Tier 4: prior-gen Qwen3 MoE (fast, only ~3B active) - both formats ----
	// SUPERSEDED (commented out 2026-06): Qwen3 30B-A3B (GGUF + MLX) -> Qwen3.6 35B-A3B (and MTP twin).
	// Uncomment to restore.
	/*
	{
		catalogId: 'qwen3-30b-a3b-gguf',
		displayName: 'Qwen3 30B-A3B MoE',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Mixture-of-experts: 30B total, ~3B active - punches above its speed/size.',
		repoId: 'unsloth/Qwen3-30B-A3B-GGUF',
		supportsVision: false,
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
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(17 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 32768,
	},
	*/
	{
		catalogId: 'gpt-oss-20b-mlx',
		displayName: 'GPT-OSS 20B (MLX)',
		vendor: 'OpenAI',
		blurb: 'OpenAI open-weight 20B (MXFP4) tuned for Apple Silicon via MLX.',
		repoId: 'mlx-community/gpt-oss-20b-MXFP4-Q8',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(12 * GB),
		minRamGB: 24,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 131072,
	},
	{
		catalogId: 'qwen3-coder-30b-a3b-mlx',
		displayName: 'Qwen3 Coder 30B-A3B (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Top MoE coder (30B total, ~3B active - fast) tuned for Apple Silicon via MLX.',
		repoId: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(17 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 262144,
		// Qwen3 tokenizer family: 0.6B MLX build drafts for the big coder via mlx-lm --draft-model.
		draftRepoId: 'mlx-community/Qwen3-0.6B-4bit',
		draftFormat: 'mlx',
	},

	// =========================================================================================
	// Tier 5: 64 GB+ (workstation-class). Models whose Q4 weights need ~45-60 GB; only seeded as a
	// comfortable pick once the machine has the RAM. Qwen3 Coder Next is the curated "Best for you"
	// here (see getRecommendedRepoId); GPT-OSS 120B is the heavier alternative, seeded hidden.
	// =========================================================================================
	{
		catalogId: 'qwen3-coder-next-gguf',
		displayName: 'Qwen3 Coder Next',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Flagship dense coder; top open-model quality for 64 GB+ workstations.',
		repoId: 'unsloth/Qwen3-Coder-Next-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(45 * GB),
		minRamGB: 64,
		tier: '64 GB+',
		contextWindow: 262144,
	},
	{
		catalogId: 'gpt-oss-120b-gguf',
		displayName: 'GPT-OSS 120B',
		vendor: 'OpenAI',
		blurb: 'OpenAI open-weight 120B MoE (~5B active); needs a 64 GB+ workstation.',
		repoId: 'unsloth/gpt-oss-120b-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(58.5 * GB),
		minRamGB: 64,
		tier: '64 GB+',
		defaultHidden: true,
		contextWindow: 131072,
	},

	// =========================================================================================
	// Dedicated code models (2026 additions): widen provider + size variety across RAM tiers.
	// Mistral Codestral (FIM autocomplete), DeepSeek-Coder-V2-Lite (light MoE), BigCode StarCoder2
	// ladder, plus Microsoft Phi-4 full and 01.AI Yi-Coder for extra provider coverage. Repo ids
	// verified as public HuggingFace GGUF repos.
	// =========================================================================================

	// ---- StarCoder2 (BigCode) - fully-open code models; 3B/7B are base completion (great for FIM) ----
	{
		catalogId: 'starcoder2-3b-gguf',
		displayName: 'StarCoder2 3B',
		vendor: 'BigCode',
		blurb: 'Tiny fully-open code model; strong fill-in-the-middle completion. Runs on 8 GB.',
		repoId: 'second-state/StarCoder2-3B-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(1.9 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 16384,
		defaultHidden: true,
	},
	{
		catalogId: 'starcoder2-7b-gguf',
		displayName: 'StarCoder2 7B',
		vendor: 'BigCode',
		blurb: 'Mid-size fully-open code model; base completion / FIM. Fits 16 GB.',
		repoId: 'second-state/StarCoder2-7B-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(4.3 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 16384,
		defaultHidden: true,
	},
	{
		catalogId: 'starcoder2-15b-instruct-gguf',
		displayName: 'StarCoder2 15B',
		vendor: 'BigCode',
		blurb: 'Self-aligned instruct code model, permissive & transparent pipeline; 600+ languages.',
		repoId: 'bartowski/starcoder2-15b-instruct-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(9.6 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 16384,
		defaultHidden: true,
	},

	// ---- DeepSeek-Coder-V2-Lite (DeepSeek) - 16B MoE, ~2.4B active: fast, low-RAM friendly ----
	{
		catalogId: 'deepseek-coder-v2-lite-gguf',
		displayName: 'DeepSeek-Coder-V2-Lite 16B MoE',
		vendor: 'DeepSeek',
		blurb: 'MoE coder (16B total, ~2.4B active - fast); strong code + FIM. Fits 16 GB.',
		repoId: 'bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(10.4 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 163840,
		defaultHidden: true,
	},

	// ---- Codestral 22B (Mistral) - best fill-in-the-middle / autocomplete; 80+ languages ----
	{
		catalogId: 'codestral-22b-gguf',
		displayName: 'Codestral 22B',
		vendor: 'Mistral',
		blurb: 'Purpose-built coder; best fill-in-the-middle autocomplete, 80+ languages.',
		repoId: 'bartowski/Codestral-22B-v0.1-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(13.3 * GB),
		minRamGB: 24,
		tier: '32 GB+',
		contextWindow: 32768,
		defaultHidden: true,
	},

	// ---- Phi-4 14B (Microsoft) - full model (you already ship the mini) ----
	{
		catalogId: 'phi-4-14b-gguf',
		displayName: 'Phi-4 14B',
		vendor: 'Microsoft',
		blurb: 'Microsoft Phi-4 (14B); strong reasoning + code for its size. Fits 16 GB.',
		repoId: 'unsloth/phi-4-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(9 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 16384,
		defaultHidden: true,
	},

	// ---- Yi-Coder 9B (01.AI) - extra provider variety; 128K context ----
	{
		catalogId: 'yi-coder-9b-chat-gguf',
		displayName: 'Yi-Coder 9B',
		vendor: '01.AI',
		blurb: 'Compact 01.AI coder with 128K context; good repo-level tasks. Fits 16 GB.',
		repoId: 'bartowski/Yi-Coder-9B-Chat-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(5 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 131072,
		defaultHidden: true,
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
		// Explicit per-entry vision flag (verified against each repo's HuggingFace pipeline_tag/tags). Text-only
		// models seed as false so image attach is gated; HF/Ollama enrichment and the toggle can still refine it.
		supportsVision: entry.supportsVision,
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
	// Current-generation Qwen line only (3.5 MTP + 3.6). The prior-gen `qwen3-4b-gguf` / `qwen3-8b-gguf`
	// are intentionally NOT here: they are superseded by Qwen3.5 4B/9B (MTP) and stay seeded hidden, so the
	// picker shows one clean generation with no duplicates. Users can still surface them via Show in My Models.
	'gemma4-12b-gguf',
	'qwen36-27b-gguf',
	'devstral-small-24b-gguf',
	'qwen35-0_8b-mtp-gguf',
	'qwen35-4b-mtp-gguf',
	'qwen35-9b-mtp-gguf',
	'qwen36-35b-a3b-gguf',
	'gemma4-e4b-gguf',
	// 32 GB+ tier: the curated "Best for you" pick (dedicated coder MoE), visible so it shows badged in the picker.
	'qwen3-coder-30b-a3b-gguf',
	// 64 GB+ tier: the curated "Best for you" pick, visible so workstation users see it badged in the picker.
	'qwen3-coder-next-gguf',
]);

/**
 * The smallest model we will ever pre-select: a tiny, fast, current-gen build that runs almost anywhere. Used
 * as the floor by {@link getDefaultPickerRepoId} and as the fallback when RAM is unknown.
 */
export const DEFAULT_PICKER_FLOOR_REPO_ID = 'unsloth/Qwen3.5-4B-MTP-GGUF';

/**
 * Repo id of the model pre-selected in the chat picker for first-time users, chosen CONSERVATIVELY for the
 * detected RAM: we pick a model one tier below what the machine could maximally handle, so the out-of-box
 * default never OOMs or crawls on a machine sitting at a tier's RAM minimum. The floor is Qwen3.5 4B (MTP).
 *
 * Seeded models store the catalog `repoId` as their `modelName`, so the provider matches on this to flag the
 * picker default. Once a user picks a different model their choice is persisted and wins over this default;
 * the recommended badge then makes the maximal pick one obvious click away.
 *
 * `ramGB <= 0` means RAM is not detected yet -> floor (safe everywhere).
 */
export function getDefaultPickerRepoId(ramGB: number): string {
	if (ramGB >= 64) {
		return 'unsloth/Qwen3.6-27B-GGUF'; // 32 GB-tier flagship on a 64 GB+ workstation: comfortable headroom.
	}
	if (ramGB >= 32) {
		return 'unsloth/gemma-4-12b-it-GGUF'; // 16 GB-tier model on a 32 GB+ machine: comfortable headroom.
	}
	// 16 GB and 8 GB machines (and unknown RAM) both land on the floor: tiny, fast, always-works.
	return DEFAULT_PICKER_FLOOR_REPO_ID;
}

/**
 * Repo id of the single "Best for you" model for the detected RAM tier: the most capable model that stays
 * COMFORTABLE in day-to-day use once the host editor (Electron) and OS overhead are accounted for. It is
 * deliberately one notch below the absolute largest model the tier could technically load - e.g. on 16 GB it
 * is Qwen3.5 9B (~5.5 GB Q4), NOT Gemma 4 12B (~7 GB), which loads but leaves little headroom for the editor
 * plus KV cache.
 *
 * Curated by hand (not derived from raw weight size) because "comfortable" depends on runtime + KV + editor
 * overhead that a size threshold can't capture cleanly across tiers. This is the SINGLE source of truth for
 * the "Best for you" badge, shared by the chat model picker and the model-list editor so the two always agree.
 *
 * Distinct from {@link getDefaultPickerRepoId}: that is the even-safer model AUTO-SELECTED on first run; this
 * is the recommended upgrade the badge points at. `ramGB <= 0` (RAM unknown) -> the safe small build.
 */
export function getRecommendedRepoId(ramGB: number): string {
	if (ramGB >= 64) {
		return 'unsloth/Qwen3-Coder-Next-GGUF'; // flagship dense coder (~45 GB Q4); comfortable on 64 GB+.
	}
	if (ramGB >= 32) {
		return 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF'; // dedicated coder MoE (~3B active - fast); comfortable on 32 GB+.
	}
	if (ramGB >= 16) {
		return 'unsloth/Qwen3.5-9B-MTP-GGUF'; // ~5.5 GB Q4; smooth on 16 GB alongside the editor.
	}
	return DEFAULT_PICKER_FLOOR_REPO_ID; // 8 GB / unknown: the tiny fast build is the comfortable best.
}

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
	if (ramGB >= 64) { return '64 GB+'; }
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

/**
 * The speculative-decoding draft pairing for a stored model, or undefined when its catalog entry has none.
 * Matched by repo id ALONE (not format): post-download enrichment rewrites a model's `format` from the
 * catalog quant (e.g. 'Q4_K_M') to the family ('gguf'), which would make the exact-format lookup miss.
 * When a repo appears in multiple entries, the first with a draft pairing wins (pairings are per-family,
 * so any twin entry's pairing is equally valid).
 */
export function findDraftPairing(repoId: string | undefined): { draftRepoId: string; draftFormat: string } | undefined {
	if (!repoId) {
		return undefined;
	}
	const entry = LOCOPILOT_DEFAULT_CATALOG.find(e => e.repoId === repoId && !!e.draftRepoId);
	return entry?.draftRepoId ? { draftRepoId: entry.draftRepoId, draftFormat: entry.draftFormat ?? '' } : undefined;
}

// ---- "Auto" model mode -------------------------------------------------------------------------------
//
// "Auto" is a picker mode (sentinel LOCOPILOT_AUTO_MODEL_ID, see customLanguageModelsService.ts), not a
// model. The helpers below turn it into a concrete choice:
//  - resolveAutoModel: which downloaded catalog model Auto uses for a request (aspirational - the most
//    capable model this machine's RAM tier supports; the live-RAM fit is deferred to the launch gate,
//    which the provider's Auto path steps down against, with a warm running server as a tie-breaker).
//  - getAutoStarterPicks: the labelled download suggestions shown in chat when NOTHING is downloaded yet.
// Scope is deliberately catalog llama.cpp/MLX models only - cloud, Ollama, and user-added local models are
// never auto-picked (they remain manually selectable).

/**
 * Find a catalog entry by repo id alone. Post-download enrichment rewrites a stored model's `format` from
 * the catalog quant ('Q4_K_M') to the family ('gguf'), so the exact repo+format lookup of
 * {@link findCatalogEntry} misses after enrichment; this loose variant is what Auto resolution uses.
 * GGUF and MLX builds live in different HF repos, so repo id alone is unambiguous for suitability data.
 */
export function findCatalogEntryByRepoId(repoId: string | undefined): ICatalogModel | undefined {
	return repoId ? LOCOPILOT_DEFAULT_CATALOG.find(e => e.repoId === repoId) : undefined;
}

/** MoE checkpoints ("35B-A3B") activate few parameters per token - fast for their quality, so Auto prefers them. */
function isMoEEntry(entry: ICatalogModel): boolean {
	return /-A\d+(\.\d+)?B/i.test(entry.repoId) || /\bMoE\b/i.test(entry.displayName);
}

/** A stored model is in Auto's candidate pool when it is a downloaded, visible catalog llama.cpp/MLX model. */
export function isAutoCandidate(model: ICustomLanguageModel): boolean {
	return model.type === 'local'
		&& model.provider === 'huggingface'
		&& !!model.localPath
		&& !model.isDownloading
		&& !model.hidden
		&& !!findCatalogEntryByRepoId(model.modelName);
}

/**
 * Resolve the Auto selection to a concrete downloaded model, or undefined when nothing qualifies (the
 * caller then shows the starter-picks download card).
 *
 * ASPIRATIONAL by design: Auto picks the most capable model this MACHINE can run - the highest catalog RAM
 * tier whose `minRamGB` fits total system RAM - NOT the biggest that fits a momentary free-RAM probe. The
 * live-RAM decision is deferred to the ONE place with ground truth: the launch gate (_memoryAllowsLaunch),
 * which credits reclaimable file cache / compression / eviction and only requires the non-reclaimable
 * working set to be physically free. Sizing Auto against the conservative available-RAM snapshot HERE used
 * to strand a 16 GB Mac on a tiny model even with nothing else running, because that snapshot excludes the
 * compressible/evictable memory a launch can reclaim. `minRamGB` already bakes in a comfortable-run headroom
 * band, so the tier ceiling is the safety margin at pick time; the launch gate + watchdog are the runtime net.
 *
 * Ranking among candidates that fit the hardware tier:
 *  1. Capability: the highest `minRamGB` tier wins.
 *  2. Stickiness: a currently-RUNNING model beats a bigger not-running rival (+200k clears the largest
 *     realistic tier gap, 8->64 = 56k), so re-resolving Auto never cold-swaps a warm model just to gain a tier.
 *  3. Ties: the curated "Best for you" repo, then architecture - MoE > MTP > MLX > plain GGUF.
 *
 * `maxSizeBytesExclusive` (optional): a STEP-DOWN ceiling. When set, only models strictly smaller than it are
 * considered. The caller (see the provider's Auto path) lowers it to the size of a pick that failed the launch
 * gate and re-resolves to get the next-smaller candidate, so a momentarily busy machine gets a smaller model
 * instead of a hard fit failure. RAM unknown (`ramGB <= 0`) restricts to the 8 GB tier.
 */
export function resolveAutoModel(
	models: readonly ICustomLanguageModel[],
	ramGB: number,
	isServerActive: (modelId: string) => boolean,
	maxSizeBytesExclusive?: number
): ICustomLanguageModel | undefined {
	const candidates = models.filter(isAutoCandidate);
	if (candidates.length === 0) {
		return undefined;
	}

	const effectiveRam = ramGB > 0 ? ramGB : 8;
	const recommendedRepoId = getRecommendedRepoId(ramGB);

	interface IScored { model: ICustomLanguageModel; score: number }
	const scored: IScored[] = [];
	for (const model of candidates) {
		const entry = findCatalogEntryByRepoId(model.modelName)!;
		if (entry.minRamGB > effectiveRam) {
			continue; // bigger than this machine's TOTAL RAM tier - never auto-picked.
		}
		if (maxSizeBytesExclusive !== undefined && entry.approxSizeBytes >= maxSizeBytesExclusive) {
			continue; // step-down: this pick (or a bigger one) already failed the launch gate this pass.
		}
		const running = isServerActive(model.id);

		let score = entry.minRamGB * 1000; // capability: the highest RAM tier the hardware supports.
		if (running) {
			// Stickiness: keep a warm model over a bigger cold rival so re-resolving Auto doesn't cold-swap.
			score += 200_000;
		}
		if (entry.repoId === recommendedRepoId) {
			score += 500; // the curated "Best for you" pick wins its tier.
		}
		if (isMoEEntry(entry)) {
			score += 300;
		} else if (entry.mtp || model.mtp) {
			score += 200;
		} else if (entry.engine === 'mlx') {
			score += 100;
		}
		if (entry.recommended) {
			score += 50;
		}
		scored.push({ model, score });
	}
	if (scored.length === 0) {
		return undefined;
	}
	return scored.reduce((best, s) => s.score > best.score ? s : best).model;
}

export type AutoStarterSlot = 'best' | 'balanced' | 'fast';

export interface IAutoStarterPick {
	readonly slot: AutoStarterSlot;
	/** Short user-facing slot title, e.g. "Best for your system". */
	readonly title: string;
	/** One-line reason shown under the title so the user knows which to download. */
	readonly reason: string;
	readonly entry: ICatalogModel;
}

/** The "Fastest" starter pick: smallest current-gen build, snappy on any machine. */
const AUTO_FAST_REPO_ID = 'unsloth/Qwen3.5-2B-MTP-GGUF';

/**
 * The up-to-three labelled download suggestions Auto offers in chat when the user has no local model yet:
 * best = the curated "Best for you" for the RAM tier, balanced = the conservative first-run default
 * ({@link getDefaultPickerRepoId}, one tier below max), fast = the smallest current-gen build. Slots that
 * collapse to the same repo on small machines are deduped (first slot wins), so 8 GB users may see two.
 */
export function getAutoStarterPicks(ramGB: number): IAutoStarterPick[] {
	const slots: { slot: AutoStarterSlot; title: string; reason: string; repoId: string }[] = [
		{
			slot: 'best',
			title: 'Best for your system',
			reason: 'Highest quality that runs comfortably on your hardware.',
			repoId: getRecommendedRepoId(ramGB),
		},
		{
			slot: 'balanced',
			title: 'Balanced',
			reason: 'Good quality with extra headroom - a safe everyday default.',
			repoId: getDefaultPickerRepoId(ramGB),
		},
		{
			slot: 'fast',
			title: 'Fastest',
			reason: 'Quickest replies for simple edits and questions.',
			repoId: AUTO_FAST_REPO_ID,
		},
	];
	const picks: IAutoStarterPick[] = [];
	const seen = new Set<string>();
	for (const s of slots) {
		if (seen.has(s.repoId)) {
			continue;
		}
		// Prefer the GGUF build for suggestions (MLX twins are separate repos and stay available in the list).
		const entry = LOCOPILOT_DEFAULT_CATALOG.find(e => e.repoId === s.repoId && e.engine === 'gguf')
			?? findCatalogEntryByRepoId(s.repoId);
		if (!entry) {
			continue;
		}
		seen.add(s.repoId);
		picks.push({ slot: s.slot, title: s.title, reason: s.reason, entry });
	}
	return picks;
}
