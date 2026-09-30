// Offers the previous session back when the last run did not end in an orderly way. Only the first window of a
// launch makes the offer, a moment after it opens so the bar does not compete with the first paint.
import type { WindowHook } from '../shell/window-hooks.js'
import { RESTORE_OVERLAY } from './restore-overlay.js'
import { shouldOfferRestore } from './startup-plan.js'

export const OFFER_DELAY_MS = 1000

export const restoreOffer: WindowHook = {
  name: 'restore-offer',
  opened: ({ window, services }, options) => {
    if (options.firstOfLaunch !== true) return
    if (!shouldOfferRestore(services.settings.get('startup.mode'), services.session.previous(), services.isPrivate)) return
    const timer = setTimeout(() => {
      if (!window.window.isDestroyed()) window.overlays.show(RESTORE_OVERLAY)
    }, OFFER_DELAY_MS)
    timer.unref()
    window.window.once('closed', () => { clearTimeout(timer) })
  }
}
