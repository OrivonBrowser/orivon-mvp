// When a page may be shared as a QR code, and what opens the sheet. The address is the tab's own, read in main:
// the sheet can neither be opened by a page nor be told what to encode.
import type { TabState } from '../shell/tab-types.js'
import type { ShellWindow } from '../shell/window-registry.js'

export const QR_OVERLAY = 'qr'

/** The address to encode for `tab`, or undefined for a tab that is not showing a page: the new-tab page and the
 * shell's own pages have no address worth handing to another device. */
export function qrAddressFor (tab: Pick<TabState, 'isNewTab' | 'isInternal' | 'displayUrl'> | undefined): string | undefined {
  if (tab === undefined || tab.isNewTab || tab.isInternal || tab.displayUrl === '') return undefined
  return tab.displayUrl
}

function activeTab (window: Pick<ShellWindow, 'tabs'>): TabState | undefined {
  const { tabs, activeTabId } = window.tabs.getState()
  return tabs.find((tab) => tab.id === activeTabId)
}

/** Whether `page.qr` would do anything in this window; the main menu greys its row by it. */
export function qrAvailable (window: Pick<ShellWindow, 'tabs'>): boolean {
  return qrAddressFor(activeTab(window)) !== undefined
}

export function openQr (target: Pick<ShellWindow, 'tabs' | 'overlays'>): void {
  const url = qrAddressFor(activeTab(target))
  if (url === undefined) return
  target.overlays.show(QR_OVERLAY, undefined, { url })
}
