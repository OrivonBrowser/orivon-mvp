// When a site may be put on the desktop, and what opens the sheet that does it. The address is the tab's own, read in
// main: a page can neither open the sheet nor say what it makes a shortcut to.
import { activeTab } from '../qr/qr-open.js'
import type { TabState } from '../shell/tab-types.js'
import type { ShellServices } from '../shell/shell-services.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { shareAddressFor } from './share.js'

export const SHORTCUT_OVERLAY = 'shortcut-sheet'

type Page = Pick<TabState, 'isNewTab' | 'isInternal' | 'displayUrl'>

/** The address a shortcut would open: an http or https page, which is all a launch from outside Orivon takes. */
export function shortcutAddressFor (tab: Page | undefined): string | undefined {
  const address = shareAddressFor(tab)
  if (address === undefined || !/^https?:\/\//i.test(address)) return undefined
  try {
    return new URL(address).toString()
  } catch {
    return undefined
  }
}

/** Why the command does nothing now, in the words the menu shows under its name; null when it does something. */
export function shortcutHint (tab: Page | undefined, platform: NodeJS.Platform, isPrivate: boolean): string | null {
  if (platform !== 'linux' && platform !== 'win32') return 'Not available on macOS'
  // A shortcut is a file on the computer, and a private window leaves none.
  if (isPrivate) return 'Not available in a private window'
  if (shareAddressFor(tab) === undefined) return 'No address'
  return shortcutAddressFor(tab) === undefined ? 'Web pages only' : null
}

export function openShortcutSheet (target: Pick<ShellWindow, 'tabs' | 'overlays'>, services: Pick<ShellServices, 'isPrivate'>, platform: NodeJS.Platform = process.platform): void {
  const tab = activeTab(target)
  if (shortcutHint(tab, platform, services.isPrivate) !== null || tab === undefined) return
  const url = shortcutAddressFor(tab)
  if (url === undefined) return
  target.overlays.show(SHORTCUT_OVERLAY, undefined, { url, title: tab.title })
}
