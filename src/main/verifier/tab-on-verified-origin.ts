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

/** A sleeping tab has a blank page and so shows nothing: waking it asks for the host again. */
export function anyTabOnVerifiedOrigin (windows: readonly TabsOfWindow[]): boolean {
  for (const { tabs, window } of windows) {
    if (window.isDestroyed()) continue
    for (const id of tabs.ids()) {
      const contents = tabs.liveWebContents(id)
      if (contents !== undefined && servedByVerifier(contents.getURL())) return true
    }
  }
  return false
}
