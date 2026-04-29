/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/locopilotSettingsEditor.css';
import './media/addCustomModelEditor.css';
import './media/customLanguageModelsListEditor.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import {
	LoCoPilotSettingsEditorInput,
	LOCOPILOT_SETTINGS_SECTION_ADD_MODEL,
	LOCOPILOT_SETTINGS_SECTION_LIST_MODELS,
	LOCOPILOT_SETTINGS_SECTION_AGENT_SETTINGS,
} from './locopilotSettingsEditorInput.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { localize } from '../../../../../nls.js';
import { Orientation, Sizing, SplitView } from '../../../../../base/browser/ui/splitview/splitview.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { Event } from '../../../../../base/common/event.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { registerColor } from '../../../../../platform/theme/common/colorRegistry.js';
import { PANEL_BORDER } from '../../../../common/theme.js';
import { ChatConfiguration } from '../../common/constants.js';
import { ILoCoPilotAgentSettingsService, DEFAULT_MAX_ITERATIONS } from '../locopilotAgentSettingsService.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles, getInputBoxStyle, getSelectBoxStyles, defaultToggleStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { settingsSelectBackground, settingsSelectBorder, settingsSelectForeground, settingsSelectListBorder, settingsTextInputBackground, settingsTextInputBorder, settingsTextInputForeground } from '../../../preferences/common/settingsEditorColorRegistry.js';
import { Toggle } from '../../../../../base/browser/ui/toggle/toggle.js';
import { SelectBox, ISelectOptionItem, ISelectData } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { ICustomLanguageModelsService, ICustomLanguageModel, getCustomModelListLabel, needsDownloadOrPullRetry } from '../../common/customLanguageModelsService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { ILoCoPilotLocalModelRunner } from '../locopilotLocalModelRunner.js';

const $ = DOM.$;

/** Use same input/select styles as the main Settings editor (e.g. Text Editor) for consistent look. */
const locopilotSettingsInputBoxStyles = getInputBoxStyle({
	inputBackground: settingsTextInputBackground,
	inputForeground: settingsTextInputForeground,
	inputBorder: settingsTextInputBorder
});
const locopilotSettingsSelectBoxStyles = getSelectBoxStyles({
	selectBackground: settingsSelectBackground,
	selectForeground: settingsSelectForeground,
	selectBorder: settingsSelectBorder,
	selectListBorder: settingsSelectListBorder
});

const CLOUD_PROVIDERS_ADD: ISelectOptionItem[] = [
	{ text: 'Anthropic', description: '' },
	{ text: 'OpenAI', description: '' },
	{ text: 'Google', description: '' },
];

const LOCAL_PROVIDERS_ADD: ISelectOptionItem[] = [
	{ text: 'HuggingFace', description: '' },
	{ text: 'Ollama', description: '' },
	{ text: 'Localhost', description: '' },
];

export const locopilotSettingsSashBorder = registerColor('locopilotSettings.sashBorder', PANEL_BORDER, localize('locopilotSettingsSashBorder', "The color of the LoCoPilot Settings editor splitview sash border."));

interface SectionItem {
	id: string;
	label: string;
}

export class LoCoPilotSettingsEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.locopilotSettings';

	private container: HTMLElement | undefined;
	private splitView: SplitView<number> | undefined;
	private sectionsList: WorkbenchList<SectionItem> | undefined;
	private headerContainer!: HTMLElement;
	private contentsContainer!: HTMLElement;

	private addModelsPanel!: HTMLElement;
	private listModelsPanel!: HTMLElement;
	private listModelsContainer!: HTMLElement;
	private agentSettingsPanel!: HTMLElement;

	// Add Language Model form
	private addFormModelTypeSelectBox!: SelectBox;
	private addFormProviderSelectBox!: SelectBox;
	private addFormApiKeyInputBox!: InputBox;
	private addFormTokenInputBox!: InputBox;
	private addFormTokenLabel!: HTMLElement;
	private addFormModelFormatInputBox!: InputBox;
	private addFormModelFormatContainer!: HTMLElement;
	private addFormModelNameInputBox!: InputBox;
	private addFormModelNameLabel!: HTMLElement;
	private addFormDisplayNameContainer!: HTMLElement;
	private addFormDisplayNameInputBox!: InputBox;
	private addFormLocalhostModelIdContainer!: HTMLElement;
	private addFormLocalhostModelIdInputBox!: InputBox;
	private addFormMaxInputTokensInput!: InputBox;
	private addFormMaxOutputTokensInput!: InputBox;
	private addFormUseNativeToolsToggle!: Toggle;
	private addFormUseNativeToolsContainer!: HTMLElement;
	private addFormAddButton!: Button;
	private addFormCurrentModelType: 'cloud' | 'local' = 'cloud';
	private addFormCurrentProviderIndex: number = 0;

	private static readonly DEFAULT_MAX_INPUT = 100000;
	private static readonly DEFAULT_MAX_OUTPUT_TOKENS = 8000; // raw tokens
	private static readonly HF_DEFAULT_MAX_INPUT = 4000;
	private static readonly HF_DEFAULT_MAX_OUTPUT_TOKENS = 1000;
	private static readonly MIN_INPUT = 0;
	private static readonly MAX_INPUT = 2000000;
	private static readonly MIN_OUTPUT_TOKENS = 0;
	private static readonly MAX_OUTPUT_TOKENS = 32000;
	/** Compact width for token fields (hover shows full value). */
	private static readonly TOKEN_LIMIT_INPUT_WIDTH_PX = 80;

	private askPromptTextarea!: HTMLTextAreaElement;
	private agentPromptTextarea!: HTMLTextAreaElement;
	private agentPromptFormattedView!: HTMLElement;
	private askPromptFormattedView!: HTMLElement;
	private agentPromptFormattedRendered: { dispose(): void } | undefined;
	private askPromptFormattedRendered: { dispose(): void } | undefined;
	private askCodingSystemPromptToggle!: Toggle;
	private agentCodingSystemPromptToggle!: Toggle;
	private agentSettingsSaveBtn!: Button;
	private agentSettingsCancelBtn!: Button;
	private agentSettingsBaseline: {
		maxIterations: number;
		autoRunSandbox: boolean;
		llamaPath: string;
		mlxPath: string;
		askCoding: boolean;
		agentCoding: boolean;
		askPrompt: string;
		agentPrompt: string;
	} | undefined;
	private maxIterationsInput!: InputBox;
	private autoRunCommandsInSandboxToggle!: Toggle;
	private llamaCppServerPathInput!: InputBox;
	private mlxPythonPathInput!: InputBox;
	private agentSettingsService!: ILoCoPilotAgentSettingsService;
	private customLanguageModelsService!: ICustomLanguageModelsService;
	private localModelRunner!: ILoCoPilotLocalModelRunner;

	private dimension: Dimension | undefined;
	private selectedSection: string = LOCOPILOT_SETTINGS_SECTION_ADD_MODEL;
	private sections: SectionItem[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILoCoPilotAgentSettingsService agentSettingsService: ILoCoPilotAgentSettingsService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICustomLanguageModelsService customLanguageModelsService: ICustomLanguageModelsService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@ILoCoPilotLocalModelRunner localModelRunner: ILoCoPilotLocalModelRunner,
	) {
		super(LoCoPilotSettingsEditor.ID, group, telemetryService, themeService, storageService);
		this.agentSettingsService = agentSettingsService;
		this.customLanguageModelsService = customLanguageModelsService;
		this.localModelRunner = localModelRunner;

		this._register(this.localModelRunner.onDidServerStateChange(() => {
			this.renderListModels();
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, $('.locopilot-settings-editor'));

		this.renderHeader(this.container);

		const splitViewContainer = DOM.append(this.container, $('.split-view-container'));

		const sidebarView = DOM.append(splitViewContainer, $('.sidebar-view'));
		const sidebarContainer = DOM.append(sidebarView, $('.sidebar-container'));

		const contentsView = DOM.append(splitViewContainer, $('.contents-view'));
		this.contentsContainer = DOM.append(contentsView, $('.contents-container'));

		this.splitView = new SplitView(splitViewContainer, {
			orientation: Orientation.HORIZONTAL,
			proportionalLayout: true
		});

		this.renderSidebar(sidebarContainer);
		this.renderContents(this.contentsContainer);

		this.splitView.addView({
			onDidChange: Event.None,
			element: sidebarView,
			minimumSize: 150,
			maximumSize: 350,
			layout: (width, _, height) => {
				sidebarContainer.style.width = `${width}px`;
				if (this.sectionsList && height !== undefined) {
					this.sectionsList.layout(height, width);
				}
			}
		}, 200, undefined, true);

		this.splitView.addView({
			onDidChange: Event.None,
			element: contentsView,
			minimumSize: 400,
			maximumSize: Number.POSITIVE_INFINITY,
			layout: (width, _, height) => {
				contentsView.style.width = `${width}px`;
				if (height !== undefined) {
					this.layoutContents(width, height);
				}
			}
		}, Sizing.Distribute, undefined, true);

		this.updateStyles();
	}

	override updateStyles(): void {
		const borderColor = this.theme.getColor(locopilotSettingsSashBorder)!;
		this.splitView?.style({ separatorBorder: borderColor });
	}

	private renderHeader(parent: HTMLElement): void {
		this.headerContainer = DOM.append(parent, $('.locopilot-settings-header'));
		const headerTitleContainer = DOM.append(this.headerContainer, $('.header-title-container'));
		// Brand logo: Bixbite letterpress (same as welcome/empty editor group). Theme-aware via CSS background-image.
		const logoEl = DOM.append(headerTitleContainer, $('.locopilot-settings-brand-logo'));
		logoEl.setAttribute('aria-hidden', 'true');
		const title = DOM.append(headerTitleContainer, $('.locopilot-settings-editor-title'));
		title.textContent = localize('locopilotSettings.title', "LoCoPilot Settings");
	}

	private renderSidebar(parent: HTMLElement): void {
		this.sections = [
			{ id: LOCOPILOT_SETTINGS_SECTION_ADD_MODEL, label: localize('locopilotSettings.addLanguageModel', "Add Language Model") },
			{ id: LOCOPILOT_SETTINGS_SECTION_LIST_MODELS, label: localize('locopilotSettings.languageModels', "Language Models") },
			{ id: LOCOPILOT_SETTINGS_SECTION_AGENT_SETTINGS, label: localize('locopilotSettings.agentSettings', "Agent Settings") },
		];

		const delegate = new SectionItemDelegate();
		const renderer = new SectionItemRenderer();

		this.sectionsList = this._register(this.instantiationService.createInstance(
			WorkbenchList<SectionItem>,
			'LoCoPilotSettingsSections',
			parent,
			delegate,
			[renderer],
			{
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel(element: SectionItem) {
						return element.label;
					},
					getWidgetAriaLabel() {
						return localize('locopilotSettingsSectionsAriaLabel', "LoCoPilot Settings Sections");
					}
				},
				openOnSingleClick: true,
				identityProvider: {
					getId(element: SectionItem) {
						return element.id;
					}
				}
			}
		));

		this.sectionsList.splice(0, this.sectionsList.length, this.sections);
		this.sectionsList.setSelection([0]);

		this._register(this.sectionsList.onDidChangeSelection(e => {
			if (e.elements.length > 0) {
				const previousSection = this.selectedSection;
				const newSection = e.elements[0].id;
				this.selectedSection = newSection;
				if (newSection === LOCOPILOT_SETTINGS_SECTION_ADD_MODEL && previousSection !== LOCOPILOT_SETTINGS_SECTION_ADD_MODEL) {
					this.resetAddModelFormToDefaults();
				}
				this.renderSelectedSection();
			}
		}));
	}

	private renderContents(parent: HTMLElement): void {
		const bodyContainer = DOM.append(parent, $('.locopilot-settings-body'));

		// Add Language Model - same UI as Add Language Model editor
		this.addModelsPanel = DOM.append(bodyContainer, $('.locopilot-settings-panel.add-models-panel'));
		this.renderAddModelForm(this.addModelsPanel);

		// Language Models list - same UI as Language Models editor
		this.listModelsPanel = DOM.append(bodyContainer, $('.locopilot-settings-panel.list-models-panel'));
		this.listModelsContainer = DOM.append(this.listModelsPanel, $('.custom-language-models-list-editor'));
		this._register(this.customLanguageModelsService.onDidChangeCustomModels(() => this.renderListModels()));

		// Agent Settings - system prompts + max iteration
		this.agentSettingsPanel = DOM.append(bodyContainer, $('.locopilot-settings-panel.agent-settings-panel'));
		this.renderAgentSettings(this.agentSettingsPanel);

		this.renderSelectedSection();
	}

	private renderAddModelForm(container: HTMLElement): void {
		const wrapper = DOM.append(container, $('.add-custom-model-editor'));
		const formContainer = DOM.append(wrapper, $('.add-custom-model-form'));

		const title = DOM.append(formContainer, $('h2.form-title'));
		title.textContent = localize('addCustomModel.title', 'Add Language Model');

		const modelTypeContainer = DOM.append(formContainer, $('.form-field'));
		const modelTypeLabel = DOM.append(modelTypeContainer, $('label.form-label'));
		modelTypeLabel.textContent = localize('addCustomModel.modelType', 'Model Type');
		const modelTypeSelectContainer = DOM.append(modelTypeContainer, $('.form-input-container'));
		this.addFormModelTypeSelectBox = this._register(new SelectBox(
			[
				{ text: localize('addCustomModel.cloud', 'Cloud'), description: '' },
				{ text: localize('addCustomModel.local', 'Local'), description: '' }
			],
			0,
			this.contextViewService,
			locopilotSettingsSelectBoxStyles
		));
		this.addFormModelTypeSelectBox.render(modelTypeSelectContainer);
		this._register(this.addFormModelTypeSelectBox.onDidSelect((e: ISelectData) => {
			this.addFormCurrentModelType = e.index === 0 ? 'cloud' : 'local';
			this.addFormCurrentProviderIndex = 0;
			this.addFormUpdateProviderOptions();
			this.addFormUpdateInputFields();
		}));

		const providerContainer = DOM.append(formContainer, $('.form-field'));
		const providerLabel = DOM.append(providerContainer, $('label.form-label'));
		providerLabel.textContent = localize('addCustomModel.provider', 'Model Provider');
		const providerSelectContainer = DOM.append(providerContainer, $('.form-input-container'));
		this.addFormProviderSelectBox = this._register(new SelectBox(CLOUD_PROVIDERS_ADD, 0, this.contextViewService, locopilotSettingsSelectBoxStyles));
		this.addFormProviderSelectBox.render(providerSelectContainer);
		this._register(this.addFormProviderSelectBox.onDidSelect((e: ISelectData) => {
			this.addFormCurrentProviderIndex = e.index;
			this.addFormUpdateInputFields();
		}));

		const apiKeyContainer = DOM.append(formContainer, $('.form-field'));
		const apiKeyLabel = DOM.append(apiKeyContainer, $('label.form-label'));
		apiKeyLabel.textContent = localize('addCustomModel.apiKey', 'API Key');
		const apiKeyInputContainer = DOM.append(apiKeyContainer, $('.form-input-container'));
		this.addFormApiKeyInputBox = this._register(new InputBox(apiKeyInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.apiKeyPlaceholder', 'Enter your API key'),
			type: 'password',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		const tokenContainer = DOM.append(formContainer, $('.form-field'));
		tokenContainer.style.display = 'none';
		this.addFormTokenLabel = DOM.append(tokenContainer, $('label.form-label'));
		this.addFormTokenLabel.textContent = localize('addCustomModel.token', 'Token (Optional)');
		const tokenInputContainer = DOM.append(tokenContainer, $('.form-input-container'));
		this.addFormTokenInputBox = this._register(new InputBox(tokenInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.tokenPlaceholder', 'Enter your token (e.g., HuggingFace token)'),
			type: 'password',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		this.addFormModelFormatContainer = DOM.append(formContainer, $('.form-field'));
		this.addFormModelFormatContainer.style.display = 'none';
		const formatLabel = DOM.append(this.addFormModelFormatContainer, $('label.form-label'));
		formatLabel.textContent = localize('addCustomModel.modelFormat', 'Model Format');
		const formatInputContainer = DOM.append(this.addFormModelFormatContainer, $('.form-input-container'));
		this.addFormModelFormatInputBox = this._register(new InputBox(formatInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.modelFormatPlaceholder', 'e.g., GGUF, Q4_K_M, Safetensors'),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		const modelNameContainer = DOM.append(formContainer, $('.form-field'));
		this.addFormModelNameLabel = DOM.append(modelNameContainer, $('label.form-label'));
		this.addFormModelNameLabel.textContent = localize('addCustomModel.modelName', 'Model Name');
		const modelNameInputContainer = DOM.append(modelNameContainer, $('.form-input-container'));
		this.addFormModelNameInputBox = this._register(new InputBox(modelNameInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.modelNamePlaceholder', 'e.g., gpt-4, claude-3-opus, llama-2-7b'),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		// Localhost only: required OpenAI `model` string (e.g. from GET /v1/models)
		this.addFormLocalhostModelIdContainer = DOM.append(formContainer, $('.form-field'));
		this.addFormLocalhostModelIdContainer.style.display = 'none';
		const localhostModelIdLabel = DOM.append(this.addFormLocalhostModelIdContainer, $('label.form-label'));
		localhostModelIdLabel.textContent = localize('addCustomModel.localhostServerModelId', 'Server model id');
		const localhostModelIdInputContainer = DOM.append(this.addFormLocalhostModelIdContainer, $('.form-input-container'));
		this.addFormLocalhostModelIdInputBox = this._register(new InputBox(localhostModelIdInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.localhostServerModelIdPlaceholder', 'e.g. Qwen/Qwen3-4B-MLX-4bit (JSON body "model" field)'),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		this.addFormDisplayNameContainer = DOM.append(formContainer, $('.form-field'));
		const displayNameLabel = DOM.append(this.addFormDisplayNameContainer, $('label.form-label'));
		displayNameLabel.textContent = localize('addCustomModel.displayNameOptional', 'Display name (optional)');
		const displayNameInputContainer = DOM.append(this.addFormDisplayNameContainer, $('.form-input-container'));
		this.addFormDisplayNameInputBox = this._register(new InputBox(displayNameInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.displayNamePlaceholder', 'Shown in the model list and Auto dropdown; must be unique if set'),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		// Max input tokens (user enters number, default 100,000)
		const maxInputRow = DOM.append(formContainer, $('.form-field.form-field-tokens'));
		const maxInputLabel = DOM.append(maxInputRow, $('label.form-label'));
		maxInputLabel.textContent = localize('addCustomModel.maxInputTokens', 'Max input tokens');
		const maxInputWrap = DOM.append(maxInputRow, $('.form-input-with-suffix'));
		const maxInputInputContainer = DOM.append(maxInputWrap, $('.form-input-container'));
		this.addFormMaxInputTokensInput = this._register(new InputBox(maxInputInputContainer, this.contextViewService, {
			placeholder: String(LoCoPilotSettingsEditor.DEFAULT_MAX_INPUT),
			tooltip: '',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		this.addFormMaxInputTokensInput.element.style.minWidth = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		this.addFormMaxInputTokensInput.element.style.width = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		this.addFormMaxInputTokensInput.value = String(LoCoPilotSettingsEditor.DEFAULT_MAX_INPUT);
		this.syncAddFormMaxInputTokenTooltip();
		this._register(this.addFormMaxInputTokensInput.onDidChange(() => this.syncAddFormMaxInputTokenTooltip()));
		// const maxInputSuffix = DOM.append(maxInputWrap, $('.form-input-suffix'));
		// maxInputSuffix.textContent = 'K';

		// Max output tokens (raw count 50 - 32K; optional K suffix e.g. 8K)
		const maxOutputRow = DOM.append(formContainer, $('.form-field.form-field-tokens'));
		const maxOutputLabel = DOM.append(maxOutputRow, $('label.form-label'));
		maxOutputLabel.textContent = localize('addCustomModel.maxOutputTokens', 'Max output tokens');
		const maxOutputInputContainer = DOM.append(maxOutputRow, $('.form-input-container'));
		this.addFormMaxOutputTokensInput = this._register(new InputBox(maxOutputInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.maxOutputTokensPlaceholder', '50 - 32000'),
			tooltip: '',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		this.addFormMaxOutputTokensInput.element.style.minWidth = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		this.addFormMaxOutputTokensInput.element.style.width = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		this.addFormMaxOutputTokensInput.value = String(LoCoPilotSettingsEditor.DEFAULT_MAX_OUTPUT_TOKENS);
		this.syncAddFormMaxOutputTokenTooltip();
		this._register(this.addFormMaxOutputTokensInput.onDidChange(() => this.syncAddFormMaxOutputTokenTooltip()));

		// Use Native Tools toggle (for local models)
		this.addFormUseNativeToolsContainer = DOM.append(formContainer, $('.form-field'));
		this.addFormUseNativeToolsContainer.style.display = 'none';
		const useNativeToolsLabel = DOM.append(this.addFormUseNativeToolsContainer, $('label.form-label'));
		useNativeToolsLabel.textContent = localize('addCustomModel.useNativeTools', 'Tools');
		const useNativeToolsToggleContainer = DOM.append(this.addFormUseNativeToolsContainer, $('.form-input-container.agent-setting-switch-wrap'));
		this.addFormUseNativeToolsToggle = this._register(new Toggle({
			title: localize('addCustomModel.useNativeToolsDescription', 'When on, use the model\'s native tool calling capability. When off, tools are injected into the system prompt. Default: off.'),
			isChecked: false,
			...defaultToggleStyles
		}));
		DOM.append(useNativeToolsToggleContainer, this.addFormUseNativeToolsToggle.domNode);

		const buttonContainer = DOM.append(formContainer, $('.form-actions'));
		this.addFormAddButton = this._register(new Button(buttonContainer, { ...defaultButtonStyles }));
		this.addFormAddButton.label = localize('addCustomModel.add', 'Add Model');
		this._register(this.addFormAddButton.onDidClick(() => this.handleAddModel()));
		this.addFormUpdateModelNameLabel();
	}

	private maxInputTokensTooltip(value: string): string {
		return localize('customLanguageModels.maxInputTokenTooltipWithValue', 'Max input tokens: {0}', value);
	}

	private maxOutputTokensTooltip(value: string): string {
		return localize('customLanguageModels.maxOutputTokenTooltipWithValue', 'Max output tokens: {0}', value);
	}

	private syncAddFormMaxInputTokenTooltip(): void {
		this.addFormMaxInputTokensInput.setTooltip(this.maxInputTokensTooltip(this.addFormMaxInputTokensInput.value));
	}

	private syncAddFormMaxOutputTokenTooltip(): void {
		this.addFormMaxOutputTokensInput.setTooltip(this.maxOutputTokensTooltip(this.addFormMaxOutputTokensInput.value));
	}

	/** Cloud + first provider, cleared fields, default token limits - use when (re)entering the Add Language Model section. */
	private resetAddModelFormToDefaults(): void {
		this.addFormCurrentModelType = 'cloud';
		this.addFormCurrentProviderIndex = 0;
		this.addFormModelTypeSelectBox.select(0);
		this.addFormUpdateProviderOptions();
		this.addFormModelNameInputBox.value = '';
		this.addFormDisplayNameInputBox.value = '';
		this.addFormLocalhostModelIdInputBox.value = '';
		this.addFormApiKeyInputBox.value = '';
		this.addFormTokenInputBox.value = '';
		this.addFormModelFormatInputBox.value = '';
		this.addFormUseNativeToolsToggle.checked = false;
		this.addFormUpdateInputFields();
	}

	private addFormUpdateProviderOptions(): void {
		const providers = this.addFormCurrentModelType === 'cloud' ? CLOUD_PROVIDERS_ADD : LOCAL_PROVIDERS_ADD;
		this.addFormProviderSelectBox.setOptions(providers, 0);
		this.addFormCurrentProviderIndex = 0;
		this.addFormUpdateModelNameLabel();
	}

	private addFormUpdateInputFields(): void {
		const apiKeyContainer = this.addFormApiKeyInputBox.element.parentElement?.parentElement;
		const tokenContainer = this.addFormTokenInputBox.element.parentElement?.parentElement;
		const providers = this.addFormCurrentModelType === 'cloud' ? CLOUD_PROVIDERS_ADD : LOCAL_PROVIDERS_ADD;
		const provider = providers[this.addFormCurrentProviderIndex];
		const isHuggingFace = this.addFormCurrentModelType === 'local' && provider.text.toLowerCase() === 'huggingface';
		const isOllama = this.addFormCurrentModelType === 'local' && provider.text.toLowerCase() === 'ollama';
		const isLocalhost = this.addFormCurrentModelType === 'local' && provider.text.toLowerCase() === 'localhost';
		if (this.addFormLocalhostModelIdContainer) {
			this.addFormLocalhostModelIdContainer.style.display = isLocalhost ? '' : 'none';
		}
		if (this.addFormCurrentModelType === 'cloud') {
			if (apiKeyContainer) { apiKeyContainer.style.display = ''; }
			if (tokenContainer) { tokenContainer.style.display = 'none'; }
			if (this.addFormModelFormatContainer) { this.addFormModelFormatContainer.style.display = 'none'; }
			if (this.addFormUseNativeToolsContainer) { this.addFormUseNativeToolsContainer.style.display = 'none'; }
			this.addFormMaxInputTokensInput.value = String(LoCoPilotSettingsEditor.DEFAULT_MAX_INPUT);
			this.addFormMaxOutputTokensInput.value = String(LoCoPilotSettingsEditor.DEFAULT_MAX_OUTPUT_TOKENS);
		} else {
			if (apiKeyContainer) { apiKeyContainer.style.display = 'none'; }
			// For Ollama, we reuse the token field for the Base URL
			if (tokenContainer) {
				tokenContainer.style.display = (isHuggingFace || isOllama) ? '' : 'none';
				this.addFormTokenLabel.textContent = isOllama
					? localize('addCustomModel.ollamaUrl', 'Ollama Base URL (Optional)')
					: localize('addCustomModel.token', 'Token (Optional)');
				this.addFormTokenInputBox.setPlaceHolder(isOllama
					? 'http://localhost:11434'
					: localize('addCustomModel.tokenPlaceholder', 'Enter your token (e.g., HuggingFace token)'));
			}
			if (this.addFormModelFormatContainer) { this.addFormModelFormatContainer.style.display = isHuggingFace ? '' : 'none'; }
			if (this.addFormUseNativeToolsContainer) { this.addFormUseNativeToolsContainer.style.display = ''; }
			// Same default token limits for HuggingFace, Ollama and Localhost (and any other local provider)
			if (isHuggingFace || isOllama || provider.text.toLowerCase() === 'localhost') {
				this.addFormMaxInputTokensInput.value = String(LoCoPilotSettingsEditor.HF_DEFAULT_MAX_INPUT);
				this.addFormMaxOutputTokensInput.value = String(LoCoPilotSettingsEditor.HF_DEFAULT_MAX_OUTPUT_TOKENS);
			} else {
				this.addFormMaxInputTokensInput.value = String(LoCoPilotSettingsEditor.DEFAULT_MAX_INPUT);
				this.addFormMaxOutputTokensInput.value = String(LoCoPilotSettingsEditor.DEFAULT_MAX_OUTPUT_TOKENS);
			}
		}
		this.syncAddFormMaxInputTokenTooltip();
		this.syncAddFormMaxOutputTokenTooltip();
		this.addFormUpdateModelNameLabel();
	}

	private addFormUpdateModelNameLabel(): void {
		if (!this.addFormModelNameLabel) { return; }
		const providers = this.addFormCurrentModelType === 'cloud' ? CLOUD_PROVIDERS_ADD : LOCAL_PROVIDERS_ADD;
		const provider = providers[this.addFormCurrentProviderIndex];
		const isLocalhost = this.addFormCurrentModelType === 'local' && provider.text.toLowerCase() === 'localhost';
		const isHuggingFace = this.addFormCurrentModelType === 'local' && provider.text.toLowerCase() === 'huggingface';
		const isOllama = this.addFormCurrentModelType === 'local' && provider.text.toLowerCase() === 'ollama';
		if (isLocalhost) {
			this.addFormModelNameLabel.textContent = localize('addCustomModel.localhostUrl', 'Localhost URL');
			this.addFormModelNameInputBox.setPlaceHolder(localize('addCustomModel.localhostUrlPlaceholder', 'e.g., http://localhost:1234/v1/chat/completions'));
		} else if (isOllama) {
			this.addFormModelNameLabel.textContent = localize('addCustomModel.ollamaModel', 'Ollama Model Name');
			this.addFormModelNameInputBox.setPlaceHolder(localize('addCustomModel.ollamaModelPlaceholder', 'e.g., llama3, mistral, deepseek-coder'));
		} else if (isHuggingFace) {
			this.addFormModelNameLabel.textContent = localize('addCustomModel.modelName', 'Model Name');
			this.addFormModelNameInputBox.setPlaceHolder(localize('addCustomModel.modelNamePlaceholderHuggingFace', 'e.g., openai/gpt-oss-20b or meta-llama/Llama-2-7b-chat'));
		} else {
			this.addFormModelNameLabel.textContent = localize('addCustomModel.modelName', 'Model Name');
			this.addFormModelNameInputBox.setPlaceHolder(localize('addCustomModel.modelNamePlaceholder', 'e.g., gpt-4, claude-3-opus, llama-2-7b'));
		}
	}

	private parseMaxInputK(inputValue: string): { valid: true; value: number } | { valid: false; error: string } {
		const s = inputValue.trim().replace(/[kK]/g, '').trim();
		if (s === '') {
			return { valid: false, error: localize('addCustomModel.error.maxInputRequired', 'Max input tokens is required.') };
		}
		const n = Number(s);
		if (Number.isNaN(n)) {
			return { valid: false, error: localize('addCustomModel.error.maxInputInvalid', 'Max input tokens must be a valid number.') };
		}
		if (!Number.isInteger(n) || n < 0) {
			return { valid: false, error: localize('addCustomModel.error.maxInputPositiveInteger', 'Max input tokens must be a positive integer.') };
		}
		if (n < LoCoPilotSettingsEditor.MIN_INPUT || n > LoCoPilotSettingsEditor.MAX_INPUT) {
			return { valid: false, error: localize('addCustomModel.error.maxInputTokensRange', 'Max input tokens must be between 0 and 2,000,000.') };
		}
		return { valid: true, value: n };
	}

	/** Validate and parse max output tokens (raw 0-32K, or with K suffix e.g. 8K). Rejects empty, non-numeric, negative, non-integer, out of range. */
	private parseMaxOutputTokens(inputValue: string): { valid: true; value: number } | { valid: false; error: string } {
		const s = inputValue.trim();
		if (s === '') {
			return { valid: false, error: localize('addCustomModel.error.maxOutputRequired', 'Max output tokens is required.') };
		}
		const hasK = /k$/i.test(s);
		const numStr = s.replace(/[kK]/g, '').trim();
		const n = Number(numStr);
		if (Number.isNaN(n)) {
			return { valid: false, error: localize('addCustomModel.error.maxOutputInvalid', 'Max output tokens must be a valid number (e.g. 4096 or 8K).') };
		}
		if (!Number.isInteger(n) || n < 0) {
			return { valid: false, error: localize('addCustomModel.error.maxOutputPositiveInteger', 'Max output tokens must be a positive integer.') };
		}
		const value = hasK ? n * 1000 : n;
		if (value < LoCoPilotSettingsEditor.MIN_OUTPUT_TOKENS || value > LoCoPilotSettingsEditor.MAX_OUTPUT_TOKENS) {
			return { valid: false, error: localize('addCustomModel.error.maxOutputTokensRange', 'Max output tokens must be between 0 and 32,000.') };
		}
		return { valid: true, value };
	}

	private async handleAddModel(): Promise<void> {
		const providers = this.addFormCurrentModelType === 'cloud' ? CLOUD_PROVIDERS_ADD : LOCAL_PROVIDERS_ADD;
		const provider = providers[this.addFormCurrentProviderIndex];
		const providerValue = provider.text.toLowerCase().replace(/\s+/g, '');
		const isLocalhost = providerValue === 'localhost';
		const modelName = this.addFormModelNameInputBox.value.trim();
		const apiKey = this.addFormCurrentModelType === 'cloud' ? this.addFormApiKeyInputBox.value.trim() : undefined;
		const token = (this.addFormCurrentModelType === 'local' && !isLocalhost) ? this.addFormTokenInputBox.value.trim() : undefined;
		const format = (this.addFormCurrentModelType === 'local' && providerValue === 'huggingface') ? this.addFormModelFormatInputBox.value.trim() : undefined;

		// For Ollama, token field holds the Base URL
		const ollamaUrl = (providerValue === 'ollama' && token) ? token : 'http://localhost:11434';

		const inputResult = this.parseMaxInputK(this.addFormMaxInputTokensInput.value);
		const outputResult = this.parseMaxOutputTokens(this.addFormMaxOutputTokensInput.value);
		const displayNameOpt = this.addFormDisplayNameInputBox.value.trim();
		const localhostServerModelId = isLocalhost ? this.addFormLocalhostModelIdInputBox.value.trim() : '';
		if (isLocalhost) {
			if (!modelName) {
				await this.dialogService.error(localize('addCustomModel.error.urlRequired', 'URL is required'));
				return;
			}
			if (!localhostServerModelId) {
				await this.dialogService.error(localize('addCustomModel.error.localhostServerModelIdRequired', 'Server model id is required (the name your OpenAI-compatible server expects in the request body, e.g. from GET /v1/models).'));
				return;
			}
		} else if (!modelName) {
			await this.dialogService.error(localize('addCustomModel.error.modelNameRequired', 'Model name is required'));
			return;
		}
		if (this.addFormCurrentModelType === 'cloud' && !apiKey) {
			await this.dialogService.error(localize('addCustomModel.error.apiKeyRequired', 'API key is required for cloud providers'));
			return;
		}
		if (!inputResult.valid) {
			await this.dialogService.error(inputResult.error);
			return;
		}
		if (!outputResult.valid) {
			await this.dialogService.error(outputResult.error);
			return;
		}

		// For Hugging Face or Ollama, check disk space before adding/downloading
		if (providerValue === 'huggingface' || providerValue === 'ollama') {
			try {
				const hasSpace = await this.commandService.executeCommand<boolean>('locopilot.checkDiskSpace');
				if (!hasSpace) {
					await this.dialogService.error(localize('addCustomModel.error.noDiskSpace', 'Insufficient disk space to download the model.'));
					return;
				}
			} catch (e) {
				this.logService.warn('Failed to check disk space', e);
			}
		}

		try {
			const nameFallback = isLocalhost ? localhostServerModelId : modelName;
			const addedModel = await this.customLanguageModelsService.addCustomModel({
				name: nameFallback,
				displayName: displayNameOpt || undefined,
				type: this.addFormCurrentModelType,
				provider: providerValue,
				apiKey,
				token: providerValue === 'ollama' ? undefined : token, // Don't store URL in token secret for Ollama
				format: format || undefined,
				modelName: modelName,
				localhostOpenAiModel: isLocalhost ? localhostServerModelId : undefined,
				localPath: providerValue === 'ollama' ? ollamaUrl : undefined, // Store Base URL in localPath for Ollama
				maxInputTokens: inputResult.value,
				maxOutputTokens: outputResult.value,
				useNativeTools: this.addFormUseNativeToolsToggle.checked
			});
			const listLabel = getCustomModelListLabel(addedModel);

			if (providerValue === 'huggingface' || providerValue === 'ollama') {
				// Start download process (runs in background; progress updates re-render the list)
				this.commandService.executeCommand('locopilot.downloadModel', addedModel.id);
				// Switch to Language Models list so user sees the model tile with download progress
				this.selectedSection = LOCOPILOT_SETTINGS_SECTION_LIST_MODELS;
				const listIdx = this.sections.findIndex(s => s.id === LOCOPILOT_SETTINGS_SECTION_LIST_MODELS);
				if (listIdx >= 0 && this.sectionsList) {
					this.sectionsList.setSelection([listIdx]);
					this.sectionsList.setFocus([listIdx]);
				}
				this.renderSelectedSection();
				const infoMsg = providerValue === 'ollama'
					? localize('addCustomModel.ollamaPullStarted', 'Ollama pull started')
					: localize('addCustomModel.downloadStarted', 'Download started');
				const infoDetail = providerValue === 'ollama'
					? localize('addCustomModel.ollamaPullStartedDetail', 'The model "{0}" is being pulled from Ollama. Track progress on the tile below.', listLabel)
					: localize('addCustomModel.downloadStartedDetail', 'The model "{0}" is being downloaded. Track progress on the tile below.', listLabel);
				await this.dialogService.info(infoMsg, infoDetail);
			} else {
				await this.dialogService.info(
					localize('addCustomModel.success', 'Model added successfully'),
					localize('addCustomModel.successDetail', 'The model "{0}" has been added and will appear in the "Auto" dropdown.', listLabel)
				);
			}
			this.resetAddModelFormToDefaults();
		} catch (error) {
			await this.dialogService.error(localize('addCustomModel.error.addFailed', 'Failed to add model'), toErrorMessage(error));
		}
	}

	private renderListModels(): void {
		if (!this.listModelsContainer) { return; }
		DOM.clearNode(this.listModelsContainer);
		const models = this.customLanguageModelsService.getCustomModels();
		if (models.length === 0) {
			const emptyContainer = DOM.append(this.listModelsContainer, $('.models-list-empty'));
			const icon = DOM.append(emptyContainer, $('.empty-icon'));
			icon.appendChild(renderIcon(Codicon.add));
			const message = DOM.append(emptyContainer, $('.empty-message'));
			message.textContent = localize('customLanguageModels.list.empty', 'No language models added yet');
			const addButton = this._register(new Button(emptyContainer, { ...defaultButtonStyles }));
			addButton.label = localize('customLanguageModels.list.add', 'Add Model');
			this._register(addButton.onDidClick(() => {
				this.commandService.executeCommand('workbench.action.chat.openLoCoPilotSettings', { section: 'add-model' });
			}));
			return;
		}
		const title = DOM.append(this.listModelsContainer, $('h2.models-list-title'));
		title.textContent = localize('customLanguageModels.list.title', 'Language Models');
		const listContainer = DOM.append(this.listModelsContainer, $('.models-list-container'));
		models.forEach((model: ICustomLanguageModel) => this.renderListModelItem(model, listContainer));
	}

	private renderListModelItem(model: ICustomLanguageModel, listContainer: HTMLElement): void {
		const isOllama = model.provider === 'ollama';
		const itemContainer = DOM.append(listContainer, $('.model-item', { 'data-model-id': model.id }));
		if (model.hidden) { itemContainer.classList.add('hidden'); }

		// Row 1: left = model name, right = Run model / Server, Hide, Delete
		const row1 = DOM.append(itemContainer, $('.model-item-row.model-item-row1'));
		const nameLabel = DOM.append(row1, $('.model-name'));
		nameLabel.textContent = getCustomModelListLabel(model);
		const actionsContainer = DOM.append(row1, $('.model-actions'));
		const runSlot = DOM.append(actionsContainer, $('.model-actions-run-slot'));
		const downloadingHFOrOllama = model.isDownloading && (model.provider === 'huggingface' || isOllama);
		if (needsDownloadOrPullRetry(model)) {
			const resumeTooltip = localize('customLanguageModels.resumeDownloadTitle', 'Start or resume downloading this model');
			const resumeButton = this._register(new Button(runSlot, { ...defaultButtonStyles, secondary: true, title: resumeTooltip }));
			resumeButton.label = localize('customLanguageModels.resumeDownload', 'Download');
			this._register(resumeButton.onDidClick(() => {
				this.commandService.executeCommand('locopilot.downloadModel', model.id);
			}));
		} else if (model.provider === 'huggingface' && model.localPath && !model.isDownloading) {
			const isRunning = this.localModelRunner.isServerRunning(model.id);
			const runServerButton = this._register(new Button(runSlot, { ...defaultButtonStyles, secondary: true }));
			runServerButton.label = isRunning ? localize('customLanguageModels.stopServer', 'Stop server') : localize('customLanguageModels.runServer', 'Run server');
			this._register(runServerButton.onDidClick(async () => {
				if (isRunning) {
					this.localModelRunner.stopServer(model.id);
				} else {
					const currentPath = this.llamaCppServerPathInput.value.trim();
					const savedPath = this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath);
					if (currentPath !== (savedPath ?? '').trim()) {
						await this.configurationService.updateValue(ChatConfiguration.LocopilotLlamaCppServerPath, currentPath);
					}
					this.commandService.executeCommand('locopilot.startLlamaServer', model.id);
				}
			}));
		} else if (isOllama && model.localPath && !model.isDownloading && !needsDownloadOrPullRetry(model)) {
			const isRunning = this.localModelRunner.isServerRunning(model.id);
			const runServerButton = this._register(new Button(runSlot, { ...defaultButtonStyles, secondary: true }));
			runServerButton.label = isRunning ? localize('customLanguageModels.stopServer', 'Stop server') : localize('customLanguageModels.runOllama', 'Run model');
			this._register(runServerButton.onDidClick(() => {
				if (isRunning) {
					this.localModelRunner.stopServer(model.id);
				} else {
					this.commandService.executeCommand('locopilot.runOllamaModel', model.id);
				}
			}));
		}
		if (downloadingHFOrOllama) {
			const stopWrap = DOM.append(actionsContainer, $('.model-action-stop-download'));
			const tooltip = localize('customLanguageModels.stopDownloadTitle', 'Stop the download or pull and discard partial files');
			const stopDownloadButton = this._register(new Button(stopWrap, { ...defaultButtonStyles, secondary: true, title: tooltip }));
			stopDownloadButton.label = localize('customLanguageModels.stopDownload', 'Stop download');
			this._register(stopDownloadButton.onDidClick(() => {
				this.commandService.executeCommand('locopilot.cancelModelDownload', model.id);
			}));
		} else {
			if (!needsDownloadOrPullRetry(model)) {
				const hideWrap = DOM.append(actionsContainer, $('.model-action-hide'));
				const hideButton = this._register(new Button(hideWrap, { ...defaultButtonStyles, secondary: true }));
				hideButton.label = model.hidden ? localize('customLanguageModels.show', 'Show') : localize('customLanguageModels.hide', 'Hide');
				this._register(hideButton.onDidClick(async () => {
					await this.customLanguageModelsService.hideCustomModel(model.id, !model.hidden);
				}));
			}
			const deleteButton = this._register(new Button(actionsContainer, { ...defaultButtonStyles, secondary: true }));
			deleteButton.label = localize('customLanguageModels.delete', 'Delete');
			this._register(deleteButton.onDidClick(async () => {
				const confirmed = await this.dialogService.confirm({
					title: localize('customLanguageModels.delete.confirm.title', 'Delete Model'),
					message: localize('customLanguageModels.delete.confirm.message', 'Are you sure you want to delete "{0}"?', getCustomModelListLabel(model)),
					primaryButton: localize('delete', 'Delete'),
					type: 'warning'
				});
				if (confirmed.confirmed) {
					itemContainer.classList.add('slide-out');
					const ANIMATION_MS = 300;
					await new Promise<void>(resolve => setTimeout(resolve, ANIMATION_MS));
					try {
						await this.commandService.executeCommand('locopilot.deleteModelFiles', model.id);
					} catch {
						// Ignore; model will still be removed from list
					}
					await this.customLanguageModelsService.removeCustomModel(model.id);
				}
			}));
		}

		// Row 2: left = local/cloud | provider | model, right = Tools toggle, Max In, Max Out
		const row2 = DOM.append(itemContainer, $('.model-item-row.model-item-row2'));
		let details = `${model.type === 'cloud' ? 'Cloud' : 'Local'} | ${model.provider} | ${model.modelName}`;
		if (model.provider === 'localhost' && model.localhostOpenAiModel) {
			details += ` | ${localize('customLanguageModels.localhostModelId', 'API model: {0}', model.localhostOpenAiModel)}`;
		}
		if (model.type === 'local' && model.useNativeTools) {
			details += ` | ${localize('customLanguageModels.nativeTools', 'Native Tools')}`;
		}
		if (model.format) {
			details += ` | ${model.format}`;
		}
		if (model.isDownloading) {
			details += isOllama
				? ` | ${localize('customLanguageModels.pullingInProgress', 'Pulling...')}`
				: ` | ${localize('customLanguageModels.downloading', 'Downloading')} ${model.downloadProgress ?? 0}%`;
		} else if (model.provider === 'huggingface' || isOllama) {
			if (!needsDownloadOrPullRetry(model)) {
				details += ` | ${isOllama ? localize('customLanguageModels.ready', 'Ready') : localize('customLanguageModels.downloaded', 'Downloaded')}`;
			} else {
				details += ` | ${localize('customLanguageModels.downloadNotFinished', 'Download not finished')}`;
			}
		}
		const detailsLabel = DOM.append(row2, $('.model-details'));
		detailsLabel.textContent = details;

		const secondarySettingsContainer = DOM.append(row2, $('.model-secondary-settings'));
		if (model.type === 'local') {
			const toolsContainer = DOM.append(secondarySettingsContainer, $('.model-action-tools-container'));
			toolsContainer.title = localize('customLanguageModels.toolsDescription', 'Enable native tool calling for this model');
			const toolsIcon = DOM.append(toolsContainer, $('span.model-action-tools-icon'));
			toolsIcon.appendChild(renderIcon(Codicon.tools));
			const toolsWrap = DOM.append(toolsContainer, $('.model-action-tools.agent-setting-switch-wrap'));
			const toolsToggle = this._register(new Toggle({
				title: localize('customLanguageModels.toolsDescription', 'Enable native tool calling for this model'),
				isChecked: !!model.useNativeTools,
				...defaultToggleStyles
			}));
			DOM.append(toolsWrap, toolsToggle.domNode);
			this._register(toolsToggle.onChange(async () => {
				await this.customLanguageModelsService.updateCustomModel(model.id, { useNativeTools: toolsToggle.checked });
			}));
		}
		const maxInputContainer = DOM.append(secondarySettingsContainer, $('.model-max-input-container'));
		const maxInputIcon = DOM.append(maxInputContainer, $('span.model-max-input-icon'));
		maxInputIcon.appendChild(renderIcon(Codicon.arrowDown));
		const maxInputInput = this._register(new InputBox(maxInputContainer, this.contextViewService, {
			placeholder: String(LoCoPilotSettingsEditor.DEFAULT_MAX_INPUT),
			tooltip: '',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		maxInputInput.element.style.minWidth = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		maxInputInput.element.style.width = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		maxInputInput.value = String(model.maxInputTokens ?? LoCoPilotSettingsEditor.DEFAULT_MAX_INPUT);
		const syncMaxInputTooltip = () => {
			maxInputInput.setTooltip(this.maxInputTokensTooltip(maxInputInput.value));
		};
		syncMaxInputTooltip();
		this._register(maxInputInput.onDidChange(async () => {
			syncMaxInputTooltip();
			const result = this.parseMaxInputK(maxInputInput.value);
			if (result.valid) {
				await this.customLanguageModelsService.updateCustomModel(model.id, { maxInputTokens: result.value });
			}
		}));
		const maxOutputContainer = DOM.append(secondarySettingsContainer, $('.model-max-output-container'));
		const maxOutputIcon = DOM.append(maxOutputContainer, $('span.model-max-output-icon'));
		maxOutputIcon.appendChild(renderIcon(Codicon.arrowUp));
		const maxOutputInput = this._register(new InputBox(maxOutputContainer, this.contextViewService, {
			placeholder: String(LoCoPilotSettingsEditor.DEFAULT_MAX_OUTPUT_TOKENS),
			tooltip: '',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		maxOutputInput.element.style.minWidth = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		maxOutputInput.element.style.width = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		maxOutputInput.value = String(model.maxOutputTokens ?? LoCoPilotSettingsEditor.DEFAULT_MAX_OUTPUT_TOKENS);
		const syncMaxOutputTooltip = () => {
			maxOutputInput.setTooltip(this.maxOutputTokensTooltip(maxOutputInput.value));
		};
		syncMaxOutputTooltip();
		this._register(maxOutputInput.onDidChange(async () => {
			syncMaxOutputTooltip();
			const result = this.parseMaxOutputTokens(maxOutputInput.value);
			if (result.valid) {
				await this.customLanguageModelsService.updateCustomModel(model.id, { maxOutputTokens: result.value });
			}
		}));

		// Row 3: local path or download progress (Ollama: indeterminate spinner; Hugging Face: % bar)
		if (model.isDownloading && isOllama) {
			const row3 = DOM.append(itemContainer, $('.model-item-row.model-item-row3'));
			const loadingWrap = DOM.append(row3, $('.model-ollama-pull-loading'));
			const loadingLabel = DOM.append(loadingWrap, $('.model-ollama-pull-label'));
			loadingLabel.textContent = localize('customLanguageModels.ollamaPullLoading', 'Pulling model from Ollama...');
			const activity = DOM.append(loadingWrap, $('.model-ollama-activity'));
			activity.setAttribute('aria-hidden', 'true');
			for (let i = 0; i < 8; i++) {
				DOM.append(activity, $('.model-ollama-activity-tick'));
			}
			loadingWrap.setAttribute('aria-busy', 'true');
			loadingWrap.setAttribute('aria-label', localize('customLanguageModels.ollamaPullLoadingAria', 'Pulling model from Ollama, please wait'));
		} else if (model.isDownloading) {
			const row3 = DOM.append(itemContainer, $('.model-item-row.model-item-row3'));
			const progressWrap = DOM.append(row3, $('.model-download-progress-wrap'));
			const progressLabel = DOM.append(progressWrap, $('.model-download-progress-label'));
			progressLabel.textContent = localize('customLanguageModels.downloadProgressShort', 'Downloading... {0}%', model.downloadProgress ?? 0);
			const progressTrack = DOM.append(progressWrap, $('.model-download-progress-track'));
			const progressFill = DOM.append(progressTrack, $('.model-download-progress-fill'));
			const pct = Math.min(100, Math.max(0, model.downloadProgress ?? 0));
			progressFill.style.setProperty('width', `${pct}%`);
			progressWrap.setAttribute('aria-label', localize('customLanguageModels.downloadProgress', 'Download progress {0}%', pct));
		}
		const showInstalledPathRow = !model.isDownloading && model.localPath && (model.provider === 'huggingface' || isOllama) && !needsDownloadOrPullRetry(model);
		if (showInstalledPathRow) {
			const row3 = DOM.append(itemContainer, $('.model-item-row.model-item-row3'));
			const pathLabel = DOM.append(row3, $('.model-saved-path'));
			pathLabel.textContent = isOllama
				? localize('customLanguageModels.ollamaModelReady', 'Ollama model "{0}" is ready', model.modelName)
				: localize('customLanguageModels.savedTo', 'Saved to: {0}', model.localPath);
			pathLabel.title = model.localPath || '';
		}
	}

	private renderAgentSettings(container: HTMLElement): void {
		// Max iterations per request
		const maxIterSection = DOM.append(container, $('.agent-setting-row'));
		const maxIterLabel = DOM.append(maxIterSection, $('label.locopilot-setting-label'));
		maxIterLabel.textContent = localize('locopilotSettings.maxIterations', "Max iterations per request");
		const maxIterWrap = DOM.append(maxIterSection, $('.agent-setting-input-wrap'));
		this.maxIterationsInput = this._register(new InputBox(DOM.append(maxIterWrap, $('div')), this.contextViewService, {
			placeholder: String(DEFAULT_MAX_ITERATIONS),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		this.maxIterationsInput.value = String(this.agentSettingsService.getMaxIterationsPerRequest());
		this._register(this.maxIterationsInput.onDidChange(() => this.updateAgentSettingsDirtyIndicators()));

		// Auto approve terminal commands (on/off switch; default off)
		const autoRunRow = DOM.append(container, $('.agent-setting-row'));
		const autoRunLabel = DOM.append(autoRunRow, $('label.locopilot-setting-label'));
		autoRunLabel.textContent = localize('locopilotSettings.autoApproveTerminalCommands', "Auto approve terminal commands");
		const autoRunWrap = DOM.append(autoRunRow, $('.agent-setting-toggle-wrap.agent-setting-switch-wrap'));
		this.autoRunCommandsInSandboxToggle = this._register(new Toggle({
			title: localize('locopilotSettings.autoApproveTerminalCommandsDescription', "When on, terminal commands from the LLM agent run without asking for permission. Commands are allowed in sandbox. Default: off."),
			isChecked: this.agentSettingsService.getAutoRunCommandsInSandbox(),
			...defaultToggleStyles
		}));
		DOM.append(autoRunWrap, this.autoRunCommandsInSandboxToggle.domNode);
		this._register(this.autoRunCommandsInSandboxToggle.onChange(() => this.updateAgentSettingsDirtyIndicators()));

		// Llama.cpp server path (for local GGUF models)
		const llamaPathRow = DOM.append(container, $('.agent-setting-row'));
		const llamaPathLabel = DOM.append(llamaPathRow, $('label.locopilot-setting-label'));
		llamaPathLabel.textContent = localize('locopilotSettings.llamaCppServerPath', "Llama.cpp server path");
		const llamaPathWrap = DOM.append(llamaPathRow, $('.agent-setting-input-wrap.agent-setting-path-wrap'));
		this.llamaCppServerPathInput = this._register(new InputBox(DOM.append(llamaPathWrap, $('div')), this.contextViewService, {
			placeholder: localize('locopilotSettings.llamaCppServerPathPlaceholder', "e.g. /path/to/llama-server or C:\\llama.cpp\\build\\bin"),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		this.llamaCppServerPathInput.value = this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath) ?? '';
		this._register(this.llamaCppServerPathInput.onDidChange(() => this.updateAgentSettingsDirtyIndicators()));

		// Python for MLX (mlx-lm) - Apple Silicon only
		const mlxPythonRow = DOM.append(container, $('.agent-setting-row'));
		const mlxPythonLabel = DOM.append(mlxPythonRow, $('label.locopilot-setting-label'));
		mlxPythonLabel.textContent = localize('locopilotSettings.mlxPythonPath', "Python for MLX (mlx-lm)");
		const mlxPythonWrap = DOM.append(mlxPythonRow, $('.agent-setting-input-wrap.agent-setting-path-wrap'));
		this.mlxPythonPathInput = this._register(new InputBox(DOM.append(mlxPythonWrap, $('div')), this.contextViewService, {
			placeholder: localize('locopilotSettings.mlxPythonPathPlaceholder', "Leave empty for python3, or path to a venv Python"),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		this.mlxPythonPathInput.value = this.configurationService.getValue<string>(ChatConfiguration.LocopilotMlxPythonPath) ?? '';
		this._register(this.mlxPythonPathInput.onDidChange(() => this.updateAgentSettingsDirtyIndicators()));

		// LoCoPilot prompt - Agent (toggle label only; no separate section heading)
		const agentSection = DOM.append(container, $('.agent-setting-block'));
		const agentCodingRow = DOM.append(agentSection, $('.agent-setting-row'));
		const agentCodingLabel = DOM.append(agentCodingRow, $('label.locopilot-setting-label'));
		agentCodingLabel.textContent = localize('locopilotSettings.locopilotPromptAgent', "LoCoPilot's prompt (Agent)");
		const agentCodingWrap = DOM.append(agentCodingRow, $('.agent-setting-toggle-wrap.agent-setting-switch-wrap'));
		this.agentCodingSystemPromptToggle = this._register(new Toggle({
			title: localize('locopilotSettings.locopilotPromptAgentDescription', "When on, Agent mode uses LoCoPilot's built-in coding prompt (tools are appended). When off, you can optionally edit below; leave blank for a short default opener."),
			isChecked: this.agentSettingsService.getAgentUseCodingSystemPrompt(),
			...defaultToggleStyles
		}));
		DOM.append(agentCodingWrap, this.agentCodingSystemPromptToggle.domNode);
		this._register(this.agentCodingSystemPromptToggle.onChange(() => {
			this.updateCodingPromptUIMode('agent');
			this._renderFormattedPrompt('agent');
			this.updateAgentSettingsDirtyIndicators();
		}));

		const agentBox = DOM.append(agentSection, $('.locopilot-prompt-box'));
		this.agentPromptFormattedView = DOM.append(agentBox, $('.locopilot-prompt-formatted'));
		this.agentPromptFormattedView.setAttribute('role', 'button');
		this.agentPromptFormattedView.setAttribute('tabindex', '0');
		this.agentPromptFormattedView.title = localize('locopilotSettings.clickToEdit', "Click to edit");
		this.agentPromptTextarea = DOM.append(agentBox, $('textarea.locopilot-prompt-textarea')) as HTMLTextAreaElement;
		this.agentPromptTextarea.placeholder = localize('locopilotSettings.agentPromptPlaceholder', "Optional when LoCoPilot's prompt is off. Blank uses a one-line default opener.");
		this.agentPromptTextarea.value = this.agentSettingsService.getAgentModeSystemPrompt();
		this.agentPromptTextarea.classList.add('locopilot-prompt-textarea-hidden');
		this.updateCodingPromptUIMode('agent');
		this._renderFormattedPrompt('agent');
		this._register(DOM.addDisposableListener(this.agentPromptFormattedView, 'click', () => this._switchToEditPrompt('agent')));
		this._register(DOM.addDisposableListener(this.agentPromptFormattedView, 'keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._switchToEditPrompt('agent'); } }));
		this._register(DOM.addDisposableListener(this.agentPromptTextarea, 'blur', () => this._switchToFormattedPrompt('agent')));
		this._register(DOM.addDisposableListener(this.agentPromptTextarea, 'input', () => this.updateAgentSettingsDirtyIndicators()));

		// LoCoPilot prompt - Ask (toggle label only; no separate section heading)
		const askSection = DOM.append(container, $('.agent-setting-block'));
		const askCodingRow = DOM.append(askSection, $('.agent-setting-row'));
		const askCodingLabel = DOM.append(askCodingRow, $('label.locopilot-setting-label'));
		askCodingLabel.textContent = localize('locopilotSettings.locopilotPromptAsk', "LoCoPilot's prompt (Ask)");
		const askCodingWrap = DOM.append(askCodingRow, $('.agent-setting-toggle-wrap.agent-setting-switch-wrap'));
		this.askCodingSystemPromptToggle = this._register(new Toggle({
			title: localize('locopilotSettings.locopilotPromptAskDescription', "When on, Ask mode uses LoCoPilot's built-in coding prompt for Ask mode (tools are appended). When off, you can optionally edit below; leave blank for a short default opener."),
			isChecked: this.agentSettingsService.getAskUseCodingSystemPrompt(),
			...defaultToggleStyles
		}));
		DOM.append(askCodingWrap, this.askCodingSystemPromptToggle.domNode);
		this._register(this.askCodingSystemPromptToggle.onChange(() => {
			this.updateCodingPromptUIMode('ask');
			this._renderFormattedPrompt('ask');
			this.updateAgentSettingsDirtyIndicators();
		}));

		const askBox = DOM.append(askSection, $('.locopilot-prompt-box'));
		this.askPromptFormattedView = DOM.append(askBox, $('.locopilot-prompt-formatted'));
		this.askPromptFormattedView.setAttribute('role', 'button');
		this.askPromptFormattedView.setAttribute('tabindex', '0');
		this.askPromptFormattedView.title = localize('locopilotSettings.clickToEdit', "Click to edit");
		this.askPromptTextarea = DOM.append(askBox, $('textarea.locopilot-prompt-textarea')) as HTMLTextAreaElement;
		this.askPromptTextarea.placeholder = localize('locopilotSettings.askPromptPlaceholder', "Optional when LoCoPilot's prompt is off. Blank uses a one-line default opener.");
		this.askPromptTextarea.value = this.agentSettingsService.getAskModeSystemPrompt();
		this.askPromptTextarea.classList.add('locopilot-prompt-textarea-hidden');
		this.updateCodingPromptUIMode('ask');
		this._renderFormattedPrompt('ask');
		this._register(DOM.addDisposableListener(this.askPromptFormattedView, 'click', () => this._switchToEditPrompt('ask')));
		this._register(DOM.addDisposableListener(this.askPromptFormattedView, 'keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._switchToEditPrompt('ask'); } }));
		this._register(DOM.addDisposableListener(this.askPromptTextarea, 'blur', () => this._switchToFormattedPrompt('ask')));
		this._register(DOM.addDisposableListener(this.askPromptTextarea, 'input', () => this.updateAgentSettingsDirtyIndicators()));

		const footerRow = DOM.append(container, $('.agent-setting-footer'));
		this.agentSettingsCancelBtn = this._register(new Button(footerRow, { ...defaultButtonStyles, secondary: true }));
		this.agentSettingsCancelBtn.label = localize('locopilotSettings.cancel', "Cancel");
		this.agentSettingsCancelBtn.enabled = false;
		this.agentSettingsCancelBtn.onDidClick(() => this.cancelAgentSettings());
		this.agentSettingsSaveBtn = this._register(new Button(footerRow, { ...defaultButtonStyles }));
		this.agentSettingsSaveBtn.label = localize('locopilotSettings.save', "Save");
		this.agentSettingsSaveBtn.enabled = false;
		this.agentSettingsSaveBtn.onDidClick(() => { this.saveAgentSettings(); });

		this.captureAgentSettingsBaselineFromPersisted();
		this.updateAgentSettingsDirtyIndicators();
	}

	private takeAgentSettingsSnapshotFromPersisted(): {
		maxIterations: number;
		autoRunSandbox: boolean;
		llamaPath: string;
		mlxPath: string;
		askCoding: boolean;
		agentCoding: boolean;
		askPrompt: string;
		agentPrompt: string;
	} {
		return {
			maxIterations: this.agentSettingsService.getMaxIterationsPerRequest(),
			autoRunSandbox: this.agentSettingsService.getAutoRunCommandsInSandbox(),
			llamaPath: (this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath) ?? '').trim(),
			mlxPath: (this.configurationService.getValue<string>(ChatConfiguration.LocopilotMlxPythonPath) ?? '').trim(),
			askCoding: this.agentSettingsService.getAskUseCodingSystemPrompt(),
			agentCoding: this.agentSettingsService.getAgentUseCodingSystemPrompt(),
			askPrompt: this.agentSettingsService.getAskModeSystemPrompt().trim(),
			agentPrompt: this.agentSettingsService.getAgentModeSystemPrompt().trim(),
		};
	}

	private snapshotAgentPanelFromUI(): {
		maxIterations: number;
		autoRunSandbox: boolean;
		llamaPath: string;
		mlxPath: string;
		askCoding: boolean;
		agentCoding: boolean;
		askPrompt: string;
		agentPrompt: string;
	} {
		const rawN = parseInt(this.maxIterationsInput.value.trim(), 10);
		return {
			maxIterations: isNaN(rawN) ? -1 : rawN,
			autoRunSandbox: this.autoRunCommandsInSandboxToggle.checked,
			llamaPath: this.llamaCppServerPathInput.value.trim(),
			mlxPath: this.mlxPythonPathInput.value.trim(),
			askCoding: this.askCodingSystemPromptToggle.checked,
			agentCoding: this.agentCodingSystemPromptToggle.checked,
			askPrompt: this.askPromptTextarea.value.trim(),
			agentPrompt: this.agentPromptTextarea.value.trim(),
		};
	}

	private captureAgentSettingsBaselineFromPersisted(): void {
		this.agentSettingsBaseline = this.takeAgentSettingsSnapshotFromPersisted();
	}

	private isAgentSettingsDirty(): boolean {
		if (!this.agentSettingsBaseline) {
			return false;
		}
		const cur = this.snapshotAgentPanelFromUI();
		const b = this.agentSettingsBaseline;
		return (
			b.maxIterations !== cur.maxIterations ||
			b.autoRunSandbox !== cur.autoRunSandbox ||
			b.llamaPath !== cur.llamaPath ||
			b.mlxPath !== cur.mlxPath ||
			b.askCoding !== cur.askCoding ||
			b.agentCoding !== cur.agentCoding ||
			b.askPrompt !== cur.askPrompt ||
			b.agentPrompt !== cur.agentPrompt
		);
	}

	private updateAgentSettingsDirtyIndicators(): void {
		const dirty = this.isAgentSettingsDirty();
		this.agentSettingsSaveBtn.enabled = dirty;
		this.agentSettingsCancelBtn.enabled = dirty;
	}

	private updateCodingPromptUIMode(which: 'agent' | 'ask'): void {
		const useBuiltin = which === 'agent' ? this.agentCodingSystemPromptToggle.checked : this.askCodingSystemPromptToggle.checked;
		const textarea = which === 'agent' ? this.agentPromptTextarea : this.askPromptTextarea;
		const formatted = which === 'agent' ? this.agentPromptFormattedView : this.askPromptFormattedView;
		const wrap = formatted.parentElement;
		textarea.disabled = useBuiltin;
		if (useBuiltin) {
			formatted.removeAttribute('role');
			formatted.tabIndex = -1;
			formatted.removeAttribute('title');
			wrap?.classList.add('locopilot-prompt-box-disabled');
		} else {
			formatted.setAttribute('role', 'button');
			formatted.tabIndex = 0;
			formatted.title = localize('locopilotSettings.clickToEdit', "Click to edit");
			wrap?.classList.remove('locopilot-prompt-box-disabled');
		}
	}

	private updateCodingPromptUIModes(): void {
		this.updateCodingPromptUIMode('agent');
		this.updateCodingPromptUIMode('ask');
	}

	private loadAgentPanelFromPersisted(): void {
		this.maxIterationsInput.value = String(this.agentSettingsService.getMaxIterationsPerRequest());
		this.autoRunCommandsInSandboxToggle.checked = this.agentSettingsService.getAutoRunCommandsInSandbox();
		this.llamaCppServerPathInput.value = this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppServerPath) ?? '';
		this.mlxPythonPathInput.value = this.configurationService.getValue<string>(ChatConfiguration.LocopilotMlxPythonPath) ?? '';
		this.askCodingSystemPromptToggle.checked = this.agentSettingsService.getAskUseCodingSystemPrompt();
		this.agentCodingSystemPromptToggle.checked = this.agentSettingsService.getAgentUseCodingSystemPrompt();
		this.askPromptTextarea.value = this.agentSettingsService.getAskModeSystemPrompt();
		this.agentPromptTextarea.value = this.agentSettingsService.getAgentModeSystemPrompt();
		this.updateCodingPromptUIModes();
		this._renderFormattedPrompt('agent');
		this._renderFormattedPrompt('ask');
		this.agentPromptFormattedView.classList.remove('locopilot-prompt-formatted-hidden');
		this.askPromptFormattedView.classList.remove('locopilot-prompt-formatted-hidden');
		this.agentPromptTextarea.classList.add('locopilot-prompt-textarea-hidden');
		this.askPromptTextarea.classList.add('locopilot-prompt-textarea-hidden');
		this.captureAgentSettingsBaselineFromPersisted();
		this.updateAgentSettingsDirtyIndicators();
	}

	private async saveAgentSettings(): Promise<void> {
		const minIterations = 10;
		const maxIterations = 500;
		const n = parseInt(this.maxIterationsInput.value.trim(), 10);
		if (isNaN(n) || n < minIterations || n > maxIterations) {
			await this.dialogService.error(
				localize('locopilotSettings.saveError.maxIterations', "Max iterations must be between {0} and {1}.", minIterations, maxIterations)
			);
			return;
		}
		try {
			this.agentSettingsService.setMaxIterationsPerRequest(n);
			this.agentSettingsService.setAutoRunCommandsInSandbox(this.autoRunCommandsInSandboxToggle.checked);
			this.agentSettingsService.setAskUseCodingSystemPrompt(this.askCodingSystemPromptToggle.checked);
			this.agentSettingsService.setAgentUseCodingSystemPrompt(this.agentCodingSystemPromptToggle.checked);
			this.agentSettingsService.setAskModeSystemPrompt(this.askPromptTextarea.value.trim());
			this.agentSettingsService.setAgentModeSystemPrompt(this.agentPromptTextarea.value.trim());
			await this.configurationService.updateValue(ChatConfiguration.LocopilotLlamaCppServerPath, this.llamaCppServerPathInput.value.trim());
			await this.configurationService.updateValue(ChatConfiguration.LocopilotMlxPythonPath, this.mlxPythonPathInput.value.trim());
			this.captureAgentSettingsBaselineFromPersisted();
			this.updateAgentSettingsDirtyIndicators();
			await this.dialogService.info(
				localize('locopilotSettings.saveSuccess', "Settings saved"),
				localize('locopilotSettings.saveSuccessDetail', "Agent settings have been saved successfully.")
			);
		} catch (error) {
			await this.dialogService.error(
				localize('locopilotSettings.saveError.title', "Failed to save settings"),
				toErrorMessage(error)
			);
		}
	}

	private _renderFormattedPrompt(which: 'agent' | 'ask'): void {
		const textarea = which === 'agent' ? this.agentPromptTextarea : this.askPromptTextarea;
		const container = which === 'agent' ? this.agentPromptFormattedView : this.askPromptFormattedView;
		const useCodingBuiltin = which === 'agent' ? this.agentCodingSystemPromptToggle.checked : this.askCodingSystemPromptToggle.checked;
		const setRendered = (r: { dispose(): void } | undefined) => {
			if (which === 'agent') { this.agentPromptFormattedRendered = r; } else { this.askPromptFormattedRendered = r; }
		};
		const prev = which === 'agent' ? this.agentPromptFormattedRendered : this.askPromptFormattedRendered;
		if (prev) {
			prev.dispose();
			setRendered(undefined);
		}
		if (useCodingBuiltin) {
			DOM.reset(container);
			container.textContent = which === 'agent'
				? localize(
					'locopilotSettings.locopilotBuiltinPromptActiveAgent',
					'LoCoPilot\'s built-in coding prompt is active. Turn off "LoCoPilot\'s prompt (Agent)" to customize.'
				)
				: localize(
					'locopilotSettings.locopilotBuiltinPromptActiveAsk',
					'LoCoPilot\'s built-in coding prompt is active. Turn off "LoCoPilot\'s prompt (Ask)" to customize.'
				);
			container.classList.add('locopilot-prompt-is-default');
			return;
		}
		const trimmed = textarea.value.trim();
		if (!trimmed) {
			DOM.reset(container);
			container.textContent = localize('locopilotSettings.clickToCustomize', "Click to customize.");
			container.classList.add('locopilot-prompt-is-default');
			return;
		}
		container.classList.remove('locopilot-prompt-is-default');
		const rendered = this.markdownRendererService.render(new MarkdownString(trimmed), {}, container);
		setRendered(rendered);
		this._register(rendered);
	}

	private _switchToEditPrompt(which: 'agent' | 'ask'): void {
		if ((which === 'agent' && this.agentCodingSystemPromptToggle.checked) || (which === 'ask' && this.askCodingSystemPromptToggle.checked)) {
			return;
		}
		const formatted = which === 'agent' ? this.agentPromptFormattedView : this.askPromptFormattedView;
		const textarea = which === 'agent' ? this.agentPromptTextarea : this.askPromptTextarea;
		formatted.classList.add('locopilot-prompt-formatted-hidden');
		textarea.classList.remove('locopilot-prompt-textarea-hidden');
		textarea.focus();
	}

	private _switchToFormattedPrompt(which: 'agent' | 'ask'): void {
		const formatted = which === 'agent' ? this.agentPromptFormattedView : this.askPromptFormattedView;
		const textarea = which === 'agent' ? this.agentPromptTextarea : this.askPromptTextarea;
		this._renderFormattedPrompt(which);
		formatted.classList.remove('locopilot-prompt-formatted-hidden');
		textarea.classList.add('locopilot-prompt-textarea-hidden');
	}

	private cancelAgentSettings(): void {
		this.loadAgentPanelFromPersisted();
	}

	private renderSelectedSection(): void {
		this.addModelsPanel.style.display = 'none';
		this.listModelsPanel.style.display = 'none';
		this.agentSettingsPanel.style.display = 'none';

		switch (this.selectedSection) {
			case LOCOPILOT_SETTINGS_SECTION_ADD_MODEL:
				this.addModelsPanel.style.display = 'block';
				break;
			case LOCOPILOT_SETTINGS_SECTION_LIST_MODELS:
				this.listModelsPanel.style.display = 'block';
				this.renderListModels();
				break;
			case LOCOPILOT_SETTINGS_SECTION_AGENT_SETTINGS:
				this.agentSettingsPanel.style.display = 'flex';
				this.loadAgentPanelFromPersisted();
				break;
		}

		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	private layoutContents(_width: number, _height: number): void {
		// Add and list panels use CSS layout
	}

	override async setInput(input: LoCoPilotSettingsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const initialSection = input.initialSection;
		if (initialSection) {
			const previousSection = this.selectedSection;
			this.selectedSection = initialSection;
			if (initialSection === LOCOPILOT_SETTINGS_SECTION_ADD_MODEL && previousSection !== LOCOPILOT_SETTINGS_SECTION_ADD_MODEL) {
				this.resetAddModelFormToDefaults();
			}
			const idx = this.sections.findIndex(s => s.id === initialSection);
			if (idx >= 0 && this.sectionsList) {
				this.sectionsList.setSelection([idx]);
				this.sectionsList.setFocus([idx]);
			}
			this.renderSelectedSection();
		}
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (this.container && this.splitView) {
			const headerHeight = this.headerContainer?.offsetHeight || 0;
			const splitViewHeight = dimension.height - headerHeight;
			this.splitView.layout(this.container.clientWidth, splitViewHeight);
			this.splitView.el.style.height = `${splitViewHeight}px`;
		}
	}

	override focus(): void {
		super.focus();
		this.sectionsList?.domFocus();
	}
}

class SectionItemDelegate implements IListVirtualDelegate<SectionItem> {
	getHeight(element: SectionItem) {
		return 22;
	}
	getTemplateId() { return 'locopilotSectionItem'; }
}

interface ISectionItemTemplateData {
	readonly label: HTMLElement;
}

class SectionItemRenderer {
	readonly templateId = 'locopilotSectionItem';

	renderTemplate(container: HTMLElement): ISectionItemTemplateData {
		container.classList.add('section-list-item');
		const label = DOM.append(container, $('.section-list-item-label'));
		return { label };
	}

	renderElement(element: SectionItem, index: number, templateData: ISectionItemTemplateData): void {
		templateData.label.textContent = element.label;
	}

	disposeTemplate(templateData: ISectionItemTemplateData): void {
	}
}
