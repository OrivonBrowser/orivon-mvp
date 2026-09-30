// The one `WindowForms` of each window, built on first use from the shell's real services. The watcher's
// messages, the overlays and the chrome's state all reach a window's forms through here, so they agree.
import type { ShellServices } from '../shell/shell-services.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { promptAnchor } from '../shell/actions/prompt-anchor.js'
import { requestSlot } from '../overlays/tab-slots.js'
import { fieldAnchor } from './field-anchor.js'
import { fillFrame } from './form-watch-ipc.js'
import { createWindowForms, SUGGEST_OVERLAY } from './window-forms.js'
import type { WindowForms } from './window-forms.js'

const forms = new WeakMap<ShellWindow, WindowForms>()

export type FormsServices = Pick<ShellServices, 'passwords' | 'settings' | 'isPrivate'>

export function formsFor (window: ShellWindow, services: FormsServices): WindowForms {
  let existing = forms.get(window)
  if (existing === undefined) {
    existing = createWindowForms(window, {
      vault: services.passwords,
      settings: services.settings,
      isPrivate: services.isPrivate,
      isAppTab: (tabId) => window.tabs.partitionOf(tabId) !== undefined,
      now: Date.now,
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms)
        return () => { clearTimeout(timer) }
      },
      requestSlot,
      anchor: () => promptAnchor(window),
      send: fillFrame,
      liveContents: (tabId) => window.tabs.liveWebContents(tabId),
      isActive: (tabId) => window.tabs.getState().activeTabId === tabId,
      openSuggest: (tabId, field) => {
        const view = window.tabs.record(tabId)?.view
        const anchor = view === undefined ? undefined : fieldAnchor(view.getBounds(), field)
        if (anchor !== undefined) window.overlays.show(SUGGEST_OVERLAY, anchor)
      },
      closeSuggest: () => { window.overlays.close(SUGGEST_OVERLAY) }
    })
    forms.set(window, existing)
  }
  return existing
}
