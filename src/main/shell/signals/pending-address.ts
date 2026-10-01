// An address a tab is waiting on that the person has to answer before the page can load (a sign-in), shown in the
// address bar and the tab's title in place of the page the tab still holds: without it the sheet floats over a
// page that gives no hint which site is asking. The tab's real URL is untouched; only what is shown changes.
import type { WebContents } from 'electron'
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import type { TabSignal } from '../tab-signals.js'

interface Pending { readonly url: string, readonly host: string }

const pending = new WeakMap<WebContents, Pending>()
/** How to tell the tab's window the state changed; set when the tab's view is wired. */
const announce = new WeakMap<WebContents, () => void>()

/** The address shown for a page that is waiting for an answer, or undefined for an address that is not a website's. */
export function pendingOf (url: string): Pending | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? { url: parsed.href, host: parsed.host } : undefined
  } catch {
    return undefined
  }
}

/** Shows `url` as the tab's address until it is called with null. */
export function setPendingAddress (contents: WebContents, url: string | null): void {
  const next = url === null ? undefined : pendingOf(url)
  if (next === undefined) pending.delete(contents)
  else pending.set(contents, next)
  announce.get(contents)?.()
}

export const pendingAddressSignal: TabSignal = {
  name: 'pending-address',
  wire: ({ record, wc }) => { announce.set(wc, () => { record.host.emitState() }) },
  state: (_record, wc) => {
    const shown = wc === undefined ? undefined : pending.get(wc)
    return shown === undefined ? {} : { displayUrl: BUILTIN_ADDRESSES.displayUrl(shown.url), isNewTab: false, title: shown.host }
  }
}
