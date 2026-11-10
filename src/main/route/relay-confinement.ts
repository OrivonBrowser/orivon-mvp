// The WebRTC policy of the pages in the sessions that follow the system while the name relay has the config they are set to: a
// peer connection in a page would otherwise reach a peer over UDP from this computer's own address, around the proxy the relay
// looks names up through. The pages take the policy when the relay starts and when they are made, and lose it when the relay
// stops or the session leaves it. A page an app's route confines keeps that policy. Electron-free over the pages it is handed.

import type { WebContents } from 'electron'

export type ConfinablePage = Pick<WebContents, 'isDestroyed' | 'setWebRTCIPHandlingPolicy'> & { readonly session: object }

export interface RelayConfinementDeps<C extends ConfinablePage> {
  readonly allContents: () => readonly C[]
  /** Whether pages in `session` are held to the proxy now: it follows the system, is on no front, and the relay has the config it is set to. */
  readonly onRelay: (session: object) => boolean
  /** The pages an app's route confined, which are the route's to restore. */
  readonly confinedByRoute: WeakSet<C>
  readonly policy: Parameters<WebContents['setWebRTCIPHandlingPolicy']>[0]
}

export interface RelayConfinement<C extends ConfinablePage> {
  /** A page was made. */
  created: (page: C) => void
  /** An app's route took the page. */
  routed: (page: C) => void
  /** The relay started or stopped, or a session left or joined it. */
  sync: () => void
}

export function createRelayConfinement<C extends ConfinablePage> (deps: RelayConfinementDeps<C>): RelayConfinement<C> {
  const held = new WeakSet<C>()
  const confine = (page: C): void => {
    held.add(page)
    page.setWebRTCIPHandlingPolicy(deps.policy)
  }
  return {
    created: (page) => { if (deps.onRelay(page.session)) confine(page) },
    routed: (page) => { held.delete(page) },
    sync: () => {
      for (const page of deps.allContents()) {
        if (page.isDestroyed()) continue
        if (deps.onRelay(page.session)) {
          if (!deps.confinedByRoute.has(page) && !held.has(page)) confine(page)
        } else if (held.has(page)) {
          held.delete(page)
          if (!deps.confinedByRoute.has(page)) page.setWebRTCIPHandlingPolicy('default')
        }
      }
    }
  }
}
