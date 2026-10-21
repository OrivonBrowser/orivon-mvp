// Offers the previous session back, and a report of the crash, when the last run did not end in an orderly way. Only
// the first window of a launch makes the offer, a moment after it opens so the bar does not compete with the first paint.
import type { WindowHook } from '../shell/window-hooks.js'
import { RESTORE_OVERLAY } from './restore-overlay.js'
import { shouldOfferRestore } from './startup-plan.js'
import { lastRunCrashId } from '../diagnostics/crash-lookup.js'

export const OFFER_DELAY_MS = 1000

export const restoreOffer: WindowHook = {
  name: 'restore-offer',
  opened: ({ window, services }, options) => {
    // A kiosk has no session of its own to offer back, and the person's windows are not for a public screen.
    if (options.firstOfLaunch !== true || services.kiosk) return
    const restore = shouldOfferRestore(services.settings.get('startup.mode'), services.session.previous(), services.isPrivate)
    // A crash of the last run that has not been reported is offered even when there is nothing to restore (the start-up choice already reopened the session).
    const report = !services.isPrivate && lastRunCrashId() !== undefined
    if (!restore && !report) return
    const timer = setTimeout(() => {
      if (!window.window.isDestroyed()) window.overlays.show(RESTORE_OVERLAY, undefined, { restore, report })
    }, OFFER_DELAY_MS)
    timer.unref()
    window.window.once('closed', () => { clearTimeout(timer) })
  }
}

/** The bar and the find bar share the top of the page and, in a window under about 1200 px wide, overlap: the find bar is the
 * person's own request, so the offer steps aside for it (the windows stay on the closed stack, so Reopen still has them). */
export function dismissRestoreOffer (window: { readonly overlays: { readonly close: (name: string) => void } }): void {
  window.overlays.close(RESTORE_OVERLAY)
}
