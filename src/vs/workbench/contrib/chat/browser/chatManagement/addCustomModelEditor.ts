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
import { ICustomLanguageModelsService, getCustomModelListLabel } from '../../common/customLanguageModelsService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { SelectBox, ISelectOptionItem, ISelectData } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { defaultButtonStyles, getInputBoxStyle, getSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { settingsSelectBackground, settingsSelectBorder, settingsSelectForeground, settingsSelectListBorder, settingsTextInputBackground, settingsTextInputBorder, settingsTextInputForeground } from '../../../preferences/common/settingsEditorColorRegistry.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';

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
];

const LOCAL_PROVIDERS: ISelectOptionItem[] = [
	{ text: 'HuggingFace', description: '' },
	{ text: 'Localhost', description: '' },
];

export class AddCustomModelEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.addCustomModel';

	private readonly editorDisposables = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	private bodyContainer: HTMLElement | undefined;

	private modelTypeSelectBox!: SelectBox;
	private providerSelectBox!: SelectBox;
	private apiKeyInputBox!: InputBox;
	private tokenInputBox!: InputBox;
	private modelNameInputBox!: InputBox;
	private modelNameLabel!: HTMLElement;
	private displayNameContainer!: HTMLElement;
	private displayNameInputBox!: InputBox;
	private localhostModelIdContainer!: HTMLElement;
	private localhostModelIdInputBox!: InputBox;
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

		// Model Type
		const modelTypeContainer = DOM.append(formContainer, $('.form-field'));
		const modelTypeLabel = DOM.append(modelTypeContainer, $('label.form-label'));
		modelTypeLabel.textContent = localize('addCustomModel.modelType', 'Model Type');
		const modelTypeSelectContainer = DOM.append(modelTypeContainer, $('.form-input-container'));
		this.modelTypeSelectBox = this._register(new SelectBox(
			[
				{ text: localize('addCustomModel.cloud', 'Cloud'), description: '' },
				{ text: localize('addCustomModel.local', 'Local'), description: '' }
			],
			0,
			this.contextViewService,
			settingsStyleSelectBox
		));
		this.modelTypeSelectBox.render(modelTypeSelectContainer);
		this._register(this.modelTypeSelectBox.onDidSelect((e: ISelectData) => {
			this.currentModelType = e.index === 0 ? 'cloud' : 'local';
			this.currentProviderIndex = 0;
			this.updateProviderOptions();
			this.updateInputFields();
		}));

		// Provider
		const providerContainer = DOM.append(formContainer, $('.form-field'));
		const providerLabel = DOM.append(providerContainer, $('label.form-label'));
		providerLabel.textContent = localize('addCustomModel.provider', 'Model Provider');
		const providerSelectContainer = DOM.append(providerContainer, $('.form-input-container'));
		this.providerSelectBox = this._register(new SelectBox(CLOUD_PROVIDERS, 0, this.contextViewService, settingsStyleSelectBox));
		this.providerSelectBox.render(providerSelectContainer);
		this._register(this.providerSelectBox.onDidSelect((e: ISelectData) => {
			this.currentProviderIndex = e.index;
			this.updateModelNameLabel();
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
		lmLabel.textContent = localize('addCustomModel.localhostServerModelId', 'Server model id');
		const lmInputWrap = DOM.append(this.localhostModelIdContainer, $('.form-input-container'));
		this.localhostModelIdInputBox = this._register(new InputBox(lmInputWrap, this.contextViewService, {
			placeholder: localize('addCustomModel.localhostServerModelIdPlaceholder', 'e.g. Qwen/Qwen3-4B-MLX-4bit'),
			inputBoxStyles: settingsStyleInputBox
		}));

		this.displayNameContainer = DOM.append(formContainer, $('.form-field'));
		const dnLabel = DOM.append(this.displayNameContainer, $('label.form-label'));
		dnLabel.textContent = localize('addCustomModel.displayNameOptional', 'Display name (optional)');
		const dnInputWrap = DOM.append(this.displayNameContainer, $('.form-input-container'));
		this.displayNameInputBox = this._register(new InputBox(dnInputWrap, this.contextViewService, {
			placeholder: localize('addCustomModel.displayNamePlaceholder', 'Shown in the model list and Auto dropdown; must be unique if set'),
			inputBoxStyles: settingsStyleInputBox
		}));

		// Add Button
		const buttonContainer = DOM.append(formContainer, $('.form-actions'));
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
		const isLocalhost = this.currentModelType === 'local' && provider.text.toLowerCase() === 'localhost';

		if (this.currentModelType === 'cloud') {
			if (apiKeyContainer) {
				apiKeyContainer.style.display = '';
			}
			if (tokenContainer) {
				tokenContainer.style.display = 'none';
			}
		} else {
			if (apiKeyContainer) {
				apiKeyContainer.style.display = 'none';
			}
			// Hide token field for localhost, show for HuggingFace
			if (tokenContainer) {
				tokenContainer.style.display = isLocalhost ? 'none' : '';
			}
		}
		if (this.localhostModelIdContainer) {
			this.localhostModelIdContainer.style.display = isLocalhost ? '' : 'none';
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
		const isLocalhost = this.currentModelType === 'local' && provider.text.toLowerCase() === 'localhost';

		if (isLocalhost) {
			this.modelNameLabel.textContent = localize('addCustomModel.localhostUrl', 'Localhost URL');
			this.modelNameInputBox.setPlaceHolder(localize('addCustomModel.localhostUrlPlaceholder', 'e.g., http://localhost:8080/v1/chat/completions'));
		} else {
			this.modelNameLabel.textContent = localize('addCustomModel.modelName', 'Model Name');
			this.modelNameInputBox.setPlaceHolder(localize('addCustomModel.modelNamePlaceholder', 'e.g., gpt-4, claude-3-opus, llama-2-7b'));
		}
	}

	private async handleAddModel(): Promise<void> {
		const providers = this.currentModelType === 'cloud' ? CLOUD_PROVIDERS : LOCAL_PROVIDERS;
		const provider = providers[this.currentProviderIndex];
		const providerValue = provider.text.toLowerCase().replace(/\s+/g, '');
		const isLocalhost = providerValue === 'localhost';
		const modelName = this.modelNameInputBox.value.trim();
		const localhostServerModelId = isLocalhost ? this.localhostModelIdInputBox.value.trim() : '';
		const displayNameOpt = this.displayNameInputBox.value.trim();
		const apiKey = this.currentModelType === 'cloud' ? this.apiKeyInputBox.value.trim() : undefined;
		// Token is only needed for HuggingFace, not for localhost
		const token = (this.currentModelType === 'local' && !isLocalhost) ? this.tokenInputBox.value.trim() : undefined;

		// Validation
		if (isLocalhost) {
			if (!modelName) {
				await this.dialogService.error(localize('addCustomModel.error.localhostUrlRequired', 'Localhost URL is required'));
				return;
			}
			if (!localhostServerModelId) {
				await this.dialogService.error(localize('addCustomModel.error.localhostServerModelIdRequired', 'Server model id is required (OpenAI `model` field, e.g. from GET /v1/models).'));
				return;
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
			const nameFallback = isLocalhost ? localhostServerModelId : modelName;
			const added = await this.customLanguageModelsService.addCustomModel({
				name: nameFallback,
				displayName: displayNameOpt || undefined,
				type: this.currentModelType,
				provider: providerValue,
				apiKey,
				token,
				modelName: modelName,
				localhostOpenAiModel: isLocalhost ? localhostServerModelId : undefined,
			});

			await this.dialogService.info(
				localize('addCustomModel.success', 'Model added successfully'),
				localize('addCustomModel.successDetail', 'The model "{0}" has been added and will appear in the "Auto" dropdown.', getCustomModelListLabel(added))
			);

			// Clear form
			this.modelNameInputBox.value = '';
			this.displayNameInputBox.value = '';
			this.localhostModelIdInputBox.value = '';
			this.apiKeyInputBox.value = '';
			this.tokenInputBox.value = '';
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
