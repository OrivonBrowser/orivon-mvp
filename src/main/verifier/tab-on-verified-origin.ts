// Whether any open tab shows an origin the verifier serves, which keeps the host running. No `electron` import: the
// windows come in.
import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'

export interface TabsOfWindow {
  readonly tabs: {
    ids: () => readonly string[]
    liveWebContents: (id: string) => { getURL: () => string } | undefined
  }
  readonly window: { isDestroyed: () => boolean }
}

/** A sleeping tab has a blank page and so shows nothing: waking it asks for the host again. An installed app served
 * from its pin (`servedFromCache`) shares the name but needs no host. */
export function anyTabOnVerifiedOrigin (windows: readonly TabsOfWindow[], servedFromCache: (origin: string) => boolean = () => false): boolean {
  for (const { tabs, window } of windows) {
    if (window.isDestroyed()) continue
    for (const id of tabs.ids()) {
      const url = tabs.liveWebContents(id)?.getURL()
      if (url !== undefined && servedByVerifier(url) && !servedFromCache(new URL(url).origin)) return true
    }
  }
  return false
}
