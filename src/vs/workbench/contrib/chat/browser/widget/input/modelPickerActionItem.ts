/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { IActionProvider } from '../../../../../../base/browser/ui/dropdown/dropdown.js';
import { IManagedHoverContent } from '../../../../../../base/browser/ui/hover/hover.js';
import { renderIcon, renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction, Separator, toAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
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
import { ICustomLanguageModelsService, ICustomLanguageModel, getCustomModelListLabel, LOCOPILOT_AUTO_MODEL_ID } from '../../../common/customLanguageModelsService.js';
import { LOCOPILOT_SETTINGS_SECTION_LIST_MODELS } from '../../chatManagement/locopilotSettingsEditorInput.js';
import { getRecommendedRepoId, resolveAutoModelPinned } from '../../locopilotModelCatalog.js';
import { ITimerService } from '../../../../../services/timer/browser/timerService.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { ILoCoPilotLocalModelRunner } from '../../locopilotLocalModelRunner.js';

export interface IModelPickerDelegate {
	readonly currentModel: IObservable<ILanguageModelChatMetadataAndIdentifier | undefined>;
	setModel(model: ILanguageModelChatMetadataAndIdentifier): void;
	getModels(): ILanguageModelChatMetadataAndIdentifier[];
	/**
	 * Gate a model switch. If a chat request is currently running, switching the model would break the
	 * ongoing execution, so the delegate prompts the user to confirm. Returns `true` when the switch may
	 * proceed (no request running, or the user confirmed - in which case the running request is cancelled)
	 * and `false` when the user chose to keep the current model. Must be awaited BEFORE any selection side
	 * effects run, so nothing changes when the user declines. `newModelName` is shown in the prompt.
	 */
	confirmModelChange(newModelName: string): Promise<boolean>;
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


/**
 * Push a custom (locopilot-vendor) model into the chat input's real selected model.
 *
 * The picker keeps two selection stores: `getSelectedCustomModelId()` only drives the picker label and
 * checkmark, while `delegate.setModel(...)` updates the chat input's `_currentLanguageModel` - the value
 * actually passed to sendChatRequest, the in-chat download prompt, and the local model runner. Selecting a
 * custom model must update BOTH; otherwise the request keeps using whatever was selected at init (the
 * default model) no matter what the user picks. Prefer the model registered with the language model service
 * (so token limits/metadata are accurate); fall back to a synthetic entry keyed by the custom model id,
 * which is enough for the provider to resolve and route the request.
 */
function selectCustomModelInChat(delegate: IModelPickerDelegate, customLanguageModelsService: ICustomLanguageModelsService, customModelId: string): void {
	const registered = delegate.getModels().find(m => m.identifier === customModelId);
	if (registered) {
		delegate.setModel(registered);
		return;
	}
	const customModel = customLanguageModelsService.getCustomModels().find(m => m.id === customModelId);
	if (!customModel) {
		return;
	}
	delegate.setModel({
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
	});
}

/**
 * Confirm-then-select a custom model. The confirmation MUST run before `setSelectedCustomModelId` (which
 * drives the picker label/checkmark) so that declining while a request is running leaves the previous
 * selection - and therefore the picker label - completely untouched. No-ops on decline.
 */
async function applyCustomModelSelection(delegate: IModelPickerDelegate, customLanguageModelsService: ICustomLanguageModelsService, customModelId: string, skipConfirm = false): Promise<void> {
	const customModel = customLanguageModelsService.getCustomModels().find(m => m.id === customModelId);
	const modelName = customModel ? getCustomModelListLabel(customModel) : customModelId;
	// `skipConfirm` is set when the picked model is the one already running the in-flight request (e.g. the
	// model Auto currently resolves to): the switch interrupts nothing, so don't prompt "change anyway?".
	if (!skipConfirm && !await delegate.confirmModelChange(modelName)) {
		return;
	}
	customLanguageModelsService.setSelectedCustomModelId(customModelId);
	selectCustomModelInChat(delegate, customLanguageModelsService, customModelId);
}

/**
 * A local model is start/stop-able from the picker when it's a downloaded HuggingFace (llama.cpp/MLX) model
 * with a resolved local path and no download in flight - the same gate the model-list editor uses to decide
 * whether to render its Run/Stop server controls. Cloud, Ollama, localhost, and not-yet-downloaded catalog
 * models have no per-model server to manage, so they keep the plain checkmark.
 */
function isStartableLocalModel(model: ICustomLanguageModel): boolean {
	return model.type === 'local' && model.provider === 'huggingface' && !!model.localPath && !model.isDownloading;
}

/**
 * Build the state-based start/stop control that REPLACES the selected model's checkmark in the picker.
 *
 * Mirrors the model-list editor's server controls, condensed to a single left-slot icon (shown in place of
 * the checkmark) so the user can start or stop the selected local model directly from the chat model picker:
 *  - starting/loading -> spinner icon, disabled, "Starting..." tooltip
 *  - running          -> stop-in-circle icon, click stops the server
 *  - stopped          -> play icon, click starts the server
 *
 * Returns the left-slot `icon`, a `tooltip`, and the `run` handler wired into the selected model's row so a
 * click anywhere on it toggles the server. Clicking refreshes the list so the icon flips as the server
 * transitions.
 */
function buildStartStopControl(
	runner: ILoCoPilotLocalModelRunner,
	actionWidgetService: IActionWidgetService,
	commandService: ICommandService,
	modelId: string
): { icon: ThemeIcon; tooltip: string; run: () => void } {
	const isRunning = runner.isServerRunning(modelId);
	const isStarting = runner.isServerStarting(modelId);

	if (isStarting) {
		return {
			icon: ThemeIcon.modify(Codicon.loading, 'spin'),
			tooltip: localize('chat.modelPicker.serverStarting', 'Starting...'),
			run: () => { }
		};
	}
	if (isRunning) {
		return {
			icon: Codicon.stopCircle,
			tooltip: localize('chat.modelPicker.stopServer', 'Stop server'),
			run: () => {
				runner.stopServer(modelId);
				actionWidgetService.refreshItems();
			}
		};
	}
	return {
		icon: Codicon.play,
		tooltip: localize('chat.modelPicker.startServer', 'Start server'),
		run: () => {
			commandService.executeCommand('locopilot.startLlamaServer', modelId);
			actionWidgetService.refreshItems();
		}
	};
}

/**
 * Detected system RAM in GB (0 if not yet measured). `startupMetrics` throws before the timer service is
 * ready, so the read is guarded; by the time the picker opens it is ready. Mirrors the model-list editor's
 * "Best for you" RAM source so the picker badge and the list badge agree.
 */
function detectedRamGB(timerService: ITimerService): number {
	try {
		const totalmem = timerService.startupMetrics.totalmem;
		return typeof totalmem === 'number' && totalmem > 0 ? totalmem / (1024 * 1024 * 1024) : 0;
	} catch {
		return 0;
	}
}

/** Shared, mutable picker UI state. Toggled by the bottom "Show hidden models" action and read when building the list. */
interface IModelPickerState {
	showHidden: boolean;
}

// ---- "Auto" picker mode ----------------------------------------------------------------------------
// Auto is a pinned pseudo-entry at the top of the picker (sentinel LOCOPILOT_AUTO_MODEL_ID). Selecting it
// stores the sentinel; the agent resolves it per request to a concrete downloaded catalog model (aspirational:
// the most capable model this machine's RAM tier supports, warm server as tie-breaker - see resolveAutoModel).
// The picker mirrors that aspirational choice for the label ("Auto (Qwen3.5 9B)"), row description, and
// start/stop icon. It intentionally does NOT run the agent's async launch-gate step-down (a label must resolve
// synchronously); in the rare case a send steps down to a smaller model, its now-running server wins the next
// re-resolve via stickiness, so the label reconverges.

/** Sits above Custom Models (order 100) and the standard categories, so Auto is always the first row. */
const AUTO_PICKER_CATEGORY = { label: localize('chat.modelPicker.autoCategory', "Auto"), order: 0 };

/**
 * The model Auto currently resolves to. Pin-aware (see resolveAutoModelPinned): the label, the selection
 * pre-warm, and the per-request resolution all read the SAME session pin, so the picker can no longer show
 * one model while the send uses another.
 */
function resolveAutoModelForPicker(customLanguageModelsService: ICustomLanguageModelsService, localModelRunner: ILoCoPilotLocalModelRunner, timerService: ITimerService): ICustomLanguageModel | undefined {
	return resolveAutoModelPinned(
		customLanguageModelsService,
		detectedRamGB(timerService),
		id => localModelRunner.isServerRunning(id) || localModelRunner.isServerStarting(id)
	);
}

/** Picker-button label for Auto: "Auto (<resolved model>)", or plain "Auto" when nothing is downloaded yet. */
function autoDisplayName(resolved: ICustomLanguageModel | undefined): string {
	return resolved
		? localize('chat.modelPicker.autoWithModel', "Auto ({0})", getCustomModelListLabel(resolved))
		: localize('chat.modelPicker.auto', "Auto");
}

/** Synthetic picker/chat entry for the Auto selection (the sentinel is not a registered language model). */
function buildAutoModelEntry(resolved: ICustomLanguageModel | undefined): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier: LOCOPILOT_AUTO_MODEL_ID,
		metadata: {
			extension: new ExtensionIdentifier('custom'),
			name: autoDisplayName(resolved),
			id: LOCOPILOT_AUTO_MODEL_ID,
			vendor: 'locopilot-auto',
			version: '1.0.0',
			family: 'auto',
			maxInputTokens: 0,
			maxOutputTokens: 0,
			isDefaultForLocation: {},
			isUserSelectable: true,
			modelPickerCategory: AUTO_PICKER_CATEGORY
		}
	};
}

function modelDelegateToWidgetActionsProvider(delegate: IModelPickerDelegate, telemetryService: ITelemetryService, customLanguageModelsService: ICustomLanguageModelsService, actionWidgetService: IActionWidgetService, timerService: ITimerService, state: IModelPickerState, localModelRunner: ILoCoPilotLocalModelRunner, commandService: ICommandService): IActionWidgetDropdownActionProvider {
	return {
		getActions: () => {
			// "Best for you" badges the single curated COMFORTABLE recommendation for this machine (the most
			// capable model that runs smoothly once editor/OS overhead is accounted for - e.g. Qwen3.5 9B on
			// 16 GB, not Gemma 4 12B). Shared with the model-list editor via getRecommendedRepoId so both agree.
			// This is the "best upgrade" signpost; the picker still AUTO-SELECTS the even-safer conservative default.
			const ramGB = detectedRamGB(timerService);
			const recommendedRepoId = getRecommendedRepoId(ramGB);
			const isBestForSystem = (m: ICustomLanguageModel): boolean => m.modelName === recommendedRepoId;
			// Custom models are sourced here (not from delegate.getModels()), so locopilot vendor models are
			// filtered out of the standard list below to avoid listing them twice. Use the VISIBLE set (not
			// just chat-ready) so curated not-yet-downloaded catalog models appear; selecting one and sending
			// shows an in-chat download prompt with its configuration + a Download button.
			const models = delegate.getModels().filter(m => m.metadata.vendor !== 'locopilot');
			const customModels = customLanguageModelsService.getVisibleCustomModels();
			const hiddenCustomModels = customLanguageModelsService.getCustomModels().filter(m => m.hidden);

			// Convert custom models to ILanguageModelChatMetadataAndIdentifier format
			const selectedCustomModelId = customLanguageModelsService.getSelectedCustomModelId();

			// Pinned "Auto" row (always first). Shows which model Auto currently resolves to; when Auto is
			// selected and that model is startable, the row gets the same start/stop control a selected
			// local model row has, so the server can be started/stopped straight from the Auto row.
			const autoResolved = resolveAutoModelForPicker(customLanguageModelsService, localModelRunner, timerService);
			const isAutoSelected = selectedCustomModelId === LOCOPILOT_AUTO_MODEL_ID;
			const autoStartStop = isAutoSelected && autoResolved && isStartableLocalModel(autoResolved)
				? buildStartStopControl(localModelRunner, actionWidgetService, commandService, autoResolved.id)
				: undefined;
			// The concrete model the current selection actually runs on: the resolved model when Auto is
			// selected, else the selected model id. Used to suppress the "a request is running, change anyway?"
			// prompt when switching to Auto would NOT change the model in use (so nothing gets interrupted).
			const currentEffectiveModelId = selectedCustomModelId === LOCOPILOT_AUTO_MODEL_ID
				? autoResolved?.id
				: (selectedCustomModelId ?? delegate.currentModel.get()?.identifier);
			const autoAction: IActionWidgetDropdownAction = {
				id: LOCOPILOT_AUTO_MODEL_ID,
				enabled: true,
				checked: isAutoSelected,
				icon: autoStartStop?.icon,
				category: AUTO_PICKER_CATEGORY,
				class: undefined,
				description: autoResolved
					? localize('chat.modelPicker.auto.uses', "Uses {0}", getCustomModelListLabel(autoResolved))
					: localize('chat.modelPicker.auto.none', "No local model downloaded yet"),
				tooltip: autoStartStop
					? autoStartStop.tooltip
					: localize('chat.modelPicker.auto.tooltip', "Automatically picks the best downloaded local model for your system"),
				label: localize('chat.modelPicker.auto', "Auto"),
				hover: undefined,
				keepDropdownOpen: !!autoStartStop,
				run: autoStartStop
					? autoStartStop.run
					: async () => {
						// Only gate on the running-request confirmation when picking Auto would actually change
						// the model in use. If Auto resolves to the same model that's already running the request
						// (running-server-wins), the switch interrupts nothing, so skip the prompt and apply silently.
						const modelUnchanged = !!autoResolved && autoResolved.id === currentEffectiveModelId;
						if (!modelUnchanged && !await delegate.confirmModelChange(localize('chat.modelPicker.auto', "Auto"))) {
							return;
						}
						customLanguageModelsService.setSelectedCustomModelId(LOCOPILOT_AUTO_MODEL_ID);
						// Auto's pick is aspirational - the most capable model this machine's RAM tier supports -
						// so it depends only on the downloaded set, total RAM, and which server is warm, none of
						// which a memory probe changes. The label is therefore final at selection time; any
						// request-time step-down to a smaller model surfaces later via the running-server
						// re-resolve (stickiness), which the picker's normal state-change refresh already tracks.
						delegate.setModel(buildAutoModelEntry(autoResolved));
					}
			};
			const customModelActions: IActionWidgetDropdownAction[] = customModels.map(customModel => {
				// "Best for you": sized for this machine's RAM/engine. Star the label and explain it on hover,
				// matching the model-list badge so the maximal pick is one obvious click from the conservative default.
				const best = isBestForSystem(customModel);
				const baseLabel = getCustomModelListLabel(customModel);
				const kindLabel = customModel.type === 'cloud' ? localize('chat.modelPicker.cloud', 'Cloud') : localize('chat.modelPicker.local', 'Local');
				const bestTooltip = localize('chat.modelPicker.bestForYou.tooltip', 'Recommended: sized for your system memory.');
				const isSelected = customModel.id === selectedCustomModelId;
				// For the SELECTED model, if it's a downloadable local model, replace the checkmark with a
				// state-based start/stop icon in the left slot. The row's own `run` is repurposed to toggle the
				// server (the model is already selected, so re-selecting it would be a no-op anyway), which makes
				// clicking the row start/stop the model. Every other row keeps the plain checkmark behaviour.
				const startStop = isSelected && isStartableLocalModel(customModel)
					? buildStartStopControl(localModelRunner, actionWidgetService, commandService, customModel.id)
					: undefined;
				return {
					id: customModel.id,
					enabled: true,
					// Keep the selected row highlighted as before (`checked` drives the option-checked background).
					// When a start/stop icon is present it's supplied via `icon`, which overrides the checkmark, so
					// the row stays highlighted but shows the server-state icon instead of the tick.
					checked: isSelected,
					icon: startStop?.icon,
					category: { label: 'Custom Models', order: 100 },
					class: undefined,
					description: best ? localize('chat.modelPicker.bestForYou.desc', '{0} - Best for you', kindLabel) : kindLabel,
					tooltip: startStop ? startStop.tooltip : (best ? `${baseLabel} - ${bestTooltip}` : baseLabel),
					label: baseLabel,
					hover: undefined,
					toolbarActions: [
						toAction({
							id: `hide-${customModel.id}`,
							label: localize('chat.modelPicker.hide', 'Hide model'),
							class: ThemeIcon.asClassName(Codicon.eyeClosed),
							tooltip: localize('chat.modelPicker.hide.tooltip', 'Hide this model from the picker'),
							run: async () => {
								await customLanguageModelsService.hideCustomModel(customModel.id, true);
								// If the hidden model was selected, clear the selection
								if (customLanguageModelsService.getSelectedCustomModelId() === customModel.id) {
									customLanguageModelsService.setSelectedCustomModelId(undefined);
								}
								// Refresh list in-place - dropdown stays open
								actionWidgetService.refreshItems();
							}
						})
					],
					// Keep the dropdown open when the click toggles the server, so the icon can flip in place;
					// a plain selection click closes it as usual.
					keepDropdownOpen: !!startStop,
					run: startStop
						? startStop.run
						: () => {
							// Skip the running-request prompt when this model is already the one in use (e.g. the
							// model Auto currently resolves to) - re-selecting it concretely interrupts nothing.
							const modelUnchanged = customModel.id === currentEffectiveModelId;
							applyCustomModelSelection(delegate, customLanguageModelsService, customModel.id, modelUnchanged);
						}
				};
			});

			// Hidden custom models. By default these are search-only; toggling "Show hidden models" (bottom bar)
			// flips `state.showHidden` so they render inline in their own "Hidden Models" section AFTER the shown
			// ones (higher category order + a header). Searching still surfaces them regardless of the toggle.
			const hiddenModelActions: IActionWidgetDropdownAction[] = hiddenCustomModels.map(hiddenModel => {
				return {
					id: hiddenModel.id,
					enabled: true,
					checked: false,
					// Only break them into their own labelled section when revealed; otherwise keep them in the
					// Custom Models category (search-only) so no empty separator/header shows while they're hidden.
					category: state.showHidden
						? { label: localize('chat.modelPicker.hiddenSection', 'Hidden Models'), order: 200, showHeader: true }
						: { label: 'Custom Models', order: 100 },
					class: undefined,
					description: hiddenModel.type === 'cloud' ? localize('chat.modelPicker.cloud', 'Cloud') : localize('chat.modelPicker.local', 'Local'),
					tooltip: getCustomModelListLabel(hiddenModel),
					label: getCustomModelListLabel(hiddenModel),
					hover: undefined,
					searchOnly: !state.showHidden,
					toolbarActions: [
						toAction({
							id: `unhide-${hiddenModel.id}`,
							label: localize('chat.modelPicker.unhide', 'Show model'),
							class: ThemeIcon.asClassName(Codicon.eye),
							tooltip: localize('chat.modelPicker.unhide.tooltip', 'Show this model in the picker'),
							run: async () => {
								// Confirm before changing anything if a request is running, then unhide + select.
								if (!await delegate.confirmModelChange(getCustomModelListLabel(hiddenModel))) {
									return;
								}
								await customLanguageModelsService.hideCustomModel(hiddenModel.id, false);
								customLanguageModelsService.setSelectedCustomModelId(hiddenModel.id);
								selectCustomModelInChat(delegate, customLanguageModelsService, hiddenModel.id);
								actionWidgetService.hide();
							}
						})
					],
					run: async () => {
						if (!await delegate.confirmModelChange(getCustomModelListLabel(hiddenModel))) {
							return;
						}
						await customLanguageModelsService.hideCustomModel(hiddenModel.id, false);
						customLanguageModelsService.setSelectedCustomModelId(hiddenModel.id);
						selectCustomModelInChat(delegate, customLanguageModelsService, hiddenModel.id);
						actionWidgetService.hide();
					}
				};
			});

			if (models.length === 0 && customModelActions.length === 0 && hiddenModelActions.length === 0) {
				// No models at all: the real Auto row is still offered (selecting it and sending shows the
				// in-chat starter download card).
				return [autoAction];
			}

			const standardModelActions = models.map(model => {
				return {
					id: model.metadata.id,
					enabled: true,
					icon: model.metadata.statusIcon,
					checked: model.identifier === delegate.currentModel.get()?.identifier,
					category: model.metadata.modelPickerCategory || DEFAULT_MODEL_PICKER_CATEGORY,
					class: undefined,
					description: undefined,
					tooltip: model.metadata.name,
					hover: undefined,
					label: model.metadata.name,
					run: async () => {
						// Gate the switch first so declining while a request runs leaves the selection untouched.
						if (!await delegate.confirmModelChange(model.metadata.name)) {
							return;
						}
						const previousModel = delegate.currentModel.get();
						customLanguageModelsService.setSelectedCustomModelId(undefined);
						telemetryService.publicLog2<ChatModelChangeEvent, ChatModelChangeClassification>('chat.modelChange', {
							fromModel: previousModel?.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(previousModel.identifier) : 'unknown',
							toModel: model.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(model.identifier) : 'unknown'
						});
						delegate.setModel(model);
					}
				} satisfies IActionWidgetDropdownAction;
			});

			// Combine the pinned Auto row, standard models, visible custom models, and (when revealed via the
			// sticky footer toggle) hidden custom models. The Show/Hide toggle lives in the bottom action bar.
			return [autoAction, ...standardModelActions, ...customModelActions, ...hiddenModelActions];
		}
	};
}

function getModelPickerActionBarActionProvider(commandService: ICommandService, chatEntitlementService: IChatEntitlementService, productService: IProductService, customLanguageModelsService: ICustomLanguageModelsService, actionWidgetService: IActionWidgetService, state: IModelPickerState): IActionProvider {

	const actionProvider: IActionProvider = {
		getActions: () => {
			const additionalActions: IAction[] = [];

			// Always offer a way to reach the full model list, where users can Show hidden catalog models,
			// download, hide, or delete. The picker itself only shows the curated/visible few.
			// Pushed first so "Manage Models" sits on the LEFT of the bottom action bar.
			additionalActions.push({
				id: 'locopilotManageModels',
				label: localize('chat.manageModels', "Manage Models"),
				enabled: true,
				tooltip: localize('chat.manageModels.tooltip', "Open the model list to show, hide, download, or remove models"),
				class: undefined,
				run: () => {
					commandService.executeCommand('workbench.action.chat.openLoCoPilotSettings', { section: LOCOPILOT_SETTINGS_SECTION_LIST_MODELS });
				}
			});

			// Sticky-footer Show/Hide toggle for the hidden models, rendered as a link/button in the bottom action
			// bar (always pinned at the bottom, never scrolls with the list). Only offered when hidden models exist.
			// `keepDropdownOpen` stops the dropdown from closing; refreshItems() rebuilds BOTH the list and this bar,
			// so the label/icon flip between "Show" and "Hide" as the state changes. State resets to collapsed on
			// each fresh open via the picker's visibility hook (not here), so this getActions can run on refresh.
			// Pushed after "Manage Models" so the "Show more" toggle sits on the RIGHT.
			const hiddenCount = customLanguageModelsService.getCustomModels().filter(m => m.hidden).length;
			if (hiddenCount > 0) {
				additionalActions.push(new Separator());
				additionalActions.push(Object.assign(
					toAction({
						id: 'locopilotToggleHiddenModels',
						label: state.showHidden
							? localize('chat.modelPicker.hideHidden', 'Show less')
							: localize('chat.modelPicker.showHidden', 'Show more'),
						run: () => {
							state.showHidden = !state.showHidden;
							actionWidgetService.refreshItems();
						}
					}),
					{ keepDropdownOpen: true }
				));
			}

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
			// NOTE: "Add Model" button temporarily commented out per request.
			// if (!isNewOrAnonymousUser && chatEntitlementService.entitlement !== ChatEntitlement.Free) {
			// 	additionalActions.push({
			// 		id: 'addLanguageModels',
			// 		label: localize('chat.addLanguageModels', "Add Model"),
			// 		enabled: true,
			// 		tooltip: localize('chat.addLanguageModels.tooltip', "Add custom language models (Cloud or Local)"),
			// 		class: undefined,
			// 		run: () => {
			// 			commandService.executeCommand('workbench.action.chat.openLoCoPilotSettings', { section: 'add-model' });
			// 		}
			// 	});
			// }

			// "Add Model" (new/anonymous user) entry temporarily removed from the picker per request. The Free-user
			// "Add Premium Models" upgrade entry is kept. To restore "Add Model", re-add the isNewOrAnonymousUser
			// branch below (open LoCoPilot settings 'add-model' section).
			if (!isNewOrAnonymousUser && chatEntitlementService.entitlement === ChatEntitlement.Free) {
				// Separator before the upgrade group, only when there is something above it.
				if (additionalActions.length > 0) {
					additionalActions.push(new Separator());
				}
				additionalActions.push({
					id: 'moreModels',
					label: localize('chat.morePremiumModels', "Add Premium Models"),
					enabled: true,
					tooltip: localize('chat.morePremiumModels.tooltip', "Add Premium Models"),
					class: undefined,
					run: () => {
						commandService.executeCommand('workbench.action.chat.upgradePlan');
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
		@ITimerService timerService: ITimerService,
		@ILoCoPilotLocalModelRunner localModelRunner: ILoCoPilotLocalModelRunner,
	) {
		// Get initial model name
		const initialModel = delegate.currentModel.get();
		const initialCustomModelId = customLanguageModelsService.getSelectedCustomModelId();
		let initialLabel = localize('chat.modelPicker.auto', "Auto");

		if (initialCustomModelId === LOCOPILOT_AUTO_MODEL_ID) {
			initialLabel = autoDisplayName(resolveAutoModelForPicker(customLanguageModelsService, localModelRunner, timerService));
		} else if (initialCustomModelId) {
			const customModel = customLanguageModelsService.getCustomModels().find(m => m.id === initialCustomModelId);
			if (customModel && !customModel.hidden) {
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

		// Shared between the list and the bottom bar so the toggle and the rendered list stay in sync within one
		// open. Reset to collapsed on each fresh open via onDropdownVisibilityChanged (see below).
		const pickerState: IModelPickerState = { showHidden: false };
		const modelPickerActionWidgetOptions: Omit<IActionWidgetDropdownOptions, 'label' | 'labelRenderer'> = {
			actionProvider: modelDelegateToWidgetActionsProvider(delegate, telemetryService, customLanguageModelsService, actionWidgetService, timerService, pickerState, localModelRunner, commandService),
			actionBarActionProvider: getModelPickerActionBarActionProvider(commandService, chatEntitlementService, productService, customLanguageModelsService, actionWidgetService, pickerState),
			// Every fresh open starts with hidden models collapsed. Toggling mid-session uses refreshItems(), which
			// does not call this, so an expanded list is only ever reset on the next open.
			onBeforeShow: () => { pickerState.showHidden = false; },
			reporter: { name: 'ChatModelPicker', includeOptions: true },
			searchable: true,
			maxVisibleItems: 10,
		};

		super(actionWithLabel, widgetOptions ?? modelPickerActionWidgetOptions, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);
		this.currentModel = initialModel;

		// Re-derive the "Auto (<model>)" button label from the current inputs. Only meaningful while Auto is
		// selected; a no-op otherwise. Keeps the collapsed button label in sync with the dropdown row and the
		// actual per-request resolution, all of which call resolveAutoModel over the same live figures (Q1).
		const refreshAutoLabel = () => {
			if (customLanguageModelsService.getSelectedCustomModelId() !== LOCOPILOT_AUTO_MODEL_ID) {
				return;
			}
			this.currentModel = buildAutoModelEntry(resolveAutoModelForPicker(customLanguageModelsService, localModelRunner, timerService));
			this.updateTooltip();
			if (this.element) {
				this.renderLabel(this.element);
			}
		};

		// While the picker is open, flip the selected model's start/stop icon as its server transitions
		// (starting -> running -> stopped). refreshItems() is a no-op when the dropdown is closed.
		// When Auto is selected, a server transition can also CHANGE what Auto resolves to (a warm
		// server is a within-tier tie-breaker), so re-derive the "Auto (<model>)" button label as well.
		this._register(localModelRunner.onDidServerStateChange(() => {
			actionWidgetService.refreshItems();
			refreshAutoLabel();
		}));

		// Available RAM shifting no longer changes Auto's aspirational pick (that depends only on the downloaded
		// set, total RAM, and which server is warm), but the dropdown's per-model rows surface live fit hints, so
		// refresh the open list - and re-derive the label defensively - whenever the memory probe lands a reading.
		this._register(localModelRunner.onDidAvailableRamChange(() => {
			actionWidgetService.refreshItems();
			refreshAutoLabel();
		}));

		// Listen for model changes from the delegate and custom models
		this._register(autorun(t => {
			const model = delegate.currentModel.read(t);
			const selectedCustomModelId = customLanguageModelsService.getSelectedCustomModelId();

			// Auto mode: the sentinel is not a stored model - synthesize its entry (label shows the
			// currently-resolved model) and never fall through to the "model was deleted" cleanup.
			if (selectedCustomModelId === LOCOPILOT_AUTO_MODEL_ID) {
				this.currentModel = buildAutoModelEntry(resolveAutoModelForPicker(customLanguageModelsService, localModelRunner, timerService));
				this.updateTooltip();
				if (this.element) {
					this.renderLabel(this.element);
				}
				return;
			}

			// If a custom model is selected, use it; otherwise use the standard model
			if (selectedCustomModelId) {
				const customModel = customLanguageModelsService.getCustomModels().find(m => m.id === selectedCustomModelId);
				if (customModel && !customModel.hidden) {
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

			// Auto mode: re-resolve (a finished download or deletion changes what Auto uses) and re-label.
			if (selectedCustomModelId === LOCOPILOT_AUTO_MODEL_ID) {
				this.currentModel = buildAutoModelEntry(resolveAutoModelForPicker(customLanguageModelsService, localModelRunner, timerService));
				if (this.element) {
					this.renderLabel(this.element);
				}
				return;
			}

			if (selectedCustomModelId) {
				const customModel = customLanguageModelsService.getCustomModels().find(m => m.id === selectedCustomModelId);
				if (customModel && !customModel.hidden) {
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
