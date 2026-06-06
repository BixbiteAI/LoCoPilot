/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILoCoPilotGitService } from '../../../../platform/locopilotGit/common/locopilotGit.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

// git runs in the shared (utility) process; the renderer talks to it over IPC.
registerSharedProcessRemoteService(ILoCoPilotGitService, 'locopilotGit');
