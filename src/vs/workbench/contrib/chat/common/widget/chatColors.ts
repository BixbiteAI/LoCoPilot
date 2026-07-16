/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color, RGBA } from '../../../../../base/common/color.js';
import { localize } from '../../../../../nls.js';
import { badgeBackground, badgeForeground, buttonBackground, contrastBorder, editorBackground, editorWidgetBackground, foreground, registerColor, transparent } from '../../../../../platform/theme/common/colorRegistry.js';

export const chatRequestBorder = registerColor(
	'chat.requestBorder',
	{ dark: new Color(new RGBA(255, 255, 255, 0.10)), light: new Color(new RGBA(0, 0, 0, 0.10)), hcDark: contrastBorder, hcLight: contrastBorder, },
	localize('chat.requestBorder', 'The border color of a chat request.')
);

export const chatRequestBackground = registerColor(
	'chat.requestBackground',
	{ dark: transparent(editorBackground, 0.62), light: transparent(editorBackground, 0.62), hcDark: editorWidgetBackground, hcLight: null },
	localize('chat.requestBackground', 'The background color of a chat request.')
);

export const chatSlashCommandBackground = registerColor(
	'chat.slashCommandBackground',
	{ dark: '#00796b66', light: '#00796b7a', hcDark: Color.white, hcLight: badgeBackground },
	localize('chat.slashCommandBackground', 'The background color of a chat slash command.')
);

export const chatSlashCommandForeground = registerColor(
	'chat.slashCommandForeground',
	{ dark: '#4db6ac', light: '#004d40', hcDark: Color.black, hcLight: badgeForeground },
	localize('chat.slashCommandForeground', 'The foreground color of a chat slash command.')
);

export const chatAvatarBackground = registerColor(
	'chat.avatarBackground',
	{ dark: '#1f1f1f', light: '#f2f2f2', hcDark: Color.black, hcLight: Color.white, },
	localize('chat.avatarBackground', 'The background color of a chat avatar.')
);

export const chatAvatarForeground = registerColor(
	'chat.avatarForeground',
	foreground,
	localize('chat.avatarForeground', 'The foreground color of a chat avatar.')
);

export const chatEditedFileForeground = registerColor(
	'chat.editedFileForeground',
	{
		light: '#895503',
		dark: '#E2C08D',
		hcDark: '#E2C08D',
		hcLight: '#895503'
	},
	localize('chat.editedFileForeground', 'The foreground color of a chat edited file in the edited file list.')
);

export const chatRequestCodeBorder = registerColor('chat.requestCodeBorder', { dark: '#004d40B8', light: '#00796b40', hcDark: null, hcLight: null }, localize('chat.requestCodeBorder', 'Border color of code blocks within the chat request bubble.'), true);

export const chatRequestBubbleBackground = registerColor('chat.requestBubbleBackground', { light: transparent(foreground, 0.06), dark: transparent(foreground, 0.07), hcDark: null, hcLight: null }, localize('chat.requestBubbleBackground', "Background color of the chat request bubble."), true);

export const chatRequestBubbleHoverBackground = registerColor('chat.requestBubbleHoverBackground', { dark: transparent(foreground, 0.12), light: transparent(foreground, 0.1), hcDark: null, hcLight: null }, localize('chat.requestBubbleHoverBackground', 'Background color of the chat request bubble on hover.'), true);

export const chatCheckpointSeparator = registerColor('chat.checkpointSeparator',
	{ dark: '#585858', light: '#a9a9a9', hcDark: '#a9a9a9', hcLight: '#a5a5a5' },
	localize('chatCheckpointSeparator', "Chat checkpoint separator color."));

export const chatLinesAddedForeground = registerColor(
	'chat.linesAddedForeground',
	{ dark: '#54B054', light: '#107C10', hcDark: '#54B054', hcLight: '#107C10' },
	localize('chat.linesAddedForeground', 'Foreground color of lines added in chat code block pill.'), true);

export const chatLinesRemovedForeground = registerColor(
	'chat.linesRemovedForeground',
	{ dark: '#FC6A6A', light: '#BC2F32', hcDark: '#F48771', hcLight: '#B5200D' },
	localize('chat.linesRemovedForeground', 'Foreground color of lines removed in chat code block pill.'), true);

export const chatTodoInProgressForeground = registerColor(
	'chat.todoInProgressForeground',
	// Match the primary ("Keep") button color in every theme so the in-progress dot reads as the
	// same brand teal as the action buttons.
	buttonBackground,
	localize('chat.todoInProgressForeground', 'Foreground color of the in-progress status icon in the chat todo list.'), true);
