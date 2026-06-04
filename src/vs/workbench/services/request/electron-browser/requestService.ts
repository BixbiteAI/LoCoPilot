/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AbstractRequestService, AuthInfo, Credentials, IRequestService, IRequestStreamResult, IRequestToFileResult } from '../../../../platform/request/common/request.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILoggerService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { windowLogGroup } from '../../log/common/logConstants.js';
import { LogService } from '../../../../platform/log/common/logService.js';

export class NativeRequestService extends AbstractRequestService implements IRequestService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILoggerService loggerService: ILoggerService,
	) {
		const logger = loggerService.createLogger(`network`, { name: localize('network', "Network"), group: windowLogGroup });
		const logService = new LogService(logger);
		super(logService);
		this._register(logger);
		this._register(logService);
	}

	async request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		if (!options.proxyAuthorization) {
			options.proxyAuthorization = this.configurationService.inspect<string>('http.proxyAuthorization').userLocalValue;
		}
		// Use main process request channel to avoid CORS (renderer fetch is subject to CORS; main process is not)
		const requestChannel = this.mainProcessService.getChannel('request');
		const requestChannelClient = new RequestChannelClient(requestChannel);
		return this.logAndRequest(options, () => requestChannelClient.request(options, token));
	}

	async requestStream(options: IRequestOptions, onChunk: (chunk: VSBuffer) => void, token: CancellationToken): Promise<IRequestStreamResult> {
		if (!options.proxyAuthorization) {
			options.proxyAuthorization = this.configurationService.inspect<string>('http.proxyAuthorization').userLocalValue;
		}
		// Stream via the main process request channel (no renderer CORS/mixed-content restrictions).
		const requestChannel = this.mainProcessService.getChannel('request');
		const requestChannelClient = new RequestChannelClient(requestChannel);
		return requestChannelClient.requestStream(options, onChunk, token);
	}

	async requestToFile(options: IRequestOptions, destinationFilePath: string, token: CancellationToken, progressRequestId?: string): Promise<IRequestToFileResult> {
		const requestChannel = this.mainProcessService.getChannel('request');
		const requestChannelClient = new RequestChannelClient(requestChannel);
		return requestChannelClient.requestToFile(options, destinationFilePath, token, progressRequestId);
	}

	getRequestToFileProgressEvent(requestId: string) {
		const requestChannel = this.mainProcessService.getChannel('request');
		const requestChannelClient = new RequestChannelClient(requestChannel);
		return requestChannelClient.onRequestToFileProgress(requestId);
	}

	async resolveProxy(url: string): Promise<string | undefined> {
		return this.nativeHostService.resolveProxy(url);
	}

	async lookupAuthorization(authInfo: AuthInfo): Promise<Credentials | undefined> {
		return this.nativeHostService.lookupAuthorization(authInfo);
	}

	async lookupKerberosAuthorization(url: string): Promise<string | undefined> {
		return this.nativeHostService.lookupKerberosAuthorization(url);
	}

	async loadCertificates(): Promise<string[]> {
		return this.nativeHostService.loadCertificates();
	}
}

registerSingleton(IRequestService, NativeRequestService, InstantiationType.Delayed);
