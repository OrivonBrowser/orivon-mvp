// What the main menu needs to know about the window in front, for the rows this directory owns.
import { activeTab } from '../qr/qr-open.js'
import type { WindowContext } from '../shell/window-context.js'
import { shareAddressFor, webLinkForTab } from './share.js'
import { webLinkFor } from './web-link.js'
import { shortcutHint } from './shortcut-open.js'

/** The note under a share row that has nothing to share on this page; null when it has. */
export function shareHint ({ window }: WindowContext): string | null {
  return shareAddressFor(activeTab(window)) === undefined ? 'No address' : null
}

/** The note under Copy web link when there is nothing for it to copy: no address, a web address Copy link already copies, or an address no browser outside Orivon opens. */
export function webLinkHint ({ window }: WindowContext): string | null {
  const tab = activeTab(window)
  const address = shareAddressFor(tab)
  if (address === undefined) return 'No address'
  if (webLinkForTab(tab) !== undefined) return null
  return webLinkFor(address) === undefined ? 'No web link' : 'Same as Copy link'
}

export function createShortcutHint ({ window, services }: WindowContext, platform: NodeJS.Platform = process.platform): string | null {
  return shortcutHint(activeTab(window), platform, services.isPrivate)
}
