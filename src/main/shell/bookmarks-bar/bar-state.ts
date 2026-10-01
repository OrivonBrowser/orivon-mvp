import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether the active tab's address is bookmarked, for the star. The window's own bookmark listener pushes on every
 * change, so this part only reads. */
export const bookmarkedStatePart: ShellStatePart = {
  name: 'bookmarked',
  read: ({ services }, { tabs, activeTabId }) => {
    const active = tabs.find((tab) => tab.id === activeTabId)
    return { bookmarked: active !== undefined && services.bookmarks.has(active.url) }
  }
}
