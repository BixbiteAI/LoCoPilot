/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Single source of truth for which tools are exposed to the agentic loop.
 *
 * Three layers, applied in this order:
 *  1. {@link AGENT_LOOP_EXCLUDED_TOOL_IDS} - never sent to ANY model from the agent loop.
 *  2. {@link EDIT_TOOL_IDS} - additionally removed in read-only modes (Ask / Plan), so
 *     read-only is enforced by the harness, not just by prompt text.
 *  3. {@link LOCAL_MODEL_EXCLUDED_TOOL_IDS} - additionally removed by the provider for local
 *     models, where every schema token costs prompt-eval time and small models get confused
 *     by overlapping tools.
 *
 * IMPORTANT: keep this file consistent with the system prompts in agentPrompts.ts. Every tool
 * the prompt tells the model to use must survive the filters for the models that see that
 * prompt text (e.g. `manage_todo_list` and `get_terminal_output` are referenced by the prompt,
 * so they must NOT appear in the local exclusion list).
 */

/** Strip the `vscode_` namespace prefix so ids match whether or not the source used it. */
function bareName(name: string): string {
	return name.startsWith('vscode_') ? name.slice('vscode_'.length) : name;
}

/**
 * Tools that never belong in the agent loop payload (any model, any mode):
 * - `setup_tools_createNewWorkspace`, `inline_chat_exit`: internal VS Code flows, not agent actions.
 * - `searchExtensions_internal`: extension-marketplace search - noise in a coding loop.
 * - `get_terminal_confirmation`, `get_confirmation`: confirmation UI helpers; run_in_terminal
 *   already has its own confirmation flow, and get_confirmation is a demo tool.
 * - `editFile_internal`: overlaps modifyFile (create/overwrite/surgical replace all covered);
 *   sending both made small models pick inconsistently. Re-enable here if a dedicated
 *   apply-edits model is ever added.
 */
export const AGENT_LOOP_EXCLUDED_TOOL_IDS: ReadonlySet<string> = new Set([
	'setup_tools_createNewWorkspace',
	'inline_chat_exit',
	'searchExtensions_internal',
	'get_terminal_confirmation',
	'get_confirmation',
	'editFile_internal',
].map(bareName));

/**
 * Tools that mutate the workspace. Hard-removed from the payload in read-only modes (Ask/Plan)
 * so a model cannot edit even if it ignores the prompt. run_in_terminal stays available (Ask
 * mode legitimately allows read-only commands); its own confirmation UI gates side effects.
 */
export const EDIT_TOOL_IDS: ReadonlySet<string> = new Set([
	'createFile',
	'editFile',
	'insertCode',
	'modifyFile', // legacy single tool (dormant, kept for easy re-enable)
	'editFile_internal',
	'create_and_run_task',
].map(bareName));

/**
 * Extra exclusions for LOCAL models only (applied by the provider on top of the always-list).
 * Rationale: keep the schema payload small for limited context windows. Deliberately NOT here,
 * because the system prompt references them: `manage_todo_list`, `get_terminal_output`.
 */
export const LOCAL_MODEL_EXCLUDED_TOOL_IDS: ReadonlySet<string> = new Set([
	'await_terminal',
	'terminal_selection',
	'terminal_last_command',
	'create_and_run_task',
	'fetchWebPage_internal',
	// runSubagent: each subagent is a full agent loop on the same single local server - no real
	// parallelism, and a confused small model can recurse. The prompt advertises it conditionally
	// ("if available"), so excluding it here is consistent.
	'runSubagent',
].map(bareName));

/**
 * True when `toolName` (a real tool id OR a provider-sanitized function name) is in `excluded`.
 * Matches with and without the `vscode_` prefix, so `vscode_searchExtensions_internal` and
 * `searchExtensions_internal` are the same tool (the old exact-match filter silently missed
 * the prefixed variants).
 */
export function isToolExcluded(toolName: string, excluded: ReadonlySet<string>): boolean {
	return excluded.has(bareName(toolName));
}
