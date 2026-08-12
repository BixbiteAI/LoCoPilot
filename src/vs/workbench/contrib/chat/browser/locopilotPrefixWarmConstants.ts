/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Values shared by the two prefix-warm implementations - llama.cpp's (in the runner, driven over HTTP) and
 * MLX's (inside the embedded Python helper, which interpolates these into its source). Both do the same
 * thing: render a turn twice with different user text and keep the shared token span, so the cached prefix
 * is STRICTLY a prefix of every later turn. Kept in one place because the two must not drift - a blob saved
 * by one and read back under different probes would silently stop matching.
 */

/**
 * Two throwaway user messages used to locate the stable/volatile boundary of a rendered chat prompt. They
 * must differ from their FIRST character, so the renderings diverge exactly where user content begins and
 * the shared span cannot accidentally extend into it.
 */
export const PREFIX_PROBE_A = 'a';
export const PREFIX_PROBE_B = 'b';

/**
 * Below this many stable tokens a prefill isn't worth a slot save - and, more importantly, a tiny shared
 * span means the probe didn't find the real boundary, so the safe move is the ordinary chat warm.
 */
export const MIN_PREFILL_PREFIX_TOKENS = 32;

/**
 * Tokens per forward pass when MLX prefills the prefix. Chunked so a multi-thousand-token prefix doesn't
 * build one enormous graph; mirrors mlx_lm's own `prefill_step_size` default for the server.
 */
export const MLX_PREFILL_CHUNK_TOKENS = 512;

/**
 * Format version of the persisted prefix caches, carried in every blob's filename.
 *
 * Bump this whenever a change alters the TOKENS a warm produces, so blobs written by older builds are
 * simply not found and get regenerated. Without it a bad blob is permanent: a restore that "succeeds"
 * (HTTP 200) makes the warm path return early, so nothing ever re-prefills and nothing ever overwrites it.
 *
 * v2: the prefill now tokenizes with `add_special`, so the cached prefix carries BOS. v1 blobs were one
 * token short at position 0 - they restore fine and then match nothing, which is worse than no cache at all.
 */
export const PREFIX_CACHE_FORMAT_VERSION = 'v2';
