// Opening what the bar or its menus name. Callers send ids; the address is read from the store and passes
// `sanitizeDirectUrl` again, so a page or a hand-edited file never chooses what opens.
import { sanitizeDirectUrl } from '../../browsing/omnibox.js'
import type { WindowContext } from '../window-context.js'

/** Where a click may send a bookmark; the private window is reached from the native menu only. */
export type ClickDisposition = 'current' | 'background' | 'window'
export type Disposition = ClickDisposition | 'private'

/** The most tabs one "Open all" makes. */
export const OPEN_ALL_LIMIT = 25

export const isClickDisposition = (value: unknown): value is ClickDisposition =>
  value === 'current' || value === 'background' || value === 'window'

function addressOf ({ services }: WindowContext, id: string): string | null {
  const node = services.bookmarks.node(id)
  return node?.kind === 'url' && node.url !== undefined ? sanitizeDirectUrl(node.url) : null
}

/** The pages directly in a folder: what "Open all" opens. */
export function openableIn ({ services }: WindowContext, folder: string): string[] {
  const out: string[] = []
  for (const node of services.bookmarks.children(folder)) {
    const url = node.kind === 'url' && node.url !== undefined ? sanitizeDirectUrl(node.url) : null
    if (url !== null) out.push(url)
  }
  return out
}

export function openBookmark (ctx: WindowContext, id: string, disposition: Disposition): boolean {
  const url = addressOf(ctx, id)
  return url !== null && openAddress(ctx, url, disposition)
}

/** Opens an address the caller has already read from a store and passed through `sanitizeDirectUrl`. */
export function openAddress (ctx: WindowContext, url: string, disposition: Disposition): boolean {
  const { tabs } = ctx.window
  const { services } = ctx
  switch (disposition) {
    case 'current': {
      const { activeTabId } = tabs.getState()
      if (activeTabId === null) tabs.createTab(url)
      else tabs.navigate(activeTabId, url)
      return true
    }
    case 'background':
      tabs.createTab(url, false)
      return true
    case 'window':
      services.commands.openWindow({ first: (opened) => { opened.createTab(url) } })
      return true
    case 'private':
      // A private session has no way back to the profile: it opens no second one.
      return !services.isPrivate && services.profiles.openPrivate(url)
  }
}

/** Opens the folder's pages in new tabs, the first in front, at most OPEN_ALL_LIMIT and as many as the window has room for. */
export function openAll (ctx: WindowContext, folder: string): number {
  const { tabs } = ctx.window
  let opened = 0
  for (const url of openableIn(ctx, folder).slice(0, OPEN_ALL_LIMIT)) {
    const before = tabs.ids().length
    tabs.createTab(url, opened === 0)
    if (tabs.ids().length === before) break
    opened += 1
  }
  return opened
}
