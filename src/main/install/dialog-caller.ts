// The tab a question is about, as `DialogCaller` sees it, built from the webContents that raised it. Shared by
// the manifest hint listener and the checks of open tabs (./update-watch.ts, the site-info popover's update).

import { callerKeyFromSenderFrame } from '../../broker/policy/origin.js'
import type { SenderFrameLike } from '../../broker/policy/origin.js'
import type { DialogCaller } from '../consent/request-grant.js'
import { holdNavigation } from '../shell/navigation-hold.js'

/** The one shape this needs from a tab's webContents -- structural, so a test never needs a real one. */
export interface CallerSender {
  isDestroyed: () => boolean
  mainFrame: SenderFrameLike | null
}

/**
 * The tab a question is about, as `DialogCaller` sees it. Built fresh, never cached: a consent dialog
 * can be answered well after it is asked (A153), and every closure below re-reads `sender`'s LIVE state
 * at whatever moment the dialog actually checks it, not the state at the time of the call. A tab already
 * gone (`sender` undefined, or already destroyed) never resolves a window and never reads as still on
 * the origin.
 */
export function dialogCallerFor (sender: CallerSender | undefined, windowForSender?: (sender: unknown) => unknown): DialogCaller {
  return {
    window: () => sender === undefined ? undefined : windowForSender?.(sender),
    contents: () => sender,
    hold: () => holdNavigation(sender),
    stillOn: (checkedOrigin) => sender !== undefined && !sender.isDestroyed() && callerKeyFromSenderFrame(sender.mainFrame) === checkedOrigin
  }
}
