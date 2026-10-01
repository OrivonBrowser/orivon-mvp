// What the main menu needs to know about the window in front, for the rows this directory owns.
import { activeTab } from '../qr/qr-open.js'
import type { WindowContext } from '../shell/window-context.js'
import { shareAddressFor } from './share.js'
import { shortcutHint } from './shortcut-open.js'

/** The note under a share row that has nothing to share on this page; null when it has. */
export function shareHint ({ window }: WindowContext): string | null {
  return shareAddressFor(activeTab(window)) === undefined ? 'No address' : null
}

export function createShortcutHint ({ window, services }: WindowContext, platform: NodeJS.Platform = process.platform): string | null {
  return shortcutHint(activeTab(window), platform, services.isPrivate)
}
