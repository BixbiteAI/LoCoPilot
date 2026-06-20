/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IManagedHoverContent } from '../../../../../../base/browser/ui/hover/hover.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider, IActionWidgetDropdownOptions } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IStorageService, StorageScope } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { DEFAULT_REASONING_EFFORT, getReasoningEffort, REASONING_EFFORT_STORAGE_KEY, REASONING_EFFORT_VALUES, ReasoningEffort, reasoningEffortLabel, setReasoningEffort } from '../../../common/locopilotReasoningEffort.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from './chatInputPickerActionItem.js';

function effortDescription(effort: ReasoningEffort): string {
	switch (effort) {
		case 'low': return localize('chat.effortPicker.low.desc', "A little thinking before answering - fastest");
		case 'medium': return localize('chat.effortPicker.medium.desc', "Balanced thinking");
		case 'high': return localize('chat.effortPicker.high.desc', "Maximum thinking - slowest, most thorough");
	}
}

function effortIcon(effort: ReasoningEffort): ThemeIcon {
	switch (effort) {
		case 'low': return Codicon.circleOutline;
		case 'medium': return Codicon.circleFilled;
		case 'high': return Codicon.lightbulbSparkleAutofix;
	}
}

function effortActionsProvider(storageService: IStorageService): IActionWidgetDropdownActionProvider {
	return {
		getActions: () => {
			const current = getReasoningEffort(storageService);
			// REASONING_EFFORT_VALUES is already High->Medium->Low; the dropdown sorts A-Z by label, so give an
			// explicit numeric sortText to preserve that intended order (otherwise it'd render High, Low, Medium).
			return REASONING_EFFORT_VALUES.map((effort, index) => ({
				id: `reasoningEffort.${effort}`,
				enabled: true,
				checked: effort === current,
				class: undefined,
				icon: effortIcon(effort),
				sortText: String(index),
				// No `description` - it renders right-aligned and overflows the narrow picker. Keep the
				// explanation in the tooltip (hover) and rely on the icon + label for the row itself.
				tooltip: effortDescription(effort),
				label: reasoningEffortLabel(effort),
				hover: undefined,
				run: () => setReasoningEffort(storageService, effort)
			} satisfies IActionWidgetDropdownAction));
		}
	};
}

/**
 * Toolbar picker that lets the user choose how much the model "thinks" before answering
 * (Off / Low / Medium / High). The selection is persisted globally and read by the LoCoPilot
 * language model provider when building each request - see locopilotReasoningEffort.ts.
 */
export class ReasoningEffortPickerActionItem extends ChatInputPickerActionViewItem {

	constructor(
		action: IAction,
		pickerOptions: IChatInputPickerOptions,
		@IStorageService private readonly storageService: IStorageService,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		const actionWithLabel: IAction = {
			...action,
			label: reasoningEffortLabel(getReasoningEffort(storageService)),
			run: () => { }
		};

		const widgetOptions: Omit<IActionWidgetDropdownOptions, 'label' | 'labelRenderer'> = {
			actionProvider: effortActionsProvider(storageService),
		};

		super(actionWithLabel, widgetOptions, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);

		// Re-render the label whenever the stored effort changes (e.g. picked from this or another widget).
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, REASONING_EFFORT_STORAGE_KEY, this._store)(() => {
			this.updateTooltip();
			if (this.element) {
				this.renderLabel(this.element);
			}
		}));
	}

	private get _effort(): ReasoningEffort {
		return getReasoningEffort(this.storageService);
	}

	protected override getHoverContents(): IManagedHoverContent | undefined {
		return localize('chat.effortPicker.hover', "Reasoning effort: {0}", reasoningEffortLabel(this._effort));
	}

	protected override setAriaLabelAttributes(element: HTMLElement): void {
		super.setAriaLabelAttributes(element);
		element.ariaLabel = localize('chat.effortPicker.ariaLabel', "Reasoning effort, {0}", reasoningEffortLabel(this._effort ?? DEFAULT_REASONING_EFFORT));
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		dom.reset(
			element,
			...renderLabelWithIcons(`$(${Codicon.lightbulb.id})`),
			dom.$('span.chat-input-picker-label', undefined, reasoningEffortLabel(this._effort)),
			...renderLabelWithIcons(`$(chevron-down)`)
		);
		this.setAriaLabelAttributes(element);
		return null;
	}
}
