/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { IActionProvider } from '../../../../../../base/browser/ui/dropdown/dropdown.js';
import { IManagedHoverContent } from '../../../../../../base/browser/ui/hover/hover.js';
import { renderIcon, renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction, Separator } from '../../../../../../base/common/actions.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider, IActionWidgetDropdownOptions } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { TelemetryTrustedValue } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../../../services/chat/common/chatEntitlementService.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../../common/constants.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../common/languageModels.js';
import { DEFAULT_MODEL_PICKER_CATEGORY } from '../../../common/widget/input/modelPickerWidget.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { ICustomLanguageModelsService, getCustomModelListLabel, isCustomModelReadyForChat } from '../../../common/customLanguageModelsService.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';

export interface IModelPickerDelegate {
	readonly currentModel: IObservable<ILanguageModelChatMetadataAndIdentifier | undefined>;
	setModel(model: ILanguageModelChatMetadataAndIdentifier): void;
	getModels(): ILanguageModelChatMetadataAndIdentifier[];
}

type ChatModelChangeClassification = {
	owner: 'lramos15';
	comment: 'Reporting when the model picker is switched';
	fromModel?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The previous chat model' };
	toModel: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The new chat model' };
};

type ChatModelChangeEvent = {
	fromModel: string | TelemetryTrustedValue<string> | undefined;
	toModel: string | TelemetryTrustedValue<string>;
};


function modelDelegateToWidgetActionsProvider(delegate: IModelPickerDelegate, telemetryService: ITelemetryService, customLanguageModelsService: ICustomLanguageModelsService): IActionWidgetDropdownActionProvider {
	return {
		getActions: () => {
			const models = delegate.getModels();
			const customModels = customLanguageModelsService.getChatSelectableCustomModels();

			// Convert custom models to ILanguageModelChatMetadataAndIdentifier format
			const selectedCustomModelId = customLanguageModelsService.getSelectedCustomModelId();
			const customModelActions: IActionWidgetDropdownAction[] = customModels.map(customModel => ({
				id: customModel.id,
				enabled: true,
				checked: customModel.id === selectedCustomModelId,
				category: { label: 'Custom Models', order: 100 },
				class: undefined,
				description: `${customModel.type === 'cloud' ? 'Cloud' : 'Local'} | ${customModel.provider}`,
				tooltip: getCustomModelListLabel(customModel),
				label: getCustomModelListLabel(customModel),
				hover: { content: localize('chat.modelPicker.customModel.description', "Custom {0} model from {1}", customModel.type, customModel.provider) },
				run: () => {
					// Store selected custom model ID
					customLanguageModelsService.setSelectedCustomModelId(customModel.id);
					// Update the label to show selected model
					// The label will be updated via the autorun in ModelPickerActionItem constructor
				}
			}));

			if (models.length === 0 && customModelActions.length === 0) {
				// Show a fake "Auto" entry when no models are available
				return [{
					id: 'auto',
					enabled: true,
					checked: true,
					category: DEFAULT_MODEL_PICKER_CATEGORY,
					class: undefined,
					description: localize('chat.modelPicker.auto.detail', "Best for your request based on capacity and performance."),
					tooltip: localize('chat.modelPicker.auto', "Auto"),
					label: localize('chat.modelPicker.auto', "Auto"),
					hover: { content: localize('chat.modelPicker.auto.description', "Automatically selects the best model for your task based on context and complexity.") },
					run: () => { }
				} satisfies IActionWidgetDropdownAction];
			}

			const standardModelActions = models.map(model => {
				const hoverContent = model.metadata.tooltip;
				return {
					id: model.metadata.id,
					enabled: true,
					icon: model.metadata.statusIcon,
					checked: model.identifier === delegate.currentModel.get()?.identifier,
					category: model.metadata.modelPickerCategory || DEFAULT_MODEL_PICKER_CATEGORY,
					class: undefined,
					description: model.metadata.multiplier ?? model.metadata.detail,
					tooltip: hoverContent ? '' : model.metadata.name,
					hover: hoverContent ? { content: hoverContent } : undefined,
					label: model.metadata.name,
					run: () => {
						const previousModel = delegate.currentModel.get();
						// Clear custom model selection when selecting a standard model
						customLanguageModelsService.setSelectedCustomModelId(undefined);
						telemetryService.publicLog2<ChatModelChangeEvent, ChatModelChangeClassification>('chat.modelChange', {
							fromModel: previousModel?.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(previousModel.identifier) : 'unknown',
							toModel: model.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(model.identifier) : 'unknown'
						});
						delegate.setModel(model);
					}
				} satisfies IActionWidgetDropdownAction;
			});

			// Combine standard and custom models
			return [...standardModelActions, ...customModelActions];
		}
	};
}

function getModelPickerActionBarActionProvider(commandService: ICommandService, chatEntitlementService: IChatEntitlementService, productService: IProductService, customLanguageModelsService: ICustomLanguageModelsService): IActionProvider {

	const actionProvider: IActionProvider = {
		getActions: () => {
			const additionalActions: IAction[] = [];

			// Add "Original" option (existing Language Models screen)
			if (
				chatEntitlementService.entitlement === ChatEntitlement.Free ||
				chatEntitlementService.entitlement === ChatEntitlement.Pro ||
				chatEntitlementService.entitlement === ChatEntitlement.ProPlus ||
				chatEntitlementService.entitlement === ChatEntitlement.Business ||
				chatEntitlementService.entitlement === ChatEntitlement.Enterprise ||
				chatEntitlementService.isInternal
			) {
				additionalActions.push({
					id: 'originalModels',
					label: localize('chat.originalModels', "Original"),
					enabled: true,
					tooltip: localize('chat.originalModels.tooltip', "Open Original Language Models screen"),
					class: undefined,
					run: () => {
						commandService.executeCommand(MANAGE_CHAT_COMMAND_ID);
					}
				});
			}

			// Add "Language Models" option (new custom models screen) - only if not already shown
			const isNewOrAnonymousUser = !chatEntitlementService.sentiment.installed ||
				chatEntitlementService.entitlement === ChatEntitlement.Available ||
				chatEntitlementService.anonymous ||
				chatEntitlementService.entitlement === ChatEntitlement.Unknown;

			// Only add if user is not new/anonymous (to avoid duplicate with "moreModels" below)
			if (!isNewOrAnonymousUser && chatEntitlementService.entitlement !== ChatEntitlement.Free) {
				additionalActions.push({
					id: 'addLanguageModels',
					label: localize('chat.addLanguageModels', "Add Language Models"),
					enabled: true,
					tooltip: localize('chat.addLanguageModels.tooltip', "Add custom language models (Cloud or Local)"),
					class: undefined,
					run: () => {
						commandService.executeCommand('workbench.action.chat.openLoCoPilotSettings', { section: 'add-model' });
					}
				});
			}

			// Add separator if there are other actions
			if (additionalActions.length > 0) {
				additionalActions.push(new Separator());
			}

			// Add sign-in / upgrade option if entitlement is anonymous / free / new user
			if (isNewOrAnonymousUser || chatEntitlementService.entitlement === ChatEntitlement.Free) {
				additionalActions.push({
					id: 'moreModels',
					label: isNewOrAnonymousUser ? localize('chat.moreModels', "Add Language Models") : localize('chat.morePremiumModels', "Add Premium Models"),
					enabled: true,
					tooltip: isNewOrAnonymousUser ? localize('chat.moreModels.tooltip', "Add Language Models") : localize('chat.morePremiumModels.tooltip', "Add Premium Models"),
					class: undefined,
					run: () => {
						if (isNewOrAnonymousUser) {
							commandService.executeCommand('workbench.action.chat.openLoCoPilotSettings', { section: 'add-model' });
						} else {
							commandService.executeCommand('workbench.action.chat.upgradePlan');
						}
					}
				});
			}

			return additionalActions;
		}
	};
	return actionProvider;
}

/**
 * Action view item for selecting a language model in the chat interface.
 */
export class ModelPickerActionItem extends ChatInputPickerActionViewItem {
	protected currentModel: ILanguageModelChatMetadataAndIdentifier | undefined;

	constructor(
		action: IAction,
		widgetOptions: Omit<IActionWidgetDropdownOptions, 'label' | 'labelRenderer'> | undefined,
		delegate: IModelPickerDelegate,
		pickerOptions: IChatInputPickerOptions,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService commandService: ICommandService,
		@IChatEntitlementService chatEntitlementService: IChatEntitlementService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IProductService productService: IProductService,
		@ICustomLanguageModelsService customLanguageModelsService: ICustomLanguageModelsService,
	) {
		// Get initial model name
		const initialModel = delegate.currentModel.get();
		const initialCustomModelId = customLanguageModelsService.getSelectedCustomModelId();
		let initialLabel = localize('chat.modelPicker.auto', "Auto");

		if (initialCustomModelId) {
			const customModel = customLanguageModelsService.getChatSelectableCustomModels().find(m => m.id === initialCustomModelId);
			if (customModel && isCustomModelReadyForChat(customModel)) {
				initialLabel = getCustomModelListLabel(customModel);
			}
		} else if (initialModel) {
			initialLabel = initialModel.metadata.name;
		}

		// Modify the original action with a different label and make it show the current model
		const actionWithLabel: IAction = {
			...action,
			label: initialLabel,
			run: () => { }
		};

		const modelPickerActionWidgetOptions: Omit<IActionWidgetDropdownOptions, 'label' | 'labelRenderer'> = {
			actionProvider: modelDelegateToWidgetActionsProvider(delegate, telemetryService, customLanguageModelsService),
			actionBarActionProvider: getModelPickerActionBarActionProvider(commandService, chatEntitlementService, productService, customLanguageModelsService),
			reporter: { name: 'ChatModelPicker', includeOptions: true },
		};

		super(actionWithLabel, widgetOptions ?? modelPickerActionWidgetOptions, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);
		this.currentModel = initialModel;

		// Listen for model changes from the delegate and custom models
		this._register(autorun(t => {
			const model = delegate.currentModel.read(t);
			const selectedCustomModelId = customLanguageModelsService.getSelectedCustomModelId();

			// If a custom model is selected, use it; otherwise use the standard model
			if (selectedCustomModelId) {
				const customModel = customLanguageModelsService.getChatSelectableCustomModels().find(m => m.id === selectedCustomModelId);
				if (customModel && isCustomModelReadyForChat(customModel)) {
					// Create a synthetic model metadata for display
					this.currentModel = {
						identifier: customModel.id,
						metadata: {
							extension: new ExtensionIdentifier('custom'),
							name: getCustomModelListLabel(customModel),
							id: customModel.id,
							vendor: customModel.provider,
							version: '1.0.0',
							family: customModel.type,
							maxInputTokens: 0,
							maxOutputTokens: 0,
							isDefaultForLocation: {},
							isUserSelectable: true,
							modelPickerCategory: { label: 'Custom Models', order: 100 }
						}
					};
				} else {
					// Custom model was deleted, hidden, or not ready for chat - clear selection
					customLanguageModelsService.setSelectedCustomModelId(undefined);
					this.currentModel = model;
				}
			} else {
				this.currentModel = model;
			}

			this.updateTooltip();
			if (this.element) {
				this.renderLabel(this.element);
			}
		}));

		// Also listen for custom model changes to immediately update the display
		this._register(customLanguageModelsService.onDidChangeCustomModels(() => {
			// Re-read the current state and update
			const selectedCustomModelId = customLanguageModelsService.getSelectedCustomModelId();
			const model = delegate.currentModel.get();

			if (selectedCustomModelId) {
				const customModel = customLanguageModelsService.getChatSelectableCustomModels().find(m => m.id === selectedCustomModelId);
				if (customModel && isCustomModelReadyForChat(customModel)) {
					this.currentModel = {
						identifier: customModel.id,
						metadata: {
							extension: new ExtensionIdentifier('custom'),
							name: getCustomModelListLabel(customModel),
							id: customModel.id,
							vendor: customModel.provider,
							version: '1.0.0',
							family: customModel.type,
							maxInputTokens: 0,
							maxOutputTokens: 0,
							isDefaultForLocation: {},
							isUserSelectable: true,
							modelPickerCategory: { label: 'Custom Models', order: 100 }
						}
					};
				} else {
					// Model was deleted or hidden or not ready for chat, clear selection
					customLanguageModelsService.setSelectedCustomModelId(undefined);
					this.currentModel = model;
				}
			} else {
				this.currentModel = model;
			}

			if (this.element) {
				this.renderLabel(this.element);
			}
		}));
	}

	protected override getHoverContents(): IManagedHoverContent | undefined {
		const label = `${localize('chat.modelPicker.label', "Pick Model")}${super.getHoverContents()}`;
		const { statusIcon, tooltip } = this.currentModel?.metadata || {};
		return statusIcon && tooltip ? `${label} | ${tooltip}` : label;
	}

	protected override setAriaLabelAttributes(element: HTMLElement): void {
		super.setAriaLabelAttributes(element);
		const modelName = this.currentModel?.metadata.name ?? localize('chat.modelPicker.auto', "Auto");
		element.ariaLabel = localize('chat.modelPicker.ariaLabel', "Pick Model, {0}", modelName);
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		const { name, statusIcon } = this.currentModel?.metadata || {};
		const domChildren = [];

		if (statusIcon) {
			const iconElement = renderIcon(statusIcon);
			domChildren.push(iconElement);
		}

		domChildren.push(dom.$('span.chat-input-picker-label', undefined, name ?? localize('chat.modelPicker.auto', "Auto")));
		domChildren.push(...renderLabelWithIcons(`$(chevron-down)`));

		dom.reset(element, ...domChildren);
		this.setAriaLabelAttributes(element);
		return null;
	}

}
