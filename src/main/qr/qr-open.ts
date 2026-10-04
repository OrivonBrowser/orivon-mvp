// When a page may be shared as a QR code, and what opens the sheet. The address is the tab's own, read in main:
// the sheet can neither be opened by a page nor be told what to encode.
import type { TabState } from '../shell/tab-types.js'
import type { ShellWindow } from '../shell/window-registry.js'

export const QR_OVERLAY = 'qr'
/** An address longer than this is not something a clipboard write or a sheet should carry. */
export const MAX_QR_ADDRESS = 32768

/** The address to encode for `tab`, or undefined for a tab that is not showing a page: the new-tab page and the
 * shell's own pages have no address worth handing to another device, and one too long for the sheet is refused here
 * rather than opening it empty. */
export function qrAddressFor (tab: Pick<TabState, 'isNewTab' | 'isInternal' | 'displayUrl'> | undefined): string | undefined {
  if (tab === undefined || tab.isNewTab || tab.isInternal || tab.displayUrl === '' || tab.displayUrl.length > MAX_QR_ADDRESS) return undefined
  return tab.displayUrl
}

export function activeTab (window: Pick<ShellWindow, 'tabs'>): TabState | undefined {
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
