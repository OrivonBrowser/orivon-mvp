// F7 and the Settings toggle, run: ask or switch, tell the person, and put the setting on every tab.
import { showToast } from '../page-tools/toast.js'
import { requestSlot } from '../overlays/tab-slots.js'
import type { ShellServices } from '../shell/shell-services.js'
import type { WindowContext } from '../shell/window-context.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { caretAppliesTo, CARET_ASK_SETTING, CARET_CONFIRM_OVERLAY, CARET_SETTING, caretPlan } from './caret.js'

/** A window's sheet up or waiting, and its tab: a second press there must not queue a second sheet behind it. */
const asking = new WeakMap<ShellWindow, { readonly tabId: string, readonly cancel: () => void }>()

/** The person left the tab the sheet was asked in: caret browsing is for every tab, so the question goes with it. */
export function dropCaretAsk (window: ShellWindow): void {
  asking.get(window)?.cancel()
}

/** Changes the setting and says so. The setting's listener (install-focus.ts) puts it on the tabs. */
export function setCaret ({ window, services }: WindowContext, on: boolean): void {
  services.settings.set(CARET_SETTING, on)
  showToast(window, on ? 'caretOn' : 'caretOff')
}

/** The F7 command. */
export function toggleCaret (ctx: WindowContext): void {
  const { window, services } = ctx
  const plan = caretPlan({ on: services.settings.get(CARET_SETTING) === true, ask: services.settings.get(CARET_ASK_SETTING) === true })
  if (plan !== 'ask') {
    setCaret(ctx, plan === 'turn-on')
    return
  }
  const tabId = window.tabs.getState().activeTabId
  if (tabId === null) return
  const held = asking.get(window)
  if (held?.tabId === tabId) return
  held?.cancel()
  let entry: { tabId: string, cancel: () => void } | undefined
  let ended = false
  const handle = requestSlot({
    window, tabId, slot: 'center', overlay: CARET_CONFIRM_OVERLAY, payload: null,
    closed: () => {
      ended = true
      if (entry !== undefined && asking.get(window) === entry) asking.delete(window)
    }
  })
  // Refused at once (the tab's queue is full): nothing is waiting, and a later press asks again.
  if (ended) return
  entry = { tabId, cancel: () => { handle.cancel() } }
  asking.set(window, entry)
}

/** Puts the setting on every tab of every window. A tab made or returned later gets it from the tab signal. */
export function applyCaret (services: Pick<ShellServices, 'windows' | 'settings'>): void {
  const on = services.settings.get(CARET_SETTING) === true
  for (const { tabs } of services.windows.all()) {
    for (const id of tabs.ids()) {
      const record = tabs.record(id)
      if (record === undefined || !caretAppliesTo(record)) continue
      const contents = record.view.webContents
      if (!contents.isDestroyed()) contents.setCaretBrowsingEnabled(on)
    }
  }
}
