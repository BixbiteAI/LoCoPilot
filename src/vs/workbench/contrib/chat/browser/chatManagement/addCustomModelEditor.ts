/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/addCustomModelEditor.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { AddCustomModelEditorInput } from './addCustomModelEditorInput.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { ICustomLanguageModelsService, getCustomModelListLabel, DEFAULT_CONTEXT_WINDOW_LOCAL } from '../../common/customLanguageModelsService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { SelectBox, ISelectOptionItem, ISelectData } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { defaultButtonStyles, getInputBoxStyle, getSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { settingsSelectBackground, settingsSelectBorder, settingsSelectForeground, settingsSelectListBorder, settingsTextInputBackground, settingsTextInputBorder, settingsTextInputForeground } from '../../../preferences/common/settingsEditorColorRegistry.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { ENDPOINT_FALLBACK_CONTEXT_WINDOW } from '../locopilotEndpointProbe.js';

const $ = DOM.$;

/** Same input/select styles as main Settings editor for consistent look. */
const settingsStyleInputBox = getInputBoxStyle({
	inputBackground: settingsTextInputBackground,
	inputForeground: settingsTextInputForeground,
	inputBorder: settingsTextInputBorder
});
const settingsStyleSelectBox = getSelectBoxStyles({
	selectBackground: settingsSelectBackground,
	selectForeground: settingsSelectForeground,
	selectBorder: settingsSelectBorder,
	selectListBorder: settingsSelectListBorder
});

const CLOUD_PROVIDERS: ISelectOptionItem[] = [
	{ text: 'Anthropic', description: '' },
	{ text: 'OpenAI', description: '' },
	{ text: 'Google', description: '' },
	{ text: 'Hugging Face', description: '' },
];

/** Display label for the custom-endpoint provider; the id persisted on the model stays `localhost`. */
const CUSTOM_ENDPOINT_LABEL = 'Custom Endpoint';
const CUSTOM_ENDPOINT_PROVIDER_ID = 'localhost';

const LOCAL_PROVIDERS: ISelectOptionItem[] = [
	{ text: 'HuggingFace', description: '' },
	{ text: CUSTOM_ENDPOINT_LABEL, description: '' },
];

export class AddCustomModelEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.addCustomModel';

	private readonly editorDisposables = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	private bodyContainer: HTMLElement | undefined;

	private modelTypeSegments: HTMLElement[] = [];
	private providerSelectBox!: SelectBox;
	private apiKeyInputBox!: InputBox;
	private tokenInputBox!: InputBox;
	private modelNameInputBox!: InputBox;
	private modelNameLabel!: HTMLElement;
	private displayNameContainer!: HTMLElement;
	private displayNameInputBox!: InputBox;
	private localhostModelIdContainer!: HTMLElement;
	private localhostModelIdInputBox!: InputBox;
	private contextWindowContainer!: HTMLElement;
	private contextWindowInputBox!: InputBox;
	private hfRoutingContainer!: HTMLElement;
	private hfFastestCheckbox!: HTMLInputElement;
	private addButton!: Button;

	private currentModelType: 'cloud' | 'local' = 'cloud';
	private currentProviderIndex: number = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@IDialogService private readonly dialogService: IDialogService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super(AddCustomModelEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.bodyContainer = DOM.append(parent, $('.add-custom-model-editor'));
		this.createForm();
	}

	private createForm(): void {
		if (!this.bodyContainer) {
			return;
		}

		const formContainer = DOM.append(this.bodyContainer, $('.add-custom-model-form'));

		// Title
		const title = DOM.append(formContainer, $('h2.form-title'));
		title.textContent = localize('addCustomModel.title', 'Add Language Model');
		const subtitle = DOM.append(formContainer, $('p.form-subtitle'));
		subtitle.textContent = localize('addCustomModel.subtitle', 'Connect a cloud provider or a local model. It will appear in the model list and the Auto dropdown.');

		// Model Type (segmented control)
		const modelTypeContainer = DOM.append(formContainer, $('.form-field'));
		const modelTypeLabel = DOM.append(modelTypeContainer, $('label.form-label'));
		modelTypeLabel.textContent = localize('addCustomModel.modelType', 'Model Type');
		const segmented = DOM.append(modelTypeContainer, $('.segmented-control'));
		const segmentDefs: Array<{ label: string; type: 'cloud' | 'local' }> = [
			{ label: localize('addCustomModel.cloud', 'Cloud'), type: 'cloud' },
			{ label: localize('addCustomModel.local', 'Local'), type: 'local' }
		];
		this.modelTypeSegments = segmentDefs.map(def => {
			const seg = DOM.append(segmented, $('button.segment'));
			seg.textContent = def.label;
			seg.classList.toggle('active', def.type === this.currentModelType);
			this._register(DOM.addDisposableListener(seg, DOM.EventType.CLICK, () => {
				if (this.currentModelType === def.type) {
					return;
				}
				this.currentModelType = def.type;
				this.currentProviderIndex = 0;
				this.modelTypeSegments.forEach((s, i) => s.classList.toggle('active', segmentDefs[i].type === def.type));
				this.updateProviderOptions();
				this.updateInputFields();
			}));
			return seg;
		});

		// Provider
		const providerContainer = DOM.append(formContainer, $('.form-field'));
		const providerLabel = DOM.append(providerContainer, $('label.form-label'));
		providerLabel.textContent = localize('addCustomModel.provider', 'Model Provider');
		const providerSelectContainer = DOM.append(providerContainer, $('.form-input-container'));
		this.providerSelectBox = this._register(new SelectBox(CLOUD_PROVIDERS, 0, this.contextViewService, settingsStyleSelectBox));
		this.providerSelectBox.render(providerSelectContainer);
		this._register(this.providerSelectBox.onDidSelect((e: ISelectData) => {
			this.currentProviderIndex = e.index;
			this.updateInputFields();
		}));

		// API Key (for cloud)
		const apiKeyContainer = DOM.append(formContainer, $('.form-field'));
		const apiKeyLabel = DOM.append(apiKeyContainer, $('label.form-label'));
		apiKeyLabel.textContent = localize('addCustomModel.apiKey', 'API Key');
		const apiKeyInputContainer = DOM.append(apiKeyContainer, $('.form-input-container'));
		this.apiKeyInputBox = this._register(new InputBox(apiKeyInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.apiKeyPlaceholder', 'Enter your API key'),
			type: 'password',
			inputBoxStyles: settingsStyleInputBox
		}));

		// Token (for local)
		const tokenContainer = DOM.append(formContainer, $('.form-field'));
		tokenContainer.style.display = 'none';
		const tokenLabel = DOM.append(tokenContainer, $('label.form-label'));
		tokenLabel.textContent = localize('addCustomModel.token', 'Token (Optional)');
		const tokenHelp = DOM.append(tokenContainer, $('span.form-help'));
		tokenHelp.textContent = localize('addCustomModel.tokenHelp', 'Needed only for gated or private models.');
		const tokenInputContainer = DOM.append(tokenContainer, $('.form-input-container'));
		this.tokenInputBox = this._register(new InputBox(tokenInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.tokenPlaceholder', 'Enter your token (e.g., HuggingFace token)'),
			type: 'password',
			inputBoxStyles: settingsStyleInputBox
		}));

		// Model Name / Localhost URL
		const modelNameContainer = DOM.append(formContainer, $('.form-field'));
		this.modelNameLabel = DOM.append(modelNameContainer, $('label.form-label'));
		this.modelNameLabel.textContent = localize('addCustomModel.modelName', 'Model Name');
		const modelNameInputContainer = DOM.append(modelNameContainer, $('.form-input-container'));
		this.modelNameInputBox = this._register(new InputBox(modelNameInputContainer, this.contextViewService, {
			placeholder: localize('addCustomModel.modelNamePlaceholder', 'e.g., gpt-4, claude-3-opus, llama-2-7b'),
			inputBoxStyles: settingsStyleInputBox
		}));

		this.localhostModelIdContainer = DOM.append(formContainer, $('.form-field'));
		this.localhostModelIdContainer.style.display = 'none';
		const lmLabel = DOM.append(this.localhostModelIdContainer, $('label.form-label'));
		lmLabel.textContent = localize('addCustomModel.localhostServerModelId', 'Server model id (optional)');
		const lmInputWrap = DOM.append(this.localhostModelIdContainer, $('.form-input-container'));
		this.localhostModelIdInputBox = this._register(new InputBox(lmInputWrap, this.contextViewService, {
			placeholder: localize('addCustomModel.localhostServerModelIdPlaceholder', 'Only needed if your server requires a specific id'),
			inputBoxStyles: settingsStyleInputBox
		}));

		// Context window: required for a custom endpoint, because LoCoPilot does not run that server and so
		// cannot read back the window it launched with. Guessing high makes the server silently truncate the
		// prompt from the left - dropping the instructions first - with no error anywhere.
		this.contextWindowContainer = DOM.append(formContainer, $('.form-field'));
		this.contextWindowContainer.style.display = 'none';
		const cwLabel = DOM.append(this.contextWindowContainer, $('label.form-label'));
		cwLabel.textContent = localize('addCustomModel.contextWindow', 'Context window');
		const cwInputWrap = DOM.append(this.contextWindowContainer, $('.form-input-container'));
		this.contextWindowInputBox = this._register(new InputBox(cwInputWrap, this.contextViewService, {
			placeholder: String(DEFAULT_CONTEXT_WINDOW_LOCAL),
			inputBoxStyles: settingsStyleInputBox
		}));
		this.contextWindowInputBox.inputElement.setAttribute('inputmode', 'numeric');

		// Routing policy toggle (Hugging Face cloud only): off = cheapest, on = fastest
		this.hfRoutingContainer = DOM.append(formContainer, $('.form-field'));
		this.hfRoutingContainer.style.display = 'none';
		const hfRoutingLabel = DOM.append(this.hfRoutingContainer, $('label.form-label'));
		hfRoutingLabel.textContent = localize('addCustomModel.hfRouting', 'Routing');
		const hfRoutingWrap = DOM.append(this.hfRoutingContainer, $('.form-input-container'));
		const hfRoutingInline = DOM.append(hfRoutingWrap, $('label.hf-routing-toggle'));
		this.hfFastestCheckbox = DOM.append(hfRoutingInline, $('input')) as HTMLInputElement;
		this.hfFastestCheckbox.type = 'checkbox';
		const hfRoutingText = DOM.append(hfRoutingInline, $('span'));
		hfRoutingText.textContent = localize('addCustomModel.hfRoutingHint', 'Prefer fastest provider (off = cheapest)');

		this.displayNameContainer = DOM.append(formContainer, $('.form-field'));
		const dnLabel = DOM.append(this.displayNameContainer, $('label.form-label'));
		dnLabel.textContent = localize('addCustomModel.displayNameOptional', 'Display name (optional)');
		const dnInputWrap = DOM.append(this.displayNameContainer, $('.form-input-container'));
		this.displayNameInputBox = this._register(new InputBox(dnInputWrap, this.contextViewService, {
			placeholder: localize('addCustomModel.displayNamePlaceholder', 'Shown in the model list and Auto dropdown; must be unique if set'),
			inputBoxStyles: settingsStyleInputBox
		}));

		// Actions: Reset (secondary) + Add Model (primary), right-aligned
		const buttonContainer = DOM.append(formContainer, $('.form-actions'));
		const resetButton = this._register(new Button(buttonContainer, { ...defaultButtonStyles, secondary: true }));
		resetButton.label = localize('addCustomModel.reset', 'Reset');
		this._register(resetButton.onDidClick(() => this.resetForm()));
		this.addButton = this._register(new Button(buttonContainer, { ...defaultButtonStyles }));
		this.addButton.label = localize('addCustomModel.add', 'Add Model');
		this._register(this.addButton.onDidClick(() => this.handleAddModel()));

		// Initialize label based on current selection (after all fields are created)
		this.updateModelNameLabel();
	}

	private updateProviderOptions(): void {
		const providers = this.currentModelType === 'cloud' ? CLOUD_PROVIDERS : LOCAL_PROVIDERS;
		this.providerSelectBox.setOptions(providers, 0);
		this.currentProviderIndex = 0;
		// Update label after provider options change
		this.updateModelNameLabel();
	}

	private updateInputFields(): void {
		const apiKeyContainer = this.apiKeyInputBox.element.parentElement?.parentElement;
		const tokenContainer = this.tokenInputBox.element.parentElement?.parentElement;
		const providers = this.currentModelType === 'cloud' ? CLOUD_PROVIDERS : LOCAL_PROVIDERS;
		const provider = providers[this.currentProviderIndex];
		const isEndpoint = this.currentModelType === 'local' && provider.text === CUSTOM_ENDPOINT_LABEL;
		const isHfCloud = this.currentModelType === 'cloud' && provider.text === 'Hugging Face';

		if (this.hfRoutingContainer) {
			this.hfRoutingContainer.style.display = isHfCloud ? '' : 'none';
		}

		if (this.currentModelType === 'cloud') {
			if (apiKeyContainer) {
				apiKeyContainer.style.display = '';
			}
			if (tokenContainer) {
				tokenContainer.style.display = 'none';
			}
		} else {
			// A custom endpoint may require a bearer token (llama-server --api-key, vLLM, a reverse proxy);
			// optional, since a bare loopback server needs none.
			if (apiKeyContainer) {
				apiKeyContainer.style.display = isEndpoint ? '' : 'none';
			}
			// Hide token field for a custom endpoint, show for HuggingFace
			if (tokenContainer) {
				tokenContainer.style.display = isEndpoint ? 'none' : '';
			}
		}
		if (this.localhostModelIdContainer) {
			this.localhostModelIdContainer.style.display = isEndpoint ? '' : 'none';
		}
		if (this.contextWindowContainer) {
			this.contextWindowContainer.style.display = isEndpoint ? '' : 'none';
		}

		// Update model name label when fields change
		this.updateModelNameLabel();
	}

	private updateModelNameLabel(): void {
		if (!this.modelNameLabel) {
			return;
		}

		const providers = this.currentModelType === 'cloud' ? CLOUD_PROVIDERS : LOCAL_PROVIDERS;
		const provider = providers[this.currentProviderIndex];
		const isEndpoint = this.currentModelType === 'local' && provider.text === CUSTOM_ENDPOINT_LABEL;

		if (isEndpoint) {
			this.modelNameLabel.textContent = localize('addCustomModel.endpointUrl', 'Endpoint URL');
			this.modelNameInputBox.setPlaceHolder(localize('addCustomModel.endpointUrlPlaceholder', 'e.g., http://192.168.1.50:8080/v1/chat/completions'));
		} else {
			this.modelNameLabel.textContent = localize('addCustomModel.modelName', 'Model Name');
			this.modelNameInputBox.setPlaceHolder(localize('addCustomModel.modelNamePlaceholder', 'e.g., gpt-4, claude-3-opus, llama-2-7b'));
		}
	}

	private resetForm(): void {
		// Reset selections back to defaults (Cloud + first provider)
		this.currentModelType = 'cloud';
		this.currentProviderIndex = 0;
		this.modelTypeSegments.forEach((s, i) => s.classList.toggle('active', i === 0));
		this.updateProviderOptions();
		this.updateInputFields();

		// Clear all input values
		this.modelNameInputBox.value = '';
		this.displayNameInputBox.value = '';
		this.localhostModelIdInputBox.value = '';
		this.contextWindowInputBox.value = '';
		this.apiKeyInputBox.value = '';
		this.tokenInputBox.value = '';
		this.hfFastestCheckbox.checked = false;
		this.modelNameInputBox.focus();
	}

	private async handleAddModel(): Promise<void> {
		const providers = this.currentModelType === 'cloud' ? CLOUD_PROVIDERS : LOCAL_PROVIDERS;
		const provider = providers[this.currentProviderIndex];
		const isHfCloud = this.currentModelType === 'cloud' && provider.text === 'Hugging Face';
		// Cloud "Hugging Face" => HF Inference Providers router. Use a distinct id so it does
		// not collide with the local `huggingface` (GGUF/MLX) provider. The custom-endpoint entry keeps its
		// legacy `localhost` id so existing user settings continue to resolve.
		const providerValue = isHfCloud
			? 'huggingface-cloud'
			: (provider.text === CUSTOM_ENDPOINT_LABEL ? CUSTOM_ENDPOINT_PROVIDER_ID : provider.text.toLowerCase().replace(/\s+/g, ''));
		const isEndpoint = providerValue === CUSTOM_ENDPOINT_PROVIDER_ID;
		const modelName = this.modelNameInputBox.value.trim();
		const localhostServerModelId = isEndpoint ? this.localhostModelIdInputBox.value.trim() : '';
		const displayNameOpt = this.displayNameInputBox.value.trim();
		// The key field serves cloud providers and custom endpoints (optional for the latter).
		const apiKeyRaw = this.apiKeyInputBox.value.trim();
		const apiKey = (this.currentModelType === 'cloud' || isEndpoint) ? (apiKeyRaw || undefined) : undefined;
		// Token is only needed for HuggingFace, not for a custom endpoint
		const token = (this.currentModelType === 'local' && !isEndpoint) ? this.tokenInputBox.value.trim() : undefined;

		// Validation
		let endpointContextWindow: number | undefined;
		if (isEndpoint) {
			if (!modelName) {
				await this.dialogService.error(localize('addCustomModel.error.endpointUrlRequired', 'Endpoint URL is required.'));
				return;
			}
			if (!/^https?:\/\//i.test(modelName)) {
				await this.dialogService.error(localize('addCustomModel.error.endpointUrlScheme', 'Enter the full endpoint URL including http:// or https:// (for example http://192.168.1.50:8080/v1/chat/completions).'));
				return;
			}
			// Server model id is optional: with none set the provider sends "local", which llama.cpp ignores.
			// Only servers that key off it (mlx_lm, vLLM) need a real value.
			// We do not run this server, so its real context window is unknowable from here. An explicit value
			// is honoured; otherwise fall back LOW rather than high - guessing high makes the server silently
			// drop the oldest part of every prompt instead of reporting an error.
			const cwRaw = this.contextWindowInputBox.value.trim();
			if (cwRaw) {
				if (!/^\d+$/.test(cwRaw) || Number(cwRaw) < 512) {
					await this.dialogService.error(localize('addCustomModel.error.contextWindowNumeric', 'Context window must be a plain number of tokens of at least 512, for example {0}.', DEFAULT_CONTEXT_WINDOW_LOCAL));
					return;
				}
				endpointContextWindow = Number(cwRaw);
			} else {
				endpointContextWindow = ENDPOINT_FALLBACK_CONTEXT_WINDOW;
			}
		} else if (!modelName) {
			await this.dialogService.error(localize('addCustomModel.error.modelNameRequired', 'Model name is required'));
			return;
		}

		if (this.currentModelType === 'cloud' && !apiKey) {
			await this.dialogService.error(localize('addCustomModel.error.apiKeyRequired', 'API key is required for cloud providers'));
			return;
		}

		try {
			// Falls back to host:port when no server model id is given, so the list entry is recognisable.
			let nameFallback = modelName;
			if (isEndpoint) {
				try { nameFallback = localhostServerModelId || new URL(modelName).host; } catch { nameFallback = localhostServerModelId || modelName; }
			}
			const added = await this.customLanguageModelsService.addCustomModel({
				name: nameFallback,
				displayName: displayNameOpt || undefined,
				type: this.currentModelType,
				provider: providerValue,
				apiKey,
				token,
				modelName: modelName,
				localhostOpenAiModel: isEndpoint ? localhostServerModelId : undefined,
				contextWindow: endpointContextWindow,
				// A hand-entered window is a statement about the user's own server, so protect it from later
				// enrichment. Every other provider derives its own and is left unmarked.
				userOverrides: isEndpoint && this.contextWindowInputBox.value.trim() ? { contextWindow: true } : undefined,
				hfFastest: isHfCloud ? this.hfFastestCheckbox.checked : undefined,
			});

			await this.dialogService.info(
				localize('addCustomModel.success', 'Model added successfully'),
				localize('addCustomModel.successDetail', 'The model "{0}" has been added and will appear in the "Auto" dropdown.', getCustomModelListLabel(added))
			);

			// Clear form
			this.modelNameInputBox.value = '';
			this.displayNameInputBox.value = '';
			this.localhostModelIdInputBox.value = '';
			this.contextWindowInputBox.value = '';
			this.apiKeyInputBox.value = '';
			this.tokenInputBox.value = '';
			this.hfFastestCheckbox.checked = false;
		} catch (error) {
			await this.dialogService.error(
				localize('addCustomModel.error.addFailed', 'Failed to add model'),
				toErrorMessage(error)
			);
		}
	}

	override async setInput(input: AddCustomModelEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		// Form layout is handled by CSS
	}

	override focus(): void {
		super.focus();
		this.modelNameInputBox.focus();
	}

	override clearInput(): void {
		super.clearInput();
	}
}
