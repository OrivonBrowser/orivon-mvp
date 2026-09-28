// Lets one of the shell's pages take the person to another (Settings to
// History, and back). The page asks by name; the tab it opens in is the window
// the asking page is in, found from the sender and never from anything the
// page says.
import type { WindowRegistry } from '../shell/window-registry.js'
import { INTERNAL_PAGES, isInternalPageId } from './internal-pages.js'
import type { InternalDomain } from './internal-ipc.js'

export function pagesDomain (windows: Pick<WindowRegistry, 'findTab'>): InternalDomain {
  return {
    pages: INTERNAL_PAGES,
    handle: (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, page?: unknown, path?: unknown }
      if (request.type !== 'open' || !isInternalPageId(request.page)) return undefined
      const path = typeof request.path === 'string' && request.path.startsWith('/') ? request.path : '/'
      windows.findTab(caller.contents)?.window.tabs.openInternal(request.page, path)
      return { ok: true }
    }
  }
}
