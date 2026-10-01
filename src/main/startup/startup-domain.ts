// What the Settings page asks of main for the start-up rows: whether an address would load, and which pages
// are open now. Answers the Settings page only, and only with addresses.
import { parseOmniboxInput } from '../browsing/omnibox.js'
import { MAX_LISTED_ADDRESSES } from '../settings/address-checks.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { WindowRegistry } from '../shell/window-registry.js'

const MAX_TEXT = 2048
const isWebAddress = (address: string): boolean => /^https?:\/\//i.test(address)

export function startupDomain (windows: Pick<WindowRegistry, 'findOwner'>): InternalDomain {
  return {
    pages: ['settings'],
    handle: (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, text?: unknown }
      if (request.type === 'validate') {
        if (typeof request.text !== 'string' || request.text.length > MAX_TEXT) return { ok: false }
        const result = parseOmniboxInput(request.text)
        return result.kind === 'url' ? { ok: true, normalised: result.url } : { ok: false }
      }
      if (request.type === 'currentPages') {
        const owner = windows.findOwner(caller.contents)
        if (owner === undefined) return []
        // The page's own address, never a title or an icon; Settings itself and the new tab page are not pages to open.
        const open = owner.tabs.getState().tabs
          .filter((tab) => !tab.isInternal && !tab.isNewTab && isWebAddress(tab.displayUrl))
          .map((tab) => tab.displayUrl)
        return [...new Set(open)].slice(0, MAX_LISTED_ADDRESSES)
      }
      return undefined
    }
  }
}
