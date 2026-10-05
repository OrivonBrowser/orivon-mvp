// Whether a page may be shown the picker at all (ADR-0055). A website needs no grant, since the picker is its
// consent: only a block, set as the default or stored for the site, refuses it. A registered app needs its
// `media.screen` grant. Nothing here remembers an allow.
import type { WebContents } from 'electron'
import type { AppMediaGrants } from './types.js'

export interface DisplayPolicyDeps {
  isApp: (origin: string) => boolean
  /** `sites.screenShare` is `block`. */
  blockedByDefault: () => boolean
  /** The site's stored answer is `block`. */
  storedBlock: (origin: string) => boolean
  /** Tells the address bar's chip that this page's screen sharing was blocked. */
  noteBlocked: (tab: WebContents, origin: string) => void
  appGrants: AppMediaGrants
}

export interface DisplayPolicy {
  /** A registered app's origin: the picker names the app. */
  isApp: (origin: string) => boolean
  /** The synchronous answer for the permission check, which can never ask: true where the page may ask. */
  mayAsk: (origin: string) => boolean
  /** Whether the picker is shown to this page now; an app that declared the kind and holds no grant is asked. */
  decide: (tab: WebContents, origin: string) => Promise<boolean>
}

export function createDisplayPolicy (deps: DisplayPolicyDeps): DisplayPolicy {
  const blocked = (origin: string): boolean => deps.blockedByDefault() || deps.storedBlock(origin)
  return {
    isApp: deps.isApp,
    mayAsk: (origin) => deps.isApp(origin) ? deps.appGrants.held(origin, 'media.screen') : !blocked(origin),
    async decide (tab, origin) {
      if (deps.isApp(origin)) return await deps.appGrants.request(tab, origin, 'media.screen')
      if (!blocked(origin)) return true
      deps.noteBlocked(tab, origin)
      return false
    }
  }
}
