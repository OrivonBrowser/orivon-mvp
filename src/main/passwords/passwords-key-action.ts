import type { ChromeAction } from '../shell/chrome-actions.js'
import { isRect } from '../shell/actions/overlay.js'
import { formsFor } from './forms-registry.js'
import { passwordSaveOverlay } from './password-overlays.js'
import { FILL_OVERLAY } from './window-forms.js'

/**
 * The password button in the address bar. With an offer to keep a sign-in waiting it shows the prompt
 * (again, if it went away) and puts the keyboard on it; otherwise it opens or closes the chooser under the
 * button. The payload is the button's rectangle; main reads which tab is in front itself.
 */
export const passwordsKey: ChromeAction = (payload, { window, services }) => {
  const tabId = window.tabs.getState().activeTabId
  if (tabId === null) return
  const anchor = typeof payload === 'object' && payload !== null ? (payload as { anchor?: unknown }).anchor : undefined
  const forms = formsFor(window, services)
  if (forms.loginState(tabId).offer) {
    if (forms.reopenOffer(tabId)) window.overlays.send(passwordSaveOverlay.name, { type: 'focus-save' })
    return
  }
  window.overlays.toggle(FILL_OVERLAY, isRect(anchor) ? anchor : undefined)
}
