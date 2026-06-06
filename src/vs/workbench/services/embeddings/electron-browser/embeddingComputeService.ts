/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEmbeddingComputeService } from '../../../../platform/embeddings/common/embeddingCompute.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

// The bundled embedder runs in the shared (utility) process; the renderer talks to it over IPC.
registerSharedProcessRemoteService(IEmbeddingComputeService, 'locopilotEmbeddings');
