/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { MarkdownString, isMarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { PolicyCategory } from '../../../../base/common/policy.js';
import { registerEditorFeature } from '../../../../editor/common/editorFeatures.js';
import * as nls from '../../../../nls.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, EditPresentationTypes, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { McpAccessValue, McpAutoStartValue, mcpAccessConfig, mcpAutoStartConfig, mcpGalleryServiceEnablementConfig, mcpGalleryServiceUrlConfig, mcpAppsEnabledConfig } from '../../../../platform/mcp/common/mcpManagement.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { Extensions, IConfigurationMigrationRegistry } from '../../../common/configuration.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IWorkbenchAssignmentService } from '../../../services/assignment/common/assignmentService.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { AddConfigurationType, AssistedTypes } from '../../mcp/browser/mcpCommandsAddConfiguration.js';
import { allDiscoverySources, discoverySourceSettingsLabel, mcpDiscoverySection, mcpServerSamplingSection } from '../../mcp/common/mcpConfiguration.js';
import { ChatAgentNameService, ChatAgentService, IChatAgentNameService, IChatAgentService } from '../common/participants/chatAgents.js';
import { CodeMapperService, ICodeMapperService } from '../common/editing/chatCodeMapperService.js';
import '../common/widget/chatColors.js';
import { IChatEditingService } from '../common/editing/chatEditingService.js';
import { IChatLayoutService } from '../common/widget/chatLayoutService.js';
import { ChatModeService, IChatMode, IChatModeService } from '../common/chatModes.js';
import { ChatResponseResourceFileSystemProvider } from '../common/widget/chatResponseResourceFileSystemProvider.js';
import { IChatService } from '../common/chatService/chatService.js';
import { ChatService } from '../common/chatService/chatServiceImpl.js';
import { IChatSessionsService } from '../common/chatSessionsService.js';
import { ChatSlashCommandService, IChatSlashCommandService } from '../common/participants/chatSlashCommands.js';
import { ChatTodoListService, IChatTodoListService } from '../common/tools/chatTodoListService.js';
import { ChatTransferService, IChatTransferService } from '../common/model/chatTransferService.js';
import { IChatVariablesService } from '../common/attachments/chatVariables.js';
import { ChatWidgetHistoryService, IChatWidgetHistoryService } from '../common/widget/chatWidgetHistoryService.js';
import { AgentsControlClickBehavior, ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../common/constants.js';
import { ILanguageModelIgnoredFilesService, LanguageModelIgnoredFilesService } from '../common/ignoredFiles.js';
import { ILanguageModelsService, LanguageModelsService } from '../common/languageModels.js';
import { ILanguageModelStatsService, LanguageModelStatsService } from '../common/languageModelStats.js';
import { ICustomLanguageModelsService, CustomLanguageModelsService } from '../common/customLanguageModelsService.js';
import { ILanguageModelToolsConfirmationService } from '../common/tools/languageModelToolsConfirmationService.js';
import { ILanguageModelToolsService } from '../common/tools/languageModelToolsService.js';
import { ChatPromptFilesExtensionPointHandler } from '../common/promptSyntax/chatPromptFilesContribution.js';
import { PromptsConfig } from '../common/promptSyntax/config/config.js';
import { INSTRUCTIONS_DEFAULT_SOURCE_FOLDER, INSTRUCTION_FILE_EXTENSION, LEGACY_MODE_DEFAULT_SOURCE_FOLDER, LEGACY_MODE_FILE_EXTENSION, PROMPT_DEFAULT_SOURCE_FOLDER, PROMPT_FILE_EXTENSION, DEFAULT_SKILL_SOURCE_FOLDERS, AGENTS_SOURCE_FOLDER, AGENT_FILE_EXTENSION, SKILL_FILENAME } from '../common/promptSyntax/config/promptFileLocations.js';
import { PromptLanguageFeaturesProvider } from '../common/promptSyntax/promptFileContributions.js';
import { AGENT_DOCUMENTATION_URL, INSTRUCTIONS_DOCUMENTATION_URL, PROMPT_DOCUMENTATION_URL, SKILL_DOCUMENTATION_URL } from '../common/promptSyntax/promptTypes.js';
import { IPromptsService } from '../common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../common/promptSyntax/service/promptsServiceImpl.js';
import { ILoCoPilotFileLog, LoCoPilotFileLog } from './locopilotFileLog.js';
import { ILoCoPilotAgentSettingsService, LoCoPilotAgentSettingsService } from './locopilotAgentSettingsService.js';
import { LoCoPilotLanguageModelProvider } from './locopilotLanguageModelProvider.js';
import { LoCoPilotModelDownloadService } from './locopilotModelDownloadService.js';
import { LoCoPilotCatalogSeedContribution } from './locopilotCatalogSeedService.js';
import { LoCoPilotUpdateCheckContribution } from './locopilotUpdateCheckService.js';
import { ILoCoPilotLocalModelRunner, LoCoPilotLocalModelRunner } from './locopilotLocalModelRunner.js';
import { ILoCoPilotOllamaService, LoCoPilotOllamaService } from './locopilotOllamaService.js';
import { ILoCoPilotProjectMemoryService, LoCoPilotProjectMemoryService } from './locopilotProjectMemoryService.js';
import { ILoCoPilotLiveStatsService, LoCoPilotLiveStatsService } from './locopilotLiveStatsService.js';
import { LoCoPilotProjectMemoryToolsContribution } from './tools/projectMemoryToolsContribution.js';
import { LanguageModelToolsExtensionPointHandler } from '../common/tools/languageModelToolsContribution.js';
import { BuiltinToolsContribution } from '../common/tools/builtinTools/tools.js';
import './retrieval/retrievalService.js'; // registers ILoCoPilotRetrievalService singleton
import { LoCoPilotRetrievalContribution } from './retrieval/retrievalContribution.js';
import { IVoiceChatService, VoiceChatService } from '../common/voiceChatService.js';
import { registerChatAccessibilityActions } from './actions/chatAccessibilityActions.js';
import { AgentChatAccessibilityHelp, EditsChatAccessibilityHelp, PanelChatAccessibilityHelp, QuickChatAccessibilityHelp } from './actions/chatAccessibilityHelp.js';
import { ACTION_ID_NEW_CHAT, ModeOpenChatGlobalAction, registerChatActions } from './actions/chatActions.js';
import { CodeBlockActionRendering, registerChatCodeBlockActions, registerChatCodeCompareBlockActions } from './actions/chatCodeblockActions.js';
import { ChatContextContributions } from './actions/chatContext.js';
import { registerChatContextActions } from './actions/chatContextActions.js';
import { registerChatCopyActions } from './actions/chatCopyActions.js';
import { registerChatDeveloperActions } from './actions/chatDeveloperActions.js';
import { ChatSubmitAction, registerChatExecuteActions } from './actions/chatExecuteActions.js';
import { registerChatFileTreeActions } from './actions/chatFileTreeActions.js';
import { ChatGettingStartedContribution } from './actions/chatGettingStarted.js';
import { registerChatExportActions } from './actions/chatImportExport.js';
import { registerLanguageModelActions } from './actions/chatLanguageModelActions.js';
import { registerMoveActions } from './actions/chatMoveActions.js';
import { registerNewChatActions } from './actions/chatNewActions.js';
import { registerChatPromptNavigationActions } from './actions/chatPromptNavigationActions.js';
import { registerQuickChatActions } from './actions/chatQuickInputActions.js';
import { ChatAgentRecommendation } from './actions/chatAgentRecommendationActions.js';
import { registerChatTitleActions } from './actions/chatTitleActions.js';
import { registerChatElicitationActions } from './actions/chatElicitationActions.js';
import { registerChatToolActions } from './actions/chatToolActions.js';
import { ChatTransferContribution } from './actions/chatTransfer.js';
import './agentSessions/agentSessions.contribution.js';
import { IAgentSessionsService } from './agentSessions/agentSessionsService.js';
import { IChatAccessibilityService, IChatCodeBlockContextProviderService, IChatWidgetService, IQuickChatService } from './chat.js';
import { ChatAccessibilityService } from './accessibility/chatAccessibilityService.js';
import './attachments/chatAttachmentModel.js';
import './widget/input/chatStatusWidget.js';
import { ChatAttachmentResolveService, IChatAttachmentResolveService } from './attachments/chatAttachmentResolveService.js';
import { ChatMarkdownAnchorService, IChatMarkdownAnchorService } from './widget/chatContentParts/chatMarkdownAnchorService.js';
import { ChatContextPickService, IChatContextPickService } from './attachments/chatContextPickService.js';
import { ChatInputBoxContentProvider } from './widget/input/editor/chatEditorInputContentProvider.js';
import { ChatEditingEditorAccessibility } from './chatEditing/chatEditingEditorAccessibility.js';
import { registerChatEditorActions } from './chatEditing/chatEditingEditorActions.js';
import { ChatEditingEditorContextKeys } from './chatEditing/chatEditingEditorContextKeys.js';
import { ChatEditingEditorOverlay } from './chatEditing/chatEditingEditorOverlay.js';
import { ChatEditingService } from './chatEditing/chatEditingServiceImpl.js';
import { ChatEditingNotebookFileSystemProviderContrib } from './chatEditing/notebook/chatEditingNotebookFileSystemProvider.js';
import { SimpleBrowserOverlay } from './attachments/simpleBrowserEditorOverlay.js';
import { ChatEditor, IChatEditorOptions } from './widgetHosts/editor/chatEditor.js';
import { ChatEditorInput, ChatEditorInputSerializer } from './widgetHosts/editor/chatEditorInput.js';
import { ChatLayoutService } from './widget/chatLayoutService.js';
import { ChatLanguageModelsDataContribution, LanguageModelsConfigurationService } from './languageModelsConfigurationService.js';
import './chatManagement/chatManagement.contribution.js';
import { agentSlashCommandToMarkdown, agentToMarkdown } from './widget/chatContentParts/chatMarkdownDecorationsRenderer.js';
import { ChatOutputRendererService, IChatOutputRendererService } from './chatOutputItemRenderer.js';
import { ChatCompatibilityNotifier, ChatExtensionPointHandler } from './chatParticipant.contribution.js';
import { ChatPasteProvidersFeature } from './widget/input/editor/chatPasteProviders.js';
import { QuickChatService } from './widgetHosts/chatQuick.js';
import { ChatResponseAccessibleView } from './accessibility/chatResponseAccessibleView.js';
import { ChatTerminalOutputAccessibleView } from './accessibility/chatTerminalOutputAccessibleView.js';
import { ChatSetupContribution, ChatTeardownContribution } from './chatSetup/chatSetupContributions.js';
// ChatStatusBarEntry: import disabled along with its (commented-out) registration below.
// import { ChatStatusBarEntry } from './chatStatus/chatStatusEntry.js';
import { ChatVariablesService } from './attachments/chatVariables.js';
import { ChatWidget } from './widget/chatWidget.js';
import { ChatCodeBlockContextProviderService } from './codeBlockContextProviderService.js';
import { ChatDynamicVariableModel } from './attachments/chatDynamicVariables.js';
import { ChatImplicitContextContribution } from './attachments/chatImplicitContext.js';
import './widget/input/editor/chatInputCompletions.js';
import './widget/input/editor/chatInputEditorContrib.js';
import './widget/input/editor/chatInputEditorHover.js';
import { ChatRelatedFilesContribution } from './attachments/chatInputRelatedFilesContrib.js';
import { LanguageModelToolsConfirmationService } from './tools/languageModelToolsConfirmationService.js';
import { LanguageModelToolsService, globalAutoApproveDescription } from './tools/languageModelToolsService.js';
import './promptSyntax/promptCodingAgentActionContribution.js';
import './promptSyntax/promptToolsCodeLensProvider.js';
import { PromptUrlHandler } from './promptSyntax/promptUrlHandler.js';
import { ConfigureToolSets, UserToolSetsContributions } from './tools/toolSetsContribution.js';
import { ChatViewsWelcomeHandler } from './viewsWelcome/chatViewsWelcomeHandler.js';
import { ChatWidgetService } from './widget/chatWidgetService.js';
import { ILanguageModelsConfigurationService } from '../common/languageModelsConfiguration.js';
import { ChatWindowNotifier } from './chatWindowNotifier.js';
import { ChatRepoInfoContribution } from './chatRepoInfo.js';
import { VALID_PROMPT_FOLDER_PATTERN } from '../common/promptSyntax/utils/promptFilesLocator.js';

const toolReferenceNameEnumValues: string[] = [];
const toolReferenceNameEnumDescriptions: string[] = [];

// Register configuration
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'chatSidebar',
	title: nls.localize('interactiveSessionConfigurationTitle', "Chat"),
	type: 'object',
	properties: {
		'chat.fontSize': {
			type: 'number',
			description: nls.localize('chat.fontSize', "Controls the font size in pixels in chat messages."),
			default: 13,
			minimum: 6,
			maximum: 100
		},
		'chat.fontFamily': {
			type: 'string',
			description: nls.localize('chat.fontFamily', "Controls the font family in chat messages."),
			default: 'default'
		},
		'chat.editor.fontSize': {
			type: 'number',
			description: nls.localize('interactiveSession.editor.fontSize', "Controls the font size in pixels in chat codeblocks."),
			default: isMacintosh ? 12 : 14,
		},
		'chat.editor.fontFamily': {
			type: 'string',
			description: nls.localize('interactiveSession.editor.fontFamily', "Controls the font family in chat codeblocks."),
			default: 'default'
		},
		'chat.editor.fontWeight': {
			type: 'string',
			description: nls.localize('interactiveSession.editor.fontWeight', "Controls the font weight in chat codeblocks."),
			default: 'default'
		},
		'chat.editor.wordWrap': {
			type: 'string',
			description: nls.localize('interactiveSession.editor.wordWrap', "Controls whether lines should wrap in chat codeblocks."),
			default: 'off',
			enum: ['on', 'off']
		},
		'chat.editor.lineHeight': {
			type: 'number',
			description: nls.localize('interactiveSession.editor.lineHeight', "Controls the line height in pixels in chat codeblocks. Use 0 to compute the line height from the font size."),
			default: 0
		},
		[ChatConfiguration.AgentsControlClickBehavior]: {
			type: 'string',
			enum: [AgentsControlClickBehavior.Default, AgentsControlClickBehavior.TriStateToggle, AgentsControlClickBehavior.Focus],
			enumDescriptions: [
				nls.localize('chat.agentsControl.clickBehavior.default', "Clicking chat icon toggles chat visibility."),
				nls.localize('chat.agentsControl.clickBehavior.triStateToggle', "Clicking chat icon cycles through: show chat, maximize chat, hide chat. This requires chat to be contained in the secondary sidebar."),
				nls.localize('chat.agentsControl.clickBehavior.focus', "Clicking chat icon focuses the chat view.")
			],
			markdownDescription: nls.localize('chat.agentsControl.clickBehavior', "Controls the behavior when clicking on the chat icon in the command center."),
			default: product.quality !== 'stable' ? AgentsControlClickBehavior.TriStateToggle : AgentsControlClickBehavior.Default,
			tags: ['experimental']
		},
		[ChatConfiguration.AgentStatusEnabled]: {
			type: 'boolean',
			markdownDescription: nls.localize('chat.agentsControl.enabled', "Controls whether the 'Agent Status' indicator is shown in the title bar command center. Enabling this setting will automatically enable {0}.", '`#window.commandCenter#`'),
			default: true,
			tags: ['experimental']
		},
		[ChatConfiguration.UnifiedAgentsBar]: {
			type: 'boolean',
			markdownDescription: nls.localize('chat.unifiedAgentsBar.enabled', "Replaces the command center search box with a unified chat and search widget."),
			default: false,
			tags: ['experimental']
		},
		[ChatConfiguration.AgentSessionProjectionEnabled]: {
			type: 'boolean',
			markdownDescription: nls.localize('chat.agentSessionProjection.enabled', "Controls whether Agent Session Projection mode is enabled for reviewing agent sessions in a focused workspace."),
			default: false,
			tags: ['experimental'],
		},
		'chat.implicitContext.enabled': {
			type: 'object',
			description: nls.localize('chat.implicitContext.enabled.1', "Enables automatically using the active editor as chat context for specified chat locations."),
			additionalProperties: {
				type: 'string',
				enum: ['never', 'first', 'always'],
				description: nls.localize('chat.implicitContext.value', "The value for the implicit context."),
				enumDescriptions: [
					nls.localize('chat.implicitContext.value.never', "Implicit context is never enabled."),
					nls.localize('chat.implicitContext.value.first', "Implicit context is enabled for the first interaction."),
					nls.localize('chat.implicitContext.value.always', "Implicit context is always enabled.")
				]
			},
			default: {
				'panel': 'always',
			}
		},
		'chat.implicitContext.suggestedContext': {
			type: 'boolean',
			markdownDescription: nls.localize('chat.implicitContext.suggestedContext', "Controls whether the new implicit context flow is shown. In Ask and Edit modes, the context will automatically be included. When using an agent, context will be suggested as an attachment. Selections are always included as context."),
			default: true,
		},
		'chat.editing.autoAcceptDelay': {
			type: 'number',
			markdownDescription: nls.localize('chat.editing.autoAcceptDelay', "Delay after which changes made by chat are automatically accepted. Values are in seconds, `0` means disabled and `100` seconds is the maximum."),
			default: 0,
			minimum: 0,
			maximum: 100
		},
		'chat.editing.confirmEditRequestRemoval': {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: nls.localize('chat.editing.confirmEditRequestRemoval', "Whether to show a confirmation before removing a request and its associated edits."),
			default: true,
		},
		'chat.editing.confirmEditRequestRetry': {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: nls.localize('chat.editing.confirmEditRequestRetry', "Whether to show a confirmation before retrying a request and its associated edits."),
			default: true,
		},
		'chat.editing.explainChanges.enabled': {
			type: 'boolean',
			markdownDescription: nls.localize('chat.editing.explainChanges.enabled', "Controls whether the Explain button in the Chat panel and the Explain Changes context menu in the SCM view are shown. This is an experimental feature."),
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
		'chat.experimental.detectParticipant.enabled': {
			type: 'boolean',
			deprecationMessage: nls.localize('chat.experimental.detectParticipant.enabled.deprecated', "This setting is deprecated. Please use `chat.detectParticipant.enabled` instead."),
			description: nls.localize('chat.experimental.detectParticipant.enabled', "Enables chat participant autodetection for panel chat."),
			default: null
		},
		'chat.detectParticipant.enabled': {
			type: 'boolean',
			description: nls.localize('chat.detectParticipant.enabled', "Enables chat participant autodetection for panel chat."),
			default: true
		},
		'chat.renderRelatedFiles': {
			type: 'boolean',
			description: nls.localize('chat.renderRelatedFiles', "Controls whether related files should be rendered in the chat input."),
			default: false
		},
		[ChatConfiguration.InlineReferencesStyle]: {
			type: 'string',
			enum: ['box', 'link'],
			enumDescriptions: [
				nls.localize('chat.inlineReferences.style.box', "Display file and symbol references as boxed widgets with icons."),
				nls.localize('chat.inlineReferences.style.link', "Display file and symbol references as simple blue links without icons.")
			],
			description: nls.localize('chat.inlineReferences.style', "Controls how file and symbol references are displayed in chat messages."),
			default: 'box'
		},
		[ChatConfiguration.EditorAssociations]: {
			type: 'object',
			markdownDescription: nls.localize('chat.editorAssociations', "Configure [glob patterns](https://aka.ms/vscode-glob-patterns) to editors for opening files from chat (for example `\"*.md\": \"vscode.markdown.preview.editor\"`)."),
			additionalProperties: {
				type: 'string'
			},
			default: {
			}
		},
		'chat.notifyWindowOnConfirmation': {
			type: 'boolean',
			description: nls.localize('chat.notifyWindowOnConfirmation', "Controls whether a chat session should present the user with an OS notification when a confirmation is needed while the window is not in focus. This includes a window badge as well as notification toast."),
			default: true,
		},
		[ChatConfiguration.GlobalAutoApprove]: {
			default: false,
			markdownDescription: globalAutoApproveDescription.value,
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION_MACHINE,
			tags: ['experimental'],
			policy: {
				name: 'ChatToolsAutoApprove',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.99',
				value: (account) => account.policyData?.chat_preview_features_enabled === false ? false : undefined,
				localization: {
					description: {
						key: 'autoApprove2.description',
						value: nls.localize('autoApprove2.description', 'Global auto approve also known as "YOLO mode" disables manual approval completely for all tools in all workspaces, allowing the agent to act fully autonomously. This is extremely dangerous and is *never* recommended, even containerized environments like Codespaces and Dev Containers have user keys forwarded into the container that could be compromised.\n\nThis feature disables critical security protections and makes it much easier for an attacker to compromise the machine.')
					}
				},
			}
		},
		[ChatConfiguration.AutoApproveEdits]: {
			default: {
				'**/*': true,
				'**/.vscode/*.json': false,
				'**/.git/**': false,
				'**/{package.json,package-lock.json,server.xml,build.rs,web.config,.gitattributes,.env}': false,
				'**/*.{code-workspace,csproj,fsproj,vbproj,vcxproj,proj,targets,props}': false,
			},
			markdownDescription: nls.localize('chat.tools.autoApprove.edits', "Controls whether edits made by chat are automatically approved. The default is to approve all edits except those made to certain files which have the potential to cause immediate unintended side-effects, such as `**/.vscode/*.json`.\n\nSet to `true` to automatically approve edits to matching files, `false` to always require explicit approval. The last pattern matching a given file will determine whether the edit is automatically approved."),
			type: 'object',
			additionalProperties: {
				type: 'boolean',
			}
		},
		[ChatConfiguration.AutoApprovedUrls]: {
			default: {},
			markdownDescription: nls.localize('chat.tools.fetchPage.approvedUrls', "Controls which URLs are automatically approved when requested by chat tools. Keys are URL patterns and values can be `true` to approve both requests and responses, `false` to deny, or an object with `approveRequest` and `approveResponse` properties for granular control.\n\nExamples:\n- `\"https://example.com\": true` - Approve all requests to example.com\n- `\"https://*.example.com\": true` - Approve all requests to any subdomain of example.com\n- `\"https://example.com/api/*\": { \"approveRequest\": true, \"approveResponse\": false }` - Approve requests but not responses for example.com/api paths"),
			type: 'object',
			additionalProperties: {
				oneOf: [
					{ type: 'boolean' },
					{
						type: 'object',
						properties: {
							approveRequest: { type: 'boolean' },
							approveResponse: { type: 'boolean' }
						}
					}
				]
			}
		},
		[ChatConfiguration.EligibleForAutoApproval]: {
			default: {},
			markdownDescription: nls.localize('chat.tools.eligibleForAutoApproval', 'Controls which tools are eligible for automatic approval. Tools set to \'false\' will always present a confirmation and will never offer the option to auto-approve. The default behavior (or setting a tool to \'true\') may result in the tool offering auto-approval options.'),
			type: 'object',
			propertyNames: {
				enum: toolReferenceNameEnumValues,
				enumDescriptions: toolReferenceNameEnumDescriptions,
			},
			additionalProperties: {
				type: 'boolean',
			},
			examples: [
				{
					'fetch': false,
					'runTask': false
				}
			],
			policy: {
				name: 'ChatToolsEligibleForAutoApproval',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.107',
				localization: {
					description: {
						key: 'chat.tools.eligibleForAutoApproval',
						value: nls.localize('chat.tools.eligibleForAutoApproval', 'Controls which tools are eligible for automatic approval. Tools set to \'false\' will always present a confirmation and will never offer the option to auto-approve. The default behavior (or setting a tool to \'true\') may result in the tool offering auto-approval options.')
					}
				},
			}
		},
		'chat.sendElementsToChat.enabled': {
			default: true,
			description: nls.localize('chat.sendElementsToChat.enabled', "Controls whether elements can be sent to chat from the Simple Browser."),
			type: 'boolean',
			tags: ['preview']
		},
		'chat.sendElementsToChat.attachCSS': {
			default: true,
			markdownDescription: nls.localize('chat.sendElementsToChat.attachCSS', "Controls whether CSS of the selected element will be added to the chat. {0} must be enabled.", '`#chat.sendElementsToChat.enabled#`'),
			type: 'boolean',
			tags: ['preview']
		},
		'chat.sendElementsToChat.attachImages': {
			default: true,
			markdownDescription: nls.localize('chat.sendElementsToChat.attachImages', "Controls whether a screenshot of the selected element will be added to the chat. {0} must be enabled.", '`#chat.sendElementsToChat.enabled#`'),
			type: 'boolean',
			tags: ['experimental']
		},
		'chat.undoRequests.restoreInput': {
			default: true,
			markdownDescription: nls.localize('chat.undoRequests.restoreInput', "Controls whether the input of the chat should be restored when an undo request is made. The input will be filled with the text of the request that was restored."),
			type: 'boolean',
		},
		'chat.editRequests': {
			markdownDescription: nls.localize('chat.editRequests', "Enables editing of requests in the chat. This allows you to change the request content and resubmit it to the model."),
			type: 'string',
			enum: ['inline', 'hover', 'input', 'none'],
			default: 'inline',
		},
		[ChatConfiguration.ChatViewSessionsEnabled]: {
			type: 'boolean',
			default: true,
			description: nls.localize('chat.viewSessions.enabled', "Show chat agent sessions when chat is empty or to the side when chat view is wide enough."),
		},
		[ChatConfiguration.ChatViewSessionsShowActiveOnly]: {
			type: 'boolean',
			default: true,
			markdownDescription: nls.localize('chat.viewSessions.showActiveOnly', "When enabled, only show active sessions in the stacked sessions view. When disabled, show all sessions. This setting requires {0} to be enabled.", '`#chat.viewSessions.enabled#`'),
		},
		[ChatConfiguration.ChatViewSessionsOrientation]: {
			type: 'string',
			enum: ['stacked', 'sideBySide'],
			enumDescriptions: [
				nls.localize('chat.viewSessions.orientation.stacked', "Display chat sessions vertically stacked above the chat input unless a chat session is visible."),
				nls.localize('chat.viewSessions.orientation.sideBySide', "Display chat sessions side by side if space is sufficient, otherwise fallback to stacked above the chat input unless a chat session is visible.")
			],
			default: 'sideBySide',
			description: nls.localize('chat.viewSessions.orientation', "Controls the orientation of the chat agent sessions view when it is shown alongside the chat."),
		},
		[ChatConfiguration.ChatViewTitleEnabled]: {
			type: 'boolean',
			default: true,
			description: nls.localize('chat.viewTitle.enabled', "Show the title of the chat above the chat in the chat view."),
		},
		[ChatConfiguration.NotifyWindowOnResponseReceived]: {
			type: 'boolean',
			default: true,
			description: nls.localize('chat.notifyWindowOnResponseReceived', "Controls whether a chat session should present the user with an OS notification when a response is received while the window is not in focus. This includes a window badge as well as notification toast."),
		},
		'chat.checkpoints.enabled': {
			type: 'boolean',
			default: true,
			description: nls.localize('chat.checkpoints.enabled', "Enables checkpoints in chat. Checkpoints allow you to restore the chat to a previous state."),
		},
		'chat.checkpoints.showFileChanges': {
			type: 'boolean',
			description: nls.localize('chat.checkpoints.showFileChanges', "Controls whether to show chat checkpoint file changes."),
			default: false
		},
		[mcpAccessConfig]: {
			type: 'string',
			description: nls.localize('chat.mcp.access', "Controls access to installed Model Context Protocol servers."),
			enum: [
				McpAccessValue.None,
				McpAccessValue.Registry,
				McpAccessValue.All
			],
			enumDescriptions: [
				nls.localize('chat.mcp.access.none', "No access to MCP servers."),
				nls.localize('chat.mcp.access.registry', "Allows access to MCP servers installed from the registry that LoCoPilot is connected to."),
				nls.localize('chat.mcp.access.any', "Allow access to any installed MCP server.")
			],
			default: McpAccessValue.All,
			policy: {
				name: 'ChatMCP',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.99',
				value: (account) => {
					if (account.policyData?.mcp === false) {
						return McpAccessValue.None;
					}
					if (account.policyData?.mcpAccess === 'registry_only') {
						return McpAccessValue.Registry;
					}
					return undefined;
				},
				localization: {
					description: {
						key: 'chat.mcp.access',
						value: nls.localize('chat.mcp.access', "Controls access to installed Model Context Protocol servers.")
					},
					enumDescriptions: [
						{
							key: 'chat.mcp.access.none', value: nls.localize('chat.mcp.access.none', "No access to MCP servers."),
						},
						{
							key: 'chat.mcp.access.registry', value: nls.localize('chat.mcp.access.registry', "Allows access to MCP servers installed from the registry that LoCoPilot is connected to."),
						},
						{
							key: 'chat.mcp.access.any', value: nls.localize('chat.mcp.access.any', "Allow access to any installed MCP server.")
						}
					]
				},
			}
		},
		[mcpAutoStartConfig]: {
			type: 'string',
			description: nls.localize('chat.mcp.autostart', "Controls whether MCP servers should be automatically started when the chat messages are submitted."),
			default: McpAutoStartValue.Never,
			enum: [
				McpAutoStartValue.Never,
				McpAutoStartValue.OnlyNew,
				McpAutoStartValue.NewAndOutdated
			],
			enumDescriptions: [
				nls.localize('chat.mcp.autostart.never', "Never automatically start MCP servers."),
				nls.localize('chat.mcp.autostart.onlyNew', "Only automatically start new MCP servers that have never been run."),
				nls.localize('chat.mcp.autostart.newAndOutdated', "Automatically start new and outdated MCP servers that are not yet running.")
			],
			tags: ['experimental'],
		},
		[mcpAppsEnabledConfig]: {
			type: 'boolean',
			description: nls.localize('chat.mcp.ui.enabled', "Controls whether MCP servers can provide custom UI for tool invocations."),
			default: true,
			tags: ['experimental'],
		},
		[mcpServerSamplingSection]: {
			type: 'object',
			description: nls.localize('chat.mcp.serverSampling', "Configures which models are exposed to MCP servers for sampling (making model requests in the background). This setting can be edited in a graphical way under the `{0}` command.", 'MCP: ' + nls.localize('mcp.list', 'List Servers')),
			scope: ConfigurationScope.RESOURCE,
			additionalProperties: {
				type: 'object',
				properties: {
					allowedDuringChat: {
						type: 'boolean',
						description: nls.localize('chat.mcp.serverSampling.allowedDuringChat', "Whether this server is make sampling requests during its tool calls in a chat session."),
						default: true,
					},
					allowedOutsideChat: {
						type: 'boolean',
						description: nls.localize('chat.mcp.serverSampling.allowedOutsideChat', "Whether this server is allowed to make sampling requests outside of a chat session."),
						default: false,
					},
					allowedModels: {
						type: 'array',
						items: {
							type: 'string',
							description: nls.localize('chat.mcp.serverSampling.model', "A model the MCP server has access to."),
						},
					}
				}
			},
		},
		[AssistedTypes[AddConfigurationType.NuGetPackage].enabledConfigKey]: {
			type: 'boolean',
			description: nls.localize('chat.mcp.assisted.nuget.enabled.description', "Enables NuGet packages for AI-assisted MCP server installation. Used to install MCP servers by name from the central registry for .NET packages (NuGet.org)."),
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'startup'
			}
		},
		[ChatConfiguration.Edits2Enabled]: {
			type: 'boolean',
			description: nls.localize('chat.edits2Enabled', "Enable the new Edits mode that is based on tool-calling. When this is enabled, models that don't support tool-calling are unavailable for Edits mode."),
			default: false,
		},
		[ChatConfiguration.ExtensionToolsEnabled]: {
			type: 'boolean',
			description: nls.localize('chat.extensionToolsEnabled', "Enable using tools contributed by third-party extensions."),
			default: true,
			policy: {
				name: 'ChatAgentExtensionTools',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.99',
				localization: {
					description: {
						key: 'chat.extensionToolsEnabled',
						value: nls.localize('chat.extensionToolsEnabled', "Enable using tools contributed by third-party extensions.")
					}
				},
			}
		},
		[ChatConfiguration.AgentEnabled]: {
			type: 'boolean',
			description: nls.localize('chat.agent.enabled.description', "When enabled, agent mode can be activated from chat and tools in agentic contexts with side effects can be used."),
			default: true,
			policy: {
				name: 'ChatAgentMode',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.99',
				value: (account) => account.policyData?.chat_agent_enabled === false ? false : undefined,
				localization: {
					description: {
						key: 'chat.agent.enabled.description',
						value: nls.localize('chat.agent.enabled.description', "When enabled, agent mode can be activated from chat and tools in agentic contexts with side effects can be used."),
					}
				}
			}
		},
		[ChatConfiguration.WebSearchApiKey]: {
			type: 'string',
			markdownDescription: nls.localize('chat.webSearch.apiKey.description', "Optional API key for the web search tool. **No key needed:** web search works out of the box using DuckDuckGo (no key, no expiry). For better rate limits and quality, set a Brave Search API key here. Get a free key at https://brave.com/search/api/. **Where to set:** Open Settings (File > Preferences > Settings or `#: Open Settings`), search for `chat.webSearch.apiKey` or \"web search api key\", and paste your key."),
			default: '',
			scope: ConfigurationScope.APPLICATION,
			tags: ['usesOnlineServices'],
		},
		[ChatConfiguration.LocopilotLlamaCppServerPath]: {
			type: 'string',
			description: nls.localize('locopilot.llamaCpp.serverPath.description', "Advanced override for the llama-server binary. LoCoPilot ships a bundled llama.cpp engine, so this is normally left empty. Set it only to point at your own build (full path to the binary, e.g. /path/to/llama-server or C:\\llama.cpp\\build\\bin\\llama-server.exe, or the directory that contains it)."),
			default: '',
		},
		[ChatConfiguration.LocopilotLlamaCppEngine]: {
			type: 'string',
			enum: ['auto', 'cpu', 'gpu'],
			enumDescriptions: [
				nls.localize('locopilot.llamaCpp.engine.auto', "Automatic (default): use the bundled GPU (Vulkan) engine when a capable GPU is detected (discrete NVIDIA/AMD, or a dedicated GPU with enough VRAM), otherwise the CPU engine. On Apple Silicon this is always the Metal engine."),
				nls.localize('locopilot.llamaCpp.engine.cpu', "Force the CPU engine. Most compatible; use this if the GPU engine misbehaves on your machine."),
				nls.localize('locopilot.llamaCpp.engine.gpu', "Force the bundled GPU (Vulkan) engine, even on integrated GPUs that automatic mode would skip. Requires a GPU with up-to-date drivers; falls back to CPU if the GPU engine was not bundled in this build. No effect on Apple Silicon (always Metal)."),
			],
			markdownDescription: nls.localize('locopilot.llamaCpp.engine.description', "Which bundled engine to run local GGUF models with. `auto` picks the GPU (Vulkan) engine when a capable GPU is detected and the CPU engine otherwise. Set `cpu` to always run on the CPU, or `gpu` to force the GPU engine (useful for a capable integrated GPU that `auto` conservatively skips). Ignored when `#locopilot.llamaCpp.serverPath#` points at your own build, and on Apple Silicon (which always uses Metal)."),
			default: 'auto',
		},
		[ChatConfiguration.LocopilotMlxPythonPath]: {
			type: 'string',
			description: nls.localize('locopilot.mlx.pythonPath.description', "Advanced override for the Python interpreter used to run `python -m mlx_lm.server` (local Hugging Face MLX models, Apple Silicon). LoCoPilot ships a bundled self-contained Python with mlx-lm pre-installed, so this is normally left empty. Set it only to use your own interpreter (e.g. /path/to/.venv/bin/python3)."),
			default: '',
		},
		[ChatConfiguration.LocopilotLlamaCppContextSize]: {
			type: 'number',
			minimum: 512,
			markdownDescription: nls.localize('locopilot.llamaCpp.contextSize.description', "Context window (`-c`) for the local llama.cpp server. A smaller window means a smaller KV cache, faster prompt processing, and less memory. Increase it only if you need longer prompts."),
			default: 16384,
		},
		[ChatConfiguration.LocopilotLlamaCppFlashAttention]: {
			type: 'string',
			enum: ['auto', 'on', 'off'],
			enumDescriptions: [
				nls.localize('locopilot.llamaCpp.fa.auto', "Enable Flash Attention where supported and automatically fall back to standard attention otherwise (recommended)."),
				nls.localize('locopilot.llamaCpp.fa.on', "Force Flash Attention on. Fails to start on backends that do not support it."),
				nls.localize('locopilot.llamaCpp.fa.off', "Disable Flash Attention."),
			],
			markdownDescription: nls.localize('locopilot.llamaCpp.flashAttention.description', "Flash Attention mode (`-fa`) for the local llama.cpp server. `auto` is the safe default: llama.cpp uses Flash Attention when the model and hardware support it and falls back to standard attention otherwise."),
			default: 'auto',
		},
		[ChatConfiguration.LocopilotLlamaCppKvCacheType]: {
			type: 'string',
			enum: ['auto', 'f16', 'q8_0', 'q4_0'],
			enumDescriptions: [
				nls.localize('locopilot.llamaCpp.kv.auto', "Automatic (default): evaluates the model's GGUF attention geometry, weights, requested context and hardware memory budget at launch. It keeps f16 for small windows, prefers near-lossless q8_0 for larger windows, and uses q4_0 when that materially extends a context that q8_0 cannot fit."),
				nls.localize('locopilot.llamaCpp.kv.f16', "Full-precision KV cache (always safe)."),
				nls.localize('locopilot.llamaCpp.kv.q8_0', "8-bit KV cache: ~half the memory, slightly faster. Requires Flash Attention (auto-enabled)."),
				nls.localize('locopilot.llamaCpp.kv.q4_0', "4-bit KV cache: smallest memory, fastest. May slightly reduce quality. Requires Flash Attention (auto-enabled)."),
			],
			markdownDescription: nls.localize('locopilot.llamaCpp.kvCacheType.description', "KV cache quantization (`--cache-type-k/v`) for the local llama.cpp server. Quantizing shrinks the cache so more context fits on the GPU. `auto` dynamically compares f16, q8_0 and q4_0 using the selected model's real attention geometry and the launch memory budget: f16 for small windows, near-lossless q8_0 for normal/large windows, or q4_0 when it grants a larger safe context. When quantized, Flash Attention is auto-enabled (required), so this never fails to start."),
			default: 'auto',
		},
		[ChatConfiguration.LocopilotLlamaCppMtp]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.llamaCpp.mtp.description', "Enable Multi-Token Prediction / NextN speculative decoding for the local llama.cpp server. When on, the model file is also passed as `--model-draft` and the flags in `#locopilot.llamaCpp.mtpArgs#` are appended. **Only enable this for models trained with MTP/NextN heads** (e.g. Qwen3.5/3.6, DeepSeek V3/R1, Gemma 4) on a **recent llama.cpp build (~b9180+)**. Older builds reject the flags and fail to start. Can also be toggled per model in LoCoPilot Settings."),
			default: false,
		},
		[ChatConfiguration.LocopilotLlamaCppMtpArgs]: {
			type: 'string',
			markdownDescription: nls.localize('locopilot.llamaCpp.mtpArgs.description', "Flags appended after `--model-draft <model>` when Multi-Token Prediction is enabled. The exact value is build-specific. Run `llama-server -h` to see your build's supported `--spec-type` values (e.g. `draft-mtp`, `draft-eagle3`, `ngram-cache`). Adjust this if your build differs; clear it to pass only `--model-draft`."),
			default: '--spec-type draft-mtp',
		},
		[ChatConfiguration.LocopilotLlamaCppCacheReuse]: {
			type: 'number',
			minimum: 0,
			markdownDescription: nls.localize('locopilot.llamaCpp.cacheReuse.description', "Minimum chunk size to reuse from the KV cache via shifting (`--cache-reuse`) on the local llama.cpp server. Lets repeated prompt prefixes (like the system prompt resent on every agent turn) skip reprocessing, which noticeably speeds up multi-turn/tool conversations. Set to `0` to disable."),
			default: 256,
		},
		[ChatConfiguration.LocopilotLlamaCppDraftModelPath]: {
			type: 'string',
			markdownDescription: nls.localize('locopilot.llamaCpp.draftModelPath.description', "Path to a separate, smaller GGUF model used for **speculative decoding** (`--model-draft`) on the local llama.cpp server. The small draft model proposes tokens that the main model verifies in one pass, typically giving 1.5-2.5x faster generation when they agree. Pick a much smaller model from the same family (e.g. a 0.5B-1B draft for a 7B+ target). Leave empty to disable. Ignored when `#locopilot.llamaCpp.multiTokenPrediction#` is on (that uses the model's own embedded draft head)."),
			default: '',
		},
		[ChatConfiguration.LocopilotLlamaCppDraftGpuLayers]: {
			type: 'number',
			minimum: 0,
			markdownDescription: nls.localize('locopilot.llamaCpp.draftGpuLayers.description', "GPU layers to offload for the speculative-decoding draft model (`--gpu-layers-draft`). `0` keeps the draft model on the CPU. Only used when `#locopilot.llamaCpp.draftModelPath#` is set."),
			default: 0,
		},
		[ChatConfiguration.LocopilotLlamaCppParallel]: {
			type: 'number',
			minimum: 0,
			markdownDescription: nls.localize('locopilot.llamaCpp.parallel.description', "Number of parallel request slots (`--parallel`) for the local llama.cpp server. Values above 1 let the server handle several requests at once (e.g. chat alongside inline completions) by splitting the KV cache into that many slots, at the cost of less context per slot. `1` (default) uses a single slot so each request gets the full context window - recommended for single-user local use. `0` lets llama.cpp auto-detect (which may pick several slots)."),
			default: 1,
		},
		[ChatConfiguration.LocopilotLlamaCppContinuousBatching]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.llamaCpp.continuousBatching.description', "Enable continuous batching (`-cb`) on the local llama.cpp server so concurrent requests are interleaved for higher throughput. Only has an effect when `#locopilot.llamaCpp.parallel#` is greater than 1. Recent llama.cpp builds enable this by default."),
			default: false,
		},
		[ChatConfiguration.LocopilotLlamaCppThreads]: {
			type: 'number',
			minimum: 0,
			markdownDescription: nls.localize('locopilot.llamaCpp.threads.description', "CPU threads (`--threads`) for the local llama.cpp server. `0` lets llama.cpp auto-detect. Set to your physical (performance) core count if auto-detection is suboptimal on a hybrid CPU."),
			default: 0,
		},
		[ChatConfiguration.LocopilotLlamaCppBatchSize]: {
			type: 'number',
			minimum: 0,
			markdownDescription: nls.localize('locopilot.llamaCpp.batchSize.description', "Logical batch size (`--batch-size`) for prompt processing on the local llama.cpp server. `0` uses the build default (2048). Larger values can speed up prefill of long prompts at the cost of memory."),
			default: 0,
		},
		[ChatConfiguration.LocopilotLlamaCppUbatchSize]: {
			type: 'number',
			minimum: 0,
			markdownDescription: nls.localize('locopilot.llamaCpp.ubatchSize.description', "Physical batch size (`--ubatch-size`) for the local llama.cpp server. `0` uses the build default (512). Larger values can speed up prefill at the cost of memory."),
			default: 0,
		},
		[ChatConfiguration.LocopilotLlamaCppWarmup]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.llamaCpp.warmup.description', "After the local llama.cpp server starts, send a tiny background request to pre-compile GPU kernels and warm the cache, so your first real message responds without the initial lag. Best-effort; failures are ignored."),
			default: true,
		},
		[ChatConfiguration.LocopilotLlamaCppMlock]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.llamaCpp.mlock.description', "Lock model weights into RAM (`--mlock`) so they are never paged out. Can speed up inference but may fail to start without sufficient memory or locked-memory privileges, so it is off by default."),
			default: false,
		},
		[ChatConfiguration.LocopilotLlamaCppSwaFull]: {
			type: 'string',
			enum: ['auto', 'on', 'off'],
			enumDescriptions: [
				nls.localize('locopilot.llamaCpp.swaFull.auto', "Enable the full SWA cache automatically for sliding-window models when it fits your memory budget (recommended)."),
				nls.localize('locopilot.llamaCpp.swaFull.on', "Always keep the full SWA cache. Faster reuse on Gemma-class models, but uses more memory."),
				nls.localize('locopilot.llamaCpp.swaFull.off', "Never keep the full SWA cache (llama.cpp default). Lowest memory, but every turn re-processes the whole prompt on these models."),
			],
			markdownDescription: nls.localize('locopilot.llamaCpp.swaFull.description', "Keep a **full-size KV cache** for sliding-window attention models (`--swa-full`), such as Gemma 2/3. These models otherwise keep only a small window of KV cache, which makes the local server discard its prompt cache and re-process the entire prompt on every turn - very slow on long agent conversations. `auto` (default) turns the full cache on only for sliding-window models that still fit your memory budget with it; `on` forces it; `off` uses the llama.cpp default. No effect on non-sliding-window models (most Llama/Qwen/Mistral builds). Newer llama.cpp flag - builds that don't support it are detected at launch and relaunched without it."),
			default: 'auto',
		},
		[ChatConfiguration.LocopilotLlamaCppCpuMoeLayers]: {
			type: 'number',
			minimum: -1,
			markdownDescription: nls.localize('locopilot.llamaCpp.cpuMoeLayers.description', "Mixture-of-Experts (MoE) expert offload (`--n-cpu-moe`) for the local llama.cpp server. Keeps the expert tensors of N transformer blocks in system RAM while attention stays on the GPU, so a large MoE model (e.g. a 35B-A3B) can run on a small GPU at near-full speed. `-1` (default) is **automatic**: LoCoPilot detects MoE models from their metadata and offloads only as many blocks as needed to fit your GPU/Metal memory. `0` disables offload (force full GPU). A positive value offloads exactly that many blocks. No effect on dense (non-MoE) models."),
			default: -1,
		},
		[ChatConfiguration.LocopilotLlamaCppOverrideTensor]: {
			type: 'string',
			editPresentation: EditPresentationTypes.Multiline,
			markdownDescription: nls.localize('locopilot.llamaCpp.overrideTensor.description', "Fine-grained tensor placement (`--override-tensor` / `-ot`) for the local llama.cpp server, **one rule per line**. Each rule is `<tensor-name-regex>=<device>` and pins the matching tensors to a device (e.g. `blk\\.(1[0-9])\\.ffn_.*_exps\\.=CPU` keeps the routed experts of blocks 10-19 in system RAM). This is the tensor-level version of `#locopilot.llamaCpp.cpuMoeLayers#`: it can fit more model onto the same GPU by offloading exactly the blocks you choose. **Leave empty (default) for automatic placement** - LoCoPilot sizes an expert offload from each block's real weight size. When set, these rules take over and `--n-cpu-moe` is not emitted. Advanced; invalid regexes or device names can prevent the server from starting."),
			default: '',
		},
		[ChatConfiguration.LocopilotLlamaCppPromptLookup]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.llamaCpp.promptLookup.description', "Enable prompt-lookup / n-gram speculative decoding on the local llama.cpp server. Drafts tokens by matching n-grams already in the context (no separate draft model), which speeds up highly repetitive generation like code edits. **Build-specific and opt-in**: the flags in `#locopilot.llamaCpp.promptLookupArgs#` are appended and may not be supported by every llama.cpp build (older builds can fail to start). Off by default."),
			default: false,
		},
		[ChatConfiguration.LocopilotLlamaCppPromptLookupArgs]: {
			type: 'string',
			markdownDescription: nls.localize('locopilot.llamaCpp.promptLookupArgs.description', "Flags appended when `#locopilot.llamaCpp.promptLookup#` is on. Build-specific; the default is `--spec-type ngram-cache`. Run `llama-server -h` to see your build's supported speculative options and adjust this if needed."),
			default: '--spec-type ngram-cache',
		},
		[ChatConfiguration.LocopilotLlamaCppSlotSavePath]: {
			type: 'string',
			markdownDescription: nls.localize('locopilot.llamaCpp.slotSavePath.description', "Directory where the local llama.cpp server persists per-slot KV cache to disk (`--slot-save-path`). When set, a previously-processed prompt prefix (like the agent system prompt) can be restored across restarts instead of being re-processed, so the first turn after a relaunch is fast. The directory must exist. Leave empty to disable."),
			default: '',
		},
		[ChatConfiguration.LocopilotLlamaCppExtraArgs]: {
			type: 'string',
			markdownDescription: nls.localize('locopilot.llamaCpp.extraArgs.description', "Extra command-line arguments appended verbatim to the local `llama-server` command (advanced). Example: `--threads 8 --batch-size 2048`. Invalid flags for your build may prevent the server from starting."),
			default: '',
		},
		[ChatConfiguration.LocopilotLlamaCppAutoSpeculative]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.llamaCpp.autoSpeculative.description', "Speed up local GGUF models with **automatic speculative decoding**. When a small same-family draft model is available for the selected model (downloaded alongside it), it fits your RAM, and a GPU/Metal backend is active, it is used to draft tokens the main model verifies in one pass (typically 1.5-2x faster generation). Otherwise - including on CPU-only machines, where a second model would compete for the same cores - n-gram drafting from the prompt itself is used (no extra memory; fastest on repetitive output like code edits). Skipped automatically for MTP models (they self-draft), when you set `#locopilot.llamaCpp.draftModelPath#` or `#locopilot.llamaCpp.promptLookup#` manually, and on llama.cpp builds that don't support speculation (detected at launch; the server is relaunched without it)."),
			default: true,
		},
		[ChatConfiguration.LocopilotLlamaCppCudaEngine]: {
			type: 'string',
			enum: ['auto', 'on', 'off'],
			enumDescriptions: [
				nls.localize('locopilot.llamaCpp.cudaEngine.auto', "Offer to download the CUDA engine once when an NVIDIA GPU is detected; use it whenever installed (recommended)."),
				nls.localize('locopilot.llamaCpp.cudaEngine.on', "Download the CUDA engine automatically (no prompt) when an NVIDIA GPU is detected, and use it."),
				nls.localize('locopilot.llamaCpp.cudaEngine.off', "Never download or use the CUDA engine (the bundled Vulkan/CPU engines are used instead)."),
			],
			markdownDescription: nls.localize('locopilot.llamaCpp.cudaEngine.description', "On Windows with an NVIDIA GPU, LoCoPilot can download the official llama.cpp **CUDA** engine (~650 MB, from the llama.cpp GitHub releases) for much faster prompt processing than the bundled Vulkan engine - often several times faster time-to-first-token on long prompts. The download happens once; the engine is stored locally and used for every local GGUF model start. Ignored on macOS/Linux and when `#locopilot.llamaCpp.serverPath#` points at your own build."),
			default: 'auto',
		},
		[ChatConfiguration.LocopilotMlxAutoTune]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.mlx.autoTune.description', "Automatically tune the local MLX server (Apple Silicon): use a small same-family draft model for **speculative decoding** when one is available and fits your RAM (typically 1.5-2x faster generation), and cap the server's cross-request prompt cache to a sensible fraction of total RAM so cached prompts never crowd out the working set. If the installed mlx-lm version doesn't support these options, the server is relaunched without them automatically."),
			default: true,
		},
		[ChatConfiguration.LocopilotOllamaKeepAlive]: {
			type: 'string',
			markdownDescription: nls.localize('locopilot.ollama.keepAlive.description', "How long Ollama keeps a model loaded in memory after use (`ollama run --keepalive`), e.g. `30m`, `1h`, or `-1` to keep it loaded indefinitely. Keeping the model resident avoids the cold-start reload between requests. Leave empty to use Ollama's default."),
			default: '30m',
		},
		[ChatConfiguration.LocopilotLocalAutoStartServer]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.local.autoStartServer.description', "Automatically start the local server (llama.cpp for GGUF, mlx-lm for MLX) when you send a message to a downloaded local model whose server is not running, so you can just pick the model and chat. When off, you start servers manually from My Models."),
			default: true,
		},
		[ChatConfiguration.LocopilotLocalSingleActiveModel]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.local.singleActiveModel.description', "Keep only one local model loaded at a time. When on, switching models stops the previous local server immediately, forcing a full reload if you switch back. Leave off (default) to keep recently-used models warm under `#locopilot.local.maxResidentModels#` and `#locopilot.local.keepAliveMinutes#`, so switching back is instant."),
			default: false,
		},
		[ChatConfiguration.LocopilotLocalPrewarmOnSelect]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.local.prewarmOnSelect.description', "Start a local model's server as soon as you pick it in the model dropdown, instead of waiting for your first message. The model loads into memory while you type, so the first response no longer pays the cold-start delay."),
			default: true,
		},
		[ChatConfiguration.LocopilotLocalPrewarmStartupDelayMs]: {
			type: 'number',
			minimum: 0,
			markdownDescription: nls.localize('locopilot.local.prewarmStartupDelayMs.description', "Extra delay, in milliseconds, before a background pre-warm launches after the window has finished loading. Used when a pre-warm is triggered while the workbench is still settling (for example a very early model pick). App start/restart no longer auto-starts the last-selected model; picking a model in the dropdown still warms promptly once the window is idle. Set to `0` to disable the extra delay."),
			default: 500,
		},
		[ChatConfiguration.LocopilotLocalKeepAliveMinutes]: {
			type: 'number',
			minimum: 0,
			markdownDescription: nls.localize('locopilot.local.keepAliveMinutes.description', "How long (in minutes) a local model server stays loaded after its last request before it is unloaded to free memory. Keeping it resident lets you switch back to a recent model with no reload. Set to `0` to never auto-unload."),
			default: 30,
		},
		[ChatConfiguration.LocopilotLocalMaxResidentModels]: {
			type: 'number',
			minimum: 1,
			markdownDescription: nls.localize('locopilot.local.maxResidentModels.description', "Maximum number of local model servers kept loaded in memory at the same time. When you exceed this, the least-recently-used model is unloaded (LRU). The default of 1 keeps memory usage lowest (switching models triggers a reload); raise it to keep recently-used models warm for instant switching, at the cost of more RAM. Acts as a hard upper bound; the actual number may be lower when `#locopilot.local.memoryBudgetFraction#` would be exceeded. Servers of a different engine (llama.cpp vs MLX) are always unloaded on switch regardless of this value. Ignored when `#locopilot.local.singleActiveModel#` is on (which forces 1)."),
			default: 1,
		},
		[ChatConfiguration.LocopilotLocalMemoryBudgetFraction]: {
			type: 'number',
			minimum: 0.1,
			maximum: 0.95,
			markdownDescription: nls.localize('locopilot.local.memoryBudgetFraction.description', "Fraction of total system RAM that all resident local models may collectively occupy. Before loading a model, least-recently-used models are unloaded until the estimated total fits within this fraction (and `#locopilot.local.minFreeMemoryGB#` is respected). Keeps switching fast without driving the machine into swap. Only applied on Apple Silicon and CPU backends, where weights live in system RAM; discrete-GPU backends fall back to the `#locopilot.local.maxResidentModels#` count."),
			default: 0.7,
		},
		[ChatConfiguration.LocopilotLocalMinFreeMemoryGB]: {
			type: 'number',
			minimum: 0,
			markdownDescription: nls.localize('locopilot.local.minFreeMemoryGB.description', "Hard floor (in GB) of free system RAM to preserve. If loading a local model would leave less than this much memory free, least-recently-used models are unloaded first. A safety net against out-of-memory and swapping even when `#locopilot.local.memoryBudgetFraction#` would otherwise allow the load."),
			default: 2,
		},
		[ChatConfiguration.LocopilotLocalMemoryWatchdog]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.local.memoryWatchdog.description', "Automatically stop local model servers when the system runs critically low on memory, instead of letting the machine slow to a crawl (swapping/overheating). A notification explains what was stopped and why. Strongly recommended to leave on."),
			default: true,
		},
		[ChatConfiguration.LocopilotLocalBackgroundPriority]: {
			type: 'boolean',
			markdownDescription: nls.localize('locopilot.local.backgroundPriority.description', "Run local model server processes at a lower scheduling priority so the editor and the rest of the system stay responsive while a model is loading or generating. On Apple Silicon this also lets macOS prefer efficiency cores under load, which runs cooler. The model still gets full speed when the machine is otherwise idle."),
			default: true,
		},
		[ChatConfiguration.LocopilotLocalPerformanceProfile]: {
			type: 'string',
			enum: ['performance', 'balanced', 'quiet'],
			enumDescriptions: [
				nls.localize('locopilot.local.performanceProfile.performance', "Maximum throughput using all detected performance cores and the largest safe prefill batches."),
				nls.localize('locopilot.local.performanceProfile.balanced', "Use about 75% of CPU cores and moderate prefill batches for lower sustained heat with a small speed trade-off."),
				nls.localize('locopilot.local.performanceProfile.quiet', "Use about half the CPU cores and small prefill batches for the lowest heat and power consumption."),
			],
			markdownDescription: nls.localize('locopilot.local.performanceProfile.description', "Power and thermal profile for sustained local inference. `performance` preserves maximum speed. Choose `balanced` or `quiet` on laptops or passively cooled systems to reduce heat and throttling during long sessions."),
			default: 'performance',
		},
		[ChatConfiguration.LocopilotShowToolDetails]: {
			type: 'boolean',
			default: false,
			description: nls.localize('locopilot.chat.showToolDetails.description', "When enabled, tool call parameters and results are shown in the chat panel. When disabled, only the tool name is shown."),
		},
		'locopilot.retrieval.enabled': {
			type: 'boolean',
			default: true,
			description: nls.localize('locopilot.retrieval.enabled.description', "Enable local semantic code search (the semanticSearch tool). Builds a private embedding index of your workspace in the background, stored only on your machine under .locopilot/. Requires a local embedding backend (Ollama with `ollama pull nomic-embed-text`, or a configured embedding endpoint)."),
		},
		'locopilot.retrieval.embeddingModel': {
			type: 'string',
			default: 'nomic-embed-text',
			description: nls.localize('locopilot.retrieval.embeddingModel.description', "Embedding model used for semantic code search. Default is nomic-embed-text (Apache-2.0, runs locally via Ollama). Changing this rebuilds the index."),
		},
		'locopilot.retrieval.ollamaUrl': {
			type: 'string',
			default: 'http://localhost:11434',
			description: nls.localize('locopilot.retrieval.ollamaUrl.description', "Base URL of the Ollama server used for embeddings (semantic code search)."),
		},
		'locopilot.retrieval.embeddingUrl': {
			type: 'string',
			default: '',
			description: nls.localize('locopilot.retrieval.embeddingUrl.description', "Optional: an OpenAI-compatible /v1/embeddings endpoint to use instead of Ollama (e.g. a llama.cpp embedding server, LM Studio, or a cloud provider). Leave empty to auto-detect Ollama."),
		},
		'locopilot.retrieval.embeddingApiKey': {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			tags: ['usesOnlineServices'],
			description: nls.localize('locopilot.retrieval.embeddingApiKey.description', "Optional API key sent as a Bearer token to the configured embedding endpoint (only needed for cloud embedding providers; leave empty for local backends)."),
		},
		[ChatConfiguration.EditModeHidden]: {
			type: 'boolean',
			description: nls.localize('chat.editMode.hidden', "When enabled, hides the Edit mode from the chat mode picker."),
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
		[ChatConfiguration.AlternativeToolAction]: {
			type: 'boolean',
			description: nls.localize('chat.alternativeToolAction', "When enabled, shows the Configure Tools action in the mode picker dropdown on hover instead of in the chat input."),
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
		[ChatConfiguration.EnableMath]: {
			type: 'boolean',
			description: nls.localize('chat.mathEnabled.description', "Enable math rendering in chat responses using KaTeX."),
			default: true,
		},
		[ChatConfiguration.ShowCodeBlockProgressAnimation]: {
			type: 'boolean',
			description: nls.localize('chat.codeBlock.showProgressAnimation.description', "When applying edits, show a progress animation in the code block pill. If disabled, shows the progress percentage instead."),
			default: true,
			tags: ['experimental'],
		},
		['chat.statusWidget.sku']: {
			type: 'string',
			enum: ['free', 'anonymous'],
			enumDescriptions: [
				nls.localize('chat.statusWidget.sku.free', "Show status widget for free tier users."),
				nls.localize('chat.statusWidget.sku.anonymous', "Show status widget for anonymous users.")
			],
			description: nls.localize('chat.statusWidget.enabled.description', "Controls which user type should see the status widget in new chat sessions when quota is exceeded."),
			default: undefined,
			tags: ['experimental', 'advanced'],
			experiment: {
				mode: 'auto'
			}
		},
		[mcpDiscoverySection]: {
			type: 'object',
			properties: Object.fromEntries(allDiscoverySources.map(k => [k, { type: 'boolean', description: discoverySourceSettingsLabel[k] }])),
			additionalProperties: false,
			default: Object.fromEntries(allDiscoverySources.map(k => [k, false])),
			markdownDescription: nls.localize('mcp.discovery.enabled', "Configures discovery of Model Context Protocol servers from configuration from various other applications."),
		},
		[mcpGalleryServiceEnablementConfig]: {
			type: 'boolean',
			default: false,
			tags: ['preview'],
			description: nls.localize('chat.mcp.gallery.enabled', "Enables the default Marketplace for Model Context Protocol (MCP) servers."),
			included: product.quality === 'stable'
		},
		[mcpGalleryServiceUrlConfig]: {
			type: 'string',
			description: nls.localize('mcp.gallery.serviceUrl', "Configure the MCP Gallery service URL to connect to"),
			default: '',
			scope: ConfigurationScope.APPLICATION,
			tags: ['usesOnlineServices', 'advanced'],
			included: false,
			policy: {
				name: 'McpGalleryServiceUrl',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.101',
				value: (account) => account.policyData?.mcpRegistryUrl,
				localization: {
					description: {
						key: 'mcp.gallery.serviceUrl',
						value: nls.localize('mcp.gallery.serviceUrl', "Configure the MCP Gallery service URL to connect to"),
					}
				}
			},
		},
		[PromptsConfig.INSTRUCTIONS_LOCATION_KEY]: {
			type: 'object',
			title: nls.localize(
				'chat.instructions.config.locations.title',
				"Instructions File Locations",
			),
			markdownDescription: nls.localize(
				'chat.instructions.config.locations.description',
				"Specify location(s) of instructions files (`*{0}`) that can be attached in Chat sessions. [Learn More]({1}).\n\nRelative paths are resolved from the root folder(s) of your workspace.",
				INSTRUCTION_FILE_EXTENSION,
				INSTRUCTIONS_DOCUMENTATION_URL,
			),
			default: {
				[INSTRUCTIONS_DEFAULT_SOURCE_FOLDER]: true,
			},
			additionalProperties: { type: 'boolean' },
			propertyNames: {
				pattern: VALID_PROMPT_FOLDER_PATTERN,
				patternErrorMessage: nls.localize('chat.instructionsLocations.invalidPath', "Paths must be relative or start with '~/'. Absolute paths and '\\' separators are not supported. Glob patterns are deprecated and will be removed in future versions."),
			},
			restricted: true,
			tags: ['prompts', 'reusable prompts', 'prompt snippets', 'instructions'],
			examples: [
				{
					[INSTRUCTIONS_DEFAULT_SOURCE_FOLDER]: true,
				},
				{
					[INSTRUCTIONS_DEFAULT_SOURCE_FOLDER]: true,
					'/Users/vscode/repos/instructions': true,
				},
			],
		},
		[PromptsConfig.PROMPT_LOCATIONS_KEY]: {
			type: 'object',
			title: nls.localize(
				'chat.reusablePrompts.config.locations.title',
				"Prompt File Locations",
			),
			markdownDescription: nls.localize(
				'chat.reusablePrompts.config.locations.description',
				"Specify location(s) of reusable prompt files (`*{0}`) that can be run in Chat sessions. [Learn More]({1}).\n\nRelative paths are resolved from the root folder(s) of your workspace.",
				PROMPT_FILE_EXTENSION,
				PROMPT_DOCUMENTATION_URL,
			),
			default: {
				[PROMPT_DEFAULT_SOURCE_FOLDER]: true,
			},
			additionalProperties: { type: 'boolean' },
			unevaluatedProperties: { type: 'boolean' },
			propertyNames: {
				pattern: VALID_PROMPT_FOLDER_PATTERN,
				patternErrorMessage: nls.localize('chat.promptFileLocations.invalidPath', "Paths must be relative or start with '~/'. Absolute paths and '\\' separators are not supported. Glob patterns are deprecated and will be removed in future versions."),
			},
			restricted: true,
			tags: ['prompts', 'reusable prompts', 'prompt snippets', 'instructions'],
			examples: [
				{
					[PROMPT_DEFAULT_SOURCE_FOLDER]: true,
				},
				{
					[PROMPT_DEFAULT_SOURCE_FOLDER]: true,
					'/Users/vscode/repos/prompts': true,
				},
			],
		},
		[PromptsConfig.MODE_LOCATION_KEY]: {
			type: 'object',
			title: nls.localize(
				'chat.mode.config.locations.title',
				"Mode File Locations",
			),
			markdownDescription: nls.localize(
				'chat.mode.config.locations.description',
				"Specify location(s) of custom chat mode files (`*{0}`). [Learn More]({1}).\n\nRelative paths are resolved from the root folder(s) of your workspace.",
				LEGACY_MODE_FILE_EXTENSION,
				AGENT_DOCUMENTATION_URL,
			),
			default: {
				[LEGACY_MODE_DEFAULT_SOURCE_FOLDER]: true,
			},
			deprecationMessage: nls.localize('chat.mode.config.locations.deprecated', "This setting is deprecated and will be removed in future releases. Chat modes are now called custom agents and are located in `.github/agents`"),
			additionalProperties: { type: 'boolean' },
			unevaluatedProperties: { type: 'boolean' },
			restricted: true,
			tags: ['experimental', 'prompts', 'reusable prompts', 'prompt snippets', 'instructions'],
			examples: [
				{
					[LEGACY_MODE_DEFAULT_SOURCE_FOLDER]: true,
				},
				{
					[LEGACY_MODE_DEFAULT_SOURCE_FOLDER]: true,
					'/Users/vscode/repos/chatmodes': true,
				},
			],
		},
		[PromptsConfig.AGENTS_LOCATION_KEY]: {
			type: 'object',
			title: nls.localize(
				'chat.agents.config.locations.title',
				"Agent File Locations",
			),
			markdownDescription: nls.localize(
				'chat.agents.config.locations.description',
				"Specify location(s) of custom agent files (`*{0}`). [Learn More]({1}).\n\nRelative paths are resolved from the root folder(s) of your workspace.",
				AGENT_FILE_EXTENSION,
				AGENT_DOCUMENTATION_URL,
			),
			default: {
				[AGENTS_SOURCE_FOLDER]: true,
			},
			additionalProperties: { type: 'boolean' },
			propertyNames: {
				pattern: VALID_PROMPT_FOLDER_PATTERN,
				patternErrorMessage: nls.localize('chat.agentLocations.invalidPath', "Paths must be relative or start with '~/'. Absolute paths and '\\' separators are not supported."),
			},
			restricted: true,
			tags: ['prompts', 'reusable prompts', 'prompt snippets', 'instructions'],
			examples: [
				{
					[AGENTS_SOURCE_FOLDER]: true,
				},
				{
					[AGENTS_SOURCE_FOLDER]: true,
					'my-agents': true,
					'../shared-agents': true,
					'~/.copilot/agents': true,
				},
			],
		},
		[PromptsConfig.USE_AGENT_MD]: {
			type: 'boolean',
			title: nls.localize('chat.useAgentMd.title', "Use AGENTS.md file",),
			markdownDescription: nls.localize('chat.useAgentMd.description', "Controls whether instructions from `AGENTS.md` file found in a workspace roots are attached to all chat requests.",),
			default: true,
			restricted: true,
			disallowConfigurationDefault: true,
			tags: ['prompts', 'reusable prompts', 'prompt snippets', 'instructions']
		},
		[PromptsConfig.USE_NESTED_AGENT_MD]: {
			type: 'boolean',
			title: nls.localize('chat.useNestedAgentMd.title', "Use nested AGENTS.md files",),
			markdownDescription: nls.localize('chat.useNestedAgentMd.description', "Controls whether instructions from nested `AGENTS.md` files found in the workspace are listed in all chat requests. The language model can load these skills on-demand if the `read` tool is available.",),
			default: false,
			restricted: true,
			disallowConfigurationDefault: true,
			tags: ['experimental', 'prompts', 'reusable prompts', 'prompt snippets', 'instructions']
		},
		[PromptsConfig.USE_AGENT_SKILLS]: {
			type: 'boolean',
			title: nls.localize('chat.useAgentSkills.title', "Use Agent skills",),
			markdownDescription: nls.localize('chat.useAgentSkills.description', "Controls whether skills are provided as specialized capabilities to the chat requests. Skills are loaded from the folders configured in `#chat.agentSkillsLocations#`. The language model can load these skills on-demand if the `read` tool is available. Learn more about [Agent Skills](https://aka.ms/vscode-agent-skills).",),
			default: true,
			restricted: true,
			disallowConfigurationDefault: true,
			tags: ['prompts', 'reusable prompts', 'prompt snippets', 'instructions']
		},
		[PromptsConfig.INCLUDE_APPLYING_INSTRUCTIONS]: {
			type: 'boolean',
			title: nls.localize('chat.includeApplyingInstructions.title', "Include Applying Instructions",),
			markdownDescription: nls.localize('chat.includeApplyingInstructions.description', "Controls whether instructions with a matching 'applyTo' attribute are automatically included in chat requests.",),
			default: true,
			restricted: true,
			disallowConfigurationDefault: true,
			tags: ['prompts', 'reusable prompts', 'prompt snippets', 'instructions']
		},
		[PromptsConfig.INCLUDE_REFERENCED_INSTRUCTIONS]: {
			type: 'boolean',
			title: nls.localize('chat.includeReferencedInstructions.title', "Include Referenced Instructions",),
			markdownDescription: nls.localize('chat.includeReferencedInstructions.description', "Controls whether referenced instructions are automatically included in chat requests.",),
			default: false,
			restricted: true,
			disallowConfigurationDefault: true,
			tags: ['prompts', 'reusable prompts', 'prompt snippets', 'instructions']
		},
		[PromptsConfig.SKILLS_LOCATION_KEY]: {
			type: 'object',
			title: nls.localize('chat.agentSkillsLocations.title', "Agent Skills Locations",),
			markdownDescription: nls.localize(
				'chat.agentSkillsLocations.description',
				"Specify location(s) of agent skills (`{0}`) that can be used in Chat Sessions. [Learn More]({1}).\n\nEach path should contain skill subfolders with SKILL.md files (e.g., add `my-skills` if you have `my-skills/skillA/SKILL.md`). Relative paths are resolved from the root folder(s) of your workspace.",
				SKILL_FILENAME,
				SKILL_DOCUMENTATION_URL,
			),
			default: {
				...DEFAULT_SKILL_SOURCE_FOLDERS.map((folder) => ({ [folder.path]: true })).reduce((acc, curr) => ({ ...acc, ...curr }), {}),
			},
			additionalProperties: { type: 'boolean' },
			propertyNames: {
				pattern: VALID_PROMPT_FOLDER_PATTERN,
				patternErrorMessage: nls.localize('chat.agentSkillsLocations.invalidPath', "Paths must be relative or start with '~/'. Absolute paths and '\\' separators are not supported."),
			},
			restricted: true,
			tags: ['prompts', 'reusable prompts', 'prompt snippets', 'instructions'],
			examples: [
				{
					[DEFAULT_SKILL_SOURCE_FOLDERS[0].path]: true,
				},
				{
					[DEFAULT_SKILL_SOURCE_FOLDERS[0].path]: true,
					'my-skills': true,
					'../shared-skills': true,
					'~/.custom/skills': true,
				},
			],
		},
		[PromptsConfig.PROMPT_FILES_SUGGEST_KEY]: {
			type: 'object',
			scope: ConfigurationScope.RESOURCE,
			title: nls.localize(
				'chat.promptFilesRecommendations.title',
				"Prompt File Recommendations",
			),
			markdownDescription: nls.localize(
				'chat.promptFilesRecommendations.description',
				"Configure which prompt files to recommend in the chat welcome view. Each key is a prompt file name, and the value can be `true` to always recommend, `false` to never recommend, or a [when clause](https://aka.ms/vscode-when-clause) expression like `resourceExtname == .js` or `resourceLangId == markdown`.",
			),
			default: {},
			additionalProperties: {
				oneOf: [
					{ type: 'boolean' },
					{ type: 'string' }
				]
			},
			tags: ['prompts', 'reusable prompts', 'prompt snippets', 'instructions'],
			examples: [
				{
					'plan': true,
					'a11y-audit': 'resourceExtname == .html',
					'document': 'resourceLangId == markdown'
				}
			],
		},
		[ChatConfiguration.TodosShowWidget]: {
			type: 'boolean',
			default: true,
			description: nls.localize('chat.tools.todos.showWidget', "Controls whether to show the todo list widget above the chat input. When enabled, the widget displays todo items created by the agent and updates as progress is made."),
		},
		[ChatConfiguration.ThinkingStyle]: {
			type: 'string',
			default: 'autoCollapse',
			enum: ['collapsed', 'collapsedPreview', 'fixedScrolling', 'autoCollapse'],
			enumDescriptions: [
				nls.localize('chat.agent.thinkingMode.collapsed', "Thinking parts will be collapsed by default."),
				nls.localize('chat.agent.thinkingMode.collapsedPreview', "Thinking parts will be expanded first, then collapse once we reach a part that is not thinking."),
				nls.localize('chat.agent.thinkingMode.fixedScrolling', "Show thinking in a fixed-height streaming panel that auto-scrolls; click header to expand to full height."),
				nls.localize('chat.agent.thinkingMode.autoCollapse', "Thinking is expanded while the model is working, then automatically collapses when done. Click to re-expand."),
			],
			description: nls.localize('chat.agent.thinkingStyle', "Controls how thinking is rendered."),
			tags: ['experimental'],
		},
		[ChatConfiguration.ThinkingGenerateTitles]: {
			type: 'boolean',
			default: true,
			description: nls.localize('chat.agent.thinking.generateTitles', "Controls whether to use an LLM to generate summary titles for thinking sections."),
			tags: ['experimental'],
		},
		'chat.agent.thinking.collapsedTools': {
			type: 'string',
			default: 'always',
			enum: ['off', 'withThinking', 'always'],
			enumDescriptions: [
				nls.localize('chat.agent.thinking.collapsedTools.off', "Tool calls are shown separately, not collapsed into thinking."),
				nls.localize('chat.agent.thinking.collapsedTools.withThinking', "Tool calls are collapsed into thinking sections when thinking is present."),
				nls.localize('chat.agent.thinking.collapsedTools.always', "Tool calls are always collapsed, even without thinking."),
			],
			markdownDescription: nls.localize('chat.agent.thinking.collapsedTools', "Controls how tool calls are displayed in relation to thinking sections."),
			tags: ['experimental'],
		},
		[ChatConfiguration.TerminalToolsInThinking]: {
			type: 'boolean',
			default: true,
			markdownDescription: nls.localize('chat.agent.thinking.terminalTools', "When enabled, terminal tool calls are displayed inside the thinking dropdown with a simplified view."),
			tags: ['experimental'],
		},
		[ChatConfiguration.AutoExpandToolFailures]: {
			type: 'boolean',
			default: true,
			markdownDescription: nls.localize('chat.tools.autoExpandFailures', "When enabled, tool failures are automatically expanded in the chat UI to show error details."),
		},
		'chat.disableAIFeatures': {
			type: 'boolean',
			description: nls.localize('chat.disableAIFeatures', "Disable and hide built-in AI features provided by GitHub Copilot, including chat and inline suggestions."),
			default: false,
			scope: ConfigurationScope.WINDOW
		},
		'chat.allowAnonymousAccess': { // TODO@bpasero remove me eventually
			type: 'boolean',
			description: nls.localize('chat.allowAnonymousAccess', "Controls whether anonymous access is allowed in chat."),
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
		[ChatConfiguration.RestoreLastPanelSession]: {
			type: 'boolean',
			description: nls.localize('chat.restoreLastPanelSession', "Controls whether the last session is restored in panel after restart."),
			default: false
		},
		[ChatConfiguration.ExitAfterDelegation]: {
			type: 'boolean',
			description: nls.localize('chat.exitAfterDelegation', "Controls whether the chat panel automatically exits after delegating a request to another session."),
			default: true,
			tags: ['preview'],
		},
		'chat.extensionUnification.enabled': {
			type: 'boolean',
			description: nls.localize('chat.extensionUnification.enabled', "Enables the unification of GitHub Copilot extensions. When enabled, all GitHub Copilot functionality is served from the GitHub Copilot Chat extension. When disabled, the GitHub Copilot and GitHub Copilot Chat extensions operate independently."),
			default: true,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
		[ChatConfiguration.SubagentToolCustomAgents]: {
			type: 'boolean',
			description: nls.localize('chat.subagentTool.customAgents', "Whether the runSubagent tool is able to use custom agents. When enabled, the tool can take the name of a custom agent, but it must be given the exact name of the agent."),
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		}
	}
});
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ChatEditor,
		ChatEditorInput.EditorID,
		nls.localize('chat', "Chat")
	),
	[
		new SyncDescriptor(ChatEditorInput)
	]
);
Registry.as<IConfigurationMigrationRegistry>(Extensions.ConfigurationMigration).registerConfigurationMigrations([
	{
		key: 'chat.experimental.detectParticipant.enabled',
		migrateFn: (value, _accessor) => ([
			['chat.experimental.detectParticipant.enabled', { value: undefined }],
			['chat.detectParticipant.enabled', { value: value !== false }]
		])
	},
	{
		key: 'chat.useClaudeSkills',
		migrateFn: (value, _accessor) => ([
			['chat.useClaudeSkills', { value: undefined }],
			['chat.useAgentSkills', { value }]
		])
	},
	{
		key: mcpDiscoverySection,
		migrateFn: (value: unknown) => {
			if (typeof value === 'boolean') {
				return { value: Object.fromEntries(allDiscoverySources.map(k => [k, value])) };
			}

			return { value };
		}
	},
]);

class ChatResolverContribution extends Disposable {

	static readonly ID = 'workbench.contrib.chatResolver';

	private readonly _editorRegistrations = this._register(new DisposableMap<string>());

	constructor(
		@IChatSessionsService chatSessionsService: IChatSessionsService,
		@IEditorResolverService private readonly editorResolverService: IEditorResolverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this._registerEditor(Schemas.vscodeChatEditor);
		this._registerEditor(Schemas.vscodeLocalChatSession);

		this._register(chatSessionsService.onDidChangeContentProviderSchemes((e) => {
			for (const scheme of e.added) {
				this._registerEditor(scheme);
			}
			for (const scheme of e.removed) {
				this._editorRegistrations.deleteAndDispose(scheme);
			}
		}));

		for (const scheme of chatSessionsService.getContentProviderSchemes()) {
			this._registerEditor(scheme);
		}
	}

	private _registerEditor(scheme: string): void {
		this._editorRegistrations.set(scheme, this.editorResolverService.registerEditor(`${scheme}:**/**`,
			{
				id: ChatEditorInput.EditorID,
				label: nls.localize('chat', "Chat"),
				priority: RegisteredEditorPriority.builtin
			},
			{
				singlePerResource: true,
				canSupportResource: resource => resource.scheme === scheme,
			},
			{
				createEditorInput: ({ resource, options }) => {
					return {
						editor: this.instantiationService.createInstance(ChatEditorInput, resource, options as IChatEditorOptions),
						options
					};
				}
			}
		));
	}
}

class ChatAgentSettingContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatAgentSetting';

	constructor(
		@IWorkbenchAssignmentService private readonly experimentService: IWorkbenchAssignmentService,
		@IChatEntitlementService private readonly entitlementService: IChatEntitlementService,
	) {
		super();
		this.registerMaxRequestsSetting();
	}


	private registerMaxRequestsSetting(): void {
		let lastNode: IConfigurationNode | undefined;
		const registerMaxRequestsSetting = () => {
			const treatmentId = this.entitlementService.entitlement === ChatEntitlement.Free ?
				'chatAgentMaxRequestsFree' :
				'chatAgentMaxRequestsPro';
			this.experimentService.getTreatment<number>(treatmentId).then((value) => {
				const defaultValue = value ?? (this.entitlementService.entitlement === ChatEntitlement.Free ? 25 : 25);
				const node: IConfigurationNode = {
					id: 'chatSidebar',
					title: nls.localize('interactiveSessionConfigurationTitle', "Chat"),
					type: 'object',
					properties: {
						'chat.agent.maxRequests': {
							type: 'number',
							markdownDescription: nls.localize('chat.agent.maxRequests', "The maximum number of requests to allow per-turn when using an agent. When the limit is reached, will ask to confirm to continue."),
							default: defaultValue,
						},
					}
				};
				configurationRegistry.updateConfigurations({ remove: lastNode ? [lastNode] : [], add: [node] });
				lastNode = node;
			});
		};
		this._register(Event.runAndSubscribe(Event.debounce(this.entitlementService.onDidChangeEntitlement, () => { }, 1000), () => registerMaxRequestsSetting()));
	}
}


/**
 * Given builtin and custom modes, returns only the custom mode IDs that should have actions registered.
 * Custom modes whose names conflict with builtin modes are excluded.
 * If there are name collisions among custom modes, the later mode in the list wins.
 */
function getCustomModesWithUniqueNames(builtinModes: readonly IChatMode[], customModes: readonly IChatMode[]): Set<string> {
	const customModeIds = new Set<string>();
	const builtinNames = new Set(builtinModes.map(mode => mode.name.get()));
	const customNameToId = new Map<string, string>();

	for (const mode of customModes) {
		const modeName = mode.name.get();

		// Skip custom modes that conflict with builtin mode names
		if (builtinNames.has(modeName)) {
			continue;
		}

		// If there is a name collision among custom modes, the later one in the list wins
		const existingId = customNameToId.get(modeName);
		if (existingId) {
			customModeIds.delete(existingId);
		}

		customNameToId.set(modeName, mode.id);
		customModeIds.add(mode.id);
	}

	return customModeIds;
}

/**
 * Workbench contribution to register actions for custom chat modes via events
 */
class ChatAgentActionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatAgentActions';

	private readonly _modeActionDisposables = new DisposableMap<string>();

	constructor(
		@IChatModeService private readonly chatModeService: IChatModeService,
	) {
		super();
		this._store.add(this._modeActionDisposables);

		// Register actions for existing custom modes (avoiding name collisions)
		const { builtin, custom } = this.chatModeService.getModes();
		const currentModeIds = getCustomModesWithUniqueNames(builtin, custom);
		for (const mode of custom) {
			if (currentModeIds.has(mode.id)) {
				this._registerModeAction(mode);
			}
		}

		// Listen for custom mode changes by tracking snapshots
		this._register(this.chatModeService.onDidChangeChatModes(() => {
			const { builtin, custom } = this.chatModeService.getModes();
			const currentModeIds = getCustomModesWithUniqueNames(builtin, custom);

			// Remove modes that no longer exist and those replaced by modes later in the list with same name
			for (const modeId of this._modeActionDisposables.keys()) {
				if (!currentModeIds.has(modeId)) {
					this._modeActionDisposables.deleteAndDispose(modeId);
				}
			}

			// Register new modes
			for (const mode of custom) {
				if (currentModeIds.has(mode.id) && !this._modeActionDisposables.has(mode.id)) {
					this._registerModeAction(mode);
				}
			}
		}));
	}

	private _registerModeAction(mode: IChatMode): void {
		const actionClass = class extends ModeOpenChatGlobalAction {
			constructor() {
				super(mode);
			}
		};
		this._modeActionDisposables.set(mode.id, registerAction2(actionClass));
	}
}

class ToolReferenceNamesContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.toolReferenceNames';

	constructor(
		@ILanguageModelToolsService private readonly _languageModelToolsService: ILanguageModelToolsService,
	) {
		super();
		this._updateToolReferenceNames();
		this._register(this._languageModelToolsService.onDidChangeTools(() => this._updateToolReferenceNames()));
	}

	private _updateToolReferenceNames(): void {
		const tools =
			Array.from(this._languageModelToolsService.getAllToolsIncludingDisabled())
				.filter((tool): tool is typeof tool & { toolReferenceName: string } => typeof tool.toolReferenceName === 'string')
				.sort((a, b) => a.toolReferenceName.localeCompare(b.toolReferenceName));
		toolReferenceNameEnumValues.length = 0;
		toolReferenceNameEnumDescriptions.length = 0;
		for (const tool of tools) {
			toolReferenceNameEnumValues.push(tool.toolReferenceName);
			toolReferenceNameEnumDescriptions.push(nls.localize(
				'chat.toolReferenceName.description',
				"{0} - {1}",
				tool.toolReferenceName,
				tool.userDescription || tool.displayName
			));
		}
		configurationRegistry.notifyConfigurationSchemaUpdated({
			id: 'chatSidebar',
			properties: {
				[ChatConfiguration.EligibleForAutoApproval]: {}
			}
		});
	}
}

AccessibleViewRegistry.register(new ChatTerminalOutputAccessibleView());
AccessibleViewRegistry.register(new ChatResponseAccessibleView());
AccessibleViewRegistry.register(new PanelChatAccessibilityHelp());
AccessibleViewRegistry.register(new QuickChatAccessibilityHelp());
AccessibleViewRegistry.register(new EditsChatAccessibilityHelp());
AccessibleViewRegistry.register(new AgentChatAccessibilityHelp());

registerEditorFeature(ChatInputBoxContentProvider);

class ChatSlashStaticSlashCommandsContribution extends Disposable {

	static readonly ID = 'workbench.contrib.chatSlashStaticSlashCommands';

	constructor(
		@IChatSlashCommandService slashCommandService: IChatSlashCommandService,
		@ICommandService commandService: ICommandService,
		@IChatAgentService chatAgentService: IChatAgentService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAgentSessionsService agentSessionsService: IAgentSessionsService,
	) {
		super();
		this._store.add(slashCommandService.registerSlashCommand({
			command: 'clear',
			detail: nls.localize('clear', "Start a new chat and archive the current one"),
			sortText: 'z2_clear',
			executeImmediately: true,
			locations: [ChatAgentLocation.Chat]
		}, async (_prompt, _progress, _history, _location, sessionResource) => {
			agentSessionsService.getSession(sessionResource)?.setArchived(true);
			commandService.executeCommand(ACTION_ID_NEW_CHAT);
		}));
		this._store.add(slashCommandService.registerSlashCommand({
			command: 'help',
			detail: '',
			sortText: 'z1_help',
			executeImmediately: true,
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Ask]
		}, async (prompt, progress, _history, _location, sessionResource) => {
			const defaultAgent = chatAgentService.getDefaultAgent(ChatAgentLocation.Chat);
			const agents = chatAgentService.getAgents();

			// Report prefix
			if (defaultAgent?.metadata.helpTextPrefix) {
				if (isMarkdownString(defaultAgent.metadata.helpTextPrefix)) {
					progress.report({ content: defaultAgent.metadata.helpTextPrefix, kind: 'markdownContent' });
				} else {
					progress.report({ content: new MarkdownString(defaultAgent.metadata.helpTextPrefix), kind: 'markdownContent' });
				}
				progress.report({ content: new MarkdownString('\n\n'), kind: 'markdownContent' });
			}

			// Report agent list
			const agentText = (await Promise.all(agents
				.filter(a => !a.isDefault && !a.isCore)
				.filter(a => a.locations.includes(ChatAgentLocation.Chat))
				.map(async a => {
					const description = a.description ? `- ${a.description}` : '';
					const agentMarkdown = instantiationService.invokeFunction(accessor => agentToMarkdown(a, sessionResource, true, accessor));
					const agentLine = `- ${agentMarkdown} ${description}`;
					const commandText = a.slashCommands.map(c => {
						const description = c.description ? `- ${c.description}` : '';
						return `\t* ${agentSlashCommandToMarkdown(a, c, sessionResource)} ${description}`;
					}).join('\n');

					return (agentLine + '\n' + commandText).trim();
				}))).join('\n');
			progress.report({ content: new MarkdownString(agentText, { isTrusted: { enabledCommands: [ChatSubmitAction.ID] } }), kind: 'markdownContent' });

			// Report help text ending
			if (defaultAgent?.metadata.helpTextPostfix) {
				progress.report({ content: new MarkdownString('\n\n'), kind: 'markdownContent' });
				if (isMarkdownString(defaultAgent.metadata.helpTextPostfix)) {
					progress.report({ content: defaultAgent.metadata.helpTextPostfix, kind: 'markdownContent' });
				} else {
					progress.report({ content: new MarkdownString(defaultAgent.metadata.helpTextPostfix), kind: 'markdownContent' });
				}
			}

			// Without this, the response will be done before it renders and so it will not stream. This ensures that if the response starts
			// rendering during the next 200ms, then it will be streamed. Once it starts streaming, the whole response streams even after
			// it has received all response data has been received.
			await timeout(200);
		}));
	}
}
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ChatEditorInput.TypeID, ChatEditorInputSerializer);

registerWorkbenchContribution2(ChatResolverContribution.ID, ChatResolverContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ChatLanguageModelsDataContribution.ID, ChatLanguageModelsDataContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatSlashStaticSlashCommandsContribution.ID, ChatSlashStaticSlashCommandsContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatExtensionPointHandler.ID, ChatExtensionPointHandler, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(LanguageModelToolsExtensionPointHandler.ID, LanguageModelToolsExtensionPointHandler, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatPromptFilesExtensionPointHandler.ID, ChatPromptFilesExtensionPointHandler, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2('locopilot.languageModelProvider', LoCoPilotLanguageModelProvider, WorkbenchPhase.AfterRestored);
// AfterRestored (not Eventually): this service registers the locopilot.downloadModel / cancelModelDownload
// commands that back the chat-panel links. The language model provider that renders those links also loads
// AfterRestored, so registering later left a window (visible in builds) where a link was clickable but its
// command did not yet exist, and the click silently did nothing.
registerWorkbenchContribution2(LoCoPilotModelDownloadService.ID, LoCoPilotModelDownloadService, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(LoCoPilotCatalogSeedContribution.ID, LoCoPilotCatalogSeedContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(LoCoPilotUpdateCheckContribution.ID, LoCoPilotUpdateCheckContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatCompatibilityNotifier.ID, ChatCompatibilityNotifier, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(CodeBlockActionRendering.ID, CodeBlockActionRendering, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatImplicitContextContribution.ID, ChatImplicitContextContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatRelatedFilesContribution.ID, ChatRelatedFilesContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatViewsWelcomeHandler.ID, ChatViewsWelcomeHandler, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ChatGettingStartedContribution.ID, ChatGettingStartedContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatSetupContribution.ID, ChatSetupContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatTeardownContribution.ID, ChatTeardownContribution, WorkbenchPhase.AfterRestored);
// LOCOPILOT: Status bar icon ("Use AI Features" / Copilot icon) hidden intentionally - do NOT delete this line, uncomment to restore.
// registerWorkbenchContribution2(ChatStatusBarEntry.ID, ChatStatusBarEntry, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(BuiltinToolsContribution.ID, BuiltinToolsContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(LoCoPilotRetrievalContribution.ID, LoCoPilotRetrievalContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(LoCoPilotProjectMemoryToolsContribution.ID, LoCoPilotProjectMemoryToolsContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatAgentSettingContribution.ID, ChatAgentSettingContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatAgentActionsContribution.ID, ChatAgentActionsContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ToolReferenceNamesContribution.ID, ToolReferenceNamesContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatAgentRecommendation.ID, ChatAgentRecommendation, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatEditingEditorAccessibility.ID, ChatEditingEditorAccessibility, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatEditingEditorOverlay.ID, ChatEditingEditorOverlay, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SimpleBrowserOverlay.ID, SimpleBrowserOverlay, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatEditingEditorContextKeys.ID, ChatEditingEditorContextKeys, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatTransferContribution.ID, ChatTransferContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatContextContributions.ID, ChatContextContributions, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatResponseResourceFileSystemProvider.ID, ChatResponseResourceFileSystemProvider, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(PromptUrlHandler.ID, PromptUrlHandler, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ChatEditingNotebookFileSystemProviderContrib.ID, ChatEditingNotebookFileSystemProviderContrib, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(UserToolSetsContributions.ID, UserToolSetsContributions, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(PromptLanguageFeaturesProvider.ID, PromptLanguageFeaturesProvider, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ChatWindowNotifier.ID, ChatWindowNotifier, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ChatRepoInfoContribution.ID, ChatRepoInfoContribution, WorkbenchPhase.Eventually);

registerChatActions();
registerChatAccessibilityActions();
registerChatCopyActions();
registerChatCodeBlockActions();
registerChatCodeCompareBlockActions();
registerChatFileTreeActions();
registerChatPromptNavigationActions();
registerChatTitleActions();
registerChatExecuteActions();
registerQuickChatActions();
registerChatExportActions();
registerMoveActions();
registerNewChatActions();
registerChatContextActions();
registerChatDeveloperActions();
registerChatEditorActions();
registerChatElicitationActions();
registerChatToolActions();
registerLanguageModelActions();
registerAction2(ConfigureToolSets);
registerEditorFeature(ChatPasteProvidersFeature);


registerSingleton(IChatTransferService, ChatTransferService, InstantiationType.Delayed);
registerSingleton(IChatService, ChatService, InstantiationType.Delayed);
registerSingleton(IChatWidgetService, ChatWidgetService, InstantiationType.Delayed);
registerSingleton(IQuickChatService, QuickChatService, InstantiationType.Delayed);
registerSingleton(IChatAccessibilityService, ChatAccessibilityService, InstantiationType.Delayed);
registerSingleton(IChatWidgetHistoryService, ChatWidgetHistoryService, InstantiationType.Delayed);
registerSingleton(ILanguageModelsConfigurationService, LanguageModelsConfigurationService, InstantiationType.Delayed);
registerSingleton(ILanguageModelsService, LanguageModelsService, InstantiationType.Delayed);
registerSingleton(ILanguageModelStatsService, LanguageModelStatsService, InstantiationType.Delayed);
registerSingleton(IChatSlashCommandService, ChatSlashCommandService, InstantiationType.Delayed);
registerSingleton(IChatAgentService, ChatAgentService, InstantiationType.Delayed);
registerSingleton(IChatAgentNameService, ChatAgentNameService, InstantiationType.Delayed);
registerSingleton(IChatVariablesService, ChatVariablesService, InstantiationType.Delayed);
registerSingleton(ILanguageModelToolsService, LanguageModelToolsService, InstantiationType.Delayed);
registerSingleton(ILanguageModelToolsConfirmationService, LanguageModelToolsConfirmationService, InstantiationType.Delayed);
registerSingleton(IVoiceChatService, VoiceChatService, InstantiationType.Delayed);
registerSingleton(IChatCodeBlockContextProviderService, ChatCodeBlockContextProviderService, InstantiationType.Delayed);
registerSingleton(ICodeMapperService, CodeMapperService, InstantiationType.Delayed);
registerSingleton(IChatEditingService, ChatEditingService, InstantiationType.Delayed);
registerSingleton(IChatMarkdownAnchorService, ChatMarkdownAnchorService, InstantiationType.Delayed);
registerSingleton(ILanguageModelIgnoredFilesService, LanguageModelIgnoredFilesService, InstantiationType.Delayed);
registerSingleton(IPromptsService, PromptsService, InstantiationType.Delayed);
registerSingleton(ICustomLanguageModelsService, CustomLanguageModelsService, InstantiationType.Delayed);
registerSingleton(IChatContextPickService, ChatContextPickService, InstantiationType.Delayed);
registerSingleton(IChatModeService, ChatModeService, InstantiationType.Delayed);
registerSingleton(IChatAttachmentResolveService, ChatAttachmentResolveService, InstantiationType.Delayed);
registerSingleton(IChatTodoListService, ChatTodoListService, InstantiationType.Delayed);
registerSingleton(IChatOutputRendererService, ChatOutputRendererService, InstantiationType.Delayed);
registerSingleton(IChatLayoutService, ChatLayoutService, InstantiationType.Delayed);
registerSingleton(ILoCoPilotFileLog, LoCoPilotFileLog, InstantiationType.Delayed);
registerSingleton(ILoCoPilotAgentSettingsService, LoCoPilotAgentSettingsService, InstantiationType.Delayed);
registerSingleton(ILoCoPilotProjectMemoryService, LoCoPilotProjectMemoryService, InstantiationType.Delayed);
registerSingleton(ILoCoPilotLocalModelRunner, LoCoPilotLocalModelRunner, InstantiationType.Delayed);
registerSingleton(ILoCoPilotOllamaService, LoCoPilotOllamaService, InstantiationType.Delayed);
registerSingleton(ILoCoPilotLiveStatsService, LoCoPilotLiveStatsService, InstantiationType.Delayed);

ChatWidget.CONTRIBS.push(ChatDynamicVariableModel);
