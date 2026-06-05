/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { IChatSessionsService } from './chatSessionsService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export enum ChatConfiguration {
	AgentEnabled = 'chat.agent.enabled',
	AgentStatusEnabled = 'chat.agentsControl.enabled',
	EditorAssociations = 'chat.editorAssociations',
	UnifiedAgentsBar = 'chat.unifiedAgentsBar.enabled',
	AgentSessionProjectionEnabled = 'chat.agentSessionProjection.enabled',
	EditModeHidden = 'chat.editMode.hidden',
	AlternativeToolAction = 'chat.alternativeToolAction.enabled',
	Edits2Enabled = 'chat.edits2.enabled',
	ExtensionToolsEnabled = 'chat.extensionTools.enabled',
	RepoInfoEnabled = 'chat.repoInfo.enabled',
	EditRequests = 'chat.editRequests',
	InlineReferencesStyle = 'chat.inlineReferences.style',
	GlobalAutoApprove = 'chat.tools.global.autoApprove',
	AutoApproveEdits = 'chat.tools.edits.autoApprove',
	AutoApprovedUrls = 'chat.tools.urls.autoApprove',
	EligibleForAutoApproval = 'chat.tools.eligibleForAutoApproval',
	EnableMath = 'chat.math.enabled',
	CheckpointsEnabled = 'chat.checkpoints.enabled',
	ThinkingStyle = 'chat.agent.thinkingStyle',
	ThinkingGenerateTitles = 'chat.agent.thinking.generateTitles',
	TerminalToolsInThinking = 'chat.agent.thinking.terminalTools',
	AutoExpandToolFailures = 'chat.tools.autoExpandFailures',
	TodosShowWidget = 'chat.tools.todos.showWidget',
	NotifyWindowOnResponseReceived = 'chat.notifyWindowOnResponseReceived',
	ChatViewSessionsEnabled = 'chat.viewSessions.enabled',
	ChatViewSessionsShowActiveOnly = 'chat.viewSessions.showActiveOnly',
	ChatViewSessionsOrientation = 'chat.viewSessions.orientation',
	ChatViewTitleEnabled = 'chat.viewTitle.enabled',
	SubagentToolCustomAgents = 'chat.customAgentInSubagent.enabled',
	ShowCodeBlockProgressAnimation = 'chat.agent.codeBlockProgress',
	RestoreLastPanelSession = 'chat.restoreLastPanelSession',
	ExitAfterDelegation = 'chat.exitAfterDelegation',
	AgentsControlClickBehavior = 'chat.agentsControl.clickBehavior',
	ExplainChangesEnabled = 'chat.editing.explainChanges.enabled',
	WebSearchApiKey = 'chat.webSearch.apiKey',
	/** Path to llama-server binary (llama.cpp). Empty = use PATH. Can be full path to binary or directory containing it. */
	LocopilotLlamaCppServerPath = 'locopilot.llamaCpp.serverPath',
	/** Python interpreter to run `python -m mlx_lm.server` for local MLX (Hugging Face) models on Apple Silicon. Empty = `python3` on PATH. */
	LocopilotMlxPythonPath = 'locopilot.mlx.pythonPath',
	/** Context window (`-c`) for llama-server. Smaller = smaller KV cache, faster prefill, less memory. */
	LocopilotLlamaCppContextSize = 'locopilot.llamaCpp.contextSize',
	/** Flash Attention mode for llama-server (`-fa`): 'auto' (default, self-falls-back), 'on', or 'off'. */
	LocopilotLlamaCppFlashAttention = 'locopilot.llamaCpp.flashAttention',
	/** KV cache quantization for llama-server (`--cache-type-k/v`): 'f16' (default/safe), 'q8_0', or 'q4_0'. */
	LocopilotLlamaCppKvCacheType = 'locopilot.llamaCpp.kvCacheType',
	/** Multi-Token Prediction / NextN speculative decoding. Opt-in: only MTP-trained models on recent builds. */
	LocopilotLlamaCppMtp = 'locopilot.llamaCpp.multiTokenPrediction',
	/** Build-specific flags appended after `--model-draft` when MTP is on (e.g. `--spec-type nextn`). */
	LocopilotLlamaCppMtpArgs = 'locopilot.llamaCpp.mtpArgs',
	/** Min chunk size to reuse from the KV cache via shifting (`--cache-reuse`). 0 disables. */
	LocopilotLlamaCppCacheReuse = 'locopilot.llamaCpp.cacheReuse',
	/** CPU threads for generation (`--threads`). 0 = auto-detect. */
	LocopilotLlamaCppThreads = 'locopilot.llamaCpp.threads',
	/** Logical batch size (`--batch-size`). 0 = build default. */
	LocopilotLlamaCppBatchSize = 'locopilot.llamaCpp.batchSize',
	/** Physical batch size (`--ubatch-size`). 0 = build default. */
	LocopilotLlamaCppUbatchSize = 'locopilot.llamaCpp.ubatchSize',
	/** Fire a tiny warm-up request after the server starts so the first real message has no JIT lag. */
	LocopilotLlamaCppWarmup = 'locopilot.llamaCpp.warmup',
	/** Lock model weights in RAM (`--mlock`) to avoid paging. Opt-in: can fail without privileges/RAM. */
	LocopilotLlamaCppMlock = 'locopilot.llamaCpp.mlock',
	/** Extra raw args appended to the llama-server command line (power users). */
	LocopilotLlamaCppExtraArgs = 'locopilot.llamaCpp.extraArgs',
	/** How long Ollama keeps a model loaded in memory (`ollama run --keepalive`). Reduces cold starts. */
	LocopilotOllamaKeepAlive = 'locopilot.ollama.keepAlive',
	/** Whether to show tool call parameters and results in the chat UI. */
	LocopilotShowToolDetails = 'locopilot.chat.showToolDetails',
}

/**
 * The "kind" of agents for custom agents.
 */
export enum ChatModeKind {
	Ask = 'ask',
	Edit = 'edit',
	Agent = 'agent'
}

export function validateChatMode(mode: unknown): ChatModeKind | undefined {
	switch (mode) {
		case ChatModeKind.Ask:
		case ChatModeKind.Edit:
		case ChatModeKind.Agent:
			return mode as ChatModeKind;
		default:
			return undefined;
	}
}

export function isChatMode(mode: unknown): mode is ChatModeKind {
	return !!validateChatMode(mode);
}

// Thinking display modes for pinned content
export enum ThinkingDisplayMode {
	Collapsed = 'collapsed',
	CollapsedPreview = 'collapsedPreview',
	FixedScrolling = 'fixedScrolling',
	AutoCollapse = 'autoCollapse',
}

export enum CollapsedToolsDisplayMode {
	Off = 'off',
	WithThinking = 'withThinking',
	Always = 'always',
}

export enum AgentsControlClickBehavior {
	Default = 'default',
	TriStateToggle = 'triStateToggle',
	Focus = 'focus',
}

export type RawChatParticipantLocation = 'panel' | 'terminal' | 'notebook' | 'editing-session';

export enum ChatAgentLocation {
	/**
	 * This is chat, whether it's in the sidebar, a chat editor, or quick chat.
	 * Leaving the values alone as they are in stored data so we don't have to normalize them.
	 */
	Chat = 'panel',
	Terminal = 'terminal',
	Notebook = 'notebook',
	/**
	 * EditorInline means inline chat in a text editor.
	 */
	EditorInline = 'editor',
}

export namespace ChatAgentLocation {
	export function fromRaw(value: RawChatParticipantLocation | string): ChatAgentLocation {
		switch (value) {
			case 'panel': return ChatAgentLocation.Chat;
			case 'terminal': return ChatAgentLocation.Terminal;
			case 'notebook': return ChatAgentLocation.Notebook;
			case 'editor': return ChatAgentLocation.EditorInline;
		}
		return ChatAgentLocation.Chat;
	}
}

/**
 * List of file schemes that are always unsupported for use in chat
 */
const chatAlwaysUnsupportedFileSchemes = new Set([
	Schemas.vscodeChatEditor,
	Schemas.walkThrough,
	Schemas.vscodeLocalChatSession,
	Schemas.vscodeSettings,
	Schemas.webviewPanel,
	Schemas.vscodeUserData,
	Schemas.extension,
	'ccreq',
	'openai-codex', // Codex session custom editor scheme
]);

export function isSupportedChatFileScheme(accessor: ServicesAccessor, scheme: string): boolean {
	const chatService = accessor.get(IChatSessionsService);

	// Exclude schemes we always know are bad
	if (chatAlwaysUnsupportedFileSchemes.has(scheme)) {
		return false;
	}

	// Plus any schemes used by content providers
	if (chatService.getContentProviderSchemes().includes(scheme)) {
		return false;
	}

	// Everything else is supported
	return true;
}

export const MANAGE_CHAT_COMMAND_ID = 'workbench.action.chat.manage';
export const ChatEditorTitleMaxLength = 30;

export const CHAT_TERMINAL_OUTPUT_MAX_PREVIEW_LINES = 1000;
export const CONTEXT_MODELS_EDITOR = new RawContextKey<boolean>('inModelsEditor', false);
export const CONTEXT_MODELS_SEARCH_FOCUS = new RawContextKey<boolean>('inModelsSearch', false);
