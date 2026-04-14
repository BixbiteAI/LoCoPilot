/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../../../base/common/actions.js';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Lazy } from '../../../../../base/common/lazy.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { CountTokensCallback, ILanguageModelToolsService, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../../common/tools/languageModelToolsService.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { ChatEntitlement, ChatEntitlementContext, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { ChatModel, ChatRequestModel, IChatRequestModel, IChatRequestVariableData, IChatRequestModeInfo } from '../../common/model/chatModel.js';
import { ChatMode } from '../../common/chatModes.js';
import { ChatRequestAgentPart, ChatRequestToolPart } from '../../common/requestParser/chatParserTypes.js';
import { IChatProgress, IChatService } from '../../common/chatService/chatService.js';
import { IChatRequestToolEntry } from '../../common/attachments/chatVariableEntries.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { ChatMessageRole, IChatMessage, ILanguageModelsService } from '../../common/languageModels.js';
import { ICustomLanguageModelsService } from '../../common/customLanguageModelsService.js';
import { IChatRequestVariableEntry, isPromptFileVariableEntry, isPromptTextVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { basename, relativePath } from '../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { CHAT_OPEN_ACTION_ID, CHAT_SETUP_ACTION_ID } from '../actions/chatActions.js';
import { IChatWidgetService } from '../chat.js';
import { ILoCoPilotFileLog } from '../locopilotFileLog.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { CodeAction, CodeActionList, Command, NewSymbolName, NewSymbolNameTriggerKind } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { ISelection, Selection } from '../../../../../editor/common/core/selection.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { CodeActionKind } from '../../../../../editor/contrib/codeAction/common/types.js';
import { ACTION_START as INLINE_CHAT_START } from '../../../inlineChat/common/inlineChat.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ChatSetupController } from './chatSetupController.js';
import { ChatSetupAnonymous, ChatSetupStep, IChatSetupResult } from './chatSetup.js';
import { ChatSetup } from './chatSetupRunner.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IWorkbenchIssueService } from '../../../issue/common/issue.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { UnifiedAgent } from '../agents/unifiedAgent.js';
import { ILoCoPilotAgentSettingsService } from '../locopilotAgentSettingsService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';

const defaultChat = {
	extensionId: product.defaultChatAgent?.extensionId ?? '',
	chatExtensionId: product.defaultChatAgent?.chatExtensionId ?? '',
	provider: product.defaultChatAgent?.provider ?? { default: { id: '', name: '' }, enterprise: { id: '', name: '' }, apple: { id: '', name: '' }, google: { id: '', name: '' } },
	outputChannelId: product.defaultChatAgent?.chatExtensionOutputId ?? '',
};

const ToolsAgentContextKey = ContextKeyExpr.and(
	ContextKeyExpr.equals(`config.${ChatConfiguration.AgentEnabled}`, true),
	ContextKeyExpr.not(`previewFeaturesDisabled`) // Set by extension
);

export class SetupAgent extends Disposable implements IChatAgentImplementation {

	static registerDefaultAgents(instantiationService: IInstantiationService, location: ChatAgentLocation, mode: ChatModeKind | undefined, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			let id: string;
			let description = ChatMode.Ask.description.get();
			switch (location) {
				case ChatAgentLocation.Chat:
					if (mode === ChatModeKind.Ask) {
						id = 'setup.chat';
					} else if (mode === ChatModeKind.Edit) {
						id = 'setup.edits';
						description = ChatMode.Edit.description.get();
					} else {
						id = 'setup.agent';
						description = ChatMode.Agent.description.get();
					}
					break;
				case ChatAgentLocation.Terminal:
					id = 'setup.terminal';
					break;
				case ChatAgentLocation.EditorInline:
					id = 'setup.editor';
					break;
				case ChatAgentLocation.Notebook:
					id = 'setup.notebook';
					break;
			}

			return SetupAgent.doRegisterAgent(instantiationService, chatAgentService, id, `${defaultChat.provider.default.name} Copilot` /* Do NOT change, this hides the username altogether in Chat */, true, description, location, mode, context, controller);
		});
	}

	static registerBuiltInAgents(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			const disposables = new DisposableStore();

			// Register VSCode agent
			const { disposable: vscodeDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.vscode', 'vscode', false, localize2('vscodeAgentDescription', "Ask questions about LoCoPilot").value, ChatAgentLocation.Chat, undefined, context, controller);
			disposables.add(vscodeDisposable);

			// Register workspace agent
			const { disposable: workspaceDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.workspace', 'workspace', false, localize2('workspaceAgentDescription', "Ask about your workspace").value, ChatAgentLocation.Chat, undefined, context, controller);
			disposables.add(workspaceDisposable);

			// Register terminal agent
			const { disposable: terminalDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.terminal.agent', 'terminal', false, localize2('terminalAgentDescription', "Ask how to do something in the terminal").value, ChatAgentLocation.Chat, undefined, context, controller);
			disposables.add(terminalDisposable);

			// Register tools
			disposables.add(SetupTool.registerTool(instantiationService, {
				id: 'setup_tools_createNewWorkspace',
				source: ToolDataSource.Internal,
				icon: Codicon.newFolder,
				displayName: localize('setupToolDisplayName', "New Workspace"),
				modelDescription: 'Scaffold a new workspace in LoCoPilot',
				userDescription: localize('setupToolsDescription', "Scaffold a new workspace in LoCoPilot"),
				canBeReferencedInPrompt: true,
				toolReferenceName: 'new',
				when: ContextKeyExpr.true(),
			}));

			return disposables;
		});
	}

	private static doRegisterAgent(instantiationService: IInstantiationService, chatAgentService: IChatAgentService, id: string, name: string, isDefault: boolean, description: string, location: ChatAgentLocation, mode: ChatModeKind | undefined, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		const disposables = new DisposableStore();
		disposables.add(chatAgentService.registerAgent(id, {
			id,
			name,
			isDefault,
			isCore: true,
			modes: mode ? [mode] : [ChatModeKind.Ask],
			when: mode === ChatModeKind.Agent ? ToolsAgentContextKey?.serialize() : undefined,
			slashCommands: [],
			disambiguation: [],
			locations: [location],
			metadata: { helpTextPrefix: SetupAgent.SETUP_NEEDED_MESSAGE },
			description,
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher
		}));

		const agent = disposables.add(instantiationService.createInstance(SetupAgent, context, controller, location));
		disposables.add(chatAgentService.registerAgentImplementation(id, agent));
		if (mode === ChatModeKind.Agent) {
			chatAgentService.updateAgent(id, { themeIcon: Codicon.tools });
		}

		return { agent, disposable: disposables };
	}

	private static readonly SETUP_NEEDED_MESSAGE = new MarkdownString(localize('settingUpCopilotNeeded', "You need to set up GitHub Copilot and be signed in to use Chat."));
	private static readonly TRUST_NEEDED_MESSAGE = new MarkdownString(localize('trustNeeded', "You need to trust this workspace to use Chat."));

	private static readonly CHAT_RETRY_COMMAND_ID = 'workbench.action.chat.retrySetup';
	private static readonly CHAT_REPORT_ISSUE_WITH_OUTPUT_COMMAND_ID = 'workbench.action.chat.reportIssueWithOutput';

	private readonly _onUnresolvableError = this._register(new Emitter<void>());
	readonly onUnresolvableError = this._onUnresolvableError.event;

	private readonly pendingForwardedRequests = new ResourceMap<Promise<void>>();

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		private readonly location: ChatAgentLocation,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
		super();

		this.registerCommands();
	}

	private registerCommands(): void {

		// Report issue with output command
		this._register(CommandsRegistry.registerCommand(SetupAgent.CHAT_REPORT_ISSUE_WITH_OUTPUT_COMMAND_ID, async accessor => {
			const outputService = accessor.get(IOutputService);
			const textModelService = accessor.get(ITextModelService);
			const issueService = accessor.get(IWorkbenchIssueService);
			const logService = accessor.get(ILogService);

			let outputData = '';
			let channelName = '';

			let channel = outputService.getChannel(defaultChat.outputChannelId);
			if (channel) {
				channelName = defaultChat.outputChannelId;
			} else {
				logService.warn(`[chat setup] Output channel '${defaultChat.outputChannelId}' not found, falling back to Window output channel`);
				channel = outputService.getChannel('rendererLog');
				channelName = 'Window';
			}

			if (channel) {
				try {
					const model = await textModelService.createModelReference(channel.uri);
					try {
						const rawOutput = model.object.textEditorModel.getValue();
						outputData = `<details>\n<summary>GitHub Copilot Chat Output (${channelName})</summary>\n\n\`\`\`\n${rawOutput}\n\`\`\`\n</details>`;
						logService.info(`[chat setup] Retrieved ${rawOutput.length} characters from ${channelName} output channel`);
					} finally {
						model.dispose();
					}
				} catch (error) {
					logService.error(`[chat setup] Failed to retrieve output channel content: ${error}`);
				}
			} else {
				logService.warn(`[chat setup] No output channel available`);
			}

			await issueService.openReporter({
				extensionId: defaultChat.chatExtensionId,
				issueTitle: 'Chat took too long to get ready',
				issueBody: 'Chat took too long to get ready',
				data: outputData || localize('chatOutputChannelUnavailable', "GitHub Copilot Chat output channel not available. Please ensure the GitHub Copilot Chat extension is active and try again. If the issue persists, you can manually include relevant information from the Output panel (View > Output > GitHub Copilot Chat).")
			});
		}));

		// Retry chat command
		this._register(CommandsRegistry.registerCommand(SetupAgent.CHAT_RETRY_COMMAND_ID, async (accessor, sessionResource: URI) => {
			const hostService = accessor.get(IHostService);
			const chatWidgetService = accessor.get(IChatWidgetService);

			const widget = chatWidgetService.getWidgetBySessionResource(sessionResource);
			await widget?.clear();

			hostService.reload();
		}));
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void): Promise<IChatAgentResult> {
		return this.instantiationService.invokeFunction(async accessor /* using accessor for lazy loading */ => {
			const chatService = accessor.get(IChatService);
			const languageModelsService = accessor.get(ILanguageModelsService);
			const chatWidgetService = accessor.get(IChatWidgetService);
			const chatAgentService = accessor.get(IChatAgentService);
			const languageModelToolsService = accessor.get(ILanguageModelToolsService);
			const defaultAccountService = accessor.get(IDefaultAccountService);

			return this.doInvoke(request, part => progress([part]), chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService, defaultAccountService);
		});
	}

	private async doInvoke(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService, defaultAccountService: IDefaultAccountService): Promise<IChatAgentResult> {
		// BYPASS: First try to use existing agents without extension checks
		// Check if there's a non-core agent available (from extensions or custom implementations)
		const widget = chatWidgetService.getWidgetBySessionResource(request.sessionResource);
		const modeInfo = widget?.input.currentModeInfo;
		const defaultAgent = chatAgentService.getDefaultAgent(this.location, modeInfo?.kind);
		
		// If we have a non-core agent available, use it directly
		if (defaultAgent && !defaultAgent.isCore) {
			return this.doInvokeWithoutSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
		}

		// If extension is installed and enabled, use it
		if (this.context.state.installed && !this.context.state.disabled && !this.context.state.untrusted) {
			return this.doInvokeWithoutSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
		}

		// Only run setup if extension is not installed and no other agents are available
		// Skip setup for untrusted workspaces and entitlement checks to allow chat without restrictions
		if (!this.context.state.installed && this.context.state.entitlement !== ChatEntitlement.Available) {
			// Try setup only if really needed, but allow fallback to built-in agents
			return this.doInvokeWithSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService, defaultAccountService);
		}

		// Default: try without setup first (use built-in agents)
		return this.doInvokeWithoutSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
	}

	private async doInvokeWithoutSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService): Promise<IChatAgentResult> {
		const requestModel = chatWidgetService.getWidgetBySessionResource(request.sessionResource)?.viewModel?.model.getRequests().at(-1);
		if (!requestModel) {
			this.logService.error('[chat setup] Request model not found, cannot redispatch request.');
			return {}; // this should not happen
		}

		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize('waitingChat', "Getting chat ready...")),
		});

		await this.forwardRequestToChat(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);

		return {};
	}

	private async forwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		try {
			await this.doForwardRequestToChat(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		} catch (error) {
			this.logService.error('[chat setup] Failed to forward request to chat', error);

			progress({
				kind: 'warning',
				content: new MarkdownString(localize('copilotUnavailableWarning', "Failed to get a response. Please try again."))
			});
		}
	}

	private async doForwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		if (this.pendingForwardedRequests.has(requestModel.session.sessionResource)) {
			throw new Error('Request already in progress');
		}

		const forwardRequest = this.doForwardRequestToChatWhenReady(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		this.pendingForwardedRequests.set(requestModel.session.sessionResource, forwardRequest);

		try {
			await forwardRequest;
		} finally {
			this.pendingForwardedRequests.delete(requestModel.session.sessionResource);
		}
	}

	private async doForwardRequestToChatWhenReady(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		const widget = chatWidgetService.getWidgetBySessionResource(requestModel.session.sessionResource);
		const modeInfo = widget?.input.currentModeInfo;

		// We need a signal to know when we can resend the request to
		// Chat. Waiting for the registration of the agent is not
		// enough, we also need a language/tools model to be available.

		let agentActivated = false;
		let agentReady = false;
		let languageModelReady = false;
		let toolsModelReady = false;

		const whenAgentActivated = this.whenAgentActivated(chatService).then(() => agentActivated = true);
		const whenAgentReady = this.whenAgentReady(chatAgentService, modeInfo?.kind)?.then(() => agentReady = true);
		if (!whenAgentReady) {
			agentReady = true;
		}
		const whenLanguageModelReady = this.whenLanguageModelReady(languageModelsService, requestModel.modelId)?.then(() => languageModelReady = true);
		if (!whenLanguageModelReady) {
			languageModelReady = true;
		}
		const whenToolsModelReady = this.whenToolsModelReady(languageModelToolsService, requestModel)?.then(() => toolsModelReady = true);
		if (!whenToolsModelReady) {
			toolsModelReady = true;
		}

		if (whenLanguageModelReady instanceof Promise || whenAgentReady instanceof Promise || whenToolsModelReady instanceof Promise) {
			const timeoutHandle = setTimeout(() => {
				progress({
					kind: 'progressMessage',
					content: new MarkdownString(localize('waitingChat2', "Chat is almost ready...")),
				});
			}, 10000);

			try {
				const ready = await Promise.race([
					timeout(this.environmentService.remoteAuthority ? 60000 /* increase for remote scenarios */ : 20000).then(() => 'timedout'),
					Promise.allSettled([
						whenAgentActivated,
						whenAgentReady,
						whenLanguageModelReady,
						whenToolsModelReady
					])
				]);

				if (ready === 'timedout') {
					let warningMessage: string;
					if (this.chatEntitlementService.anonymous) {
						warningMessage = localize('chatTookLongWarningAnonymous', "Chat took too long to get ready. Please ensure that the extension `{0}` is installed and enabled. Click restart to try again if this issue persists.", defaultChat.chatExtensionId);
					} else {
						warningMessage = localize('chatTookLongWarning', "Chat took too long to get ready. Please ensure you are signed in to {0} and that the extension `{1}` is installed and enabled. Click restart to try again if this issue persists.", defaultChat.provider.default.name, defaultChat.chatExtensionId);
					}

					this.logService.warn(warningMessage, {
						agentActivated,
						agentReady,
						languageModelReady,
						toolsModelReady
					});

					type ChatSetupTimeoutClassification = {
						owner: 'chrmarti';
						comment: 'Provides insight into chat setup timeouts.';
						agentActivated: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the agent was activated.' };
						agentReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the agent was ready.' };
						languageModelReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the language model was ready.' };
						toolsModelReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the tools model was ready.' };
						isRemote: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether this is a remote scenario.' };
						isAnonymous: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether anonymous access is enabled.' };
					};
					type ChatSetupTimeoutEvent = {
						agentActivated: boolean;
						agentReady: boolean;
						languageModelReady: boolean;
						toolsModelReady: boolean;
						isRemote: boolean;
						isAnonymous: boolean;
					};
					this.telemetryService.publicLog2<ChatSetupTimeoutEvent, ChatSetupTimeoutClassification>('chatSetup.timeout', {
						agentActivated,
						agentReady,
						languageModelReady,
						toolsModelReady,
						isRemote: !!this.environmentService.remoteAuthority,
						isAnonymous: this.chatEntitlementService.anonymous
					});

					progress({
						kind: 'warning',
						content: new MarkdownString(warningMessage)
					});

					progress({
						kind: 'command',
						command: {
							id: SetupAgent.CHAT_RETRY_COMMAND_ID,
							title: localize('retryChat', "Restart"),
							arguments: [requestModel.session.sessionResource]
						},
						additionalCommands: [{
							id: SetupAgent.CHAT_REPORT_ISSUE_WITH_OUTPUT_COMMAND_ID,
							title: localize('reportChatIssue', "Report Issue"),
						}]
					});

					// This means Chat is unhealthy and we cannot retry the
					// request. Signal this to the outside via an event.
					this._onUnresolvableError.fire();
					return;
				}
			} finally {
				clearTimeout(timeoutHandle);
			}
		}

		await chatService.resendRequest(requestModel, {
			...widget?.getModeRequestOptions(),
			modeInfo,
			userSelectedModelId: widget?.input.currentLanguageModel
		});
	}

	private whenLanguageModelReady(languageModelsService: ILanguageModelsService, modelId: string | undefined): Promise<unknown> | void {
		const hasModelForRequest = () => {
			if (modelId) {
				return !!languageModelsService.lookupLanguageModel(modelId);
			}

			for (const id of languageModelsService.getLanguageModelIds()) {
				const model = languageModelsService.lookupLanguageModel(id);
				if (model?.isDefaultForLocation[ChatAgentLocation.Chat]) {
					return true;
				}
			}

			return false;
		};

		if (hasModelForRequest()) {
			return;
		}

		return Event.toPromise(Event.filter(languageModelsService.onDidChangeLanguageModels, () => hasModelForRequest()));
	}

	private whenToolsModelReady(languageModelToolsService: ILanguageModelToolsService, requestModel: IChatRequestModel): Promise<unknown> | void {
		const needsToolsModel = requestModel.message.parts.some(part => part instanceof ChatRequestToolPart);
		if (!needsToolsModel) {
			return; // No tools in this request, no need to check
		}

		// check that tools other than setup. and internal tools are registered.
		for (const tool of languageModelToolsService.getAllToolsIncludingDisabled()) {
			if (tool.id.startsWith('copilot_')) {
				return; // we have tools!
			}
		}

		return Event.toPromise(Event.filter(languageModelToolsService.onDidChangeTools, () => {
			for (const tool of languageModelToolsService.getAllToolsIncludingDisabled()) {
				if (tool.id.startsWith('copilot_')) {
					return true; // we have tools!
				}
			}

			return false; // no external tools found
		}));
	}

	private whenAgentReady(chatAgentService: IChatAgentService, mode: ChatModeKind | undefined): Promise<unknown> | void {
		const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
		if (defaultAgent && !defaultAgent.isCore) {
			return; // we have a default agent from an extension!
		}

		return Event.toPromise(Event.filter(chatAgentService.onDidChangeAgents, () => {
			const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
			return Boolean(defaultAgent && !defaultAgent.isCore);
		}));
	}

	private async whenAgentActivated(chatService: IChatService): Promise<void> {
		try {
			await chatService.activateDefaultAgent(this.location);
		} catch (error) {
			this.logService.error(error);
		}
	}

	private async doInvokeWithSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService, defaultAccountService: IDefaultAccountService): Promise<IChatAgentResult> {
		this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id: CHAT_SETUP_ACTION_ID, from: 'chat' });

		const widget = chatWidgetService.getWidgetBySessionResource(request.sessionResource);
		const requestModel = widget?.viewModel?.model.getRequests().at(-1);

		const setupListener = Event.runAndSubscribe(this.controller.value.onDidChange, (() => {
			switch (this.controller.value.step) {
				case ChatSetupStep.SigningIn:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('setupChatSignIn2', "Signing in to {0}...", defaultAccountService.getDefaultAccountAuthenticationProvider().name)),
					});
					break;
				case ChatSetupStep.Installing:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('installingChat', "Getting chat ready...")),
					});
					break;
			}
		}));

		let result: IChatSetupResult | undefined = undefined;
		try {
			// Removed sign-in requirement: enable anonymous mode by default when entitlement is Unknown
			const shouldUseAnonymous = this.context.state.entitlement === ChatEntitlement.Unknown || this.chatEntitlementService.anonymous;
			result = await ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				disableChatViewReveal: true, 																				// we are already in a chat context
				forceAnonymous: shouldUseAnonymous ? ChatSetupAnonymous.EnabledWithoutDialog : undefined	// enable anonymous when entitlement is Unknown
			});
		} catch (error) {
			this.logService.error(`[chat setup] Error during setup: ${toErrorMessage(error)}`);
		} finally {
			setupListener.dispose();
		}

		// User has agreed to run the setup
		if (typeof result?.success === 'boolean') {
			if (result.success) {
				if (result.dialogSkipped) {
					await widget?.clear(); // make room for the Chat welcome experience
				} else if (requestModel) {
					let newRequest = this.replaceAgentInRequestModel(requestModel, chatAgentService); 	// Replace agent part with the actual Chat agent...
					newRequest = this.replaceToolInRequestModel(newRequest); 							// ...then replace any tool parts with the actual Chat tools

					await this.forwardRequestToChat(newRequest, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
				}
			} else {
				progress({
					kind: 'warning',
					content: new MarkdownString(localize('chatSetupError', "Chat setup failed."))
				});
			}
		}

		// User has cancelled the setup
		else {
			progress({
				kind: 'markdownContent',
				content: this.workspaceTrustManagementService.isWorkspaceTrusted() ? SetupAgent.SETUP_NEEDED_MESSAGE : SetupAgent.TRUST_NEEDED_MESSAGE
			});
		}

		return {};
	}

	private replaceAgentInRequestModel(requestModel: IChatRequestModel, chatAgentService: IChatAgentService): IChatRequestModel {
		const agentPart = requestModel.message.parts.find((r): r is ChatRequestAgentPart => r instanceof ChatRequestAgentPart);
		if (!agentPart) {
			return requestModel;
		}

		const agentId = agentPart.agent.id.replace(/setup\./, `${defaultChat.extensionId}.`.toLowerCase());
		const githubAgent = chatAgentService.getAgent(agentId);
		if (!githubAgent) {
			return requestModel;
		}

		const newAgentPart = new ChatRequestAgentPart(agentPart.range, agentPart.editorRange, githubAgent);

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestAgentPart) {
						return newAgentPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: requestModel.variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: requestModel.attachedContext,
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}

	private replaceToolInRequestModel(requestModel: IChatRequestModel): IChatRequestModel {
		const toolPart = requestModel.message.parts.find((r): r is ChatRequestToolPart => r instanceof ChatRequestToolPart);
		if (!toolPart) {
			return requestModel;
		}

		const toolId = toolPart.toolId.replace(/setup.tools\./, `copilot_`.toLowerCase());
		const newToolPart = new ChatRequestToolPart(
			toolPart.range,
			toolPart.editorRange,
			toolPart.toolName,
			toolId,
			toolPart.displayName,
			toolPart.icon
		);

		const chatRequestToolEntry: IChatRequestToolEntry = {
			id: toolId,
			name: 'new',
			range: toolPart.range,
			kind: 'tool',
			value: undefined
		};

		const variableData: IChatRequestVariableData = {
			variables: [chatRequestToolEntry]
		};

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestToolPart) {
						return newToolPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: [chatRequestToolEntry],
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}
}

export class SetupTool implements IToolImpl {

	static registerTool(instantiationService: IInstantiationService, toolData: IToolData): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const toolService = accessor.get(ILanguageModelToolsService);

			const tool = instantiationService.createInstance(SetupTool);
			return toolService.registerTool(toolData, tool);
		});
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const result: IToolResult = {
			content: [
				{
					kind: 'text',
					value: ''
				}
			]
		};

		return result;
	}

	async prepareToolInvocation?(parameters: unknown, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

export class AINewSymbolNamesProvider {

	static registerProvider(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(AINewSymbolNamesProvider, context, controller);
			return languageFeaturesService.newSymbolNamesProvider.register('*', provider);
		});
	}

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
	}

	async provideNewSymbolNames(model: ITextModel, range: IRange, triggerKind: NewSymbolNameTriggerKind, token: CancellationToken): Promise<NewSymbolName[] | undefined> {
		await this.instantiationService.invokeFunction(accessor => {
			return ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				forceAnonymous: this.chatEntitlementService.anonymous ? ChatSetupAnonymous.EnabledWithDialog : undefined
			});
		});

		return [];
	}
}

export class ChatCodeActionsProvider {

	static registerProvider(instantiationService: IInstantiationService): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(ChatCodeActionsProvider);
			return languageFeaturesService.codeActionProvider.register('*', provider);
		});
	}

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
	) {
	}

	async provideCodeActions(model: ITextModel, range: Range | Selection): Promise<CodeActionList | undefined> {
		const actions: CodeAction[] = [];

		// "Generate" if the line is whitespace only
		// "Modify" if there is a selection
		let generateOrModifyTitle: string | undefined;
		let generateOrModifyCommand: Command | undefined;
		if (range.isEmpty()) {
			const textAtLine = model.getLineContent(range.startLineNumber);
			if (/^\s*$/.test(textAtLine)) {
				generateOrModifyTitle = localize('generate', "Generate");
				generateOrModifyCommand = AICodeActionsHelper.generate(range);
			}
		} else {
			const textInSelection = model.getValueInRange(range);
			if (!/^\s*$/.test(textInSelection)) {
				generateOrModifyTitle = localize('modify', "Modify");
				generateOrModifyCommand = AICodeActionsHelper.modify(range);
			}
		}

		if (generateOrModifyTitle && generateOrModifyCommand) {
			actions.push({
				kind: CodeActionKind.RefactorRewrite.append('copilot').value,
				isAI: true,
				title: generateOrModifyTitle,
				command: generateOrModifyCommand,
			});
		}

		const markers = AICodeActionsHelper.warningOrErrorMarkersAtRange(this.markerService, model.uri, range);
		if (markers.length > 0) {

			// "Fix" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('copilot').value,
				isAI: true,
				diagnostics: markers,
				title: localize('fix', "Fix"),
				command: AICodeActionsHelper.fixMarkers(markers, range)
			});

			// "Explain" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('explain').append('copilot').value,
				isAI: true,
				diagnostics: markers,
				title: localize('explain', "Explain"),
				command: AICodeActionsHelper.explainMarkers(markers)
			});
		}

		return {
			actions,
			dispose() { }
		};
	}
}

export class AICodeActionsHelper {

	static warningOrErrorMarkersAtRange(markerService: IMarkerService, resource: URI, range: Range | Selection): IMarker[] {
		return markerService
			.read({ resource, severities: MarkerSeverity.Error | MarkerSeverity.Warning })
			.filter(marker => range.startLineNumber <= marker.endLineNumber && range.endLineNumber >= marker.startLineNumber);
	}

	static modify(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('modify', "Modify"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	static generate(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('generate', "Generate"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	private static rangeToSelection(range: Range): ISelection {
		return new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
	}

	static explainMarkers(markers: IMarker[]): Command {
		return {
			id: CHAT_OPEN_ACTION_ID,
			title: localize('explain', "Explain"),
			arguments: [
				{
					query: `@workspace /explain ${markers.map(marker => marker.message).join(', ')}`,
					isPartialQuery: true
				} satisfies { query: string; isPartialQuery: boolean }
			]
		};
	}

	static fixMarkers(markers: IMarker[], range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('fix', "Fix"),
			arguments: [
				{
					message: `/fix ${markers.map(marker => marker.message).join(', ')}`,
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { message: string; initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}
}

/**
 * Custom built-in LoCoPilot agent that works without requiring extensions.
 * This agent tries to use existing agents when available, otherwise provides basic functionality.
 */
export class LoCoPilotBuiltInAgent extends Disposable implements IChatAgentImplementation {

	static registerAgent(instantiationService: IInstantiationService, location: ChatAgentLocation, mode: ChatModeKind | undefined): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			let id: string;
			let name: string;
			let description: string;
			const isDefault = true;

			switch (location) {
				case ChatAgentLocation.Chat:
					if (mode === ChatModeKind.Ask) {
						id = 'locopilot.ask';
						name = 'LoCoPilot';
						description = localize2('locopilotAgentDescription', "LoCoPilot AI Assistant").value;
					} else if (mode === ChatModeKind.Edit) {
						id = 'locopilot.edit';
						name = 'LoCoPilot';
						description = ChatMode.Edit.description.get();
					} else {
						id = 'locopilot.agent';
						name = 'LoCoPilot';
						description = ChatMode.Agent.description.get();
					}
					break;
				case ChatAgentLocation.Terminal:
					id = 'locopilot.terminal';
					name = 'LoCoPilot Terminal';
					description = localize2('locopilotTerminalDescription', "LoCoPilot Terminal Assistant").value;
					break;
				case ChatAgentLocation.EditorInline:
					id = 'locopilot.inline';
					name = 'LoCoPilot Inline';
					description = localize2('locopilotInlineDescription', "LoCoPilot Inline Assistant").value;
					break;
				case ChatAgentLocation.Notebook:
					id = 'locopilot.notebook';
					name = 'LoCoPilot Notebook';
					description = localize2('locopilotNotebookDescription', "LoCoPilot Notebook Assistant").value;
					break;
				default:
					id = 'locopilot';
					name = 'LoCoPilot';
					description = localize2('locopilotAgentDescription', "LoCoPilot AI Assistant").value;
			}

			const disposables = new DisposableStore();
			
			// Register the agent
			disposables.add(chatAgentService.registerAgent(id, {
				id,
				name,
				isDefault,
				isCore: true,
				modes: mode ? [mode] : [ChatModeKind.Ask],
				slashCommands: [],
				disambiguation: [],
				locations: [location],
				metadata: {},
				description,
				extensionId: nullExtensionDescription.identifier,
				extensionVersion: undefined,
				extensionDisplayName: nullExtensionDescription.name,
				extensionPublisherId: nullExtensionDescription.publisher
			}));

			// Create and register the implementation
			const agent = disposables.add(instantiationService.createInstance(LoCoPilotBuiltInAgent, location));
			disposables.add(chatAgentService.registerAgentImplementation(id, agent));

			return disposables;
		});
	}

	private readonly unifiedAgent: UnifiedAgent;

	constructor(
		private readonly location: ChatAgentLocation,
		@ILogService private readonly logService: ILogService,
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@ILanguageModelToolsService private readonly toolsService: ILanguageModelToolsService,
		@IFileService private readonly fileService: IFileService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@ILoCoPilotFileLog private readonly locopilotFileLog: ILoCoPilotFileLog,
		@ILoCoPilotAgentSettingsService private readonly agentSettingsService: ILoCoPilotAgentSettingsService,
	) {
		super();
		const maxIterations = this.agentSettingsService.getMaxIterationsPerRequest();
		this.unifiedAgent = new UnifiedAgent(this.languageModelsService, this.toolsService, this.logService, this.workspaceService, this.locopilotFileLog, maxIterations);
	}

	private _log(msg: string, ...args: unknown[]): void {
		this.logService.info(msg, ...args);
		this.locopilotFileLog.log(msg, ...args);
	}

	/** Threshold: trigger summarization when conversation tokens >= this fraction of max input tokens. */
	private static readonly AUTO_SUMMARIZE_THRESHOLD = 0.9;
	/** Fraction of history entries to keep as recent (not summarized). */
	private static readonly RECENT_HISTORY_FRACTION = 0.1;
	/** Target summary length as fraction of max input tokens. */
	private static readonly SUMMARY_LENGTH_FRACTION = 0.1;

	/**
	 * Compute total token count for an array of chat messages (for context window check).
	 */
	private async computeTotalTokenCount(modelId: string, messages: IChatMessage[], token: CancellationToken): Promise<number> {
		let total = 0;
		try {
			for (const msg of messages) {
				const n = await this.languageModelsService.computeTokenLength(modelId, msg, token);
				total += n;
			}
			return total;
		} catch (e) {
			this._log(`[LoCoPilot] computeTokenLength failed, using character estimate: ${e}`);
			// Fallback: ~4 chars per token
			for (const msg of messages) {
				const text = msg.content.map(p => p.type === 'text' ? p.value : '').join('');
				total += Math.ceil(text.length / 4);
			}
			return total;
		}
	}

	/**
	 * Convert history entries to a plain transcript string for the summarizer.
	 */
	private historyEntriesToTranscript(entries: IChatAgentHistoryEntry[]): string {
		const lines: string[] = [];
		for (const h of entries) {
			lines.push(`User: ${h.request.message ?? ''}`);
			const assistantParts: string[] = [];
			for (const r of h.response) {
				if (r.kind === 'markdownContent') {
					assistantParts.push(r.content.value);
				} else if (r.kind === 'progressMessage') {
					assistantParts.push((r as any).content || '');
				}
			}
			if (assistantParts.length > 0) {
				lines.push(`Assistant: ${assistantParts.join('\n\n')}`);
			}
		}
		return lines.join('\n\n');
	}

	/**
	 * Call the LLM to summarize old conversation entries into a single memory-style summary.
	 * Target length is maxSummaryTokens (approx 10% of model context).
	 */
	private async summarizeHistoryEntries(
		modelId: string,
		oldEntries: IChatAgentHistoryEntry[],
		maxSummaryTokens: number,
		token: CancellationToken
	): Promise<string> {
		const transcript = this.historyEntriesToTranscript(oldEntries);
		const systemPrompt = `You are a conversation summarizer. Your task is to produce a concise "memory" summary of the following conversation that preserves all information important for continuing the discussion later.

Preserve: key facts, decisions, code changes, file names and paths, user preferences, requirements, errors and fixes, and any context that would be needed to answer follow-up questions. Write in clear, dense prose. Do not include greetings or filler. Keep the summary under ${maxSummaryTokens} tokens. Output only the summary, no preamble.`;

		const userMessage = `Summarize this conversation:\n\n${transcript}`;
		const response = await this.languageModelsService.sendChatRequest(
			modelId,
			nullExtensionDescription.identifier,
			[
				{ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt }] },
				{ role: ChatMessageRole.User, content: [{ type: 'text', value: userMessage }] }
			],
			{},
			token
		);
		let summary = '';
		for await (const part of response.stream) {
			const parts = Array.isArray(part) ? part : [part];
			for (const p of parts) {
				if (p.type === 'text') {
					summary += p.value;
				}
			}
		}
		await response.result;
		return summary.trim();
	}

	/**
	 * If conversation would exceed 90% of model's max input tokens, replace oldest history
	 * with a single summarized entry (keep 10% most recent turns intact). Otherwise return original history.
	 */
	private async getHistoryWithSummarizationIfNeeded(
		request: IChatAgentRequest,
		history: IChatAgentHistoryEntry[],
		modelId: string,
		maxInputTokens: number,
		token: CancellationToken
	): Promise<IChatAgentHistoryEntry[]> {
		if (history.length <= 1) {
			return history;
		}
		const keepCount = Math.max(1, Math.ceil(history.length * LoCoPilotBuiltInAgent.RECENT_HISTORY_FRACTION));
		const recent = history.slice(-keepCount);
		const oldEntries = history.slice(0, history.length - keepCount);
		if (oldEntries.length === 0) {
			return history;
		}
		this._log(`[LoCoPilot] Auto-summarizer: summarizing ${oldEntries.length} old entries, keeping ${keepCount} recent`);
		const maxSummaryTokens = Math.max(100, Math.floor(maxInputTokens * LoCoPilotBuiltInAgent.SUMMARY_LENGTH_FRACTION));
		const summaryText = await this.summarizeHistoryEntries(modelId, oldEntries, maxSummaryTokens, token);
		if (!summaryText || token.isCancellationRequested) {
			return history;
		}
		const firstRequest = oldEntries[0].request;
		const summaryEntry: IChatAgentHistoryEntry = {
			request: {
				...firstRequest,
				message: '[Earlier conversation summary]',
				variables: { variables: [] }
			},
			response: [{ kind: 'markdownContent', content: new MarkdownString(summaryText) }],
			result: {}
		};
		return [summaryEntry, ...recent];
	}

	/**
	 * Get editor context (open files, active file, cursor position, selected code)
	 */
	private async getEditorContext(): Promise<string> {
		let context = '';

		// Get active editor
		const activeEditor = this.editorService.activeTextEditorControl;
		const activeEditorInput = this.editorService.activeEditor;

		if (activeEditor && activeEditorInput) {
			const uri = activeEditorInput.resource;
			if (uri) {
				context += `\n**Active File:** \`${uri.fsPath}\`\n`;

				// Get cursor position
				const codeEditor = this.codeEditorService.getActiveCodeEditor();
				if (codeEditor) {
					const position = codeEditor.getPosition();
					if (position) {
						context += `**Cursor Position:** Line ${position.lineNumber}, Column ${position.column}\n`;
					}

					// Get selected text if any
					const selection = codeEditor.getSelection();
					if (selection && !selection.isEmpty()) {
						context += `**Selected Text:** Lines ${selection.startLineNumber}-${selection.endLineNumber}\n`;
						const model = codeEditor.getModel();
						if (model) {
							const selectedText = model.getValueInRange(selection);
							if (selectedText && selectedText.length < 500) {
								context += `\`\`\`\n${selectedText}\n\`\`\`\n`;
							} else if (selectedText) {
								context += `*[${selectedText.length} characters selected]*\n`;
							}
						}
					}
				}
			}
		}

		// Get all open editors
		const editors = this.editorService.editors;
		if (editors.length > 0) {
			context += `\n**Open Files (${editors.length}):**\n`;
			const filesToShow = editors.slice(0, 10); // Limit to 10 files
			for (const editor of filesToShow) {
				if (editor.resource) {
					const fileName = basename(editor.resource);
					context += `- \`${fileName}\``;
					if (editor.resource === activeEditorInput?.resource) {
						context += ` *(active)*`;
					}
					context += `\n`;
				}
			}
			if (editors.length > 10) {
				context += `*... and ${editors.length - 10} more files*\n`;
			}
		}

		return context;
	}

	/**
	 * Get workspace context for agent mode
	 */
	private async getWorkspaceContext(): Promise<string | undefined> {
		const workspaceFolders = this.workspaceService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			return undefined;
		}

		const workspaceRoot = workspaceFolders[0].uri;
		let context = `\n# WORKSPACE & EDITOR CONTEXT\n\n`;
		context += `**Workspace Root:** \`${workspaceRoot.fsPath}\`\n`;

		// Add editor context (open files, active file, cursor position)
		const editorContext = await this.getEditorContext();
		if (editorContext) {
			context += editorContext;
		}

		// Try to detect project type by looking for common config files
		const commonConfigFiles = [
			'package.json',
			'tsconfig.json',
			'requirements.txt',
			'setup.py',
			'pom.xml',
			'build.gradle',
			'Cargo.toml',
			'go.mod',
			'composer.json',
			'Gemfile',
			'.csproj',
			'.sln'
		];

		const detectedConfigs: string[] = [];
		for (const configFile of commonConfigFiles) {
			try {
				const configPath = URI.joinPath(workspaceRoot, configFile);
				const stat = await this.fileService.resolve(configPath);
				if (stat) {
					detectedConfigs.push(configFile);
				}
			} catch {
				// File doesn't exist, continue
			}
		}

		if (detectedConfigs.length > 0) {
			context += `\n**Detected Project Files:** ${detectedConfigs.join(', ')}\n`;
			
			// Add project type hints
			if (detectedConfigs.includes('package.json')) {
				context += `- This appears to be a **JavaScript/TypeScript** project (Node.js/npm)\n`;
			}
			if (detectedConfigs.includes('requirements.txt') || detectedConfigs.includes('setup.py')) {
				context += `- This appears to be a **Python** project\n`;
			}
			if (detectedConfigs.includes('pom.xml') || detectedConfigs.includes('build.gradle')) {
				context += `- This appears to be a **Java** project\n`;
			}
			if (detectedConfigs.includes('Cargo.toml')) {
				context += `- This appears to be a **Rust** project\n`;
			}
			if (detectedConfigs.includes('go.mod')) {
				context += `- This appears to be a **Go** project\n`;
			}
		}

		context += `\n---\n\n**You have access to powerful tools** to explore and modify this codebase:\n`;
		context += `- **Read files:** Use \`readFile\` to read any file\n`;
		context += `- **Search code:** Use \`grep\` to search for patterns\n`;
		context += `- **Find files:** Use \`findFiles\` to locate files by name\n`;
		context += `- **List directories:** Use \`listDirectory\` to explore structure\n`;
		context += `- **Modify code:** Use \`modifyFile\` to create or edit files (path, oldString, newString; use oldString "" to create or overwrite entire file)\n`;
		context += `- **Run commands:** Use \`run_in_terminal\` to execute shell commands\n\n`;
		context += `**Start by exploring the codebase to understand its structure before making changes.**\n`;

		return context;
	}

	/**
	 * Resolve a file URI from a variable (handles file kind, implicit with isFile, and value.uri)
	 */
	private getFileUriFromVariable(variable: IChatRequestVariableEntry): URI | undefined {
		if (variable.kind === 'file' && URI.isUri(variable.value)) {
			return variable.value;
		}
		if (variable.kind === 'file' && typeof variable.value === 'string') {
			try {
				return URI.file(variable.value);
			} catch {
				return undefined;
			}
		}
		// Implicit file attachment (e.g. @file:index.js from chat)
		const v = variable as IChatRequestVariableEntry & { isFile?: boolean; uri?: URI };
		if (v.kind === 'implicit' && v.isFile && v.uri) {
			return v.uri;
		}
		// Location or object with uri (e.g. file with range)
		if (variable.value && typeof variable.value === 'object' && 'uri' in variable.value) {
			const loc = variable.value as { uri: URI };
			if (URI.isUri(loc.uri)) {
				return loc.uri;
			}
		}
		// Fallback: id is often the URI string for file variables (e.g. from attachment model)
		if (variable.kind === 'file' && variable.id && typeof variable.id === 'string') {
			try {
				const uri = URI.parse(variable.id);
				if (uri.scheme && uri.path) {
					return uri;
				}
			} catch {
				// ignore
			}
		}
		return undefined;
	}

	/**
	 * Get workspace-relative path for a file URI so the LLM can pass it to readFile/findFiles.
	 */
	private getWorkspaceRelativePath(uri: URI): string {
		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return uri.fsPath;
		}
		const rel = relativePath(folders[0].uri, uri);
		return rel ?? uri.fsPath;
	}

	/**
	 * Get line range from a file variable if value is { uri, range }.
	 */
	private getFileRangeFromVariable(variable: IChatRequestVariableEntry): IRange | undefined {
		if (variable.value && typeof variable.value === 'object' && 'range' in variable.value) {
			const loc = variable.value as { uri: URI; range: IRange };
			return loc.range;
		}
		return undefined;
	}

	/**
	 * Convert variables/attachments to message content parts.
	 * For file attachments: sends path (workspace-relative) and optional line range only — no file content.
	 * LLM can use readFile(path) or readFile(path, offset, limit) when needed.
	 */
	private async convertVariablesToContent(variables: IChatRequestVariableEntry[]): Promise<IChatMessage['content']> {
		const content: IChatMessage['content'] = [];
		const attachedFileUris = new Set<string>();

		// Resolve active editor and cursor once for "main file" cursor info
		const activeEditorInput = this.editorService.activeEditor;
		const codeEditor = this.codeEditorService.getActiveCodeEditor();
		const cursorPosition = codeEditor?.getPosition();

		this._log(`[LoCoPilot] convertVariablesToContent: Processing ${variables.length} variables`);

		for (const variable of variables) {
			this._log(`[LoCoPilot]   Processing variable: kind=${variable.kind}, name=${variable.name}`);
			if (isPromptFileVariableEntry(variable) || isPromptTextVariableEntry(variable)) {
				// Prompt files are handled separately as system prompts
				continue;
			}

			// Resolve file URI from file, implicit file, or location
			const fileUri = this.getFileUriFromVariable(variable);
			if (fileUri) {
				const workspacePath = this.getWorkspaceRelativePath(fileUri);
				const range = this.getFileRangeFromVariable(variable);
				const rangeStr = range ? ` (lines ${range.startLineNumber}-${range.endLineNumber})` : '';
				const isActiveFile = activeEditorInput?.resource && fileUri.toString() === activeEditorInput.resource.toString();
				const cursorStr = isActiveFile && cursorPosition ? ` — cursor at line ${cursorPosition.lineNumber}, column ${cursorPosition.column}` : '';

				const ext = fileUri.path.split('.').pop()?.toLowerCase();
				const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
				if (ext && imageExts.includes(ext)) {
					// Image file: still send image content (user said don't send file content for text files)
					try {
						const fileContent = await this.fileService.readFile(fileUri);
						const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
						content.push({
							type: 'image_url',
							value: {
								mimeType: mimeType as any,
								data: fileContent.value
							}
						});
						this._log(`[LoCoPilot]   Added image: ${workspacePath}`);
					} catch (e) {
						this.logService.warn(`[LoCoPilot] Failed to read image ${fileUri}: ${e}`);
						content.push({
							type: 'text',
							value: `\n\n[Attached image: ${workspacePath} — could not read]\n`
						});
					}
				} else {
					// Text file: send path and optional line range only — no content; LLM can use readFile when needed
					content.push({
						type: 'text',
						value: `\n\n[Attached file: ${workspacePath}]${rangeStr}${cursorStr}\n`
					});
					this._log(`[LoCoPilot]   Added file reference: ${workspacePath}${rangeStr}`);
				}
				attachedFileUris.add(fileUri.toString());
				continue;
			}

			if (variable.kind === 'image') {
				// Image variable - value can be Uint8Array (e.g. from addFile) or ArrayBuffer (e.g. from history/MCP)
				if (variable.value instanceof Uint8Array || variable.value instanceof ArrayBuffer) {
					const mimeType = variable.mimeType || 'image/png';
					const data = variable.value instanceof ArrayBuffer
						? VSBuffer.wrap(new Uint8Array(variable.value))
						: VSBuffer.wrap(variable.value);
					content.push({
						type: 'image_url',
						value: {
							mimeType: mimeType as any,
							data
						}
					});
				}
			} else if (variable.kind === 'paste') {
				// Pasted code
				content.push({
					type: 'text',
					value: `\n\n[Pasted ${variable.language} code]\n\`\`\`${variable.language}\n${variable.code}\n\`\`\`\n`
				});
			} else if (variable.kind === 'string' && typeof variable.value === 'string') {
				content.push({
					type: 'text',
					value: `\n\n[${variable.name}]: ${variable.value}\n`
				});
			} else if (variable.kind === 'symbol' && variable.value && typeof variable.value === 'object' && 'uri' in variable.value) {
				// Symbol reference
				const location = variable.value as any;
				try {
					const model = await this.textModelService.createModelReference(location.uri);
					const text = model.object.textEditorModel?.getValueInRange(location.range) || '';
					model.dispose();
					content.push({
						type: 'text',
						value: `\n\n[Symbol: ${variable.name}]\n\`\`\`\n${text}\n\`\`\`\n`
					});
				} catch (e) {
					this.logService.warn(`[LoCoPilot] Failed to read symbol ${variable.name}: ${e}`);
					this.locopilotFileLog.log(`[LoCoPilot] Failed to read symbol ${variable.name}: ${e}`);
				}
			}
		}

		// Other open files (max 10) — for images: include actual image content so LLM can see them; for text files: paths only
		const editors = this.editorService.editors;
		const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff'];
		const maxOpenImages = 3; // avoid huge payloads
		let openImageCount = 0;
		if (editors.length > 0) {
			const otherOpenPaths: string[] = [];
			for (const editor of editors) {
				if (!editor.resource || attachedFileUris.has(editor.resource.toString())) {
					continue;
				}
				const workspacePath = this.getWorkspaceRelativePath(editor.resource);
				otherOpenPaths.push(workspacePath);
				// Include image bytes for open image files so the LLM can actually see them
				const ext = editor.resource.path.split('.').pop()?.toLowerCase();
				if (ext && imageExts.includes(ext) && openImageCount < maxOpenImages) {
					try {
						const fileContent = await this.fileService.readFile(editor.resource);
						const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
						content.push({
							type: 'image_url',
							value: {
								mimeType: mimeType as any,
								data: fileContent.value
							}
						});
						openImageCount++;
						this._log(`[LoCoPilot] Added open image to content: ${workspacePath}`);
					} catch (e) {
						this.logService.warn(`[LoCoPilot] Failed to read open image ${editor.resource}: ${e}`);
					}
				}
			}
			const pathsToShow = otherOpenPaths.slice(0, 10);
			if (pathsToShow.length > 0) {
				content.push({
					type: 'text',
					value: `\n\n[Other open files (${pathsToShow.length}):]\n${pathsToShow.map(p => `- ${p}`).join('\n')}\n`
				});
				this._log(`[LoCoPilot] Added ${pathsToShow.length} other open file path(s)`);
			}
		}

		this._log(`[LoCoPilot] convertVariablesToContent: Created ${content.length} content parts`);
		return content;
	}

	/**
	 * Get full system prompt for LLM: general (from settings) + tools prompt.
	 */
	private getDefaultSystemPrompt(modeKind: ChatModeKind | undefined): string {
		switch (modeKind) {
			case ChatModeKind.Agent:
				return this.agentSettingsService.getFullAgentModeSystemPrompt();

			case ChatModeKind.Edit:
				return `You are an AI assistant specialized in editing code. Your role is to:
- Make precise code edits based on user requests
- Understand context from attached files
- Apply changes accurately
- Maintain code quality and style
- Use tools to read and modify files

Focus on making the exact changes requested while preserving code structure and quality.`;

			case ChatModeKind.Ask:
			default:
				return this.agentSettingsService.getFullAskModeSystemPrompt();
		}
	}

	/**
	 * Build complete messages array with system prompt, history, variables, and current message
	 */
	private async buildMessages(
		request: IChatAgentRequest,
		history: IChatAgentHistoryEntry[],
		modelMetadata: any,
		modeInfo?: IChatRequestModeInfo
	): Promise<IChatMessage[]> {
		const messages: IChatMessage[] = [];
		
		// 1. Add system prompt from mode instructions or use default based on mode
		let systemPrompt: string | undefined = request.modeInstructions?.content;
		
		// If no mode instructions in request, try to get from modeInfo
		if (!systemPrompt && modeInfo?.modeInstructions?.content) {
			systemPrompt = modeInfo.modeInstructions.content;
			this._log(`[LoCoPilot] Got mode instructions from modeInfo: ${modeInfo.modeId}`);
		}
		
		// If still no system prompt, add default based on mode kind
		if (!systemPrompt) {
			// Use modeInfo.kind if available, otherwise fallback based on location
			const modeKind = modeInfo?.kind ?? (request.location === ChatAgentLocation.EditorInline ? ChatModeKind.Edit : ChatModeKind.Ask);
			systemPrompt = this.getDefaultSystemPrompt(modeKind);
			this._log(`[LoCoPilot] Using default system prompt for mode: ${modeKind} (modeInfo.kind=${modeInfo?.kind}, location=${request.location})`);
		}
		
		// Add workspace context for Agent mode
		const modeKind = modeInfo?.kind ?? ChatModeKind.Ask;
		if (modeKind === ChatModeKind.Agent) {
			const workspaceContext = await this.getWorkspaceContext();
			if (workspaceContext) {
				systemPrompt = systemPrompt + '\n\n' + workspaceContext;
			}
		}
		
		if (systemPrompt) {
			messages.push({
				role: ChatMessageRole.System,
				content: [{ type: 'text', value: systemPrompt }]
			});
		}
		
		// 2. Reconstruct history with variables and tool calls
		for (const h of history) {
			// User message with variables
			const userContent: IChatMessage['content'] = [];
			
			// Add variables/attachments to user message
			if (h.request.variables?.variables) {
				const variableContent = await this.convertVariablesToContent([...h.request.variables.variables]);
				userContent.push(...variableContent);
			}
			
			// Add the actual message text
			userContent.push({ type: 'text', value: h.request.message });
			
			messages.push({
				role: ChatMessageRole.User,
				content: userContent
			});
			
			// Assistant response - extract text from various response types
			const assistantParts: string[] = [];
			for (const r of h.response) {
				if (r.kind === 'markdownContent') {
					assistantParts.push(r.content.value);
				} else if (r.kind === 'progressMessage') {
					assistantParts.push((r as any).content || '');
				}
				// Note: Other response types (textEditGroup, treeData, etc.) are complex structures
				// For now, we only extract simple text/markdown content
			}
			
			if (assistantParts.length > 0) {
				messages.push({
					role: ChatMessageRole.Assistant,
					content: [{ type: 'text', value: assistantParts.join('\n\n') }]
				});
			}
		}
		
		// 3. Add current request with variables
		const currentContent: IChatMessage['content'] = [];
		
		// Add variables/attachments to current message
		if (request.variables?.variables) {
			const variableContent = await this.convertVariablesToContent([...request.variables.variables]);
			currentContent.push(...variableContent);
		}
		
		// Add the actual message text
		currentContent.push({ type: 'text', value: request.message });
		
		messages.push({
			role: ChatMessageRole.User,
			content: currentContent
		});
		
		return messages;
	}

	/**
	 * Generate a short session title using the LLM from the first user message.
	 * Called by the chat service for new sessions (first request only).
	 */
	async provideChatTitle(history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<string | undefined> {
		if (history.length === 0) {
			return undefined;
		}
		const firstMessage = history[0].request.message?.trim();
		if (!firstMessage) {
			return undefined;
		}
		try {
			// Prefer LoCoPilot custom models, then fallback to any available model for title generation
			let models = await this.languageModelsService.selectLanguageModels({ vendor: 'locopilot' });
			if (!models.length) {
				models = await this.languageModelsService.selectLanguageModels({ vendor: 'copilot', id: 'copilot-fast' });
			}
			if (!models.length) {
				models = await this.languageModelsService.selectLanguageModels({ vendor: 'copilot', family: 'gpt-4o-mini' });
			}
			if (!models.length) {
				models = await this.languageModelsService.selectLanguageModels({});
			}
			if (!models.length || token.isCancellationRequested) {
				return undefined;
			}
			const prompt = `Generate a very short title (max 6-8 words) for a chat that starts with this message. Reply with only the title, no quotes or extra punctuation.

Message: ${firstMessage.substring(0, 500)}`;
			const response = await this.languageModelsService.sendChatRequest(
				models[0],
				new ExtensionIdentifier('core'),
				[{ role: ChatMessageRole.User, content: [{ type: 'text', value: prompt }] }],
				{},
				token
			);
			let title = '';
			for await (const part of response.stream) {
				if (Array.isArray(part)) {
					for (const p of part) {
						if (p.type === 'text') {
							title += p.value;
						}
					}
				} else if (part.type === 'text') {
					title += part.value;
				}
			}
			await response.result;
			title = title.trim().split('\n')[0].substring(0, 80);
			if (title && !token.isCancellationRequested) {
				this._log(`[LoCoPilot] Generated session title: ${title}`);
				return title;
			}
		} catch (e) {
			this.logService.warn(`[LoCoPilot] Failed to generate chat title: ${e}`);
		}
		return undefined;
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		// Try to find and use an existing non-core agent first
		const widget = this.chatWidgetService.getWidgetBySessionResource(request.sessionResource);
		const modeInfo = widget?.input.currentModeInfo;
		const defaultAgent = this.chatAgentService.getDefaultAgent(this.location, modeInfo?.kind);

		// If there's a non-core agent available (from extensions), try to use it
		if (defaultAgent && !defaultAgent.isCore && defaultAgent.id !== 'locopilot.ask' && defaultAgent.id !== 'locopilot.edit' && defaultAgent.id !== 'locopilot.agent') {
			this._log(`[LoCoPilot] Delegating to existing agent: ${defaultAgent.id}`);
			try {
				// Forward the request to the existing agent
				const requestModel = this.chatWidgetService.getWidgetBySessionResource(request.sessionResource)?.viewModel?.model.getRequests().at(-1);
				if (requestModel) {
					await this.chatService.resendRequest(requestModel, {
						...widget?.getModeRequestOptions(),
						modeInfo,
						userSelectedModelId: widget?.input.currentLanguageModel
					});
					return {};
				}
			} catch (error) {
				this.logService.warn(`[LoCoPilot] Failed to delegate to existing agent, using built-in: ${error}`);
				this.locopilotFileLog.log(`[LoCoPilot] Failed to delegate to existing agent, using built-in: ${error}`);
			}
		}

		// Try to use custom models if available
		const allModelIds = this.languageModelsService.getLanguageModelIds();
		const userSelectedModelId = request.userSelectedModelId;
		
		// Also check the widget's current language model selection
		const widgetModelId = widget?.input.currentLanguageModel;
		
		// Check custom models service directly
		const customModels = this.customLanguageModelsService.getVisibleCustomModels();
		const selectedCustomModelId = this.customLanguageModelsService.getSelectedCustomModelId();
		
		// Try to find a custom model - check userSelectedModelId first, then widget's selection, then selected custom model, then any custom model
		let modelId = userSelectedModelId || widgetModelId || selectedCustomModelId;
		
		// If no explicit selection, try to find any custom model from the service
		if (!modelId && customModels.length > 0) {
			modelId = customModels[0].id;
			this._log(`[LoCoPilot] No explicit model selected, using first available custom model: ${modelId}`);
		}
		
		// Also check if the model exists by looking it up in the language models service
		if (modelId) {
			const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
			if (!modelMetadata) {
				this.logService.warn(`[LoCoPilot] Model ${modelId} not found in language models service, but found in custom models service. Will try anyway.`);
				this.locopilotFileLog.log(`[LoCoPilot] Model ${modelId} not found in language models service, but found in custom models service. Will try anyway.`);
				// Don't set to undefined - we'll try to use it anyway since it exists in custom models
			}
		}

		this._log(`[LoCoPilot] Invoke - userSelectedModelId: ${userSelectedModelId}, widgetModelId: ${widgetModelId}, selectedCustomModelId: ${selectedCustomModelId}, final modelId: ${modelId}`);
		this._log(`[LoCoPilot] Available model IDs from service: ${allModelIds.join(', ') || '(none)'}`);
		this._log(`[LoCoPilot] Available custom models: ${customModels.map(m => m.id).join(', ') || '(none)'}`);

		if (modelId) {
			this._log(`[LoCoPilot] Using model: ${modelId}`);
			
			// Check if model is in cache, if not, try to resolve it
			let modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
			if (!modelMetadata) {
				this._log(`[LoCoPilot] Model ${modelId} not in cache, attempting to resolve...`);
				try {
					// Trigger resolution by selecting models for locopilot vendor
					const resolvedIds = await this.languageModelsService.selectLanguageModels({ vendor: 'locopilot' });
					this._log(`[LoCoPilot] Resolved ${resolvedIds.length} models: ${resolvedIds.join(', ')}`);
					modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
					if (!modelMetadata) {
						this.logService.warn(`[LoCoPilot] Model ${modelId} still not found after resolution`);
						this.locopilotFileLog.log(`[LoCoPilot] Model ${modelId} still not found after resolution`);
					}
				} catch (e) {
					this.logService.warn(`[LoCoPilot] Failed to resolve models: ${e}`);
					this.locopilotFileLog.log(`[LoCoPilot] Failed to resolve models: ${e}`);
				}
			}

			try {
				// Get mode info from widget if available
				const widget = this.chatWidgetService.getWidgetBySessionResource(request.sessionResource);
				const modeInfo = widget?.input.currentModeInfo;
				
				// Get attachments from widget's attachment model (files attached via UI)
				const widgetAttachments = widget?.input.attachmentModel.attachments || [];
				this._log(`[LoCoPilot] Widget attachments: ${widgetAttachments.length} items`);
				for (const att of widgetAttachments) {
					this._log(`[LoCoPilot]   - Widget attachment: ${att.kind} "${att.name}"`);
				}
				
				// Merge widget attachments with request variables
				const allVariables = [...(request.variables?.variables || [])];
				// Add widget attachments that aren't already in variables
				for (const widgetAtt of widgetAttachments) {
					// Check if this attachment is already in variables
					const alreadyIncluded = allVariables.some(v => 
						v.id === widgetAtt.id || 
						(v.kind === 'file' && widgetAtt.kind === 'file' && URI.isUri(v.value) && URI.isUri(widgetAtt.value) && v.value.toString() === widgetAtt.value.toString())
					);
					if (!alreadyIncluded) {
						allVariables.push(widgetAtt);
						this._log(`[LoCoPilot] Added widget attachment to variables: ${widgetAtt.kind} "${widgetAtt.name}"`);
					}
				}
				
				// Log what we're receiving
				this._log(`[LoCoPilot] Request details:`);
				this._log(`[LoCoPilot] - Message: "${request.message}"`);
				this._log(`[LoCoPilot] - Variables from request: ${request.variables?.variables?.length || 0} items`);
				this._log(`[LoCoPilot] - Total variables (including widget attachments): ${allVariables.length} items`);
				if (allVariables.length > 0) {
					for (const v of allVariables) {
						this._log(`[LoCoPilot]   - Variable: ${v.kind} "${v.name}"`);
					}
				}
				this._log(`[LoCoPilot] - Mode: ${modeInfo?.modeId || 'unknown'}, Kind: ${modeInfo?.kind || 'unknown'}`);
				this._log(`[LoCoPilot] - Mode instructions in request: ${request.modeInstructions ? 'Yes' : 'No'}`);
				if (request.modeInstructions) {
					this._log(`[LoCoPilot]   - Content: ${request.modeInstructions.content.substring(0, 100)}...`);
				}
				this._log(`[LoCoPilot] - Mode instructions in modeInfo: ${modeInfo?.modeInstructions ? 'Yes' : 'No'}`);
				if (modeInfo?.modeInstructions) {
					this._log(`[LoCoPilot]   - Content: ${modeInfo.modeInstructions.content.substring(0, 100)}...`);
				}
				this._log(`[LoCoPilot] - User selected tools: ${request.userSelectedTools ? Object.keys(request.userSelectedTools).length : 0} tools`);
				this._log(`[LoCoPilot] - History entries: ${history.length}`);
				
				// Build complete messages with system prompt, history, variables, and current message
				// Create a modified request with merged variables
				const requestWithMergedVars: IChatAgentRequest = {
					...request,
					variables: {
						variables: allVariables
					}
				};
				// Auto-summarizer: if conversation would exceed 90% of model's max input tokens, summarize old history
				const maxInputTokens = modelMetadata?.maxInputTokens ?? 128000;
				let historyToUse = history;
				let messages = await this.buildMessages(requestWithMergedVars, historyToUse, modelMetadata, modeInfo);
				const totalTokens = await this.computeTotalTokenCount(modelId, messages, token);
				if (totalTokens >= LoCoPilotBuiltInAgent.AUTO_SUMMARIZE_THRESHOLD * maxInputTokens && history.length > 1) {
					this._log(`[LoCoPilot] Conversation tokens (${totalTokens}) >= 90% of max input (${maxInputTokens}), triggering auto-summarizer`);
					historyToUse = await this.getHistoryWithSummarizationIfNeeded(requestWithMergedVars, history, modelId, maxInputTokens, token);
					messages = await this.buildMessages(requestWithMergedVars, historyToUse, modelMetadata, modeInfo);
					this._log(`[LoCoPilot] After summarization: ${historyToUse.length} history entries, ${messages.length} messages`);
				}
				// Main agentic loop - handle tool calls iteratively
				return this.unifiedAgent.run(request, progress, messages, modelId, token);
			} catch (e) {
				this.logService.error(`[LoCoPilot] Failed to call model ${modelId}: ${e}`);
				this.locopilotFileLog.log(`[LoCoPilot] Failed to call model ${modelId}: ${e}`);
				// Show error to user
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`**Error calling model:** ${toErrorMessage(e)}\n\nPlease check your API key and model configuration.`)
				}]);
				return {};
			}
		}

		// If no external agent is available, provide a helpful message
		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(localize('locopilotNoAgentAvailable',
				"Chat is ready! To get AI-powered responses:\n\n" +
				"1. From the **Auto** dropdown, choose **Add language models**\n" +
				"2. Add a model from cloud or local providers\n" +
				"3. Select it from the Auto dropdown and use it\n\n" +
				"The chat panel is now available for use."
			))
		}]);

		return {};
	}
}
