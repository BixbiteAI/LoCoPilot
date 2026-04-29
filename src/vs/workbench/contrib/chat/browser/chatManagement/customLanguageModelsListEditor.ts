/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { ICustomLanguageModelsService, ICustomLanguageModel, getCustomModelListLabel } from '../../common/customLanguageModelsService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CustomLanguageModelsListEditorInput } from './customLanguageModelsListEditorInput.js';
import './media/customLanguageModelsListEditor.css';

const $ = DOM.$;

export class CustomLanguageModelsListEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.customLanguageModelsList';

	private readonly editorDisposables = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	private bodyContainer: HTMLElement | undefined;
	private modelsListContainer: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICustomLanguageModelsService private readonly customLanguageModelsService: ICustomLanguageModelsService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(CustomLanguageModelsListEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.bodyContainer = DOM.append(parent, $('.custom-language-models-list-editor'));
		this.renderModelsList();

		// Listen for model changes
		this._register(this.customLanguageModelsService.onDidChangeCustomModels(() => {
			this.renderModelsList();
		}));
	}

	private renderModelsList(): void {
		if (!this.bodyContainer) {
			return;
		}

		// Clear existing content
		DOM.clearNode(this.bodyContainer);

		const models = this.customLanguageModelsService.getCustomModels();

		if (models.length === 0) {
			this.renderEmptyState();
			return;
		}

		// Title
		const title = DOM.append(this.bodyContainer, $('h2.models-list-title'));
		title.textContent = localize('customLanguageModels.list.title', 'Language Models');

		// Models list container
		this.modelsListContainer = DOM.append(this.bodyContainer, $('.models-list-container'));

		models.forEach((model: ICustomLanguageModel) => {
			this.renderModelItem(model);
		});
	}

	private renderEmptyState(): void {
		const emptyContainer = DOM.append(this.bodyContainer!, $('.models-list-empty'));

		const icon = DOM.append(emptyContainer, $('.empty-icon'));
		icon.appendChild(renderIcon(Codicon.add));

		const message = DOM.append(emptyContainer, $('.empty-message'));
		message.textContent = localize('customLanguageModels.list.empty', 'No language models added yet');

		const addButton = this._register(new Button(emptyContainer, { ...defaultButtonStyles }));
		addButton.label = localize('customLanguageModels.list.add', 'Add Model');
		this._register(addButton.onDidClick(() => {
			this.commandService.executeCommand('workbench.action.chat.addCustomModel');
		}));
	}

	private renderModelItem(model: ICustomLanguageModel): void {
		if (!this.modelsListContainer) {
			return;
		}

		const itemContainer = DOM.append(this.modelsListContainer, $('.model-item', { 'data-model-id': model.id }));
		if (model.hidden) {
			itemContainer.classList.add('hidden');
		}

		// Model info
		const infoContainer = DOM.append(itemContainer, $('.model-info'));

		const nameLabel = DOM.append(infoContainer, $('.model-name'));
		nameLabel.textContent = getCustomModelListLabel(model);

		const detailsLabel = DOM.append(infoContainer, $('.model-details'));
		detailsLabel.textContent = `${model.type === 'cloud' ? 'Cloud' : 'Local'} | ${model.provider} | ${model.modelName}`;

		// Actions
		const actionsContainer = DOM.append(itemContainer, $('.model-actions'));

		// Hide/Show button
		const hideButton = this._register(new Button(actionsContainer, { ...defaultButtonStyles, secondary: true }));
		hideButton.label = model.hidden ? localize('customLanguageModels.show', 'Show') : localize('customLanguageModels.hide', 'Hide');
		this._register(hideButton.onDidClick(async () => {
			await this.customLanguageModelsService.hideCustomModel(model.id, !model.hidden);
		}));

		// Delete button
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
				await this.deleteModelWithAnimation(model.id, itemContainer);
			}
		}));
	}

	private async deleteModelWithAnimation(modelId: string, element: HTMLElement): Promise<void> {
		// Add slide-out animation
		element.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
		element.style.transform = 'translateX(-100%)';
		element.style.opacity = '0';

		// Wait for animation to complete
		await new Promise(resolve => setTimeout(resolve, 300));

		// Delete the local files first (if any)
		await this.commandService.executeCommand('locopilot.deleteModelFiles', modelId);

		// Delete the model from the service
		await this.customLanguageModelsService.removeCustomModel(modelId);

		// The list will be re-rendered by the onDidChangeCustomModels listener
	}

	override async setInput(input: CustomLanguageModelsListEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		// Layout is handled by CSS
	}

	override focus(): void {
		super.focus();
	}

	override clearInput(): void {
		super.clearInput();
	}
}
