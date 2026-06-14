/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import * as nls from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

export const LOCOPILOT_SETTINGS_SECTION_ADD_MODEL = 'add-model';
export const LOCOPILOT_SETTINGS_SECTION_LIST_MODELS = 'list-models';
export const LOCOPILOT_SETTINGS_SECTION_AGENT_SETTINGS = 'agent-settings';

/* LoCoPilot Settings tab icon. Fallback is gear; CSS overrides to Bixbite logo (black in light theme, white in dark). */
const LoCoPilotSettingsEditorIcon = registerIcon('locopilot-settings-editor-label-icon', Codicon.settingsGear, nls.localize('locopilotSettingsEditorLabelIcon', 'LoCoPilot Settings tab icon.'));

export class LoCoPilotSettingsEditorInput extends EditorInput {

	static readonly ID: string = 'workbench.input.locopilotSettings';

	readonly resource = undefined;

	constructor(
		readonly initialSection?: string,
		readonly focusModelId?: string,
	) {
		super();
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		// Singleton: there is only ever one LoCoPilot Settings tab regardless of the section it was
		// opened to. The section is navigated imperatively (see LoCoPilotSettingsEditor.switchToSection),
		// so keying matches() off initialSection would spawn duplicate tabs and break section switching
		// when a chat-panel link targets a section other than the one already open.
		if (otherInput instanceof LoCoPilotSettingsEditorInput) {
			return true;
		}
		return super.matches(otherInput);
	}

	override get typeId(): string {
		return LoCoPilotSettingsEditorInput.ID;
	}

	override getName(): string {
		return nls.localize('locopilotSettingsEditorInputName', "LoCoPilot Settings");
	}

	override getIcon(): ThemeIcon {
		return LoCoPilotSettingsEditorIcon;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
