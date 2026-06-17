/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILoCoPilotSystemInfoService } from '../../../../platform/locopilotSystemInfo/common/locopilotSystemInfo.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

// Hardware probing runs in the shared (utility) process; the renderer talks to it over IPC.
registerSharedProcessRemoteService(ILoCoPilotSystemInfoService, 'locopilotSystemInfo');
