/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICustomLanguageModel, ICustomLanguageModelsService } from '../common/customLanguageModelsService.js';
import {
	metalOffloadBudgetBytes,
	usableSystemMemoryBytes,
	discreteVramBudgetBytes,
	kvPlanBytesPerElem,
	kvCacheBytesPerElem,
	DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16,
	RUNTIME_OVERHEAD_BYTES,
} from './locopilotLlamaCppServer.js';

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

	// ---- Gemma 4 (Google) - QAT builds ----
	// All five entries below point at Google's QAT (Quantization-Aware Training) GGUFs rather than the
	// regular post-training-quantized ones. QAT simulates 4-bit rounding DURING the final training run, so
	// the int4 weights keep far more of the BF16 quality than rounding BF16 down afterwards does - and they
	// come out SMALLER too (fewer tensors need a high-precision fallback), 6-16% off each download.
	//
	// `format: 'Q4_K_XL'` is REQUIRED, not a preference: the QAT repos ship no `Q4_K_M` file at all. With the
	// old 'Q4_K_M' the format filter would miss, fall through GGUF_QUANT_PRIORITY, and land on a `Q8_0`-tagged
	// MTP draft head. (That trap is now also blocked at the source by isMtpGgufPath in the download service.)
	//
	// TRADE-OFF, deliberate: these repos are effectively single-quant (12B/26B/31B ship exactly one weight
	// file; E2B/E4B add only a UD-Q2_K_XL). That disables the two-way hardware-aware quant sizing - a 64 GB
	// machine can no longer be upgraded to Q8_0, a tight one can't be downgraded to Q3. We trade adaptive
	// sizing for better quality at one fixed, smaller size.
	{
		catalogId: 'gemma4-e2b-gguf',
		displayName: 'Gemma 4 E2B',
		vendor: 'Google',
		blurb: 'Smallest Gemma 4 (edge-class ~2B effective); tool calling + vision. Runs on 8 GB.',
		repoId: 'unsloth/gemma-4-E2B-it-qat-GGUF',
		supportsVision: true,
		format: 'Q4_K_XL',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.44 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
	},
	{
		catalogId: 'gemma4-e4b-gguf',
		displayName: 'Gemma 4 E4B',
		vendor: 'Google',
		blurb: 'Latest small Gemma (edge-class ~4B effective); tool calling + vision.',
		repoId: 'unsloth/gemma-4-E4B-it-qat-GGUF',
		supportsVision: true,
		format: 'Q4_K_XL',
		engine: 'gguf',
		approxSizeBytes: Math.round(3.93 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
	},
	// RESOLVED 2026-07: Gemma 4 E4B now HAS an MLX twin (`gemma4-e4b-mlx`, at the bottom of this file).
	// The old note here said mlx-lm could not load it; that stopped being true once mlx-lm gained a
	// `gemma4` module - it loads the language tower and ignores the vision one. Only the *12B* and the
	// QAT builds remain unloadable, because those report `model_type: gemma4_unified`.
	{
		catalogId: 'gemma4-12b-gguf',
		displayName: 'Gemma 4 12B',
		vendor: 'Google',
		blurb: 'Latest mid-size Gemma; native audio, tools + vision. Fits 16 GB.',
		repoId: 'unsloth/gemma-4-12b-it-qat-GGUF',
		supportsVision: true,
		format: 'Q4_K_XL',
		engine: 'gguf',
		approxSizeBytes: Math.round(6.26 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 262144,
	},
	{
		catalogId: 'gemma4-26b-a4b-gguf',
		displayName: 'Gemma 4 26B-A4B MoE',
		vendor: 'Google',
		blurb: 'Mixture-of-experts Gemma 4: 26B total, ~4B active - fast for its quality.',
		repoId: 'unsloth/gemma-4-26B-A4B-it-qat-GGUF',
		supportsVision: true,
		format: 'Q4_K_XL',
		engine: 'gguf',
		approxSizeBytes: Math.round(13.27 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
	},
	{
		catalogId: 'gemma4-31b-gguf',
		displayName: 'Gemma 4 31B',
		vendor: 'Google',
		blurb: 'Largest dense Gemma 4; top quality for 32 GB+ machines.',
		repoId: 'unsloth/gemma-4-31B-it-qat-GGUF',
		supportsVision: true,
		format: 'Q4_K_XL',
		engine: 'gguf',
		approxSizeBytes: Math.round(16.1 * GB),
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
	// RESOLVED 2026-07: Qwen3.6 27B now HAS an MLX twin (`qwen36-27b-mlx`, at the bottom of this file),
	// using the mlx-community 4bit build. The old note assumed the multimodal checkpoint was unloadable;
	// mlx-lm dispatches on `model_type` (`qwen3_5`, present since 0.31.x) and loads the text tower.
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
	// RESOLVED 2026-07: Qwen3.6 35B-A3B now HAS an MLX twin (`qwen36-35b-a3b-mlx`, bottom of this file).
	// Same correction as the 27B above: `model_type: qwen3_5_moe` is supported by the bundled mlx-lm.

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
		// Unhidden 2026-07: at ~1.42M downloads this is the most-pulled repo in the whole catalog, and
		// it is strictly the faster way to run Qwen3.6 27B (embedded MTP draft head). Surfaced via
		// DEFAULT_VISIBLE_CATALOG_IDS below rather than left behind Show in "My Models".
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
	// REMOVED (2026-07): DeepSeek-R1 Distill 14B/32B (+ their 1.5B draft pairing). Both shipped with
	// `useNativeTools: false` - they cannot call tools, which is the core loop of this editor - and their
	// reasoning is superseded by Qwen3.5 9B/27B (MTP), which reason AND call tools at the same tier.

	// ---- Tier 3: 32 GB+ (power users) ----
	// SUPERSEDED (commented out 2026-07): Devstral Small 2507 -> Devstral Small 2 (2512). Uncomment to restore.
	/*
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
	*/
	{
		catalogId: 'devstral-small-2-24b-gguf',
		displayName: 'Devstral Small 2 24B',
		vendor: 'Mistral',
		blurb: 'Latest agentic coder (68% SWE-bench); tools + vision. Fits 32 GB.',
		repoId: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(14.3 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
	},
	// REMOVED (2026-07): Mistral Small 24B Instruct 2501 (Jan 2025, 32K ctx) - Devstral Small 2 24B above is
	// the same size from the same vendor with 262K context and a newer training run.
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
	// July 2026 additions: Devstral Small 2 (above), Ministral 3 edge ladder, Nemotron 3 Nano-Omni.
	// Repo ids verified as public HuggingFace GGUF repos (Unsloth Q4_K_M / UD-Q4_K_M).
	// =========================================================================================

	// ---- Ministral 3 Instruct (Mistral) - multimodal edge models; 3B/8B/14B ----
	{
		catalogId: 'ministral-3-3b-gguf',
		displayName: 'Ministral 3 3B',
		vendor: 'Mistral',
		blurb: 'Tiny multimodal Ministral; tools + vision on 8 GB.',
		repoId: 'unsloth/Ministral-3-3B-Instruct-2512-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.1 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 262144,
		defaultHidden: true,
	},
	{
		catalogId: 'ministral-3-8b-gguf',
		displayName: 'Ministral 3 8B',
		vendor: 'Mistral',
		blurb: 'Edge multimodal Ministral; strong tools + vision for 16 GB.',
		repoId: 'unsloth/Ministral-3-8B-Instruct-2512-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(5.2 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 262144,
		defaultHidden: true,
	},
	{
		catalogId: 'ministral-3-14b-gguf',
		displayName: 'Ministral 3 14B',
		vendor: 'Mistral',
		blurb: 'Largest Ministral 3 Instruct; multimodal tools + vision. Fits 16 GB.',
		repoId: 'unsloth/Ministral-3-14B-Instruct-2512-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(8.2 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 262144,
		defaultHidden: true,
	},

	// ---- Nemotron 3 Nano-Omni (NVIDIA) - 30B/~3B MoE multimodal reasoner ----
	{
		catalogId: 'nemotron-3-nano-omni-30b-a3b-gguf',
		displayName: 'Nemotron 3 Nano-Omni 30B-A3B',
		vendor: 'NVIDIA',
		blurb: 'NVIDIA MoE (30B total, ~3B active); multimodal agentic reasoning. Fits 32 GB.',
		repoId: 'unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(23.9 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 32768,
		defaultHidden: true,
	},

	// ---- GLM-4.7-Flash (Zhipu) - ~30B MoE / ~3.6B active; strong coding, fast ----
	{
		catalogId: 'glm-4_7-flash-gguf',
		displayName: 'GLM-4.7-Flash',
		vendor: 'Zhipu (GLM)',
		blurb: 'Fast coding MoE (~30B total, ~3.6B active). Fits 32 GB.',
		repoId: 'unsloth/GLM-4.7-Flash-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(18.3 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 202752,
		defaultHidden: true,
	},

	// =========================================================================================
	// REMOVED (2026-07): the "dedicated code models" block that used to sit here - BigCode StarCoder2
	// 3B/7B/15B (Mar 2024, 16K ctx), DeepSeek-Coder-V2-Lite (Jun 2024), Mistral Codestral 22B v0.1
	// (Jun 2024, non-commercial MNPL), Microsoft Phi-4 14B (Jan 2025, 16K ctx) and 01.AI Yi-Coder 9B
	// (Sep 2024). All were 2024/early-2025 checkpoints whose upstreams have shipped no successor; each
	// is beaten at its own size by a current-gen entry above (Qwen3.5 2B/4B/9B MTP, Ornith 1.0 9B/35B,
	// Devstral Small 2 24B, GLM-4.7-Flash). Phi-4 *mini* is deliberately KEPT above as the universal
	// 8 GB fallback - nothing else in the catalog fills that "always works anywhere" role.
	// =========================================================================================

	// =========================================================================================
	// July 2026 additions. Repo ids, on-disk Q4 sizes, context windows and licenses verified against
	// the HuggingFace API. Every entry ships a plain or UD- `Q4_K_M` weight file, so `format: 'Q4_K_M'`
	// resolves via pickBestGGUFFile's substring match (a repo with only `Q4_K_XL` would NOT - it would
	// fall through the quant priority list, so do not copy this format onto a QAT-style repo).
	// =========================================================================================

	// ---- Ornith 1.0 (DeepReinforce) - MIT-licensed agentic coders that learn their own RL scaffold ----
	{
		catalogId: 'ornith-1_0-9b-gguf',
		displayName: 'Ornith 1.0 9B',
		vendor: 'DeepReinforce',
		blurb: 'Agentic coder punching far above 9B (69.4 SWE-bench Verified); MIT. Best pick for 16 GB.',
		repoId: 'unsloth/Ornith-1.0-9B-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(5.31 * GB),
		minRamGB: 16,
		tier: '16 GB',
		contextWindow: 262144,
	},
	{
		catalogId: 'ornith-1_0-35b-gguf',
		displayName: 'Ornith 1.0 35B MoE',
		vendor: 'DeepReinforce',
		blurb: 'MoE agentic coder; 64.2 Terminal-Bench 2.1, ahead of far larger models. MIT.',
		repoId: 'unsloth/Ornith-1.0-35B-GGUF',
		supportsVision: true,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(20.61 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
	},

	// ---- North Mini Code 1.0 (Cohere) - dedicated coder MoE with a 500K window ----
	{
		catalogId: 'north-mini-code-1_0-gguf',
		displayName: 'North Mini Code 1.0',
		vendor: 'Cohere',
		blurb: 'Cohere coder MoE with a 500K context window; Apache 2.0. Fits 32 GB.',
		repoId: 'unsloth/North-Mini-Code-1.0-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(17.88 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 500000,
		defaultHidden: true,
	},

	// ---- Laguna XS 2.1 (poolside) - coder-first model, OpenMDW license ----
	{
		catalogId: 'laguna-xs-2_1-gguf',
		displayName: 'Laguna XS 2.1',
		vendor: 'poolside',
		blurb: 'Coding-first model from poolside; 262K context. Fits 32 GB.',
		repoId: 'poolside/Laguna-XS-2.1-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(18.88 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 262144,
		defaultHidden: true,
	},

	// ---- Granite 4.1 ladder (IBM) - 3B and 30B siblings of the 8B already seeded above ----
	{
		catalogId: 'granite-4_1-3b-gguf',
		displayName: 'Granite 4.1 3B',
		vendor: 'IBM',
		blurb: 'Tiny IBM Granite; solid tool-calling in under 2 GB. Runs on 8 GB.',
		repoId: 'unsloth/granite-4.1-3b-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(1.96 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 131072,
		defaultHidden: true,
	},
	{
		catalogId: 'granite-4_1-30b-gguf',
		displayName: 'Granite 4.1 30B',
		vendor: 'IBM',
		blurb: 'Largest IBM Granite 4.1; enterprise tasks + tool calling. Fits 32 GB.',
		repoId: 'unsloth/granite-4.1-30b-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(16.29 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		contextWindow: 131072,
		defaultHidden: true,
	},

	// ---- Nemotron 3 Nano 4B (NVIDIA) - small text-only sibling of the Nano-Omni entry above ----
	{
		catalogId: 'nemotron-3-nano-4b-gguf',
		displayName: 'Nemotron 3 Nano 4B',
		vendor: 'NVIDIA',
		blurb: 'Compact NVIDIA reasoner (hybrid Mamba-Transformer); 262K context. Runs on 8 GB.',
		repoId: 'unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF',
		supportsVision: false,
		format: 'Q4_K_M',
		engine: 'gguf',
		approxSizeBytes: Math.round(2.7 * GB),
		minRamGB: 8,
		tier: '8 GB',
		contextWindow: 262144,
		defaultHidden: true,
	},

	// =========================================================================================
	// Apple Silicon (MLX) twins, July 2026. Before this block the ONLY MLX entries were the two
	// 32 GB+ ones above, so every 8/16 GB Apple Silicon machine - i.e. most MacBook Airs - silently
	// fell back to llama.cpp and lost the MLX speedup. These fill the 8 GB and 16 GB rungs.
	//
	// SUPPORT WAS VERIFIED, NOT ASSUMED: mlx-lm dispatches on config.json `model_type` (via
	// mlx_lm.utils.MODEL_REMAPPING -> `mlx_lm.models.<type>`), NOT on `architectures`. Every entry
	// below resolves to a module present in the bundled mlx-lm (0.31.3): `qwen3_5`, `qwen3_5_moe`,
	// `gemma4`, `granite`, `glm4_moe_lite`. That is why the "no MLX twin, mlx-lm cannot load it"
	// notes further up are obsolete for Qwen3.6 and Gemma 4 - they predate those modules.
	//
	// DELIBERATELY ABSENT (checked, and they genuinely fail):
	//  - Gemma 4 *12B* MLX and every Gemma 4 *QAT* MLX build -> `model_type: gemma4_unified`, which
	//    mlx-lm 0.31.3 has no module for ("Model type gemma4_unified not supported"). Note 26B/31B
	//    are plain `gemma4` and would work; only 12B and the QAT line are unified builds.
	//  - North Mini Code 1.0 MLX -> `cohere2_moe`, likewise absent. It stays GGUF-only above.
	//
	// mlx-lm is a TEXT-only engine: it loads the language tower and ignores the vision one, so these
	// carry supportsVision: false even where the checkpoint itself is multimodal.
	//
	// Draft pairing: every `qwen3_5*` entry here shares one tokenizer (vocab_size 248320, verified
	// across all six repos), so Qwen3.5 0.8B (0.61 GB) is a safe `--draft-model` for them. It is
	// paired only where the target/draft size ratio clears ~8x - below that the doc comment on
	// draftRepoId says the speedup stops paying for the RAM, which is why 4B has no pairing.
	// =========================================================================================

	// ---- 8 GB tier ----
	{
		catalogId: 'qwen35-4b-mlx',
		displayName: 'Qwen3.5 4B (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'The picker-floor model tuned for Apple Silicon via MLX - fastest small option on M-series.',
		repoId: 'mlx-community/Qwen3.5-4B-MLX-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(2.85 * GB),
		minRamGB: 8,
		tier: '8 GB',
		requiresAppleSilicon: true,
		contextWindow: 262144,
	},
	{
		catalogId: 'gemma4-e4b-mlx',
		displayName: 'Gemma 4 E4B (MLX)',
		vendor: 'Google',
		blurb: 'Latest small Gemma tuned for Apple Silicon via MLX (text-only build).',
		repoId: 'mlx-community/gemma-4-e4b-it-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		// 4.82 GB of weights is a tight-but-runnable fit on an 8 GB Mac (its GGUF twin is 3.0 GB). Kept at
		// the twin's tier on purpose: the launch fit gate and OOM ladder are what guard this case, and
		// raising minRamGB would falsely mark a runnable model 'too-big' and hide it from Auto.
		approxSizeBytes: Math.round(4.82 * GB),
		minRamGB: 8,
		tier: '8 GB',
		requiresAppleSilicon: true,
		contextWindow: 131072,
	},

	// ---- 16 GB tier ----
	{
		catalogId: 'ornith-1_0-9b-mlx',
		displayName: 'Ornith 1.0 9B (MLX)',
		vendor: 'DeepReinforce',
		blurb: 'Best 16 GB coder, tuned for Apple Silicon via MLX - 30-50% faster on M-series chips.',
		repoId: 'mlx-community/Ornith-1.0-9B-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(5.57 * GB),
		minRamGB: 16,
		tier: '16 GB',
		requiresAppleSilicon: true,
		contextWindow: 262144,
		draftRepoId: 'mlx-community/Qwen3.5-0.8B-MLX-4bit',
		draftFormat: 'mlx',
	},
	{
		catalogId: 'qwen35-9b-mlx',
		displayName: 'Qwen3.5 9B (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'The 16 GB recommended model tuned for Apple Silicon via MLX.',
		repoId: 'mlx-community/Qwen3.5-9B-MLX-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(5.57 * GB),
		minRamGB: 16,
		tier: '16 GB',
		requiresAppleSilicon: true,
		contextWindow: 262144,
		draftRepoId: 'mlx-community/Qwen3.5-0.8B-MLX-4bit',
		draftFormat: 'mlx',
	},
	{
		catalogId: 'granite-4_1-8b-mlx',
		displayName: 'Granite 4.1 8B (MLX)',
		vendor: 'IBM',
		blurb: 'IBM Granite 4.1 tuned for Apple Silicon via MLX; strong tool calling.',
		repoId: 'mlx-community/granite-4.1-8b-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(4.89 * GB),
		minRamGB: 16,
		tier: '16 GB',
		requiresAppleSilicon: true,
		contextWindow: 131072,
		defaultHidden: true,
	},

	// ---- 32 GB+ tier ----
	{
		catalogId: 'qwen36-27b-mlx',
		displayName: 'Qwen3.6 27B (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Latest top dense coder tuned for Apple Silicon via MLX.',
		repoId: 'mlx-community/Qwen3.6-27B-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(14.98 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 262144,
		draftRepoId: 'mlx-community/Qwen3.5-0.8B-MLX-4bit',
		draftFormat: 'mlx',
	},
	{
		catalogId: 'qwen36-35b-a3b-mlx',
		displayName: 'Qwen3.6 35B-A3B MoE (MLX)',
		vendor: 'Alibaba (Qwen)',
		blurb: 'Latest Qwen MoE (~3B active - fast) tuned for Apple Silicon via MLX.',
		repoId: 'mlx-community/Qwen3.6-35B-A3B-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(19.03 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 262144,
		draftRepoId: 'mlx-community/Qwen3.5-0.8B-MLX-4bit',
		draftFormat: 'mlx',
	},
	{
		catalogId: 'glm-4_7-flash-mlx',
		displayName: 'GLM-4.7-Flash (MLX)',
		vendor: 'Zhipu (GLM)',
		blurb: 'Fast coding MoE tuned for Apple Silicon via MLX.',
		repoId: 'mlx-community/GLM-4.7-Flash-4bit',
		supportsVision: false,
		format: 'mlx',
		engine: 'mlx',
		approxSizeBytes: Math.round(15.71 * GB),
		minRamGB: 32,
		tier: '32 GB+',
		requiresAppleSilicon: true,
		contextWindow: 202752,
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
	'devstral-small-2-24b-gguf',
	'qwen35-0_8b-mtp-gguf',
	'qwen35-4b-mtp-gguf',
	'qwen35-9b-mtp-gguf',
	'qwen36-35b-a3b-gguf',
	'gemma4-e4b-gguf',
	// 16 GB tier: the strongest coder that fits there (69.4 SWE-bench Verified at 5.3 GB Q4), so it is
	// visible rather than buried behind Show - a hidden entry is effectively an entry nobody finds.
	'ornith-1_0-9b-gguf',
	// The catalog's most-downloaded repo (~1.42M): Qwen3.6 27B with MTP speculative decoding.
	'qwen36-27b-mtp-gguf',
	// Apple Silicon: one MLX pick per tier so an M-series machine always sees a native-engine option
	// in the picker (the rest of the MLX set is seeded hidden and surfaced via Show).
	'qwen35-4b-mlx',
	'gemma4-e4b-mlx',
	'ornith-1_0-9b-mlx',
	'qwen35-9b-mlx',
	'qwen36-27b-mlx',
	'qwen36-35b-a3b-mlx',
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
		// 16 GB-tier model on a 32 GB+ machine: comfortable headroom. Must track the catalog entry's repoId
		// exactly (the provider matches on it to flag the picker default), so this moved to the QAT repo
		// along with the entry itself.
		return 'unsloth/gemma-4-12b-it-qat-GGUF';
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
export function getRecommendedRepoId(ramGB: number, profile?: IHardwareProfile): string {
	const curated = curatedRecommendedRepoId(ramGB);
	if (!profile || !(profile.totalRamBytes > 0)) {
		return curated; // no hardware detail yet - the curated tier pick is the best guess we have.
	}
	const budget = inferenceBudgetBytes(profile);
	if (!(budget > 0)) {
		return curated;
	}
	// Does the curated pick actually run WELL here? The tier switch only knows total RAM, which is the wrong
	// number on three common machines: a Mac (Metal wires ~66-75% of RAM), a PC with a discrete card (bounded by
	// VRAM, and past it the driver OOMs rather than paging), and a CPU-only box (holds the weights, decodes far
	// too slowly to be "best"). So verify the curated entry against the real budget and fall back to a ranked
	// search when it does not clear the comfort bar.
	// Walk the curated ladder DOWN from this machine's tier and take the first pick that genuinely runs
	// comfortably here. Every rung is a hand-chosen, coder-oriented model, so descending the ladder keeps that
	// judgement intact - which a size-ranked search does not: scored purely on bytes, a large general-purpose
	// model outranks a smaller dedicated coder that is far better for this product's actual job.
	for (const repoId of CURATED_RECOMMENDATION_LADDER) {
		if (curatedRank(repoId) < curatedRank(curated)) {
			continue; // above this machine's tier - never recommend upward
		}
		const entry = LOCOPILOT_DEFAULT_CATALOG.find(e => e.repoId === repoId && e.engine === 'gguf')
			?? findCatalogEntryByRepoId(repoId);
		if (entry && recommendationScore(entry, budget, profile) > 0
			&& estimateCatalogContextTokens(entry, budget) >= AUTO_COMFORT_CONTEXT) {
			return repoId;
		}
	}
	// No curated pick clears the comfort bar (an unusual machine - tiny VRAM, CPU-only, or a raised Metal
	// limit). Fall back to the widest catalog search so the badge still points somewhere runnable.
	const ranked = rankRecommendations(budget, profile);
	return ranked[0]?.repoId ?? curated;
}

/**
 * The curated "Best for you" picks, most capable first - the ladder {@link getRecommendedRepoId} descends when
 * a machine cannot comfortably run its nominal tier's pick. Every entry is chosen for coding work specifically
 * (dedicated coders, then the strong general models), which is the judgement a size-based ranking loses.
 */
const CURATED_RECOMMENDATION_LADDER: readonly string[] = [
	'unsloth/Qwen3-Coder-Next-GGUF',                    // 64 GB+ tier
	'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',        // 32 GB+ tier
	'unsloth/Qwen3.5-9B-MTP-GGUF',                      // 16 GB tier
	DEFAULT_PICKER_FLOOR_REPO_ID,                       // 8 GB tier / floor
];

/** Position of a repo on the curated ladder; unknown ids sort to the bottom so they never block a descent. */
function curatedRank(repoId: string): number {
	const i = CURATED_RECOMMENDATION_LADDER.indexOf(repoId);
	return i < 0 ? CURATED_RECOMMENDATION_LADDER.length : i;
}

/** The hand-curated pick per RAM tier - quality judgements (coder-tuned, MoE speed) that sizing can't derive.
 * Kept as the PREFERENCE, applied only once the hardware check above confirms it runs comfortably here. */
function curatedRecommendedRepoId(ramGB: number): string {
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

/**
 * Weight (billions of ACTIVE parameters) above which a dense model is too slow to recommend on a CPU-only
 * machine. MoE checkpoints activate a fraction of their weights per token, so they are judged on that fraction
 * instead. Memory-fit alone would happily recommend a 30B dense model to a 32 GB CPU box that decodes it at
 * single-digit tokens/second - runnable, but not anyone's "best".
 */
export const CPU_ONLY_MAX_ACTIVE_PARAMS_B = 9;

/** Active parameters (billions) per token: the "A<n>B" tag for MoE checkpoints, else the full param count. */
export function activeParamsBillions(entry: ICatalogModel): number | undefined {
	const active = /-A(\d+(?:\.\d+)?)B/i.exec(entry.repoId) ?? /\bA(\d+(?:\.\d+)?)B\b/i.exec(entry.displayName);
	if (active) {
		return parseFloat(active[1]);
	}
	return modelParamsBillionsFromName(entry.displayName) ?? modelParamsBillionsFromName(entry.repoId);
}

/**
 * How good a recommendation this entry is for the given machine. `0` = not recommendable at all (won't reach a
 * usable window here, or is too slow for this backend); higher is better. Ranking is by achievable CONTEXT
 * first, then curated quality signals - the same "runs well, not merely loads" bar the launch planner enforces.
 */
function recommendationScore(entry: ICatalogModel, budgetBytes: number, profile: IHardwareProfile): number {
	if (entry.requiresAppleSilicon && !profile.isAppleSilicon) {
		return 0;
	}
	const context = estimateCatalogContextTokens(entry, budgetBytes);
	if (context <= 0) {
		return 0; // cannot even reach the usability floor on this hardware
	}
	if (isCpuOnlyProfile(profile)) {
		const active = activeParamsBillions(entry);
		if (active !== undefined && active > CPU_ONLY_MAX_ACTIVE_PARAMS_B) {
			return 0; // fits memory, decodes too slowly to call "best"
		}
	}
	// Service level dominates: a comfortable window beats a bigger model stuck at the floor.
	let score = (context >= AUTO_COMFORT_CONTEXT ? 2 : 1) * 1_000_000;
	// Within a service level, prefer the more capable model - approximated by its published weight size, which
	// is what the curated tiers already track.
	score += Math.min(999, Math.round(entry.approxSizeBytes / GB)) * 1000;
	if (entry.recommended) {
		score += 500;
	}
	if (isMoEEntry(entry)) {
		score += 300; // few active params per token: the best quality-per-second on any backend.
	} else if (entry.mtp) {
		score += 200;
	}
	if (entry.engine === 'mlx' && profile.isAppleSilicon) {
		score += 100;
	}
	return score;
}

/**
 * Every catalog entry that is a defensible recommendation for this machine, best first. Exported so callers
 * can offer a runner-up (and so the ranking is testable); {@link getRecommendedRepoId} takes the head.
 */
export function rankRecommendations(budgetBytes: number, profile: IHardwareProfile): ICatalogModel[] {
	return LOCOPILOT_DEFAULT_CATALOG
		.map(entry => ({ entry, score: recommendationScore(entry, budgetBytes, profile) }))
		.filter(s => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.map(s => s.entry);
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

/**
 * The catalog entry behind a STORED model, tolerant of the format rewrite a download performs.
 *
 * {@link findCatalogEntry} matches repoId + exact format, which only works BEFORE a download: post-download
 * enrichment replaces the stored format with the detected family (`detectFormatFamily`), so a GGUF entry
 * seeded as `Q4_K_M` becomes `gguf` and the exact match silently misses. Every hardware-fit signal keyed off
 * that lookup then degrades to "unknown" the moment a model is downloaded - which is how a too-big model
 * stopped being grouped as oversized and lost its "Needs N GB RAM" chip exactly when it mattered most.
 * (The download-time quant picker widens the gap further: it may store a quant the catalog never named.)
 *
 * Resolution order, most specific first:
 *  1. exact repoId + format (an un-downloaded seed, or MLX where the family name IS the format);
 *  2. repoId + the ENGINE implied by the stored format family, so a repo offering both builds resolves to the
 *     one actually downloaded;
 *  3. repoId alone.
 */
export function findCatalogEntryForStoredModel(repoId: string | undefined, format: string | undefined): ICatalogModel | undefined {
	if (!repoId) {
		return undefined;
	}
	const exact = findCatalogEntry(repoId, format);
	if (exact) {
		return exact;
	}
	const family = (format ?? '').trim().toLowerCase();
	const engine: CatalogEngine | undefined = family.includes('mlx') ? 'mlx' : (family.includes('gguf') ? 'gguf' : undefined);
	if (engine) {
		const byEngine = LOCOPILOT_DEFAULT_CATALOG.find(e => e.repoId === repoId && e.engine === engine);
		if (byEngine) {
			return byEngine;
		}
	}
	return findCatalogEntryByRepoId(repoId);
}

/** MoE checkpoints ("35B-A3B") activate few parameters per token - fast for their quality, so Auto prefers them. */
function isMoEEntry(entry: ICatalogModel): boolean {
	return /-A\d+(\.\d+)?B/i.test(entry.repoId) || /\bMoE\b/i.test(entry.displayName);
}

// ---- hardware-aware sizing (shared with the launch planner) ------------------------------------------
//
// These let the catalog answer "will this run WELL here?" for models that are NOT downloaded yet, using the
// same arithmetic the launch planner applies to real files: name -> params -> layers -> KV cost, weighed
// against the platform's real inference budget.

/** Transformer-layer count bucketed from a model's TOTAL parameter count (billions). Layers track a model's
 * DEPTH, which tracks total params for dense models and is the memory-safe over-estimate for MoE (whose depth
 * is lower than a dense model of the same total). Quant-INDEPENDENT, unlike the file-size fallback. */
function estimateLayerCountFromParamsB(paramsB: number): number {
	if (paramsB <= 1.5) { return 24; }
	if (paramsB <= 4) { return 30; }
	if (paramsB <= 9) { return 36; }
	if (paramsB <= 16) { return 48; }
	if (paramsB <= 40) { return 64; }
	return 80;
}

/**
 * Approximate TOTAL parameter count (billions) parsed from a model name / repo id. Handles dense names
 * ("Qwen3-4B" -> 4), MoE names ("Qwen3.6-35B-A3B" -> 35 total, NOT the 3B active - KV scales with the model's
 * full transformer depth and the total is the memory-safe over-estimate), and Gemma effective sizes
 * ("gemma-4-E4B" -> 4). The active "A<n>B" token is deliberately ignored. Returns undefined when no size token
 * is present (e.g. "Phi-4-mini"), so callers fall back to the quant-dependent file-size bucket.
 */
export function modelParamsBillionsFromName(name: string): number | undefined {
	if (!name) {
		return undefined;
	}
	// A standalone <N>B or E<N>B token at a word boundary; the leading 'A' of an active-param "A3B" tag is not
	// in the boundary class, so active tokens never match - only total/dense sizes do.
	const matches = [...name.matchAll(/(?:^|[-_/ ])E?(\d+(?:\.\d+)?)\s*B(?![a-z])/gi)];
	if (matches.length === 0) {
		return undefined;
	}
	// The total is the largest size token (an MoE's active "A<n>B" is always smaller and never matches anyway).
	return Math.max(...matches.map(m => parseFloat(m[1])));
}

/** Layer count for a model from its NAME (params-based, quant-independent, MoE-aware), or undefined when the
 * name carries no size token. Preferred over {@link estimateLayerCountFromWeightBytes} because the same model's
 * higher-quant (larger) file must not be charged more KV layers than its lower-quant file. */
export function estimateLayerCountFromModelName(name: string): number | undefined {
	const paramsB = modelParamsBillionsFromName(name);
	return paramsB !== undefined ? estimateLayerCountFromParamsB(paramsB) : undefined;
}

/**
 * The hardware facts the "Best for you" recommendation needs. Supplied by the local-model runner so the chat
 * picker and the model-list editor read the SAME numbers (see its `getHardwareProfile`).
 *
 * Total RAM alone cannot rank models: a 16 GB Mac can wire ~10.5 GB for inference, a 16 GB PC with an 8 GB
 * discrete card is bounded by VRAM and hard-OOMs past it, and a 16 GB CPU-only laptop can hold the weights but
 * decodes at a fraction of the speed. All three used to receive an identical recommendation.
 */
export interface IHardwareProfile {
	readonly totalRamBytes: number;
	readonly isAppleSilicon: boolean;
	/** User-raised Metal wired limit (`iogpu.wired_limit_mb`), 0/undefined when unset. */
	readonly metalWiredLimitBytes?: number;
	/** Total VRAM of the target discrete GPU, 0 when there is none. */
	readonly discreteVramBytes: number;
	/** Free VRAM on that GPU at probe time, 0 when unknown. */
	readonly discreteVramFreeBytes: number;
}

/**
 * Memory a recommendation may assume for weights + KV + runtime, using the SAME budget functions the launch
 * planner uses - so a badge can never promise a model the planner would then refuse or cramp.
 */
export function inferenceBudgetBytes(profile: IHardwareProfile): number {
	if (profile.isAppleSilicon) {
		return metalOffloadBudgetBytes(profile.totalRamBytes, profile.metalWiredLimitBytes || undefined);
	}
	// A discrete GPU is the binding pool when present - weights and the whole KV must fit VRAM or the driver
	// OOMs outright. Without one, inference runs from system RAM.
	const vram = discreteVramBudgetBytes(profile.discreteVramBytes, profile.discreteVramFreeBytes);
	return vram > 0 ? vram : usableSystemMemoryBytes(profile.totalRamBytes);
}

/** True when this machine has no GPU to offload to, so decode speed is bounded by CPU throughput. */
export function isCpuOnlyProfile(profile: IHardwareProfile): boolean {
	return !profile.isAppleSilicon && profile.discreteVramBytes <= 0;
}

/**
 * Estimated runtime footprint of a NOT-yet-downloaded catalog entry at a given service level: its published
 * weight size, plus a KV cache for `contextTokens` at q8_0, plus engine overhead. Mirrors the download
 * picker's estimate so the badge, the download quant choice and the launch clamp all agree on what a model
 * costs. Layers come from the model NAME (quant-independent and MoE-aware).
 */
export function estimateCatalogFootprintBytes(entry: ICatalogModel, contextTokens: number): number {
	const layers = estimateLayerCountFromModelName(entry.displayName) ?? estimateLayerCountFromModelName(entry.repoId) ?? 48;
	const perTokenPerLayer = DEFAULT_KV_BYTES_PER_TOKEN_PER_LAYER_F16 * kvPlanBytesPerElem({ k: 'q8_0', v: 'q8_0' }) / kvCacheBytesPerElem('f16');
	return entry.approxSizeBytes + perTokenPerLayer * layers * contextTokens + RUNTIME_OVERHEAD_BYTES;
}

/** The largest of {@link AUTO_COMFORT_CONTEXT} / {@link AUTO_USABLE_CONTEXT} this entry could run at here, or 0
 * when even the usability floor does not fit. Capped by the model's own trained window. */
export function estimateCatalogContextTokens(entry: ICatalogModel, budgetBytes: number): number {
	if (!(budgetBytes > 0)) {
		return 0;
	}
	const trained = entry.contextWindow && entry.contextWindow > 0 ? entry.contextWindow : AUTO_COMFORT_CONTEXT;
	for (const target of [AUTO_COMFORT_CONTEXT, AUTO_USABLE_CONTEXT]) {
		const want = Math.min(target, trained);
		if (estimateCatalogFootprintBytes(entry, want) <= budgetBytes) {
			return want;
		}
	}
	return 0;
}

/**
 * What a downloaded model would ACTUALLY do on this machine, measured by the launch planner rather than read
 * off the catalog. Supplied to Auto by the local-model runner (see its `getAutoPlan`).
 *
 * Auto's catalog fields describe the model in the abstract; these describe the copy on THIS disk running on
 * THIS hardware. The two now diverge in two ways that matter:
 *  - the download picker chooses a quant per machine, so the same catalog entry can be a 4.7 GB Q4_K_M here
 *    and an 8.1 GB Q8_0 there, while `approxSizeBytes` says one fixed number;
 *  - the launch planner solves for a context window, and "fits" only guarantees the usability floor - so two
 *    models that both "fit" can differ by 4x in usable context, which the catalog cannot express at all.
 */
export interface IAutoModelPlan {
	/** Real weight bytes on disk (the quant actually downloaded), 0 when not yet measured. */
	readonly weightBytes: number;
	/** Context window the launch planner would grant on this machine, 0 when not yet measured. */
	readonly plannedContext: number;
}

/** Looks up the planner's verdict for a model; undefined = not measured yet, fall back to catalog figures. */
export type AutoModelPlanProbe = (modelId: string) => IAutoModelPlan | undefined;

/**
 * How much usable context a pick is expected to deliver, in the terms the launch planner already uses. This is
 * the dimension Auto was missing: it maximized model SIZE subject to fitting at all, and since "fits" now means
 * "reaches {@link AUTO_USABLE_CONTEXT}", a big model pinned at the floor outranked a smaller one running four
 * times longer. For a coding agent that is backwards - a window that cannot hold the file being edited plus a
 * couple of tool round-trips fails the task regardless of how capable the weights are.
 */
export const enum AutoServiceTier {
	/** Below the usability floor - runnable, but cramped enough to break multi-turn work. */
	Tight = 0,
	/** At or above the floor: every task works, with less room to spare. */
	Usable = 1,
	/** At or above the comfort target: full multi-file, multi-turn headroom. */
	Comfort = 2,
}

/**
 * Context thresholds for {@link AutoServiceTier}. Deliberately duplicated from the llama.cpp planner's
 * MIN_CLAMPED_CONTEXT / TARGET_MIN_CONTEXT rather than imported: this module is a dependency-free leaf that
 * both the runner and the picker import, and pulling the server module in here would make that cycle.
 */
export const AUTO_USABLE_CONTEXT = 16384;
export const AUTO_COMFORT_CONTEXT = 32768;

/** The service tier a planned context falls into. An unmeasured (0) context is treated as Comfort so an
 * un-probed model ranks exactly as it did before this dimension existed - never demoted for missing data. */
export function autoServiceTier(plannedContext: number): AutoServiceTier {
	if (!(plannedContext > 0) || plannedContext >= AUTO_COMFORT_CONTEXT) {
		return AutoServiceTier.Comfort;
	}
	return plannedContext >= AUTO_USABLE_CONTEXT ? AutoServiceTier.Usable : AutoServiceTier.Tight;
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
	maxSizeBytesExclusive?: number,
	getPlan?: AutoModelPlanProbe
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
		const running = isServerActive(model.id);
		const plan = getPlan?.(model.id);
		// Real bytes on disk beat the catalog's nominal size wherever we have them: the download picker chooses
		// the quant per machine, so approxSizeBytes can be ~2x off in either direction and the step-down ladder
		// below would otherwise step by the wrong amounts.
		const sizeBytes = plan?.weightBytes && plan.weightBytes > 0 ? plan.weightBytes : entry.approxSizeBytes;
		if (entry.minRamGB > effectiveRam && !running) {
			// Bigger than this machine's TOTAL RAM tier - never auto-picked... unless it is ALREADY RUNNING.
			// The tier ceiling is an aspiration guard for COLD picks; a loaded server has empirically proven
			// it runs here, so excluding it would make Auto name (and switch to) a different model than the
			// one in memory - the opposite of the stickiness rule below, and a guaranteed pointless cold swap.
			// This matters most when `ramGB` is unknown: detectedRamGB reads timerService.startupMetrics,
			// which THROWS until startup finishes, so it reports 0 and effectiveRam falls back to the 8 GB
			// tier - which used to exclude every running 16/32 GB-tier model outright.
			continue;
		}
		if (maxSizeBytesExclusive !== undefined && sizeBytes >= maxSizeBytesExclusive) {
			continue; // step-down: this pick (or a bigger one) already failed the launch gate this pass.
		}

		// Service tier FIRST, capability second: a model that only reaches the cramped floor is worse for agent
		// work than a smaller one with a comfortable window, however capable its weights are. Weighted above the
		// stickiness bonus on purpose - a one-time cold swap is cheaper than every turn running in a window too
		// small to hold the task. Unmeasured models score as Comfort, so this never demotes on missing data.
		let score = autoServiceTier(plan?.plannedContext ?? 0) * 1_000_000;
		score += entry.minRamGB * 1000; // capability: the highest RAM tier the hardware supports.
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

/**
 * The pinned Auto model, but only while the pin is still WORTH HONOURING - i.e. its model is a valid Auto
 * candidate AND its server is running/starting. Returns undefined otherwise, meaning "re-resolve from live
 * state". Pure: never writes the pin, so both the commit and the render wrapper below can share it.
 *
 * Warmth is the whole point of the pin. It exists so Auto does not bounce off a model that is already
 * loaded (the label, the pre-warm and the send must agree on the model actually in memory); once that
 * server is stopped there is nothing left to preserve, and honouring the pin would strand Auto on a model
 * it would never pick fresh. That was the bug: hand-selecting a small model let a picker render pin it (it
 * wins resolveAutoModel's stickiness bonus while warm), and after stopping it Auto still resolved to - and
 * started - that small model instead of the larger one this machine can run.
 */
function warmPinnedAutoModel(
	service: ICustomLanguageModelsService,
	isServerActive: (modelId: string) => boolean
): ICustomLanguageModel | undefined {
	const pinnedId = service.getPinnedAutoModelId();
	if (!pinnedId || !isServerActive(pinnedId)) {
		return undefined; // no pin, or the pinned model is cold - nothing worth preserving
	}
	const pinned = service.getCustomModels().find(m => m.id === pinnedId);
	return pinned && isAutoCandidate(pinned) ? pinned : undefined; // deleted/hidden pin also re-resolves
}

/**
 * PIN-AWARE Auto resolution for COMMIT paths - selecting Auto in the picker, prefix warming, and the
 * per-request resolution - so they all agree on the SAME concrete model. Render paths (labels, row
 * descriptions) must use {@link peekAutoModel}: resolving for display must never mutate session state.
 *
 * Auto used to be re-resolved independently at each of those sites, each at a different moment over
 * different live inputs (which server happened to be running/starting for the stickiness bonus, momentary
 * free RAM for the step-down), so the label could say one model, selecting Auto warmed another, and the
 * send used a third. This wrapper funnels them through a session pin held on the service: a resolution
 * pins its pick, later calls reuse it while it stays warm (see warmPinnedAutoModel), and the request path
 * re-pins when its launch-gate step-down lands on a smaller model - after which every consumer follows.
 * The pin is also cleared when the selection moves off Auto (service side).
 */
export function resolveAutoModelPinned(
	service: ICustomLanguageModelsService,
	ramGB: number,
	isServerActive: (modelId: string) => boolean,
	getPlan?: AutoModelPlanProbe
): ICustomLanguageModel | undefined {
	const warm = warmPinnedAutoModel(service, isServerActive);
	if (warm) {
		return warm;
	}
	const resolved = resolveAutoModel(service.getCustomModels(), ramGB, isServerActive, undefined, getPlan);
	service.setPinnedAutoModelId(resolved?.id);
	return resolved;
}

/**
 * READ-ONLY Auto resolution for render paths: what Auto would use if it ran right now, without pinning.
 *
 * Rendering must not pin, because the picker draws the Auto row (and its "Uses <model>" description) even
 * when Auto is NOT the selection - a render that pinned would let whatever model happens to be warm at
 * that moment capture Auto's pick behind the user's back. Agreement with {@link resolveAutoModelPinned} is
 * structural, not coincidental: both prefer the same warm pin and otherwise run the same deterministic
 * resolveAutoModel over the same live inputs.
 */
export function peekAutoModel(
	service: ICustomLanguageModelsService,
	ramGB: number,
	isServerActive: (modelId: string) => boolean,
	getPlan?: AutoModelPlanProbe
): ICustomLanguageModel | undefined {
	return warmPinnedAutoModel(service, isServerActive)
		?? resolveAutoModel(service.getCustomModels(), ramGB, isServerActive, undefined, getPlan);
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
export function getAutoStarterPicks(ramGB: number, profile?: IHardwareProfile): IAutoStarterPick[] {
	const slots: { slot: AutoStarterSlot; title: string; reason: string; repoId: string }[] = [
		{
			slot: 'best',
			title: 'Best for your system',
			reason: 'Highest quality that runs comfortably on your hardware.',
			repoId: getRecommendedRepoId(ramGB, profile),
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
