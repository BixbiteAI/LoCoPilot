/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INotificationService, INotificationHandle, Severity, INotificationActions } from '../../../../platform/notification/common/notification.js';

/** Default lifetime for a transient LoCoPilot toast before it self-closes. */
export const LOCOPILOT_TRANSIENT_TOAST_MS = 6000;

/**
 * Show a transient, self-dismissing LoCoPilot toast.
 *
 * The workbench's own toast auto-hide is unreliable for us: it pauses whenever the window
 * reports no focus, and the LoCoPilot chat panel / model settings editor are webviews, so
 * `document.hasFocus()` is `false` while the user works inside them - which parked our
 * acknowledgement toasts on screen indefinitely. Rather than depend on that path, we close
 * the notification explicitly via its handle after a short delay, so it always disappears.
 *
 * Errors are never auto-closed here - those should stay until the user dismisses them.
 *
 * @returns the notification handle (already scheduled to close), for callers that want to
 *          close it sooner or attach further behavior.
 */
export function showTransientNotification(
	notificationService: INotificationService,
	severity: Severity,
	message: string,
	options?: { readonly actions?: INotificationActions; readonly timeoutMs?: number },
): INotificationHandle {
	const handle = notificationService.notify({
		severity,
		message,
		actions: options?.actions,
	});

	if (severity !== Severity.Error) {
		const timeoutMs = options?.timeoutMs ?? LOCOPILOT_TRANSIENT_TOAST_MS;
		let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
			timer = undefined;
			handle.close();
		}, timeoutMs);

		// If the user dismisses it first, cancel our timer so we don't touch a closed handle.
		handle.onDidClose(() => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		});
	}

	return handle;
}
