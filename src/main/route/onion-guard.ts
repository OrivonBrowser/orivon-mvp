// Whether a session may send an onion address (`.onion`) out: only the person's own SOCKS5 tunnel can, because it passes the
// name on unresolved. Any other route would look the name up (a resolver then learns which hidden service the person is
// about to visit) or, through Nym, send the lookup to a public resolver that cannot answer for it. Pure: no `electron`.

import { isOnionUrl } from '../../broker/route/onion.js'
import type { TunnelKind } from './route-state.js'

/** How a session sends: the tunnel of the front it is pointed at, `held` when it is stopped, undefined when it follows the system (`RouteController.tunnelOf`). */
export type SessionRoute = TunnelKind | 'held' | undefined

/** Whether a request for `url` made in a session that sends as `via` is cancelled before anything is resolved. */
export function onionRefused (url: string, via: SessionRoute): boolean {
  return via !== 'socks5' && isOnionUrl(url)
}

/** What the sheet over a tab needs to tell a cancelled onion load from any other cancelled load. */
export interface OnionRefusals {
  /** Remembers that the main-frame load of `url` in the web contents `contentsId` was cancelled; a request that belongs to no web contents is not remembered. */
  readonly note: (contentsId: number | undefined, url: string) => void
  /** Whether the load that failed at `url` in `contentsId` is one that was cancelled for being an onion address; true once per refusal. */
  readonly claims: (contentsId: number, url: string) => boolean
}

/** The newest refusal of each of at most `limit` web contents: a tab that is gone leaves one behind, and the oldest goes first. */
export function createOnionRefusals (limit = 64): OnionRefusals {
  const refused = new Map<number, string>()
  return {
    note (contentsId, url) {
      if (contentsId === undefined) return
      refused.delete(contentsId)
      refused.set(contentsId, url)
      while (refused.size > limit) refused.delete(refused.keys().next().value as number)
    },
    claims (contentsId, url) {
      if (refused.get(contentsId) !== url) return false
      refused.delete(contentsId)
      return true
    }
  }
}

/** The refusals of this run, shared by the guard on every session and the sheet. */
export const onionRefusals: OnionRefusals = createOnionRefusals()
