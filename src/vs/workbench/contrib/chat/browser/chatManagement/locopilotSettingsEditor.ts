/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/locopilotSettingsEditor.css';
import './media/addCustomModelEditor.css';
import './media/customLanguageModelsListEditor.css';
import * as DOM from '../../../../../base/browser/dom.js';
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
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { registerColor, foreground, listActiveSelectionBackground, listActiveSelectionForeground } from '../../../../../platform/theme/common/colorRegistry.js';
import { PANEL_BORDER } from '../../../../common/theme.js';
import { ILoCoPilotAgentSettingsService, DEFAULT_MAX_ITERATIONS } from '../locopilotAgentSettingsService.js';
import { ILoCoPilotProjectMemoryService } from '../locopilotProjectMemoryService.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles, getInputBoxStyle, getSelectBoxStyles, defaultToggleStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { settingsSelectBackground, settingsSelectBorder, settingsSelectForeground, settingsSelectListBorder, settingsTextInputBackground, settingsTextInputBorder, settingsTextInputForeground } from '../../../preferences/common/settingsEditorColorRegistry.js';
import { Toggle } from '../../../../../base/browser/ui/toggle/toggle.js';
import { SelectBox, ISelectOptionItem, ISelectData } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { ICustomLanguageModelsService, ICustomLanguageModel, getCustomModelListLabel, customModelSupportsVision, customModelVisionEnabled, needsDownloadOrPullRetry, hasRemovableLocalDownload, DEFAULT_CONTEXT_WINDOW_CLOUD, DEFAULT_CONTEXT_WINDOW_LOCAL, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW } from '../../common/customLanguageModelsService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import Severity from '../../../../../base/common/severity.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { ILoCoPilotLocalModelRunner } from '../locopilotLocalModelRunner.js';
import { ITimerService } from '../../../../services/timer/browser/timerService.js';
import { isAppleSiliconMac } from '../locopilotMlxServer.js';
import { findCatalogEntry, getCatalogSuitability, getRecommendedRepoId, ModelSuitability } from '../locopilotModelCatalog.js';
// [engine-ui] Only needed by the commented-out engine dropdown in renderAgentSettings; uncomment to restore.
// import { isMacintosh } from '../../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../common/constants.js';

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
	selectListBorder: settingsSelectListBorder,
	// Use the theme's standard list-selection colors for the open dropdown instead of the
	// quick-input/picker defaults (which render an accent blue many themes don't override).
	listFocusBackground: listActiveSelectionBackground,
	listFocusForeground: listActiveSelectionForeground,
	decoratorRightForeground: foreground
});

const CLOUD_PROVIDERS_ADD: ISelectOptionItem[] = [
	{ text: 'Anthropic', description: '' },
	{ text: 'Google', description: '' },
	{ text: 'Hugging Face', description: '' },
	{ text: 'OpenAI', description: '' },
];

const LOCAL_PROVIDERS_ADD: ISelectOptionItem[] = [
	{ text: 'HuggingFace', description: '' },
	{ text: 'Localhost', description: '' },
	{ text: 'Ollama', description: '' },
];

export const locopilotSettingsSashBorder = registerColor('locopilotSettings.sashBorder', PANEL_BORDER, localize('locopilotSettingsSashBorder', "The color of the LoCoPilot Settings editor splitview sash border."));

/**
 * Parse a model's parameter count (in billions) from its label, e.g. "Qwen3.5 0.8B" -> 0.8,
 * "Mistral Small 24B" -> 24, "Gemma 4 26B-A4B MoE" -> 26 (total params), "Gemma 4 E4B" -> 4.
 * Returns undefined when the name carries no recognizable "<n>B" parameter hint.
 */
function parseModelParamsB(name: string | undefined): number | undefined {
	if (!name) {
		return undefined;
	}
	// First "<number>B" token where B is not part of a longer word (so "GB"/"Bytes" etc. don't match).
	const match = /(\d+(?:\.\d+)?)\s*B(?![a-z])/i.exec(name);
	if (!match) {
		return undefined;
	}
	const value = parseFloat(match[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Format a parameter count for display: 24 -> "24B", 0.8 -> "0.8B". */
function formatParamsB(params: number): string {
	const rounded = Math.round(params * 10) / 10;
	const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
	return `${text}B`;
}

interface SectionItem {
	id: string;
	label: string;
	icon: ThemeIcon;
	description?: string;
}

/**
 * Two-option segmented control for prompt mode: "Default" (use LoCoPilot's built-in prompt)
 * vs "Override" (user supplies their own). `checked === true` means Default is selected.
 * API mirrors the subset of Toggle used by the settings editor (`checked`, `onChange`, `domNode`).
 */
class PromptModeControl extends Disposable {
	private readonly _domNode: HTMLElement;
	private readonly _defaultBtn: HTMLElement;
	private readonly _overrideBtn: HTMLElement;
	private _checked: boolean;
	private readonly _onChange = this._register(new Emitter<boolean>());
	readonly onChange = this._onChange.event;

	constructor(initialChecked: boolean, ariaLabel: string) {
		super();
		this._checked = initialChecked;
		this._domNode = $('.locopilot-segmented');
		this._domNode.setAttribute('role', 'radiogroup');
		this._domNode.setAttribute('aria-label', ariaLabel);

		this._defaultBtn = DOM.append(this._domNode, $('button.locopilot-segmented-option'));
		this._defaultBtn.textContent = localize('locopilotSettings.promptModeDefault', "Default");
		this._defaultBtn.setAttribute('role', 'radio');
		this._defaultBtn.title = localize('locopilotSettings.promptModeDefaultTitle', "Use LoCoPilot's built-in coding prompt.");

		this._overrideBtn = DOM.append(this._domNode, $('button.locopilot-segmented-option'));
		this._overrideBtn.textContent = localize('locopilotSettings.promptModeOverride', "Override");
		this._overrideBtn.setAttribute('role', 'radio');
		this._overrideBtn.title = localize('locopilotSettings.promptModeOverrideTitle', "Write your own system prompt.");

		this._register(DOM.addDisposableListener(this._defaultBtn, 'click', () => this._set(true, true)));
		this._register(DOM.addDisposableListener(this._overrideBtn, 'click', () => this._set(false, true)));
		this._update();
	}

	get domNode(): HTMLElement { return this._domNode; }
	get checked(): boolean { return this._checked; }
	set checked(value: boolean) { this._set(value, false); }

	private _set(value: boolean, fire: boolean): void {
		if (this._checked === value) { return; }
		this._checked = value;
		this._update();
		if (fire) { this._onChange.fire(value); }
	}

	private _update(): void {
		this._defaultBtn.classList.toggle('selected', this._checked);
		this._defaultBtn.setAttribute('aria-checked', String(this._checked));
		this._overrideBtn.classList.toggle('selected', !this._checked);
		this._overrideBtn.setAttribute('aria-checked', String(!this._checked));
	}
}

export class LoCoPilotSettingsEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.locopilotSettings';

	private container: HTMLElement | undefined;
	private tabBar: HTMLElement | undefined;
	private tabButtons = new Map<string, HTMLElement>();
	private headerContainer!: HTMLElement;
	private contentsContainer!: HTMLElement;

	private addModelsPanel!: HTMLElement;
	private listModelsPanel!: HTMLElement;
	private listModelsContainer!: HTMLElement;
	private agentSettingsPanel!: HTMLElement;
	private modelSearchQuery: string = '';
	/**
	 * Model to pin at the very top of the list (above running models) - set when the user clicks a
	 * "Download" link in the chat panel so the just-started download is the first thing they see,
	 * without filtering the list down to a single search result. Cleared by {@link resetModelFilters}.
	 */
	private pinnedModelId: string | undefined = undefined;
	private modelTypeFilter: 'all' | 'local' | 'cloud' = 'all';
	private modelStatusFilter: 'all' | 'downloaded' | 'not-downloaded' = 'all';
	private modelVisibilityFilter: 'all' | 'shown' | 'hidden' = 'all';
	/** "Best for you" filter: when 'best', show only catalog models that fit this machine's RAM/engine. */
	private modelBestFilter: 'all' | 'best' = 'all';
	private modelToolsFilter: boolean = false;
	private modelMtpFilter: boolean = false;
	/** Parameter-count range filter (billions). Undefined means "all sizes" - no constraint applied. */
	private modelParamsFilter: { min: number; max: number } | undefined = undefined;
	/**
	 * Whether the collapsed "too large for this system" group is expanded. Models that need more memory
	 * than this machine has are tucked below a "Show N more" button so low-end systems don't scroll past
	 * a wall of models they can't run - the full catalog is one click away. Reset to false (collapsed)
	 * every time the user (re-)enters the model list via {@link resetModelFilters}.
	 */
	private modelsIncompatibleExpanded: boolean = false;

	// Add Language Model form
	/** Cloud / Local segmented control buttons (index 0 = Cloud, 1 = Local). */
	private addFormModelTypeSegments: HTMLElement[] = [];
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
	private addFormContextWindowInput!: InputBox;
	private addFormUseNativeToolsToggle!: Toggle;
	private addFormUseNativeToolsContainer!: HTMLElement;
	private addFormMtpToggle!: Toggle;
	private addFormMtpContainer!: HTMLElement;
	private addFormVisionToggle!: Toggle;
	private addFormVisionContainer!: HTMLElement;
	private addFormHfFastestToggle!: Toggle;
	private addFormHfFastestContainer!: HTMLElement;
	private addFormAddButton!: Button;
	private addFormResetButton!: Button;
	private addFormCurrentModelType: 'cloud' | 'local' = 'local';
	private addFormCurrentProviderIndex: number = 0;

	private static readonly DEFAULT_CONTEXT_WINDOW = DEFAULT_CONTEXT_WINDOW_CLOUD;
	private static readonly LOCAL_DEFAULT_CONTEXT_WINDOW = DEFAULT_CONTEXT_WINDOW_LOCAL;
	private static readonly MIN_CONTEXT_WINDOW = MIN_CONTEXT_WINDOW;
	private static readonly MAX_CONTEXT_WINDOW = MAX_CONTEXT_WINDOW;
	/** Compact width for token fields (hover shows full value). */
	private static readonly TOKEN_LIMIT_INPUT_WIDTH_PX = 80;

	private askPromptTextarea!: HTMLTextAreaElement;
	private agentPromptTextarea!: HTMLTextAreaElement;
	private planPromptTextarea!: HTMLTextAreaElement;
	private agentPromptFormattedView!: HTMLElement;
	private askPromptFormattedView!: HTMLElement;
	private planPromptFormattedView!: HTMLElement;
	private agentPromptFormattedRendered: { dispose(): void } | undefined;
	private askPromptFormattedRendered: { dispose(): void } | undefined;
	private planPromptFormattedRendered: { dispose(): void } | undefined;
	private askCodingSystemPromptToggle!: PromptModeControl;
	private agentCodingSystemPromptToggle!: PromptModeControl;
	private planCodingSystemPromptToggle!: PromptModeControl;
	/** Inline validation hint shown under the max-iterations input. */
	private maxIterationsHint!: HTMLElement;
	/** "Unsaved changes" indicator in the sticky footer. */
	private agentSettingsDirtyIndicator!: HTMLElement;
	private agentSettingsSaveBtn!: Button;
	private agentSettingsCancelBtn!: Button;
	private agentSettingsBaseline: {
		maxIterations: number;
		autoRunSandbox: boolean;
		braveApiKey: string;
		askCoding: boolean;
		agentCoding: boolean;
		planCoding: boolean;
		askPrompt: string;
		agentPrompt: string;
		planPrompt: string;
		workspaceInstructions: string;
	} | undefined;
	private maxIterationsInput!: InputBox;
	private autoRunCommandsInSandboxToggle!: Toggle;
	private braveApiKeyInput!: InputBox;
	// [engine-ui] private engineSelectBox!: SelectBox;
	/** Phase 3: per-workspace ("this project only") agent instructions. */
	private workspaceInstructionsTextarea!: HTMLTextAreaElement;
	private agentSettingsService!: ILoCoPilotAgentSettingsService;
	private customLanguageModelsService!: ICustomLanguageModelsService;
	private localModelRunner!: ILoCoPilotLocalModelRunner;

	private dimension: Dimension | undefined;
	private selectedSection: string = LOCOPILOT_SETTINGS_SECTION_LIST_MODELS;
	private sections: SectionItem[] = [];

	private currentLogsModelId: string | undefined;
	private logsBackdropEl: HTMLElement | undefined;
	private logsOverlayEl: HTMLElement | undefined;
	private logsTitleEl: HTMLElement | undefined;
	private logsSubtitleEl: HTMLElement | undefined;
	private logsBadgeEl: HTMLElement | undefined;
	private logsBodyEl: HTMLElement | undefined;
	private logsFooterInfoEl: HTMLElement | undefined;
	private logsErrorStatEl: HTMLElement | undefined;
	private logsWarnStatEl: HTMLElement | undefined;
	private logsCopyBtn: HTMLElement | undefined;
	private logsCopyLabel: HTMLElement | undefined;
	private logsSearchInput: HTMLInputElement | undefined;
	private logsJumpBtn: HTMLElement | undefined;
	private logsAutoScroll: boolean = true;
	private logsFilterText: string = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ILoCoPilotAgentSettingsService agentSettingsService: ILoCoPilotAgentSettingsService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICustomLanguageModelsService customLanguageModelsService: ICustomLanguageModelsService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@ILoCoPilotLocalModelRunner localModelRunner: ILoCoPilotLocalModelRunner,
		@ILoCoPilotProjectMemoryService private readonly projectMemoryService: ILoCoPilotProjectMemoryService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ITimerService private readonly timerService: ITimerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(LoCoPilotSettingsEditor.ID, group, telemetryService, themeService, storageService);
		this.agentSettingsService = agentSettingsService;
		this.customLanguageModelsService = customLanguageModelsService;
		this.localModelRunner = localModelRunner;
		this.primeHardwareDetection();

		this._register(this.localModelRunner.onDidServerStateChange((modelId) => {
			this.renderListModels();
			if (!this.localModelRunner.isServerRunning(modelId) && this.currentLogsModelId === modelId) {
				this._hideLogsOverlay();
			}
		}));
		this._register(this.localModelRunner.onDidServerStartFailed(() => {
			// The failure is surfaced to the user by a toast (see the runner). The list just needs to drop the
			// "Starting..." spinner and fall back to the plain "Start server" button - no distinct error/Retry
			// state - so re-render.
			this.renderListModels();
		}));
		this._register(this.localModelRunner.onDidLogUpdate((modelId) => {
			if (this.currentLogsModelId === modelId && this.logsBodyEl) {
				this._appendLogsLine(this.localModelRunner.getServerLogs(modelId));
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, $('.locopilot-settings-editor'));

		this.renderHeader(this.container);

		this.renderTabs(this.container);

		const contentsView = DOM.append(this.container, $('.contents-view'));
		this.contentsContainer = DOM.append(contentsView, $('.contents-container'));

		this.renderContents(this.contentsContainer);
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

	private renderTabs(parent: HTMLElement): void {
		this.sections = [
			{ id: LOCOPILOT_SETTINGS_SECTION_ADD_MODEL, label: localize('locopilotSettings.addModel', "Add Model"), icon: Codicon.add, description: localize('locopilotSettings.addModel.desc', "Connect a new local model") },
			{ id: LOCOPILOT_SETTINGS_SECTION_LIST_MODELS, label: localize('locopilotSettings.myModels', "My Models"), icon: Codicon.layers, description: localize('locopilotSettings.myModels.desc', "Manage installed models") },
			{ id: LOCOPILOT_SETTINGS_SECTION_AGENT_SETTINGS, label: localize('locopilotSettings.agentSettings', "Agent Settings"), icon: Codicon.settingsGear, description: localize('locopilotSettings.agentSettings.desc', "Prompts & behavior") },
		];

		this.tabBar = DOM.append(parent, $('.locopilot-settings-tabs'));
		this.tabBar.setAttribute('role', 'tablist');
		this.tabBar.setAttribute('aria-label', localize('locopilotSettingsSectionsAriaLabel', "LoCoPilot Settings Sections"));

		this.tabButtons.clear();
		for (const section of this.sections) {
			const tab = DOM.append(this.tabBar, $('button.locopilot-settings-tab'));
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-label', section.label);
			tab.title = section.description ?? section.label;

			const icon = DOM.append(tab, $('.locopilot-settings-tab-icon'));
			icon.appendChild(renderIcon(section.icon));
			const text = DOM.append(tab, $('.locopilot-settings-tab-text'));
			const label = DOM.append(text, $('.locopilot-settings-tab-label'));
			label.textContent = section.label;
			if (section.description) {
				const description = DOM.append(text, $('.locopilot-settings-tab-description'));
				description.textContent = section.description;
			}

			this._register(DOM.addDisposableListener(tab, 'click', () => this.selectTab(section.id)));
			this.tabButtons.set(section.id, tab);
		}

		this.updateTabSelection();
	}

	/** User clicked a tab: run the section's reset hooks (matching the old sidebar behavior) and switch. */
	private selectTab(newSection: string): void {
		const previousSection = this.selectedSection;
		if (newSection === previousSection) {
			return;
		}
		this.selectedSection = newSection;
		if (newSection === LOCOPILOT_SETTINGS_SECTION_ADD_MODEL && previousSection !== LOCOPILOT_SETTINGS_SECTION_ADD_MODEL) {
			this.resetAddModelFormToDefaults();
		}
		if (newSection === LOCOPILOT_SETTINGS_SECTION_LIST_MODELS && previousSection !== LOCOPILOT_SETTINGS_SECTION_LIST_MODELS) {
			this.resetModelFilters();
		}
		this.updateTabSelection();
		this.renderSelectedSection();
	}

	/** Reflect this.selectedSection onto the tab buttons' active state. */
	private updateTabSelection(): void {
		for (const [id, tab] of this.tabButtons) {
			const active = id === this.selectedSection;
			tab.classList.toggle('active', active);
			tab.setAttribute('aria-selected', active ? 'true' : 'false');
			tab.tabIndex = active ? 0 : -1;
		}
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

		// Logs modal - a floating, centered popup with a dimmed backdrop, appended to the editor
		// root so it overlays the whole settings surface instead of living inside the list panel.
		this._createLogsModal();

		// Agent Settings - system prompts + max iteration
		this.agentSettingsPanel = DOM.append(bodyContainer, $('.locopilot-settings-panel.agent-settings-panel'));
		this.renderAgentSettings(this.agentSettingsPanel);

		this.renderSelectedSection();
	}

	private renderAddModelForm(container: HTMLElement): void {
		const wrapper = DOM.append(container, $('.add-custom-model-editor'));
		const formContainer = DOM.append(wrapper, $('.add-custom-model-form'));

		const title = DOM.append(formContainer, $('h2.form-title'));
		title.textContent = localize('addCustomModel.title', 'Add Model');
		const subtitle = DOM.append(formContainer, $('.form-subtitle'));
		subtitle.textContent = localize('addCustomModel.subtitle', "Connect a cloud provider with an API key, or add a local model to download and run on this machine.");

		const card = DOM.append(formContainer, $('.add-model-card'));

		const modelTypeContainer = DOM.append(card, $('.form-field'));
		const modelTypeLabel = DOM.append(modelTypeContainer, $('label.form-label'));
		modelTypeLabel.textContent = localize('addCustomModel.modelType', 'Model Type');
		const segmented = DOM.append(modelTypeContainer, $('.segmented-control'));
		segmented.setAttribute('role', 'radiogroup');
		segmented.setAttribute('aria-label', localize('addCustomModel.modelType', 'Model Type'));
		const segmentLabels = [localize('addCustomModel.local', 'Local'), localize('addCustomModel.cloud', 'Cloud')];
		this.addFormModelTypeSegments = segmentLabels.map((text, index) => {
			const seg = DOM.append(segmented, $('button.segment'));
			seg.textContent = text;
			seg.setAttribute('role', 'radio');
			this._register(DOM.addDisposableListener(seg, 'click', () => this.selectModelTypeSegment(index, true)));
			return seg;
		});
		this.selectModelTypeSegment(0, false);

		const providerContainer = DOM.append(card, $('.form-field'));
		const providerLabel = DOM.append(providerContainer, $('label.form-label'));
		providerLabel.textContent = localize('addCustomModel.provider', 'Model Provider');
		const providerSelectContainer = DOM.append(providerContainer, $('.form-input-container'));
		this.addFormProviderSelectBox = this._register(new SelectBox(LOCAL_PROVIDERS_ADD, 0, this.contextViewService, locopilotSettingsSelectBoxStyles));
		this.addFormProviderSelectBox.render(providerSelectContainer);
		this._register(this.addFormProviderSelectBox.onDidSelect((e: ISelectData) => {
			this.addFormCurrentProviderIndex = e.index;
			this.addFormUpdateInputFields();
		}));

		const apiKeyContainer = DOM.append(card, $('.form-field'));
		const apiKeyLabel = DOM.append(apiKeyContainer, $('label.form-label'));
		apiKeyLabel.textContent = localize('addCustomModel.apiKey', 'API Key');
		const apiKeyInputContainer = DOM.append(apiKeyContainer, $('.form-input-container'));
		this.addFormApiKeyInputBox = this._register(new InputBox(apiKeyInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.apiKeyPlaceholder', 'Enter your API key'),
			type: 'password',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		const tokenContainer = DOM.append(card, $('.form-field'));
		tokenContainer.style.display = 'none';
		this.addFormTokenLabel = DOM.append(tokenContainer, $('label.form-label'));
		this.addFormTokenLabel.textContent = localize('addCustomModel.token', 'Token (Optional)');
		const tokenInputContainer = DOM.append(tokenContainer, $('.form-input-container'));
		this.addFormTokenInputBox = this._register(new InputBox(tokenInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.tokenPlaceholder', 'Enter your token (e.g., HuggingFace token)'),
			type: 'password',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		this.addFormModelFormatContainer = DOM.append(card, $('.form-field'));
		this.addFormModelFormatContainer.style.display = 'none';
		const formatLabel = DOM.append(this.addFormModelFormatContainer, $('label.form-label'));
		formatLabel.textContent = localize('addCustomModel.modelFormat', 'Model Format');
		const formatInputContainer = DOM.append(this.addFormModelFormatContainer, $('.form-input-container'));
		this.addFormModelFormatInputBox = this._register(new InputBox(formatInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.modelFormatPlaceholder', 'e.g., GGUF, Q4_K_M, Safetensors'),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		const modelNameContainer = DOM.append(card, $('.form-field'));
		this.addFormModelNameLabel = DOM.append(modelNameContainer, $('label.form-label'));
		this.addFormModelNameLabel.textContent = localize('addCustomModel.modelName', 'Model Name');
		const modelNameInputContainer = DOM.append(modelNameContainer, $('.form-input-container'));
		this.addFormModelNameInputBox = this._register(new InputBox(modelNameInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.modelNamePlaceholder', 'e.g., gpt-4, claude-3-opus, llama-2-7b'),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		// Localhost only: required OpenAI `model` string (e.g. from GET /v1/models)
		this.addFormLocalhostModelIdContainer = DOM.append(card, $('.form-field'));
		this.addFormLocalhostModelIdContainer.style.display = 'none';
		const localhostModelIdLabel = DOM.append(this.addFormLocalhostModelIdContainer, $('label.form-label'));
		localhostModelIdLabel.textContent = localize('addCustomModel.localhostServerModelId', 'Server model id');
		const localhostModelIdInputContainer = DOM.append(this.addFormLocalhostModelIdContainer, $('.form-input-container'));
		this.addFormLocalhostModelIdInputBox = this._register(new InputBox(localhostModelIdInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.localhostServerModelIdPlaceholder', 'e.g. Qwen/Qwen3-4B-MLX-4bit (JSON body "model" field)'),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		this.addFormDisplayNameContainer = DOM.append(card, $('.form-field'));
		const displayNameLabel = DOM.append(this.addFormDisplayNameContainer, $('label.form-label'));
		displayNameLabel.textContent = localize('addCustomModel.displayNameOptional', 'Display name (optional)');
		const displayNameInputContainer = DOM.append(this.addFormDisplayNameContainer, $('.form-input-container'));
		this.addFormDisplayNameInputBox = this._register(new InputBox(displayNameInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.displayNamePlaceholder', 'Shown in the model list and Auto dropdown; must be unique if set'),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));

		// Context window is auto-derived from HF/Ollama after download (or service default), and overridden
		// from the model list - so it is not collected on the Add form. The widget is kept (hidden) to avoid
		// churn in the form-state helpers that still reference it.
		const contextWindowRow = DOM.append(card, $('.form-field.form-field-tokens'));
		contextWindowRow.style.display = 'none';
		const contextWindowLabel = DOM.append(contextWindowRow, $('label.form-label'));
		contextWindowLabel.textContent = localize('addCustomModel.contextWindow', 'Context window');
		const contextWindowWrap = DOM.append(contextWindowRow, $('.form-input-with-suffix'));
		const contextWindowInputContainer = DOM.append(contextWindowWrap, $('.form-input-container'));
		this.addFormContextWindowInput = this._register(new InputBox(contextWindowInputContainer, this.contextViewService, {
			placeholder: String(LoCoPilotSettingsEditor.DEFAULT_CONTEXT_WINDOW),
			tooltip: '',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		this.addFormContextWindowInput.element.style.minWidth = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		this.addFormContextWindowInput.element.style.width = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		this.addFormContextWindowInput.value = String(LoCoPilotSettingsEditor.DEFAULT_CONTEXT_WINDOW);
		this.syncAddFormContextWindowTooltip();
		this._register(this.addFormContextWindowInput.onDidChange(() => this.syncAddFormContextWindowTooltip()));

		// Use Native Tools toggle (for local models)
		this.addFormUseNativeToolsContainer = DOM.append(card, $('.form-field'));
		this.addFormUseNativeToolsContainer.style.display = 'none';
		const useNativeToolsLabel = DOM.append(this.addFormUseNativeToolsContainer, $('label.form-label'));
		useNativeToolsLabel.textContent = localize('addCustomModel.useNativeTools', 'Tools');
		const useNativeToolsToggleContainer = DOM.append(this.addFormUseNativeToolsContainer, $('.form-input-container.agent-setting-switch-wrap'));
		this.addFormUseNativeToolsToggle = this._register(new Toggle({
			title: localize('addCustomModel.useNativeToolsDescription', 'When on, use the model\'s native tool calling capability. When off, tools are injected into the system prompt. Default: on.'),
			isChecked: true,
			...defaultToggleStyles
		}));
		DOM.append(useNativeToolsToggleContainer, this.addFormUseNativeToolsToggle.domNode);

		// Multi-Token Prediction toggle (llama.cpp GGUF models only)
		this.addFormMtpContainer = DOM.append(card, $('.form-field'));
		this.addFormMtpContainer.style.display = 'none';
		const mtpLabel = DOM.append(this.addFormMtpContainer, $('label.form-label'));
		mtpLabel.textContent = localize('addCustomModel.mtp', 'Multi-Token Prediction');
		const mtpToggleContainer = DOM.append(this.addFormMtpContainer, $('.form-input-container.agent-setting-switch-wrap'));
		this.addFormMtpToggle = this._register(new Toggle({
			title: localize('addCustomModel.mtpDescription', 'Speculative decoding via the model\'s own Multi-Token Prediction heads (faster). Only enable for MTP-trained models (e.g. Qwen3.5/3.6, DeepSeek V3/R1, Gemma 4) on a recent llama.cpp build; other models will fail to start. Default: off.'),
			isChecked: false,
			...defaultToggleStyles
		}));
		DOM.append(mtpToggleContainer, this.addFormMtpToggle.domNode);

		// Vision toggle (local models): whether the model can read image attachments. Shown for local providers
		// so the user can declare a multimodal model up front. Auto-detection (HF/Ollama) and the runtime
		// auto-disable can still refine this; the My Models toggle lets it be changed later.
		this.addFormVisionContainer = DOM.append(card, $('.form-field'));
		this.addFormVisionContainer.style.display = 'none';
		const visionLabel = DOM.append(this.addFormVisionContainer, $('label.form-label'));
		visionLabel.textContent = localize('addCustomModel.vision', 'Vision (image input)');
		const visionToggleContainer = DOM.append(this.addFormVisionContainer, $('.form-input-container.agent-setting-switch-wrap'));
		this.addFormVisionToggle = this._register(new Toggle({
			title: localize('addCustomModel.visionDescription', 'Turn on only for multimodal models that can read images. If the model can\'t actually process an image, vision is turned off automatically. Default: off.'),
			isChecked: false,
			...defaultToggleStyles
		}));
		DOM.append(visionToggleContainer, this.addFormVisionToggle.domNode);

		// HF cloud routing toggle (shown only for Hugging Face cloud): on = cheapest, off = fastest
		this.addFormHfFastestContainer = DOM.append(card, $('.form-field'));
		this.addFormHfFastestContainer.style.display = 'none';
		const hfFastestLabel = DOM.append(this.addFormHfFastestContainer, $('label.form-label'));
		hfFastestLabel.textContent = localize('addCustomModel.hfCheapest', 'Cheapest');
		const hfFastestToggleContainer = DOM.append(this.addFormHfFastestContainer, $('.form-input-container.agent-setting-switch-wrap'));
		this.addFormHfFastestToggle = this._register(new Toggle({
			title: localize('addCustomModel.hfCheapestDescription', 'On = route to the cheapest available provider; Off = route to the fastest available provider. HF controls the actual routing.'),
			isChecked: true,
			...defaultToggleStyles
		}));
		DOM.append(hfFastestToggleContainer, this.addFormHfFastestToggle.domNode);

		const buttonContainer = DOM.append(formContainer, $('.form-actions'));
		this.addFormResetButton = this._register(new Button(buttonContainer, { ...defaultButtonStyles, secondary: true }));
		this.addFormResetButton.label = localize('addCustomModel.reset', 'Reset');
		this.addFormResetButton.element.title = localize('addCustomModel.resetTitle', 'Clear all fields and reset the form to defaults');
		this._register(this.addFormResetButton.onDidClick(() => this.resetAddModelFormToDefaults()));
		this.addFormAddButton = this._register(new Button(buttonContainer, { ...defaultButtonStyles }));
		this.addFormAddButton.label = localize('addCustomModel.add', 'Add Model');
		this._register(this.addFormAddButton.onDidClick(() => this.handleAddModel()));
		this.addFormUpdateModelNameLabel();
	}

	private contextWindowTooltip(value: string): string {
		return localize('customLanguageModels.contextWindowTooltipWithValue', 'Context window: {0} tokens. Input and output budgets are derived from this.', value);
	}

	private syncAddFormContextWindowTooltip(): void {
		this.addFormContextWindowInput.setTooltip(this.contextWindowTooltip(this.addFormContextWindowInput.value));
	}

	/** Cloud + first provider, cleared fields, default token limits - use when (re)entering the Add Language Model section. */
	private resetAddModelFormToDefaults(): void {
		this.selectModelTypeSegment(0, false);
		this.addFormUpdateProviderOptions();
		this.addFormModelNameInputBox.value = '';
		this.addFormDisplayNameInputBox.value = '';
		this.addFormLocalhostModelIdInputBox.value = '';
		this.addFormApiKeyInputBox.value = '';
		this.addFormTokenInputBox.value = '';
		this.addFormModelFormatInputBox.value = '';
		this.addFormUseNativeToolsToggle.checked = false;
		this.addFormMtpToggle.checked = false;
		this.addFormVisionToggle.checked = false;
		this.addFormUpdateInputFields();
	}

	/** Selects the Local (0) / Cloud (1) segment, updating the active style and dependent fields. */
	private selectModelTypeSegment(index: number, fireChange: boolean): void {
		this.addFormModelTypeSegments.forEach((seg, i) => {
			seg.classList.toggle('active', i === index);
			seg.setAttribute('aria-checked', String(i === index));
		});
		this.addFormCurrentModelType = index === 0 ? 'local' : 'cloud';
		this.addFormCurrentProviderIndex = 0;
		if (fireChange) {
			this.addFormUpdateProviderOptions();
			this.addFormUpdateInputFields();
		}
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
		const isHfCloud = this.addFormCurrentModelType === 'cloud' && provider.text === 'Hugging Face';
		if (this.addFormLocalhostModelIdContainer) {
			this.addFormLocalhostModelIdContainer.style.display = isLocalhost ? '' : 'none';
		}
		if (this.addFormCurrentModelType === 'cloud') {
			if (apiKeyContainer) { apiKeyContainer.style.display = ''; }
			if (tokenContainer) { tokenContainer.style.display = 'none'; }
			if (this.addFormModelFormatContainer) { this.addFormModelFormatContainer.style.display = 'none'; }
			// Tools / MTP / context window are auto-derived or overridden from the model list, never on the Add form.
			if (this.addFormUseNativeToolsContainer) { this.addFormUseNativeToolsContainer.style.display = 'none'; }
			if (this.addFormMtpContainer) { this.addFormMtpContainer.style.display = 'none'; }
			// Vision is a cloud-model capability we leave to the provider's own metadata, so hide it for cloud.
			if (this.addFormVisionContainer) { this.addFormVisionContainer.style.display = 'none'; }
			if (this.addFormHfFastestContainer) { this.addFormHfFastestContainer.style.display = isHfCloud ? '' : 'none'; }
			// Reset HF cloud routing toggle to its default (cheapest on) when HF cloud is selected.
			if (isHfCloud && this.addFormHfFastestToggle) { this.addFormHfFastestToggle.checked = true; }
			this.addFormContextWindowInput.value = String(LoCoPilotSettingsEditor.DEFAULT_CONTEXT_WINDOW);
		} else {
			if (this.addFormHfFastestContainer) { this.addFormHfFastestContainer.style.display = 'none'; }
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
			// Format / Tools / MTP / context window are auto-derived (HF/Ollama) or overridden from the model list,
			// so none are collected on the Add form for local providers either.
			if (this.addFormModelFormatContainer) { this.addFormModelFormatContainer.style.display = 'none'; }
			if (this.addFormUseNativeToolsContainer) { this.addFormUseNativeToolsContainer.style.display = 'none'; }
			if (this.addFormMtpContainer) { this.addFormMtpContainer.style.display = 'none'; }
			// Vision toggle is shown for all local providers so the user can declare a multimodal model up front.
			if (this.addFormVisionContainer) { this.addFormVisionContainer.style.display = ''; }
			// All local providers (HuggingFace, Ollama, Localhost) default to the smaller local context window.
			this.addFormContextWindowInput.value = String(LoCoPilotSettingsEditor.LOCAL_DEFAULT_CONTEXT_WINDOW);
		}
		this.syncAddFormContextWindowTooltip();
		this.addFormUpdateModelNameLabel();
	}

	private addFormUpdateModelNameLabel(): void {
		if (!this.addFormModelNameLabel) { return; }
		const providers = this.addFormCurrentModelType === 'cloud' ? CLOUD_PROVIDERS_ADD : LOCAL_PROVIDERS_ADD;
		const provider = providers[this.addFormCurrentProviderIndex];
		const isLocalhost = this.addFormCurrentModelType === 'local' && provider.text.toLowerCase() === 'localhost';
		const isHuggingFace = this.addFormCurrentModelType === 'local' && provider.text.toLowerCase() === 'huggingface';
		const isOllama = this.addFormCurrentModelType === 'local' && provider.text.toLowerCase() === 'ollama';
		const isHfCloud = this.addFormCurrentModelType === 'cloud' && provider.text === 'Hugging Face';
		if (isHfCloud) {
			this.addFormModelNameLabel.textContent = localize('addCustomModel.modelName', 'Model Name');
			this.addFormModelNameInputBox.setPlaceHolder(localize('addCustomModel.modelNamePlaceholderHfCloud', 'e.g., meta-llama/Llama-3.3-70B-Instruct'));
		} else if (isLocalhost) {
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

	/** Validate and parse the context window (raw number, or with K suffix e.g. 128K). Rejects empty, non-numeric, negative, non-integer, out of range. */
	private parseContextWindow(inputValue: string): { valid: true; value: number } | { valid: false; error: string } {
		const s = inputValue.trim();
		if (s === '') {
			return { valid: false, error: localize('addCustomModel.error.contextWindowRequired', 'Context window is required.') };
		}
		const hasK = /k$/i.test(s);
		const numStr = s.replace(/[kK]/g, '').trim();
		const n = Number(numStr);
		if (Number.isNaN(n)) {
			return { valid: false, error: localize('addCustomModel.error.contextWindowInvalid', 'Context window must be a valid number (e.g. 128000 or 128K).') };
		}
		if (!Number.isInteger(n) || n < 0) {
			return { valid: false, error: localize('addCustomModel.error.contextWindowPositiveInteger', 'Context window must be a positive integer.') };
		}
		const value = hasK ? n * 1000 : n;
		if (value < LoCoPilotSettingsEditor.MIN_CONTEXT_WINDOW || value > LoCoPilotSettingsEditor.MAX_CONTEXT_WINDOW) {
			return { valid: false, error: localize('addCustomModel.error.contextWindowRange', 'Context window must be between {0} and {1}.', LoCoPilotSettingsEditor.MIN_CONTEXT_WINDOW, LoCoPilotSettingsEditor.MAX_CONTEXT_WINDOW) };
		}
		return { valid: true, value };
	}

	private async handleAddModel(): Promise<void> {
		const providers = this.addFormCurrentModelType === 'cloud' ? CLOUD_PROVIDERS_ADD : LOCAL_PROVIDERS_ADD;
		const provider = providers[this.addFormCurrentProviderIndex];
		const isHfCloud = this.addFormCurrentModelType === 'cloud' && provider.text === 'Hugging Face';
		// Use distinct id for cloud HF so it doesn't collide with local 'huggingface' (GGUF/MLX)
		const providerValue = isHfCloud ? 'huggingface-cloud' : provider.text.toLowerCase().replace(/\s+/g, '');
		const isLocalhost = providerValue === 'localhost';
		const modelName = this.addFormModelNameInputBox.value.trim();
		const apiKey = this.addFormCurrentModelType === 'cloud' ? this.addFormApiKeyInputBox.value.trim() : undefined;
		const token = (this.addFormCurrentModelType === 'local' && !isLocalhost) ? this.addFormTokenInputBox.value.trim() : undefined;

		// For Ollama, token field holds the Base URL
		const ollamaUrl = (providerValue === 'ollama' && token) ? token : 'http://localhost:11434';

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
				// format / contextWindow / useNativeTools / mtp are intentionally omitted here: they are
				// auto-derived from HuggingFace/Ollama after download (see applyDerivedMetadata) and otherwise
				// fall back to service defaults. The user can override any of them from the model list.
				modelName: modelName,
				localhostOpenAiModel: isLocalhost ? localhostServerModelId : undefined,
				localPath: providerValue === 'ollama' ? ollamaUrl : undefined, // Store Base URL in localPath for Ollama
				hfFastest: isHfCloud ? !this.addFormHfFastestToggle.checked : undefined,
				// Vision is collected for local models only (cloud relies on provider metadata). A confirmed
				// HF/Ollama capability can still refine this after download; the My Models toggle can change it.
				// Ticking it on add is explicit intent to use images, so enable runtime loading too (visionEnabled),
				// not just the capability - otherwise the projector would download but never load.
				supportsVision: this.addFormCurrentModelType === 'local' ? this.addFormVisionToggle.checked : undefined,
				visionEnabled: this.addFormCurrentModelType === 'local' && this.addFormVisionToggle.checked ? true : undefined,
			});
			const listLabel = getCustomModelListLabel(addedModel);

			if (providerValue === 'huggingface' || providerValue === 'ollama') {
				// Start download process (runs in background; progress updates re-render the list)
				this.commandService.executeCommand('locopilot.downloadModel', addedModel.id);
				// Switch to Language Models list so user sees the model tile with download progress
				this.selectedSection = LOCOPILOT_SETTINGS_SECTION_LIST_MODELS;
				this.updateTabSelection();
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
		const savedScroll = this.contentsContainer?.scrollTop ?? 0;
		// Track whether the search input had focus so we can restore it after re-render
		const activeEl = DOM.getActiveWindow().document.activeElement;
		const searchWasFocused = this.listModelsContainer.contains(activeEl) &&
			(activeEl as HTMLElement)?.classList?.contains('models-search-input');
		DOM.clearNode(this.listModelsContainer);
		const allModels = this.customLanguageModelsService.getCustomModels();
		if (allModels.length === 0) {
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

		// Sticky top bar: title + search + filters
		const stickyTop = DOM.append(this.listModelsContainer, $('.models-list-sticky-top'));
		const title = DOM.append(stickyTop, $('h2.models-list-title'));
		title.textContent = localize('customLanguageModels.list.title', 'My Models');
		const searchWrap = DOM.append(stickyTop, $('.models-search-wrap'));
		const searchInput = DOM.append(searchWrap, $('input.models-search-input')) as HTMLInputElement;
		searchInput.type = 'text';
		searchInput.placeholder = localize('customLanguageModels.search.placeholder', 'Search by name, provider...');
		searchInput.value = this.modelSearchQuery;
		searchInput.addEventListener('input', () => {
			this.modelSearchQuery = searchInput.value;
			this.renderListModels();
		});
		if (searchWasFocused) { searchInput.focus(); }

		// Filters row: fieldset/legend dropdowns (label cuts the border) + toggle filters
		const filtersRow = DOM.append(stickyTop, $('.models-filters-row'));

		// Dropdown filter using <fieldset>/<legend> so the label natively cuts the top border
		const makeDropdownFilter = (labelText: string, options: { label: string; value: string }[], current: string, onSelect: (v: string) => void) => {
			const fieldset = DOM.append(filtersRow, $('fieldset.models-filter'));
			const legend = DOM.append(fieldset, $('legend.models-filter-label'));
			legend.textContent = labelText;
			const select = DOM.append(fieldset, $('select.models-filter-select')) as HTMLSelectElement;
			select.setAttribute('aria-label', labelText);
			for (const opt of options) {
				const optionEl = DOM.append(select, $('option')) as HTMLOptionElement;
				optionEl.value = opt.value;
				optionEl.textContent = opt.label;
				if (opt.value === current) { optionEl.selected = true; }
			}
			select.value = current;
			select.addEventListener('change', () => {
				onSelect(select.value);
				this.renderListModels();
			});
		};

		// Toggle filter using <fieldset>/<legend> - same border-cut label, toggle switch inside.
		// Currently unused: the Tools and MTP toggle filters are commented out below.
		// const makeToggleFilter = (labelText: string, checked: boolean, onToggle: (v: boolean) => void) => {
		// 	const fieldset = DOM.append(filtersRow, $('fieldset.models-filter'));
		// 	const legend = DOM.append(fieldset, $('legend.models-filter-label'));
		// 	legend.textContent = labelText;
		// 	const track = DOM.append(fieldset, $('label.models-filter-toggle-track'));
		// 	const checkbox = DOM.append(track, $('input.models-filter-toggle-input')) as HTMLInputElement;
		// 	checkbox.type = 'checkbox';
		// 	checkbox.checked = checked;
		// 	DOM.append(track, $('span.models-filter-toggle-thumb'));
		// 	checkbox.addEventListener('change', () => {
		// 		onToggle(checkbox.checked);
		// 		this.renderListModels();
		// 	});
		// };

		makeDropdownFilter(
			localize('customLanguageModels.filter.typeLabel', 'Type'),
			[
				{ label: localize('customLanguageModels.filter.all', 'All'), value: 'all' },
				{ label: localize('customLanguageModels.filter.local', 'Local'), value: 'local' },
				{ label: localize('customLanguageModels.filter.cloud', 'Cloud'), value: 'cloud' },
			],
			this.modelTypeFilter,
			(v) => { this.modelTypeFilter = v as 'all' | 'local' | 'cloud'; }
		);

		makeDropdownFilter(
			localize('customLanguageModels.filter.statusLabel', 'Status'),
			[
				{ label: localize('customLanguageModels.filter.statusAll', 'All'), value: 'all' },
				{ label: localize('customLanguageModels.filter.downloaded', 'Downloaded'), value: 'downloaded' },
				{ label: localize('customLanguageModels.filter.notDownloaded', 'Not downloaded'), value: 'not-downloaded' },
			],
			this.modelStatusFilter,
			(v) => { this.modelStatusFilter = v as 'all' | 'downloaded' | 'not-downloaded'; }
		);

		makeDropdownFilter(
			localize('customLanguageModels.filter.visibilityLabel', 'Visibility'),
			[
				{ label: localize('customLanguageModels.filter.visAll', 'All'), value: 'all' },
				{ label: localize('customLanguageModels.filter.shown', 'Shown'), value: 'shown' },
				{ label: localize('customLanguageModels.filter.hidden', 'Hidden'), value: 'hidden' },
			],
			this.modelVisibilityFilter,
			(v) => { this.modelVisibilityFilter = v as 'all' | 'shown' | 'hidden'; }
		);

		// "Best for you": filters to catalog models sized for the detected RAM / engine. Only useful
		// when we actually detected RAM - otherwise everything reads as "unknown" and the filter would
		// hide the whole list, so skip rendering it on machines where startup metrics gave us nothing.
		if (this.detectedRamGB() > 0) {
			makeDropdownFilter(
				localize('customLanguageModels.filter.bestLabel', 'Best for you'),
				[
					{ label: localize('customLanguageModels.filter.bestAll', 'All'), value: 'all' },
					{ label: localize('customLanguageModels.filter.bestOnly', 'Best for you'), value: 'best' },
				],
				this.modelBestFilter,
				(v) => { this.modelBestFilter = v as 'all' | 'best'; }
			);
		}

		// Parameters range slider, rendered on its own row below the dropdown filters.
		this.renderParamsRangeFilter(stickyTop, allModels);

		// makeToggleFilter(
		// 	localize('customLanguageModels.filter.toolsLabel', 'Tools'),
		// 	this.modelToolsFilter,
		// 	(v) => { this.modelToolsFilter = v; }
		// );

		// makeToggleFilter(
		// 	localize('customLanguageModels.filter.mtpLabel', 'MTP'),
		// 	this.modelMtpFilter,
		// 	(v) => { this.modelMtpFilter = v; }
		// );

		// Pin the section headers exactly below the sticky top bar. The bar's height varies (search +
		// three filter dropdowns may wrap on narrow widths), so measure it instead of hard-coding an
		// offset - otherwise list items peek through the gap, or the headers overlap, while scrolling.
		// The sticky bar uses top:-20px (it scrolls 20px up into the container padding before pinning),
		// so the headers stick at (barHeight - 20). The -1px forces a hairline overlap; the bar has the
		// higher z-index, so it covers the seam rather than leaving a sub-pixel gap.
		const stickyTopHeight = stickyTop.offsetHeight;
		const sectionHeaderTop = Math.max(0, stickyTopHeight - 21);
		this.listModelsContainer.style.setProperty('--models-section-header-top', `${sectionHeaderTop}px`);

		const q = this.modelSearchQuery.toLowerCase().trim();
		const isModelDownloaded = (m: ICustomLanguageModel): boolean => {
			return !!(m.localPath && !needsDownloadOrPullRetry(m) && !m.isDownloading);
		};
		const matchesFilters = (m: ICustomLanguageModel): boolean => {
			if (this.modelTypeFilter !== 'all' && m.type !== this.modelTypeFilter) { return false; }
			// "Downloaded" / "Not downloaded" are local-only concepts: cloud models have no weights to fetch,
			// so they belong to neither bucket. Exclude them from both status filters (they still show under
			// Status = All or the Type = Cloud filter).
			if (this.modelStatusFilter === 'downloaded' && (m.type === 'cloud' || !isModelDownloaded(m))) { return false; }
			if (this.modelStatusFilter === 'not-downloaded' && (m.type === 'cloud' || isModelDownloaded(m))) { return false; }
			if (this.modelVisibilityFilter === 'shown' && m.hidden) { return false; }
			if (this.modelVisibilityFilter === 'hidden' && !m.hidden) { return false; }
			if (this.modelBestFilter === 'best' && this.modelSuitability(m) !== 'best') { return false; }
			if (this.modelToolsFilter && !m.useNativeTools) { return false; }
			if (this.modelMtpFilter && !m.mtp) { return false; }
			// Parameter-count filter: only constrains models whose name carries a "<n>B" hint; others always pass.
			if (this.modelParamsFilter) {
				const params = parseModelParamsB(getCustomModelListLabel(m));
				if (params !== undefined && (params < this.modelParamsFilter.min || params > this.modelParamsFilter.max)) { return false; }
			}
			if (!q) { return true; }
			const label = getCustomModelListLabel(m).toLowerCase();
			return label.includes(q) || (m.provider || '').toLowerCase().includes(q) || (m.modelName || '').toLowerCase().includes(q) || (m.type || '').toLowerCase().includes(q);
		};

		const sortAZ = (a: ICustomLanguageModel, b: ICustomLanguageModel) =>
			getCustomModelListLabel(a).localeCompare(getCustomModelListLabel(b));

		// A model counts as "running" while its local server is starting up or already serving.
		const isRunning = (m: ICustomLanguageModel): boolean =>
			this.localModelRunner.isServerRunning(m.id) || this.localModelRunner.isServerStarting(m.id);

		// One flat list, ordered by "what the user most likely wants to touch". Rank buckets from the top:
		//   0. the pinned model (set when the user clicks a chat-panel "Download" link), so the
		//      just-started download is the first row they see;
		//   1. currently running/starting models;
		//   2. ready local models - HF weights on disk or a pulled Ollama model (the daemon auto-loads
		//      those on demand, so they are just as usable as a downloaded GGUF);
		//   3. ready cloud/localhost models - a cloud model with an API key, or an OpenAI-compatible
		//      localhost server (needs no key): zero load time, usable right now, but this is a
		//      local-first product so they sort below the downloaded local models;
		//   4. the single "Best for you" curated pick - the first not-yet-downloaded row, since it is
		//      literally our suggestion of what to get next;
		//   5. everything else (remaining catalog / custom models), largest parameter count first so the
		//      most capable model that fits this machine reads like a quality ranking;
		//   6. cloud models without an API key - "needs setup" items belong at the bottom.
		// A-Z is the final tiebreaker everywhere so the order stays stable and scannable.
		// (Visibility and "Best for you" are applied as filters in matchesFilters rather than as
		// separate sections, so there are no sticky section titles anymore - hidden models stay in
		// place, just dimmed via the .hidden row class.)
		const modelRank = (m: ICustomLanguageModel): number => {
			if (m.id === this.pinnedModelId) { return 0; }
			if (isRunning(m)) { return 1; }
			if (m.type === 'local' && m.provider !== 'localhost' && isModelDownloaded(m)) { return 2; }
			if (m.type === 'cloud' || m.provider === 'localhost') {
				return (m.apiKey || m.provider === 'localhost') ? 3 : 6;
			}
			if (this.isRecommendedForSystem(m)) { return 4; }
			return 5;
		};
		const matched = allModels.filter(matchesFilters);
		const sortedModels = matched.sort((a, b) => {
			const ra = modelRank(a);
			const rb = modelRank(b);
			if (ra !== rb) { return ra - rb; }
			if (ra === 5) {
				// Params descending; models without a "<n>B" size hint in their name sort after sized ones.
				const pa = parseModelParamsB(getCustomModelListLabel(a)) ?? -1;
				const pb = parseModelParamsB(getCustomModelListLabel(b)) ?? -1;
				if (pa !== pb) { return pb - pa; }
			}
			return sortAZ(a, b);
		});
		const hasActiveFilter = this.modelTypeFilter !== 'all' || this.modelStatusFilter !== 'all' || this.modelVisibilityFilter !== 'all' || this.modelBestFilter !== 'all' || this.modelToolsFilter || this.modelMtpFilter || !!this.modelParamsFilter;

		// A catalog model too large for this machine's RAM (or Apple-Silicon-only off Apple Silicon) is
		// "incompatible" and gets tucked into the collapsed group. A pinned model (a just-clicked download)
		// or a running server stays in the always-visible list even if oversized, so the user never loses
		// sight of the model they just acted on.
		const isCollapsibleIncompatible = (m: ICustomLanguageModel): boolean => {
			if (m.id === this.pinnedModelId || isRunning(m)) { return false; }
			const suitability = this.modelSuitability(m);
			return suitability === 'too-big' || suitability === 'incompatible';
		};

		const listContainer = DOM.append(this.listModelsContainer, $('.models-list-container'));
		if (sortedModels.length === 0) {
			const noResults = DOM.append(listContainer, $('.models-section-empty'));
			noResults.textContent = (q || hasActiveFilter)
				? localize('customLanguageModels.list.noMatch', 'No models match your search')
				: localize('customLanguageModels.list.none', 'No models');
		} else {
			const compatibleModels = sortedModels.filter(m => !isCollapsibleIncompatible(m));
			const incompatibleModels = sortedModels.filter(isCollapsibleIncompatible);
			compatibleModels.forEach((model: ICustomLanguageModel) => this.renderListModelItem(model, listContainer));
			if (incompatibleModels.length > 0) {
				this.renderIncompatibleModelsSection(incompatibleModels, listContainer);
			}
		}

		if (this.contentsContainer) { this.contentsContainer.scrollTop = savedScroll; }
	}

	private renderListModelItem(model: ICustomLanguageModel, listContainer: HTMLElement): void {
		const isOllama = model.provider === 'ollama';
		const itemContainer = DOM.append(listContainer, $('.model-item', { 'data-model-id': model.id }));
		if (model.hidden) { itemContainer.classList.add('hidden'); }

		// Row 1: left = model name, right = Run model / Server, Hide, Delete
		const row1 = DOM.append(itemContainer, $('.model-item-row.model-item-row1'));
		const nameLabel = DOM.append(row1, $('.model-name'));
		const nameText = DOM.append(nameLabel, $('span.model-name-text'));
		nameText.textContent = getCustomModelListLabel(model);
		// The single "Best for you" recommendation gets a double-tick after the name; hovering it explains why.
		if (this.isRecommendedForSystem(model)) {
			const bestIcon = DOM.append(nameLabel, $('span.model-name-best-icon'));
			bestIcon.appendChild(renderIcon(Codicon.pass));
			bestIcon.title = localize('customLanguageModels.bestForYou.tooltip', 'Recommended: sized for your system memory.');
		}
		// Live running indicator: a pulsing green dot when the model's server is up, or a spinner while it
		// is starting/loading its weights. Driven by the runner's phase; the list re-renders on state change.
		this._renderRunningIndicator(model.id, nameLabel);
		const actionsContainer = DOM.append(row1, $('.model-actions'));
		const runSlot = DOM.append(actionsContainer, $('.model-actions-run-slot'));
		const downloadingHFOrOllama = model.isDownloading && (model.provider === 'huggingface' || isOllama);
		if (needsDownloadOrPullRetry(model)) {
			const resumeTooltip = localize('customLanguageModels.resumeDownloadTitle', 'Start or resume downloading this model');
			const resumeButton = this._register(new Button(runSlot, { ...defaultButtonStyles, secondary: true, title: resumeTooltip, supportIcons: true }));
			resumeButton.label = '$(cloud-download) ' + localize('customLanguageModels.resumeDownload', 'Download');
			this._register(resumeButton.onDidClick(() => {
				this.commandService.executeCommand('locopilot.downloadModel', model.id);
			}));
		} else if (model.provider === 'huggingface' && model.localPath && !model.isDownloading) {
			this._renderServerControls(
				model.id, getCustomModelListLabel(model), runSlot, actionsContainer,
				() => this.commandService.executeCommand('locopilot.startLlamaServer', model.id)
			);
		}
		// Ollama models need no Run/Stop/Logs controls: the Ollama daemon auto-loads the model
		// on demand when a chat request arrives, so there is no per-model server to manage.
		if (downloadingHFOrOllama) {
			const stopWrap = DOM.append(actionsContainer, $('.model-action-stop-download'));
			const tooltip = localize('customLanguageModels.stopDownloadTitle', 'Stop the download or pull and discard partial files');
			const stopDownloadButton = this._register(new Button(stopWrap, { ...defaultButtonStyles, secondary: true, title: tooltip, supportIcons: true }));
			stopDownloadButton.label = '$(stop-circle) ' + localize('customLanguageModels.stopDownload', 'Stop download');
			this._register(stopDownloadButton.onDidClick(() => {
				this.commandService.executeCommand('locopilot.cancelModelDownload', model.id);
			}));
		} else {
			// Hide/Show is available for every model regardless of download state, so users can control which
			// models appear in the chat picker (including not-yet-downloaded catalog models).
			const hideWrap = DOM.append(actionsContainer, $('.model-action-hide'));
			const hideButton = this._register(new Button(hideWrap, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			hideButton.label = model.hidden
				? '$(eye) ' + localize('customLanguageModels.show', 'Show')
				: '$(eye-closed) ' + localize('customLanguageModels.hide', 'Hide');
			hideButton.element.classList.add(model.hidden ? 'model-btn-show' : 'model-btn-hide');
			this._register(hideButton.onDidClick(async () => {
				await this.customLanguageModelsService.hideCustomModel(model.id, !model.hidden);
			}));
			const deleteButton = this._register(new Button(actionsContainer, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			deleteButton.label = '$(trash) ' + localize('customLanguageModels.delete', 'Delete');
			this._register(deleteButton.onDidClick(async () => {
				await this._onDeleteModelClicked(model, itemContainer);
			}));
		}

		// Row 2: left = type/provider/model/status chips, right = context window input
		const row2 = DOM.append(itemContainer, $('.model-item-row.model-item-row2'));
		const detailsLabel = DOM.append(row2, $('.model-details'));
		const addChip = (text: string, ...variants: string[]): HTMLElement => {
			const chip = DOM.append(detailsLabel, $('span.model-chip' + variants.map(v => '.model-chip-' + v).join('')));
			chip.textContent = text;
			return chip;
		};
		// Hardware-fit badge (catalog models only): "Best for you" on the single curated recommendation for this
		// machine, or a soft "Needs N GB RAM" / Apple-Silicon warning when a model won't run comfortably here.
		const suitability = this.modelSuitability(model);
		if (this.isRecommendedForSystem(model)) {
			const chip = addChip(localize('customLanguageModels.bestForYou', 'Best for you'), 'best');
			chip.title = localize('customLanguageModels.bestForYou.tooltip', 'Recommended: sized for your system memory.');
		} else if (suitability === 'too-big') {
			const entry = findCatalogEntry(model.modelName, model.format);
			const chip = addChip(localize('customLanguageModels.needsRam', 'Needs {0} GB RAM', entry?.minRamGB ?? '?'), 'warn');
			chip.title = localize('customLanguageModels.needsRam.tooltip', 'Needs more memory than detected; may run slowly or fail to load.');
		} else if (suitability === 'incompatible') {
			const chip = addChip(localize('customLanguageModels.needsApple', 'Apple Silicon only'), 'warn');
			chip.title = localize('customLanguageModels.needsApple.tooltip', 'This MLX build runs only on Apple Silicon Macs.');
		}
		// Type badge (colored): Cloud vs Local
		addChip(model.type === 'cloud' ? localize('customLanguageModels.cloud', 'Cloud') : localize('customLanguageModels.local', 'Local'),
			model.type === 'cloud' ? 'cloud' : 'local');
		// Provider + model name (muted metadata)
		if (model.provider) { addChip(model.provider, 'muted'); }
		if (model.modelName) { addChip(model.modelName, 'muted', 'mono'); }
		if (model.provider === 'localhost' && model.localhostOpenAiModel) {
			addChip(localize('customLanguageModels.localhostModelId', 'API model: {0}', model.localhostOpenAiModel), 'muted', 'mono');
		}
		if (model.type === 'local' && model.useNativeTools) {
			addChip(localize('customLanguageModels.nativeTools', 'Native Tools'), 'muted');
		}
		if (model.format) { addChip(model.format, 'muted'); }
		// Status badge: only show the in-progress download/pull state. Steady-state
		// (Downloaded / Download not finished / Ready) chips are intentionally omitted.
		if (model.isDownloading) {
			addChip(isOllama
				? localize('customLanguageModels.pullingInProgress', 'Pulling...')
				: `${localize('customLanguageModels.downloading', 'Downloading')} ${model.downloadProgress ?? 0}%`,
				'status', 'pending');
		}

		// Context window input sits on the right of row 2, inline with the details text
		const contextWindowContainer = DOM.append(row2, $('.model-max-input-container'));
		const contextWindowIcon = DOM.append(contextWindowContainer, $('span.model-max-input-icon'));
		contextWindowIcon.appendChild(renderIcon(Codicon.window));
		const isLocalModel = model.type === 'local';
		const contextWindowDefault = isLocalModel ? LoCoPilotSettingsEditor.LOCAL_DEFAULT_CONTEXT_WINDOW : LoCoPilotSettingsEditor.DEFAULT_CONTEXT_WINDOW;
		const contextWindowInput = this._register(new InputBox(contextWindowContainer, this.contextViewService, {
			placeholder: String(contextWindowDefault),
			tooltip: '',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		contextWindowInput.element.style.minWidth = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		contextWindowInput.element.style.width = `${LoCoPilotSettingsEditor.TOKEN_LIMIT_INPUT_WIDTH_PX}px`;
		contextWindowInput.value = String(model.contextWindow ?? model.maxInputTokens ?? contextWindowDefault);
		const syncContextWindowTooltip = () => {
			contextWindowInput.setTooltip(this.contextWindowTooltip(contextWindowInput.value));
		};
		syncContextWindowTooltip();
		this._register(contextWindowInput.onDidChange(async () => {
			syncContextWindowTooltip();
			const result = this.parseContextWindow(contextWindowInput.value);
			if (result.valid) {
				await this.customLanguageModelsService.updateCustomModel(model.id, { contextWindow: result.value });
			}
		}));

		// Settings row: toggles only (right-aligned)
		const settingsRow = DOM.append(itemContainer, $('.model-item-row.model-item-row-settings'));
		const secondarySettingsContainer = DOM.append(settingsRow, $('.model-secondary-settings'));
		if (model.type === 'local' || model.provider === 'huggingface-cloud') {
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
		// Multi-Token Prediction toggle: llama.cpp GGUF feature, so HuggingFace local models only.
		if (model.provider === 'huggingface') {
			const mtpDesc = localize('customLanguageModels.mtpDescription', 'Run with Multi-Token Prediction (faster). Only for MTP-trained models on a recent llama.cpp build; other models will fail to start.');
			const mtpContainer = DOM.append(secondarySettingsContainer, $('.model-action-tools-container'));
			mtpContainer.title = mtpDesc;
			const mtpIcon = DOM.append(mtpContainer, $('span.model-action-tools-icon'));
			mtpIcon.appendChild(renderIcon(Codicon.rocket));
			const mtpWrap = DOM.append(mtpContainer, $('.model-action-tools.agent-setting-switch-wrap'));
			const mtpToggle = this._register(new Toggle({
				title: mtpDesc,
				isChecked: !!model.mtp,
				...defaultToggleStyles
			}));
			DOM.append(mtpWrap, mtpToggle.domNode);
			this._register(mtpToggle.onChange(async () => {
				await this.customLanguageModelsService.updateCustomModel(model.id, { mtp: mtpToggle.checked });
			}));
		}
		// Vision toggle: only shown for models that actually SUPPORT images, so text-only models stay clean.
		// A local model is vision-capable once that's confirmed - catalog entries, HF/Ollama enrichment, or a
		// projector found on disk at download all set supportsVision=true; the user can also declare it via the
		// add-model form's vision toggle. The switch itself then controls runtime loading (visionEnabled),
		// which is off until the user turns it on. HF-cloud multimodal models keep their provider-driven flag.
		const showVisionToggle = model.type === 'local'
			? model.supportsVision === true
			: model.provider === 'huggingface-cloud' && customModelSupportsVision(model);
		if (showVisionToggle) {
			const visionDesc = model.visionAutoDisabled
				? localize('customLanguageModels.visionAutoDisabledDescription', 'Vision was turned off automatically because this model couldn\'t read the last image. Turn it back on to try again.')
				: localize('customLanguageModels.visionDescription', 'Allow image attachments for this model. Only enable for models that can read images.');
			const visionContainer = DOM.append(secondarySettingsContainer, $('.model-action-tools-container'));
			visionContainer.title = visionDesc;
			const visionIcon = DOM.append(visionContainer, $('span.model-action-tools-icon'));
			visionIcon.appendChild(renderIcon(Codicon.eye));
			const visionWrap = DOM.append(visionContainer, $('.model-action-tools.agent-setting-switch-wrap'));
			const visionToggle = this._register(new Toggle({
				title: visionDesc,
				// For local models the toggle reflects whether vision is actually LOADED (visionEnabled): the
				// projector is downloaded for capable models but not loaded until the user opts in here, so the
				// switch must show the real runtime state, not the mere capability. Cloud vision is capability-only.
				isChecked: model.type === 'local' ? customModelVisionEnabled(model) : customModelSupportsVision(model),
				...defaultToggleStyles
			}));
			DOM.append(visionWrap, visionToggle.domNode);
			this._register(visionToggle.onChange(async () => {
				const checked = visionToggle.checked;
				// Local: an explicit user toggle is intent to use images, so it drives BOTH the capability
				// (supportsVision) and the runtime load (visionEnabled) together - turning it on loads the
				// projector (the runner reserves memory for it); turning it off keeps the model text-only.
				const updates = model.type === 'local'
					? { supportsVision: checked, visionEnabled: checked }
					: { supportsVision: checked };
				await this.customLanguageModelsService.updateCustomModel(model.id, updates);
			}));
		}
		// HF cloud routing toggle: on = cheapest, off = fastest. Shown only for HF cloud models.
		if (model.provider === 'huggingface-cloud') {
			const hfDesc = localize('customLanguageModels.hfCheapestDescription', 'On = route to the cheapest provider; Off = route to the fastest provider. HF controls the actual routing.');
			const hfContainer = DOM.append(secondarySettingsContainer, $('.model-action-tools-container'));
			hfContainer.title = hfDesc;
			const hfIcon = DOM.append(hfContainer, $('span.model-action-tools-icon'));
			hfIcon.appendChild(renderIcon(Codicon.tag));
			const hfWrap = DOM.append(hfContainer, $('.model-action-tools.agent-setting-switch-wrap'));
			const hfToggle = this._register(new Toggle({
				title: hfDesc,
				isChecked: !model.hfFastest, // checked = cheapest
				...defaultToggleStyles
			}));
			DOM.append(hfWrap, hfToggle.domNode);
			this._register(hfToggle.onChange(async () => {
				await this.customLanguageModelsService.updateCustomModel(model.id, { hfFastest: !hfToggle.checked });
			}));
		}

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

	/**
	 * Renders the collapsible "too large for this system" group at the bottom of the model list. The toggle is a
	 * plain right-aligned text link (no button chrome, no chevron): collapsed it reads "Show N more too large for
	 * this system"; expanded it lists the oversized models followed by a "Show less" link. The expanded models keep
	 * their "Needs N GB RAM" chip so the reason stays visible right where the user decides.
	 */
	private renderIncompatibleModelsSection(models: ICustomLanguageModel[], listContainer: HTMLElement): void {
		const tooltip = localize('customLanguageModels.showIncompatible.tooltip', 'These models need more memory than this system has. You can still download them, but they may run slowly or fail to load.');
		const addToggleLink = (text: string, expand: boolean): void => {
			const toggleRow = DOM.append(listContainer, $('.models-incompatible-toggle'));
			const link = DOM.append(toggleRow, $('a.models-incompatible-link'));
			link.textContent = text;
			link.title = tooltip;
			link.setAttribute('role', 'button');
			link.setAttribute('tabindex', '0');
			const activate = () => { this.modelsIncompatibleExpanded = expand; this.renderListModels(); };
			this._register(DOM.addDisposableListener(link, 'click', activate));
			this._register(DOM.addDisposableListener(link, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
			}));
		};

		if (!this.modelsIncompatibleExpanded) {
			addToggleLink(localize('customLanguageModels.showIncompatible', 'Show {0} more too large for this system', models.length), true);
			return;
		}

		// Closest-to-runnable first: "needs 24 GB" before "needs 64 GB", so the models a user might
		// unlock by freeing memory (or a RAM upgrade) surface at the top of the expanded group.
		const sorted = [...models].sort((a, b) => {
			const ra = findCatalogEntry(a.modelName, a.format)?.minRamGB ?? Number.MAX_SAFE_INTEGER;
			const rb = findCatalogEntry(b.modelName, b.format)?.minRamGB ?? Number.MAX_SAFE_INTEGER;
			if (ra !== rb) { return ra - rb; }
			return getCustomModelListLabel(a).localeCompare(getCustomModelListLabel(b));
		});
		sorted.forEach((model: ICustomLanguageModel) => this.renderListModelItem(model, listContainer));
		addToggleLink(localize('customLanguageModels.hideIncompatible', 'Show less'), false);
	}

	/**
	 * Renders a small "Running" indicator (pulsing dot + label, in the theme accent color) next to the model
	 * name once its server is ready. The starting/loading phases are intentionally left to the server-controls
	 * spinner so we don't show two loaders. Re-rendered by onDidServerStateChange.
	 */
	/**
	 * Delete button: downloaded local models get a choice dialog (remove download vs delete from list);
	 * everything else gets a simple remove-from-list confirm.
	 */
	private async _onDeleteModelClicked(model: ICustomLanguageModel, itemContainer: HTMLElement): Promise<void> {
		const label = getCustomModelListLabel(model);
		if (hasRemovableLocalDownload(model)) {
			const { result } = await this.dialogService.prompt({
				type: Severity.Warning,
				title: localize('customLanguageModels.remove.title', 'Remove "{0}"?', label),
				message: localize('customLanguageModels.remove.downloaded.message', 'How do you want to remove "{0}"?', label),
				detail: localize('customLanguageModels.remove.downloaded.detail', 'Remove download deletes its files and keeps it in My Models so you can download it again. Delete from list removes "{0}" completely.', label),
				// Cancel is a normal last button (not cancelButton) so macOS/Linux keep it on the leading
				// side; using cancelButton would force it into the middle of a 3-button row.
				buttons: [
					{
						label: localize('customLanguageModels.removeDownload', 'Remove download'),
						run: () => 'remove-download' as const,
					},
					{
						label: localize('customLanguageModels.deleteFromList', 'Delete from list'),
						run: () => 'delete-from-list' as const,
					},
					{
						label: localize('cancel', 'Cancel'),
						run: () => undefined,
					},
				],
			});
			if (result === 'remove-download') {
				this._stopModelServerIfNeeded(model.id);
				try {
					await this.commandService.executeCommand('locopilot.removeModelDownload', model.id);
				} catch {
					// Non-fatal; list will refresh from service state if partial success
				}
			} else if (result === 'delete-from-list') {
				await this._deleteModelFromList(model, itemContainer);
			}
			return;
		}

		const confirmed = await this.dialogService.confirm({
			title: localize('customLanguageModels.remove.title', 'Remove "{0}"?', label),
			message: localize('customLanguageModels.remove.notDownloaded.message', 'Remove "{0}" from My Models?', label),
			primaryButton: localize('customLanguageModels.removeFromList', 'Remove'),
			cancelButton: localize('cancel', 'Cancel'),
			type: 'warning',
		});
		if (confirmed.confirmed) {
			await this._deleteModelFromList(model, itemContainer);
		}
	}

	private _stopModelServerIfNeeded(modelId: string): void {
		if (this.localModelRunner.isServerRunning(modelId) || this.localModelRunner.isServerStarting(modelId)) {
			this.localModelRunner.stopServer(modelId);
		}
	}

	private async _deleteModelFromList(model: ICustomLanguageModel, itemContainer: HTMLElement): Promise<void> {
		this._stopModelServerIfNeeded(model.id);
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

	private _renderRunningIndicator(modelId: string, nameLabel: HTMLElement): void {
		// Only show this for a fully-ready server. While starting/loading, the server controls already show a
		// spinner, so there is no second indicator.
		if (this.localModelRunner.getServerPhase(modelId) !== 'ready') {
			return;
		}
		const badge = DOM.append(nameLabel, $('span.model-running-indicator.model-running-ready'));
		const dot = DOM.append(badge, $('span.model-running-dot'));
		dot.appendChild(renderIcon(Codicon.circleFilled));
		const text = DOM.append(badge, $('span.model-running-label'));
		text.textContent = localize('customLanguageModels.serverRunning', 'Running');
		badge.title = localize('customLanguageModels.serverRunningTooltip', 'This model is loaded and ready to answer requests.');
	}

	/**
	 * Renders the Run/Stop button area for a local model server (llama.cpp or Ollama).
	 * Shows a spinner while starting and Stop + Logs once the server is running; otherwise a plain
	 * "Start server" button. A failed launch is NOT given a distinct "Failed / Retry" state here - the
	 * failure is already reported by a toast, and the model simply falls back to "Start server" (identical
	 * to a model that was never started), so the user isn't shown the error twice and can just start again.
	 */
	private _renderServerControls(
		modelId: string,
		modelLabel: string,
		runSlot: HTMLElement,
		actionsContainer: HTMLElement,
		startCommand: () => void
	): void {
		// Gate the controls on the real load phase, not merely on "a process exists". A server record is created
		// with ready:false the instant the process spawns, so isServerRunning() flips true while weights are still
		// loading ('loading' phase) - which used to show the Stop button before the model could actually answer.
		// The chat send path only fires at phase 'ready' (getServerPhase === 'ready'), so a message sent during the
		// loading window re-enters its own wait, making a "Stop"-showing model look like it is starting again. Show
		// the spinner for both 'starting' and 'loading', and only offer Stop once the endpoint is truly ready.
		const phase = this.localModelRunner.getServerPhase(modelId);
		const isReady = phase === 'ready';
		const isLaunching = phase === 'starting' || phase === 'loading';

		if (isLaunching) {
			// Spinner + disabled label while the server is launching (process spawning OR weights still loading)
			const spinnerWrap = DOM.append(runSlot, $('.model-server-starting'));
			const activity = DOM.append(spinnerWrap, $('.model-ollama-activity'));
			activity.setAttribute('aria-hidden', 'true');
			for (let i = 0; i < 8; i++) { DOM.append(activity, $('.model-ollama-activity-tick')); }
			const startingLabel = DOM.append(spinnerWrap, $('span.model-server-starting-label'));
			startingLabel.textContent = localize('customLanguageModels.serverStarting', 'Starting...');
			spinnerWrap.setAttribute('aria-busy', 'true');
			spinnerWrap.setAttribute('aria-label', localize('customLanguageModels.serverStartingAria', 'Server is starting, please wait'));
		} else if (isReady) {
			// Running: Stop + Logs. Local models also auto-start on first use (see ensureServerForModel),
			// so the button below is a convenience to spin up (or shut down) the server ahead of a request.
			const btn = this._register(new Button(runSlot, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: localize('customLanguageModels.stopServerTooltip', 'Unload this model and stop its server') }));
			btn.label = '$(stop-circle) ' + localize('customLanguageModels.stopServer', 'Stop server');
			this._register(btn.onDidClick(() => this.localModelRunner.stopServer(modelId)));
			const logsButton = this._register(new Button(actionsContainer, { ...defaultButtonStyles, secondary: true, title: localize('customLanguageModels.logs.viewTooltip', 'View server logs') }));
			logsButton.label = localize('customLanguageModels.logs', 'Logs');
			this._register(logsButton.onDidClick(() => this._showLogsOverlay(modelId, modelLabel)));
		} else {
			// Not running (never started, stopped, OR a previous start failed): offer a plain Start button.
			// The server would otherwise start automatically on the first message (ensureServerForModel), but
			// showing an explicit Start mirrors the Stop button and lets users pre-warm the model before chatting.
			const startBtn = this._register(new Button(runSlot, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: localize('customLanguageModels.startServerTooltip', 'Load this model and start its server') }));
			startBtn.label = '$(play) ' + localize('customLanguageModels.startServer', 'Start server');
			this._register(startBtn.onDidClick(() => startCommand()));
		}
	}

	/**
	 * Builds the floating logs modal once, hidden. Appended to the editor root (this.container)
	 * so the dimmed backdrop and centered dialog overlay the entire settings surface.
	 */
	private _createLogsModal(): void {
		const root = this.container ?? this.listModelsPanel;

		// Dimmed backdrop - click outside the dialog to dismiss.
		this.logsBackdropEl = DOM.append(root, $('.model-logs-backdrop'));
		this.logsBackdropEl.style.display = 'none';
		this._register(DOM.addDisposableListener(this.logsBackdropEl, 'click', (e: MouseEvent) => {
			if (e.target === this.logsBackdropEl) { this._hideLogsOverlay(); }
		}));
		this._register(DOM.addDisposableListener(this.logsBackdropEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') { this._hideLogsOverlay(); }
		}));

		// The dialog itself.
		this.logsOverlayEl = DOM.append(this.logsBackdropEl, $('.model-logs-overlay'));
		this.logsOverlayEl.setAttribute('role', 'dialog');
		this.logsOverlayEl.setAttribute('aria-modal', 'true');

		// --- Header: status dot, terminal icon, title + model id subtitle, live line badge, close.
		const logsHeader = DOM.append(this.logsOverlayEl, $('.model-logs-header'));
		const logsHeaderLeft = DOM.append(logsHeader, $('.model-logs-header-left'));
		DOM.append(logsHeaderLeft, $('.model-logs-status-dot'));
		const headerIcon = DOM.append(logsHeaderLeft, $('.model-logs-header-icon'));
		headerIcon.appendChild(renderIcon(Codicon.terminal));
		const titleWrap = DOM.append(logsHeaderLeft, $('.model-logs-title-wrap'));
		this.logsTitleEl = DOM.append(titleWrap, $('.model-logs-title'));
		this.logsSubtitleEl = DOM.append(titleWrap, $('.model-logs-subtitle'));
		this.logsBadgeEl = DOM.append(logsHeaderLeft, $('.model-logs-badge'));
		this.logsBadgeEl.style.display = 'none';

		const logsCloseBtn = DOM.append(logsHeader, $('button.model-logs-close'));
		logsCloseBtn.appendChild(renderIcon(Codicon.close));
		logsCloseBtn.title = localize('customLanguageModels.logs.close', 'Close logs');
		this._register(DOM.addDisposableListener(logsCloseBtn, 'click', () => this._hideLogsOverlay()));

		// --- Toolbar: search filter + Copy / Clear actions.
		const logsToolbar = DOM.append(this.logsOverlayEl, $('.model-logs-toolbar'));
		const searchWrap = DOM.append(logsToolbar, $('.model-logs-search'));
		const searchIcon = DOM.append(searchWrap, $('.model-logs-search-icon'));
		searchIcon.appendChild(renderIcon(Codicon.search));
		this.logsSearchInput = DOM.append(searchWrap, $('input.model-logs-search-input')) as HTMLInputElement;
		this.logsSearchInput.type = 'text';
		this.logsSearchInput.placeholder = localize('customLanguageModels.logs.searchPlaceholder', 'Filter logs…');
		this._register(DOM.addDisposableListener(this.logsSearchInput, 'input', () => {
			this.logsFilterText = (this.logsSearchInput?.value ?? '').toLowerCase();
			this._applyLogFilter();
		}));

		const toolbarActions = DOM.append(logsToolbar, $('.model-logs-toolbar-actions'));
		this.logsCopyBtn = DOM.append(toolbarActions, $('button.model-logs-action-btn'));
		this.logsCopyBtn.appendChild(renderIcon(Codicon.copy));
		this.logsCopyLabel = DOM.append(this.logsCopyBtn, $('span.model-logs-action-label'));
		this.logsCopyLabel.textContent = localize('customLanguageModels.logs.copy', 'Copy');
		this.logsCopyBtn.title = localize('customLanguageModels.logs.copyTooltip', 'Copy all logs to clipboard');
		this._register(DOM.addDisposableListener(this.logsCopyBtn, 'click', () => this._copyLogs()));

		const logsClearBtn = DOM.append(toolbarActions, $('button.model-logs-action-btn'));
		logsClearBtn.appendChild(renderIcon(Codicon.clearAll));
		DOM.append(logsClearBtn, $('span')).textContent = localize('customLanguageModels.logs.clear', 'Clear');
		logsClearBtn.title = localize('customLanguageModels.logs.clearTooltip', 'Clear log view');
		this._register(DOM.addDisposableListener(logsClearBtn, 'click', () => {
			if (this.logsBodyEl) { DOM.clearNode(this.logsBodyEl); this._updateLogsBadge(); this._updateJumpButton(); }
		}));

		// --- Body: scrolling log lines.
		this.logsBodyEl = DOM.append(this.logsOverlayEl, $('.model-logs-body'));
		this._register(DOM.addDisposableListener(this.logsBodyEl, 'scroll', () => {
			if (!this.logsBodyEl) { return; }
			const { scrollTop, scrollHeight, clientHeight } = this.logsBodyEl;
			this.logsAutoScroll = scrollHeight - scrollTop - clientHeight < 24;
			this._updateJumpButton();
		}));

		// Floating "jump to latest" button, shown when scrolled up.
		this.logsJumpBtn = DOM.append(this.logsOverlayEl, $('button.model-logs-jump'));
		this.logsJumpBtn.appendChild(renderIcon(Codicon.arrowDown));
		DOM.append(this.logsJumpBtn, $('span')).textContent = localize('customLanguageModels.logs.jump', 'Latest');
		this.logsJumpBtn.title = localize('customLanguageModels.logs.jumpTooltip', 'Scroll to latest log line');
		this._register(DOM.addDisposableListener(this.logsJumpBtn, 'click', () => {
			if (this.logsBodyEl) {
				this.logsAutoScroll = true;
				this.logsBodyEl.scrollTop = this.logsBodyEl.scrollHeight;
			}
			this._updateJumpButton();
		}));

		// --- Footer: line count + error/warning tallies.
		const logsFooter = DOM.append(this.logsOverlayEl, $('.model-logs-footer'));
		this.logsFooterInfoEl = DOM.append(logsFooter, $('.model-logs-footer-info'));
		this.logsFooterInfoEl.textContent = localize('customLanguageModels.logs.footerEmpty', 'No log entries');
		const footerStats = DOM.append(logsFooter, $('.model-logs-footer-stats'));
		this.logsErrorStatEl = DOM.append(footerStats, $('.model-logs-stat.stat-error'));
		this.logsErrorStatEl.style.display = 'none';
		this.logsWarnStatEl = DOM.append(footerStats, $('.model-logs-stat.stat-warn'));
		this.logsWarnStatEl.style.display = 'none';
	}

	private _showLogsOverlay(modelId: string, modelLabel: string): void {
		this.currentLogsModelId = modelId;
		if (!this.logsBackdropEl || !this.logsOverlayEl || !this.logsBodyEl) { return; }
		if (this.logsTitleEl) {
			this.logsTitleEl.textContent = modelLabel;
		}
		if (this.logsSubtitleEl) {
			const running = this.localModelRunner.isServerRunning(modelId);
			this.logsSubtitleEl.textContent = running
				? localize('customLanguageModels.logs.subtitleRunning', 'Server running · live')
				: localize('customLanguageModels.logs.subtitleStopped', 'Server stopped');
			this.logsSubtitleEl.classList.toggle('running', running);
		}
		if (this.logsSearchInput) {
			this.logsSearchInput.value = '';
			this.logsFilterText = '';
		}
		this.logsAutoScroll = true;
		DOM.clearNode(this.logsBodyEl);
		const lines = this.localModelRunner.getServerLogs(modelId);
		for (const line of lines) {
			this._appendLogLine(line);
		}
		this.logsBackdropEl.style.display = '';
		// Force reflow then add the class so the CSS enter-animation plays.
		this.logsOverlayEl.classList.remove('visible');
		void this.logsOverlayEl.offsetWidth;
		this.logsOverlayEl.classList.add('visible');
		this.logsBodyEl.scrollTop = this.logsBodyEl.scrollHeight;
		this._updateJumpButton();
		this.logsSearchInput?.focus();
	}

	private _hideLogsOverlay(): void {
		this.currentLogsModelId = undefined;
		if (this.logsOverlayEl) {
			this.logsOverlayEl.classList.remove('visible');
		}
		if (this.logsBackdropEl) {
			this.logsBackdropEl.style.display = 'none';
		}
		if (this.logsBodyEl) {
			DOM.clearNode(this.logsBodyEl);
		}
		if (this.logsBadgeEl) {
			this.logsBadgeEl.style.display = 'none';
		}
		this.logsJumpBtn?.classList.remove('visible');
		if (this.logsFooterInfoEl) {
			this.logsFooterInfoEl.textContent = localize('customLanguageModels.logs.footerEmpty', 'No log entries');
		}
	}

	private _appendLogsLine(allLines: string[]): void {
		if (!this.logsBodyEl) { return; }
		// Only append lines that aren't already rendered (track count via child count)
		const rendered = this.logsBodyEl.childElementCount;
		const newLines = allLines.slice(rendered);
		for (const line of newLines) {
			this._appendLogLine(line);
		}
		// Auto-scroll only if the user hasn't scrolled up.
		if (this.logsAutoScroll) {
			this.logsBodyEl.scrollTop = this.logsBodyEl.scrollHeight;
		}
		this._updateJumpButton();
	}

	/** Show the "Latest" pill only when there is scrollable content and the user has scrolled up. */
	private _updateJumpButton(): void {
		if (!this.logsBodyEl || !this.logsJumpBtn) { return; }
		const { scrollTop, scrollHeight, clientHeight } = this.logsBodyEl;
		const hasOverflow = scrollHeight - clientHeight > 4;
		const atBottom = scrollHeight - scrollTop - clientHeight < 24;
		const show = hasOverflow && !atBottom && this.logsBodyEl.childElementCount > 0;
		this.logsJumpBtn.classList.toggle('visible', show);
	}

	private _appendLogLine(line: string): void {
		if (!this.logsBodyEl) { return; }
		const lineEl = DOM.append(this.logsBodyEl, $('div.model-log-line'));
		lineEl.textContent = line;
		const lower = line.toLowerCase();
		if (/\b(error|fatal|exception|failed|failure)\b/.test(lower)) {
			lineEl.classList.add('log-level-error');
		} else if (/\b(warn|warning)\b/.test(lower)) {
			lineEl.classList.add('log-level-warn');
		} else if (/\b(info|starting|started|loaded|listening|ready)\b/.test(lower)) {
			lineEl.classList.add('log-level-info');
		} else if (/\b(debug|trace|verbose)\b/.test(lower)) {
			lineEl.classList.add('log-level-debug');
		}
		// Respect an active filter on freshly appended lines.
		if (this.logsFilterText && !lower.includes(this.logsFilterText)) {
			lineEl.classList.add('filtered-out');
		}
		this._updateLogsBadge();
	}

	/** Show/hide already-rendered log lines to match the current search filter. */
	private _applyLogFilter(): void {
		if (!this.logsBodyEl) { return; }
		const filter = this.logsFilterText;
		for (const child of Array.from(this.logsBodyEl.children)) {
			const el = child as HTMLElement;
			const match = !filter || (el.textContent ?? '').toLowerCase().includes(filter);
			el.classList.toggle('filtered-out', !match);
		}
	}

	private _updateLogsBadge(): void {
		if (!this.logsBodyEl || !this.logsBadgeEl || !this.logsFooterInfoEl) { return; }
		const count = this.logsBodyEl.childElementCount;
		if (count > 0) {
			this.logsBadgeEl.textContent = localize('customLanguageModels.logs.badge', '{0} lines', count);
			this.logsBadgeEl.style.display = '';
			this.logsFooterInfoEl.textContent = localize('customLanguageModels.logs.footerCount', '{0} lines', count);
		} else {
			this.logsBadgeEl.style.display = 'none';
			this.logsFooterInfoEl.textContent = localize('customLanguageModels.logs.footerEmpty', 'No log entries');
		}
		// Error / warning tallies in the footer.
		let errors = 0;
		let warns = 0;
		for (const child of Array.from(this.logsBodyEl.children)) {
			const cls = (child as HTMLElement).classList;
			if (cls.contains('log-level-error')) { errors++; }
			else if (cls.contains('log-level-warn')) { warns++; }
		}
		if (this.logsErrorStatEl) {
			this.logsErrorStatEl.style.display = errors > 0 ? '' : 'none';
			this.logsErrorStatEl.textContent = localize('customLanguageModels.logs.errorStat', '{0} errors', errors);
		}
		if (this.logsWarnStatEl) {
			this.logsWarnStatEl.style.display = warns > 0 ? '' : 'none';
			this.logsWarnStatEl.textContent = localize('customLanguageModels.logs.warnStat', '{0} warnings', warns);
		}
	}

	private _copyLogs(): void {
		if (!this.logsBodyEl || !this.logsCopyBtn) { return; }
		// Copy only the lines currently visible (i.e. matching the active filter).
		const lines = Array.from(this.logsBodyEl.children)
			.filter(el => !(el as HTMLElement).classList.contains('filtered-out'))
			.map(el => (el as HTMLElement).textContent ?? '');
		const text = lines.join('\n');
		this.clipboardService.writeText(text);
		const label = this.logsCopyLabel;
		if (label) {
			label.textContent = localize('customLanguageModels.logs.copied', 'Copied');
			setTimeout(() => {
				label.textContent = localize('customLanguageModels.logs.copy', 'Copy');
			}, 2000);
		}
	}

	private renderAgentSettings(container: HTMLElement): void {
		const title = DOM.append(container, $('h2.agent-settings-title'));
		title.textContent = localize('locopilotSettings.agentSettingsTitle', 'Agent Settings');
		const subtitle = DOM.append(container, $('.agent-settings-subtitle'));
		subtitle.textContent = localize('locopilotSettings.agentSettingsSubtitle', "Control how the agent runs and which system prompt it uses.");

		// --- Card: Execution -------------------------------------------------
		const execCard = DOM.append(container, $('.agent-setting-card'));
		const execHeader = DOM.append(execCard, $('.agent-setting-card-header'));
		execHeader.textContent = localize('locopilotSettings.executionSection', "Execution");

		// Max iterations per request
		const maxIterSection = DOM.append(execCard, $('.agent-setting-row'));
		const maxIterText = DOM.append(maxIterSection, $('.agent-setting-text'));
		const maxIterLabel = DOM.append(maxIterText, $('label.locopilot-setting-label'));
		maxIterLabel.textContent = localize('locopilotSettings.maxIterations', "Max iterations per request");
		const maxIterDesc = DOM.append(maxIterText, $('.agent-setting-description'));
		maxIterDesc.textContent = localize('locopilotSettings.maxIterationsDescription', "How many tool/LLM steps the agent may take to answer a single request.");
		// Hint/error lives in the left text column so the input never shifts when its text changes width.
		this.maxIterationsHint = DOM.append(maxIterText, $('.agent-setting-hint'));
		this.maxIterationsHint.textContent = localize('locopilotSettings.maxIterationsHint', "Between 10 and 500.");
		const maxIterControl = DOM.append(maxIterSection, $('.agent-setting-control'));
		const maxIterWrap = DOM.append(maxIterControl, $('.agent-setting-input-wrap'));
		this.maxIterationsInput = this._register(new InputBox(DOM.append(maxIterWrap, $('div')), this.contextViewService, {
			placeholder: String(DEFAULT_MAX_ITERATIONS),
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		this.maxIterationsInput.value = String(this.agentSettingsService.getMaxIterationsPerRequest());
		this._register(this.maxIterationsInput.onDidChange(() => { this.validateMaxIterations(); this.updateAgentSettingsDirtyIndicators(); }));

		// Auto approve terminal commands (on/off switch; default off)
		const autoRunRow = DOM.append(execCard, $('.agent-setting-row'));
		const autoRunText = DOM.append(autoRunRow, $('.agent-setting-text'));
		const autoRunLabel = DOM.append(autoRunText, $('label.locopilot-setting-label'));
		autoRunLabel.textContent = localize('locopilotSettings.autoApproveTerminalCommands', "Auto approve agent tool calls");
		const autoRunDesc = DOM.append(autoRunText, $('.agent-setting-description.agent-setting-description-warning'));
		DOM.append(autoRunDesc, renderIcon(Codicon.warning));
		DOM.append(autoRunDesc, $('span', undefined, localize('locopilotSettings.autoApproveTerminalCommandsHint', "Runs terminal commands and MCP/tool calls without asking. Off by default.")));
		const autoRunWrap = DOM.append(autoRunRow, $('.agent-setting-control.agent-setting-toggle-wrap.agent-setting-switch-wrap'));
		this.autoRunCommandsInSandboxToggle = this._register(new Toggle({
			title: localize('locopilotSettings.autoApproveTerminalCommandsDescription', "When on, the LLM agent runs all tool calls - terminal commands, MCP tools and built-in tools - and sends their results back without asking for permission. Default: off."),
			isChecked: this.agentSettingsService.getAutoRunCommandsInSandbox(),
			...defaultToggleStyles
		}));
		DOM.append(autoRunWrap, this.autoRunCommandsInSandboxToggle.domNode);
		this._register(this.autoRunCommandsInSandboxToggle.onChange(() => this.updateAgentSettingsDirtyIndicators()));

		// Web search API key (Brave). Optional: when empty, web search falls back to DuckDuckGo
		// (no key needed). When set, the webSearch tool uses the Brave Search API for better
		// rate limits and quality. See webSearchTool.ts (reads ChatConfiguration.WebSearchApiKey).
		const braveRow = DOM.append(execCard, $('.agent-setting-row'));
		const braveText = DOM.append(braveRow, $('.agent-setting-text'));
		const braveLabel = DOM.append(braveText, $('label.locopilot-setting-label'));
		braveLabel.textContent = localize('locopilotSettings.braveApiKey', "Web search API key (Brave)");
		const braveDesc = DOM.append(braveText, $('.agent-setting-description'));
		braveDesc.textContent = localize('locopilotSettings.braveApiKeyDescription', "Optional. Leave empty to use DuckDuckGo search. Enter a Brave Search API key for better results - get a key at https://brave.com/search/api/.");
		const braveControl = DOM.append(braveRow, $('.agent-setting-control'));
		const braveWrap = DOM.append(braveControl, $('.agent-setting-input-wrap.agent-setting-brave-wrap'));
		this.braveApiKeyInput = this._register(new InputBox(DOM.append(braveWrap, $('div')), this.contextViewService, {
			placeholder: localize('locopilotSettings.braveApiKeyPlaceholder', "Enter Brave Search API key"),
			type: 'password',
			inputBoxStyles: locopilotSettingsInputBoxStyles
		}));
		this.braveApiKeyInput.value = this.configurationService.getValue<string>(ChatConfiguration.WebSearchApiKey) ?? '';
		this._register(this.braveApiKeyInput.onDidChange(() => this.updateAgentSettingsDirtyIndicators()));

		// [engine-ui] The local-model engine (auto/cpu/gpu) is decided automatically (see
		// LoCoPilotLocalModelRunner._resolveServerLaunch). The override is intentionally NOT shown in this
		// panel - power users can still change it via the "LoCoPilot: Select Local Model Engine" command or
		// the `locopilot.llamaCpp.engine` setting. To restore an inline dropdown here, uncomment this block
		// and the lines tagged [engine-ui] above (imports, field, constructor param).
		//
		// if (!isMacintosh) {
		// 	const engineOptions: ISelectOptionItem[] = [
		// 		{ text: localize('locopilotSettings.engine.auto', 'Auto (recommended)'), description: localize('locopilotSettings.engine.auto.desc', 'GPU when a capable one is detected, otherwise CPU') },
		// 		{ text: localize('locopilotSettings.engine.cpu', 'CPU'), description: localize('locopilotSettings.engine.cpu.desc', 'Always use the CPU engine') },
		// 		{ text: localize('locopilotSettings.engine.gpu', 'GPU (Vulkan)'), description: localize('locopilotSettings.engine.gpu.desc', 'Force the GPU engine even on integrated graphics') },
		// 	];
		// 	const engineValues = ['auto', 'cpu', 'gpu'] as const;
		// 	const currentEngine = this.configurationService.getValue<string>(ChatConfiguration.LocopilotLlamaCppEngine) ?? 'auto';
		// 	const engineIndex = Math.max(0, engineValues.indexOf(currentEngine as typeof engineValues[number]));
		//
		// 	const engineRow = DOM.append(execCard, $('.agent-setting-row'));
		// 	const engineText = DOM.append(engineRow, $('.agent-setting-text'));
		// 	const engineLabel = DOM.append(engineText, $('label.locopilot-setting-label'));
		// 	engineLabel.textContent = localize('locopilotSettings.engine', 'Local model engine');
		// 	const engineDesc = DOM.append(engineText, $('.agent-setting-description'));
		// 	engineDesc.textContent = localize('locopilotSettings.engineDescription', 'Which engine runs local GGUF models. Auto uses the GPU when a capable one is detected and falls back to CPU. Force GPU to enable Vulkan on an integrated GPU that auto skips.');
		// 	const engineControl = DOM.append(engineRow, $('.agent-setting-control'));
		// 	const engineSelectContainer = DOM.append(engineControl, $('div'));
		// 	this.engineSelectBox = this._register(new SelectBox(engineOptions, engineIndex, this.contextViewService, locopilotSettingsSelectBoxStyles));
		// 	this.engineSelectBox.render(engineSelectContainer);
		// 	this._register(this.engineSelectBox.onDidSelect(e => {
		// 		const val = engineValues[e.index] ?? 'auto';
		// 		this.configurationService.updateValue(ChatConfiguration.LocopilotLlamaCppEngine, val);
		// 	}));
		// }

		// --- Card: System Prompts -------------------------------------------
		const promptCard = DOM.append(container, $('.agent-setting-card'));
		const promptHeader = DOM.append(promptCard, $('.agent-setting-card-header'));
		promptHeader.textContent = localize('locopilotSettings.systemPromptsSection', "System Prompts");
		this.renderPromptBlock(promptCard, 'agent');
		this.renderPromptBlock(promptCard, 'ask');
		this.renderPromptBlock(promptCard, 'plan');

		// --- Card: Project Memory (per-workspace instructions) ---------------
		this.renderWorkspaceInstructions(container);

		// --- Sticky footer ---------------------------------------------------
		const footerRow = DOM.append(container, $('.agent-setting-footer'));
		this.agentSettingsDirtyIndicator = DOM.append(footerRow, $('.agent-setting-dirty-indicator'));
		this.agentSettingsDirtyIndicator.textContent = localize('locopilotSettings.unsavedChanges', "Unsaved changes");
		this.agentSettingsCancelBtn = this._register(new Button(footerRow, { ...defaultButtonStyles, secondary: true }));
		this.agentSettingsCancelBtn.label = localize('locopilotSettings.cancel', "Cancel");
		this.agentSettingsCancelBtn.enabled = false;
		this.agentSettingsCancelBtn.onDidClick(() => this.cancelAgentSettings());
		this.agentSettingsSaveBtn = this._register(new Button(footerRow, { ...defaultButtonStyles }));
		this.agentSettingsSaveBtn.label = localize('locopilotSettings.save', "Save");
		this.agentSettingsSaveBtn.enabled = false;
		this.agentSettingsSaveBtn.onDidClick(() => { this.saveAgentSettings(); });

		this.validateMaxIterations();
		this.captureAgentSettingsBaselineFromPersisted();
		this.updateAgentSettingsDirtyIndicators();
	}

	/** Resolves the UI controls bound to a given prompt mode. Assigned during {@link renderPromptBlock}. */
	private promptModeFields(which: 'agent' | 'ask' | 'plan'): {
		toggle: PromptModeControl;
		textarea: HTMLTextAreaElement;
		formatted: HTMLElement;
		getRendered: () => { dispose(): void } | undefined;
		setRendered: (r: { dispose(): void } | undefined) => void;
	} {
		switch (which) {
			case 'agent':
				return { toggle: this.agentCodingSystemPromptToggle, textarea: this.agentPromptTextarea, formatted: this.agentPromptFormattedView, getRendered: () => this.agentPromptFormattedRendered, setRendered: r => { this.agentPromptFormattedRendered = r; } };
			case 'ask':
				return { toggle: this.askCodingSystemPromptToggle, textarea: this.askPromptTextarea, formatted: this.askPromptFormattedView, getRendered: () => this.askPromptFormattedRendered, setRendered: r => { this.askPromptFormattedRendered = r; } };
			case 'plan':
				return { toggle: this.planCodingSystemPromptToggle, textarea: this.planPromptTextarea, formatted: this.planPromptFormattedView, getRendered: () => this.planPromptFormattedRendered, setRendered: r => { this.planPromptFormattedRendered = r; } };
		}
	}

	/** Persisted "use built-in prompt" toggle for a mode. */
	private getUseCodingPrompt(which: 'agent' | 'ask' | 'plan'): boolean {
		switch (which) {
			case 'agent': return this.agentSettingsService.getAgentUseCodingSystemPrompt();
			case 'ask': return this.agentSettingsService.getAskUseCodingSystemPrompt();
			case 'plan': return this.agentSettingsService.getPlanUseCodingSystemPrompt();
		}
	}

	/** Persisted custom prompt text for a mode. */
	private getModePrompt(which: 'agent' | 'ask' | 'plan'): string {
		switch (which) {
			case 'agent': return this.agentSettingsService.getAgentModeSystemPrompt();
			case 'ask': return this.agentSettingsService.getAskModeSystemPrompt();
			case 'plan': return this.agentSettingsService.getPlanModeSystemPrompt();
		}
	}

	private promptModeLabel(which: 'agent' | 'ask' | 'plan'): string {
		switch (which) {
			case 'agent': return localize('locopilotSettings.promptAgentLabel', "Agent mode prompt");
			case 'ask': return localize('locopilotSettings.promptAskLabel', "Ask mode prompt");
			case 'plan': return localize('locopilotSettings.promptPlanLabel', "Plan mode prompt");
		}
	}

	private promptModeDesc(which: 'agent' | 'ask' | 'plan'): string {
		switch (which) {
			case 'agent': return localize('locopilotSettings.promptAgentDesc', "Default uses LoCoPilot's built-in coding prompt. Override to write your own.");
			case 'ask': return localize('locopilotSettings.promptAskDesc', "Default uses LoCoPilot's built-in Ask prompt. Override to write your own.");
			case 'plan': return localize('locopilotSettings.promptPlanDesc', "Default uses LoCoPilot's built-in Plan prompt (research, no edits). Override to write your own.");
		}
	}

	/** Builds one prompt mode block (Default/Override segmented control + editable prompt box). */
	private renderPromptBlock(container: HTMLElement, which: 'agent' | 'ask' | 'plan'): void {
		const section = DOM.append(container, $('.agent-setting-block'));
		const headerRow = DOM.append(section, $('.agent-setting-row'));
		const text = DOM.append(headerRow, $('.agent-setting-text'));
		const label = DOM.append(text, $('label.locopilot-setting-label'));
		label.textContent = this.promptModeLabel(which);
		const desc = DOM.append(text, $('.agent-setting-description'));
		desc.textContent = this.promptModeDesc(which);

		const control = this._register(new PromptModeControl(
			this.getUseCodingPrompt(which),
			this.promptModeLabel(which)
		));
		DOM.append(headerRow, $('.agent-setting-control', undefined, control.domNode));
		this._register(control.onChange(() => {
			this.updateCodingPromptUIMode(which);
			this._renderFormattedPrompt(which);
			this.updateAgentSettingsDirtyIndicators();
		}));

		const box = DOM.append(section, $('.locopilot-prompt-box'));
		const formatted = DOM.append(box, $('.locopilot-prompt-formatted'));
		formatted.setAttribute('role', 'button');
		formatted.setAttribute('tabindex', '0');
		formatted.title = localize('locopilotSettings.clickToEdit', "Click to edit");
		const textarea = DOM.append(box, $('textarea.locopilot-prompt-textarea')) as HTMLTextAreaElement;
		textarea.placeholder = localize('locopilotSettings.promptPlaceholder', "Write your system prompt. Leave blank for a short default opener.");
		textarea.value = this.getModePrompt(which);
		textarea.classList.add('locopilot-prompt-textarea-hidden');

		switch (which) {
			case 'agent':
				this.agentCodingSystemPromptToggle = control;
				this.agentPromptFormattedView = formatted;
				this.agentPromptTextarea = textarea;
				break;
			case 'ask':
				this.askCodingSystemPromptToggle = control;
				this.askPromptFormattedView = formatted;
				this.askPromptTextarea = textarea;
				break;
			case 'plan':
				this.planCodingSystemPromptToggle = control;
				this.planPromptFormattedView = formatted;
				this.planPromptTextarea = textarea;
				break;
		}

		this.updateCodingPromptUIMode(which);
		this._renderFormattedPrompt(which);
		this._register(DOM.addDisposableListener(formatted, 'click', () => this._switchToEditPrompt(which)));
		this._register(DOM.addDisposableListener(formatted, 'keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._switchToEditPrompt(which); } }));
		this._register(DOM.addDisposableListener(textarea, 'blur', () => this._switchToFormattedPrompt(which)));
		this._register(DOM.addDisposableListener(textarea, 'input', () => this.updateAgentSettingsDirtyIndicators()));
	}

	/**
	 * Project Memory card: a per-workspace instruction box. Unlike the Agent/Ask mode prompts above
	 * (which are global), this applies only to the currently open project and is appended to the
	 * agent's PROJECT MEMORY block on every request for this workspace.
	 */
	private renderWorkspaceInstructions(container: HTMLElement): void {
		const card = DOM.append(container, $('.agent-setting-card'));

		// Collapsible header: the body stays hidden until the user opens it, so the panel isn't
		// dominated by a large empty textarea on first view.
		const header = DOM.append(card, $('.agent-setting-card-header.agent-setting-card-header-collapsible'));
		header.setAttribute('role', 'button');
		header.setAttribute('tabindex', '0');
		const chevron = DOM.append(header, $('.agent-setting-collapse-chevron'));
		chevron.appendChild(renderIcon(Codicon.chevronRight));
		DOM.append(header, $('span', undefined, localize('locopilotSettings.projectMemorySection', "Project Memory")));

		const block = DOM.append(card, $('.agent-setting-block'));
		block.style.display = 'none';

		let expanded = false;
		const setExpanded = (next: boolean) => {
			expanded = next;
			block.style.display = expanded ? '' : 'none';
			header.classList.toggle('agent-setting-card-header-expanded', expanded);
			header.setAttribute('aria-expanded', String(expanded));
			if (expanded && !this.workspaceInstructionsTextarea.disabled) {
				this.workspaceInstructionsTextarea.focus();
			}
		};
		this._register(DOM.addDisposableListener(header, 'click', () => {
			setExpanded(!expanded);
			// After a mouse click the header keeps focus, so its :focus-visible (teal) outline
			// lingers - especially noticeable after collapsing. Blur it so the outline clears
			// immediately; keyboard activation (Enter/Space) still keeps the focus ring for a11y.
			if (!expanded) {
				header.blur();
			}
		}));
		this._register(DOM.addDisposableListener(header, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); }
		}));

		const text = DOM.append(block, $('.agent-setting-text'));
		const label = DOM.append(text, $('label.locopilot-setting-label'));
		label.textContent = localize('locopilotSettings.workspaceInstructionsLabel', "Instructions for this project");
		const desc = DOM.append(text, $('.agent-setting-description'));
		desc.textContent = localize('locopilotSettings.workspaceInstructionsDesc', "Project-specific guidance the agent follows in THIS workspace only - added on top of the global prompt above, on every request. Great for conventions, commands, and \"don't touch\" areas. Stored per-project on this machine; not committed to the repo.");

		const box = DOM.append(block, $('.locopilot-prompt-box'));
		const textarea = DOM.append(box, $('textarea.locopilot-prompt-textarea')) as HTMLTextAreaElement;
		textarea.classList.remove('locopilot-prompt-textarea-hidden');
		textarea.rows = 8;
		textarea.placeholder = localize(
			'locopilotSettings.workspaceInstructionsPlaceholder',
			"e.g.\n- This is a Next.js app; components live in src/components and use named exports.\n- Run tests with `npm run test`; lint with `npm run lint`.\n- Never edit anything under legacy/ - it is generated.\n- Prefer tabs over spaces; keep imports sorted."
		);
		textarea.value = this.projectMemoryService.getWorkspaceInstructions();
		if (!this.projectMemoryService.hasWorkspace()) {
			textarea.disabled = true;
			const noWs = DOM.append(block, $('.agent-setting-hint'));
			noWs.textContent = localize('locopilotSettings.workspaceInstructionsNoWorkspace', "Open a folder to set instructions for a project.");
		}
		this.workspaceInstructionsTextarea = textarea;
		this._register(DOM.addDisposableListener(textarea, 'input', () => this.updateAgentSettingsDirtyIndicators()));
	}

	/** Live-validates the max-iterations field, toggling an error state + hint text. */
	private validateMaxIterations(): void {
		if (!this.maxIterationsInput || !this.maxIterationsHint) { return; }
		const n = parseInt(this.maxIterationsInput.value.trim(), 10);
		const valid = !isNaN(n) && n >= 10 && n <= 500;
		this.maxIterationsInput.element.classList.toggle('agent-setting-input-invalid', !valid);
		this.maxIterationsHint.classList.toggle('agent-setting-hint-error', !valid);
		this.maxIterationsHint.textContent = valid
			? localize('locopilotSettings.maxIterationsHint', "Between 10 and 500.")
			: localize('locopilotSettings.maxIterationsHintError', "Enter a number between 10 and 500.");
	}

	private takeAgentSettingsSnapshotFromPersisted(): {
		maxIterations: number;
		autoRunSandbox: boolean;
		braveApiKey: string;
		askCoding: boolean;
		agentCoding: boolean;
		planCoding: boolean;
		askPrompt: string;
		agentPrompt: string;
		planPrompt: string;
		workspaceInstructions: string;
	} {
		return {
			maxIterations: this.agentSettingsService.getMaxIterationsPerRequest(),
			autoRunSandbox: this.agentSettingsService.getAutoRunCommandsInSandbox(),
			braveApiKey: (this.configurationService.getValue<string>(ChatConfiguration.WebSearchApiKey) ?? '').trim(),
			askCoding: this.agentSettingsService.getAskUseCodingSystemPrompt(),
			agentCoding: this.agentSettingsService.getAgentUseCodingSystemPrompt(),
			planCoding: this.agentSettingsService.getPlanUseCodingSystemPrompt(),
			askPrompt: this.agentSettingsService.getAskModeSystemPrompt().trim(),
			agentPrompt: this.agentSettingsService.getAgentModeSystemPrompt().trim(),
			planPrompt: this.agentSettingsService.getPlanModeSystemPrompt().trim(),
			workspaceInstructions: this.projectMemoryService.getWorkspaceInstructions().trim(),
		};
	}

	private snapshotAgentPanelFromUI(): {
		maxIterations: number;
		autoRunSandbox: boolean;
		braveApiKey: string;
		askCoding: boolean;
		agentCoding: boolean;
		planCoding: boolean;
		askPrompt: string;
		agentPrompt: string;
		planPrompt: string;
		workspaceInstructions: string;
	} {
		const rawN = parseInt(this.maxIterationsInput.value.trim(), 10);
		return {
			maxIterations: isNaN(rawN) ? -1 : rawN,
			autoRunSandbox: this.autoRunCommandsInSandboxToggle.checked,
			braveApiKey: this.braveApiKeyInput.value.trim(),
			askCoding: this.askCodingSystemPromptToggle.checked,
			agentCoding: this.agentCodingSystemPromptToggle.checked,
			planCoding: this.planCodingSystemPromptToggle.checked,
			askPrompt: this.askPromptTextarea.value.trim(),
			agentPrompt: this.agentPromptTextarea.value.trim(),
			planPrompt: this.planPromptTextarea.value.trim(),
			workspaceInstructions: this.workspaceInstructionsTextarea.value.trim(),
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
			b.braveApiKey !== cur.braveApiKey ||
			b.askCoding !== cur.askCoding ||
			b.agentCoding !== cur.agentCoding ||
			b.planCoding !== cur.planCoding ||
			b.askPrompt !== cur.askPrompt ||
			b.agentPrompt !== cur.agentPrompt ||
			b.planPrompt !== cur.planPrompt ||
			b.workspaceInstructions !== cur.workspaceInstructions
		);
	}

	private updateAgentSettingsDirtyIndicators(): void {
		const dirty = this.isAgentSettingsDirty();
		this.agentSettingsSaveBtn.enabled = dirty;
		this.agentSettingsCancelBtn.enabled = dirty;
		if (this.agentSettingsDirtyIndicator) {
			this.agentSettingsDirtyIndicator.classList.toggle('visible', dirty);
		}
	}

	private updateCodingPromptUIMode(which: 'agent' | 'ask' | 'plan'): void {
		// `checked === true` means Default (built-in prompt): hide the prompt box entirely.
		// Override (false) reveals the editable box.
		const { toggle, textarea, formatted } = this.promptModeFields(which);
		const useBuiltin = toggle.checked;
		const box = formatted.parentElement; // .locopilot-prompt-box
		textarea.disabled = useBuiltin;
		if (useBuiltin) {
			box?.classList.add('locopilot-prompt-box-hidden');
		} else {
			box?.classList.remove('locopilot-prompt-box-hidden');
			// Reset to the read-only formatted view whenever Override is (re)selected.
			formatted.classList.remove('locopilot-prompt-formatted-hidden');
			formatted.setAttribute('role', 'button');
			formatted.tabIndex = 0;
			formatted.title = localize('locopilotSettings.clickToEdit', "Click to edit");
			textarea.classList.add('locopilot-prompt-textarea-hidden');
		}
	}

	private updateCodingPromptUIModes(): void {
		this.updateCodingPromptUIMode('agent');
		this.updateCodingPromptUIMode('ask');
		this.updateCodingPromptUIMode('plan');
	}

	private loadAgentPanelFromPersisted(): void {
		this.maxIterationsInput.value = String(this.agentSettingsService.getMaxIterationsPerRequest());
		this.validateMaxIterations();
		this.autoRunCommandsInSandboxToggle.checked = this.agentSettingsService.getAutoRunCommandsInSandbox();
		this.braveApiKeyInput.value = this.configurationService.getValue<string>(ChatConfiguration.WebSearchApiKey) ?? '';
		this.askCodingSystemPromptToggle.checked = this.agentSettingsService.getAskUseCodingSystemPrompt();
		this.agentCodingSystemPromptToggle.checked = this.agentSettingsService.getAgentUseCodingSystemPrompt();
		this.planCodingSystemPromptToggle.checked = this.agentSettingsService.getPlanUseCodingSystemPrompt();
		this.askPromptTextarea.value = this.agentSettingsService.getAskModeSystemPrompt();
		this.agentPromptTextarea.value = this.agentSettingsService.getAgentModeSystemPrompt();
		this.planPromptTextarea.value = this.agentSettingsService.getPlanModeSystemPrompt();
		this.workspaceInstructionsTextarea.value = this.projectMemoryService.getWorkspaceInstructions();
		this.updateCodingPromptUIModes();
		this._renderFormattedPrompt('agent');
		this._renderFormattedPrompt('ask');
		this._renderFormattedPrompt('plan');
		this.agentPromptFormattedView.classList.remove('locopilot-prompt-formatted-hidden');
		this.askPromptFormattedView.classList.remove('locopilot-prompt-formatted-hidden');
		this.planPromptFormattedView.classList.remove('locopilot-prompt-formatted-hidden');
		this.agentPromptTextarea.classList.add('locopilot-prompt-textarea-hidden');
		this.askPromptTextarea.classList.add('locopilot-prompt-textarea-hidden');
		this.planPromptTextarea.classList.add('locopilot-prompt-textarea-hidden');
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
			// Persist the Brave Search API key. Empty -> clear the setting so the webSearch tool
			// falls back to free DuckDuckGo search.
			const braveKey = this.braveApiKeyInput.value.trim();
			await this.configurationService.updateValue(ChatConfiguration.WebSearchApiKey, braveKey === '' ? undefined : braveKey);
			this.agentSettingsService.setAskUseCodingSystemPrompt(this.askCodingSystemPromptToggle.checked);
			this.agentSettingsService.setAgentUseCodingSystemPrompt(this.agentCodingSystemPromptToggle.checked);
			this.agentSettingsService.setPlanUseCodingSystemPrompt(this.planCodingSystemPromptToggle.checked);
			this.agentSettingsService.setAskModeSystemPrompt(this.askPromptTextarea.value.trim());
			this.agentSettingsService.setAgentModeSystemPrompt(this.agentPromptTextarea.value.trim());
			this.agentSettingsService.setPlanModeSystemPrompt(this.planPromptTextarea.value.trim());
			if (this.projectMemoryService.hasWorkspace()) {
				this.projectMemoryService.setWorkspaceInstructions(this.workspaceInstructionsTextarea.value.trim());
			}
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

	private _renderFormattedPrompt(which: 'agent' | 'ask' | 'plan'): void {
		const { textarea, formatted: container, getRendered, setRendered } = this.promptModeFields(which);
		const prev = getRendered();
		if (prev) {
			prev.dispose();
			setRendered(undefined);
		}
		// In Default mode the whole box is hidden, so only the Override content matters here.
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

	private _switchToEditPrompt(which: 'agent' | 'ask' | 'plan'): void {
		const { toggle, formatted, textarea } = this.promptModeFields(which);
		if (toggle.checked) {
			return;
		}
		formatted.classList.add('locopilot-prompt-formatted-hidden');
		textarea.classList.remove('locopilot-prompt-textarea-hidden');
		textarea.focus();
	}

	private _switchToFormattedPrompt(which: 'agent' | 'ask' | 'plan'): void {
		const { formatted, textarea } = this.promptModeFields(which);
		this._renderFormattedPrompt(which);
		formatted.classList.remove('locopilot-prompt-formatted-hidden');
		textarea.classList.add('locopilot-prompt-textarea-hidden');
	}

	private cancelAgentSettings(): void {
		this.loadAgentPanelFromPersisted();
	}

	/**
	 * Render the "Parameters" range slider below the dropdown filters. A custom two-handle slider (real
	 * pointer dragging - native overlapping range inputs don't drag reliably in Electron) bounded by the
	 * smallest/largest parameter count among the models, rounded out to "nice" endpoints (e.g. 0.6B/34.8B
	 * -> 0.5B/64B). Handles default to the full extent ("All sizes"); dragging filters the list on release.
	 * Hidden when fewer than two distinct parameter counts exist (nothing to range over).
	 */
	private renderParamsRangeFilter(stickyTop: HTMLElement, allModels: ICustomLanguageModel[]): void {
		let dataMin: number | undefined;
		let dataMax: number | undefined;
		for (const m of allModels) {
			const params = parseModelParamsB(getCustomModelListLabel(m));
			if (params === undefined) { continue; }
			dataMin = dataMin === undefined ? params : Math.min(dataMin, params);
			dataMax = dataMax === undefined ? params : Math.max(dataMax, params);
		}
		if (dataMin === undefined || dataMax === undefined || dataMin >= dataMax) {
			// Nothing to range over - drop any stale filter so the list isn't silently constrained.
			this.modelParamsFilter = undefined;
			return;
		}

		// Round the rail out to clean power-of-two-ish endpoints so the scale reads nicely (0.5B ... 64B).
		const LADDER = [0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
		const railMin = [...LADDER].reverse().find(v => v <= dataMin!) ?? dataMin;
		const railMax = LADDER.find(v => v >= dataMax!) ?? dataMax;
		const range = railMax - railMin || 1;

		// Clamp any active filter to the current rail (model set may have changed since it was set).
		const clamp = (v: number) => Math.max(railMin, Math.min(v, railMax));
		const state = this.modelParamsFilter
			? { min: clamp(this.modelParamsFilter.min), max: clamp(this.modelParamsFilter.max) }
			: { min: railMin, max: railMax };

		const fieldset = DOM.append(stickyTop, $('fieldset.models-filter.models-params-filter'));
		const legend = DOM.append(fieldset, $('legend.models-filter-label'));
		legend.textContent = localize('customLanguageModels.filter.paramsLabel', 'Parameters');

		const slider = DOM.append(fieldset, $('.models-params-slider'));
		DOM.append(slider, $('.models-params-rail'));
		const fill = DOM.append(slider, $('.models-params-fill'));
		const minHandle = DOM.append(slider, $('.models-params-handle.models-params-handle-min'));
		const maxHandle = DOM.append(slider, $('.models-params-handle.models-params-handle-max'));
		minHandle.tabIndex = 0;
		maxHandle.tabIndex = 0;
		minHandle.setAttribute('role', 'slider');
		maxHandle.setAttribute('role', 'slider');
		minHandle.setAttribute('aria-label', localize('customLanguageModels.filter.minParams', 'Minimum parameters'));
		maxHandle.setAttribute('aria-label', localize('customLanguageModels.filter.maxParams', 'Maximum parameters'));

		const scale = DOM.append(fieldset, $('.models-params-scale'));
		const minLabel = DOM.append(scale, $('span.models-params-minlabel'));
		const maxLabel = DOM.append(scale, $('span.models-params-maxlabel'));

		const pct = (v: number) => ((v - railMin) / range) * 100;
		const layout = () => {
			minHandle.style.left = `${pct(state.min)}%`;
			maxHandle.style.left = `${pct(state.max)}%`;
			fill.style.left = `${pct(state.min)}%`;
			fill.style.width = `${Math.max(0, pct(state.max) - pct(state.min))}%`;
			// At the extremes the bucket is open-ended ("< 0.5B" / "> 64B") - everything below/above is shown.
			minLabel.textContent = state.min <= railMin ? `< ${formatParamsB(railMin)}` : formatParamsB(state.min);
			maxLabel.textContent = state.max >= railMax ? `> ${formatParamsB(railMax)}` : formatParamsB(state.max);
			minHandle.setAttribute('aria-valuenow', String(state.min));
			maxHandle.setAttribute('aria-valuenow', String(state.max));
		};

		const commit = () => {
			this.modelParamsFilter = (state.min <= railMin && state.max >= railMax) ? undefined : { min: state.min, max: state.max };
			this.renderListModels();
		};

		const valueAt = (clientX: number): number => {
			const rect = slider.getBoundingClientRect();
			const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
			const v = railMin + Math.max(0, Math.min(1, ratio)) * range;
			return Math.round(v * 10) / 10; // snap to 0.1B
		};

		const startDrag = (which: 'min' | 'max', downEvent: PointerEvent) => {
			downEvent.preventDefault();
			(which === 'min' ? minHandle : maxHandle).focus();
			const win = DOM.getWindow(slider);
			const moveDisposable = DOM.addDisposableListener(win, DOM.EventType.POINTER_MOVE, (e: PointerEvent) => {
				const v = valueAt(e.clientX);
				if (which === 'min') { state.min = Math.min(v, state.max); }
				else { state.max = Math.max(v, state.min); }
				layout();
			});
			const upDisposable = DOM.addDisposableListener(win, DOM.EventType.POINTER_UP, () => {
				moveDisposable.dispose();
				upDisposable.dispose();
				commit();
			});
		};
		this._register(DOM.addDisposableListener(minHandle, DOM.EventType.POINTER_DOWN, (e: PointerEvent) => startDrag('min', e)));
		this._register(DOM.addDisposableListener(maxHandle, DOM.EventType.POINTER_DOWN, (e: PointerEvent) => startDrag('max', e)));

		// Keyboard: arrow keys nudge the focused handle by one snap step.
		const onKey = (which: 'min' | 'max', e: KeyboardEvent) => {
			const delta = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.1 : (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.1 : 0);
			if (delta === 0) { return; }
			e.preventDefault();
			if (which === 'min') { state.min = Math.max(railMin, Math.min(clamp(Math.round((state.min + delta) * 10) / 10), state.max)); }
			else { state.max = Math.min(railMax, Math.max(clamp(Math.round((state.max + delta) * 10) / 10), state.min)); }
			layout();
			commit();
		};
		this._register(DOM.addDisposableListener(minHandle, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => onKey('min', e)));
		this._register(DOM.addDisposableListener(maxHandle, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => onKey('max', e)));

		layout();
	}

	private resetModelFilters(): void {
		this.modelSearchQuery = '';
		this.pinnedModelId = undefined;
		this.modelTypeFilter = 'all';
		this.modelStatusFilter = 'all';
		this.modelVisibilityFilter = 'all';
		this.modelBestFilter = 'all';
		this.modelToolsFilter = false;
		this.modelMtpFilter = false;
		this.modelParamsFilter = undefined;
		this.modelsIncompatibleExpanded = false;
	}

	/**
	 * Detected system RAM in GB (0 until measured). Sourced from the startup metrics the timer service
	 * collects on every platform (Win/macOS/Linux), so no node `os` import is needed in this browser-layer
	 * editor. Cached because `timerService.startupMetrics` THROWS if read before `whenReady()` resolves -
	 * {@link primeHardwareDetection} fills this in and re-renders once metrics are available.
	 */
	private detectedRamGBValue = 0;

	private detectedRamGB(): number {
		return this.detectedRamGBValue;
	}

	/** Read system RAM once startup metrics are ready, then re-render so the badges/Best filter appear. */
	private primeHardwareDetection(): void {
		this.timerService.whenReady().then(() => {
			let totalmem: number | undefined;
			try {
				totalmem = this.timerService.startupMetrics.totalmem;
			} catch {
				totalmem = undefined;
			}
			if (typeof totalmem === 'number' && totalmem > 0) {
				this.detectedRamGBValue = totalmem / (1024 * 1024 * 1024);
				if (this.listModelsContainer) { this.renderListModels(); }
			}
		});
	}

	/** How well a stored model fits this machine. Non-catalog (custom/cloud) models return 'unknown'. */
	private modelSuitability(model: ICustomLanguageModel): ModelSuitability {
		const entry = findCatalogEntry(model.modelName, model.format);
		return getCatalogSuitability(entry, this.detectedRamGB(), isAppleSiliconMac());
	}

	/**
	 * Whether this model is THE single "Best for you" recommendation for the detected RAM - the curated
	 * comfortable pick shared with the chat model picker (see {@link getRecommendedRepoId}). Only one catalog
	 * model qualifies per machine; needs detected RAM. Drives the "Best for you" tick/chip so the model list
	 * and the picker always badge the same model.
	 */
	private isRecommendedForSystem(model: ICustomLanguageModel): boolean {
		const ramGB = this.detectedRamGB();
		return ramGB > 0 && model.modelName === getRecommendedRepoId(ramGB);
	}

	private renderSelectedSection(): void {
		// Never leave the logs modal open across a section switch or a return to the settings page.
		if (this.logsBackdropEl && this.logsBackdropEl.style.display !== 'none') {
			this._hideLogsOverlay();
		}
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

	override async setInput(input: LoCoPilotSettingsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.switchToSection(input.initialSection, input.focusModelId);
	}

	/**
	 * Navigate the (already open) settings editor to a section and optionally focus a model.
	 * Called from setInput when the editor is first opened, and directly by the
	 * `openLoCoPilotSettings` command when the editor is already open in some tab/group -
	 * in that case openEditor just reveals the existing input without re-running setInput,
	 * so the command must drive the section switch itself. This is what makes chat-panel
	 * links (Open My Models, etc.) work even when LoCoPilot Settings is already open.
	 */
	switchToSection(section?: string, focusModelId?: string): void {
		if (section) {
			const previousSection = this.selectedSection;
			this.selectedSection = section;
			if (section === LOCOPILOT_SETTINGS_SECTION_ADD_MODEL && previousSection !== LOCOPILOT_SETTINGS_SECTION_ADD_MODEL) {
				this.resetAddModelFormToDefaults();
			}
			if (section === LOCOPILOT_SETTINGS_SECTION_LIST_MODELS && previousSection !== LOCOPILOT_SETTINGS_SECTION_LIST_MODELS) {
				this.resetModelFilters();
			}
			this.updateTabSelection();
			this.renderSelectedSection();
		}
		if (focusModelId) {
			const focusedModel = this.customLanguageModelsService.getCustomModels().find(m => m.id === focusModelId);
			if (focusedModel) {
				// Clear any pre-existing filters so the focused model can't be hidden by a
				// stale type/status/visibility filter. We pin it to the top of the list rather than
				// filtering down to a search result, so the user sees the downloading model first
				// while still being able to scroll through running and other models below.
				this.resetModelFilters();
				this.pinnedModelId = focusModelId;
				this.renderListModels();
				// Scroll the tile into view and briefly highlight it
				// eslint-disable-next-line no-restricted-syntax
				const tile = this.listModelsContainer?.querySelector(`[data-model-id="${focusModelId}"]`) as HTMLElement | null;
				if (tile) {
					tile.classList.add('model-item-highlight');
					tile.scrollIntoView({ behavior: 'smooth', block: 'center' });
					setTimeout(() => tile.classList.remove('model-item-highlight'), 2000);
				}
			}
		}
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		// Layout is driven by flexbox CSS; nothing imperative to do here.
	}

	override focus(): void {
		super.focus();
		this.tabButtons.get(this.selectedSection)?.focus();
	}
}

