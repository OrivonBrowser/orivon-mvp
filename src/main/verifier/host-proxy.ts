// What the verifier host is told about the network when it starts: which gateways and which CCIP-Read hosts have no proxy
// in front of them (the only ones its direct routes may dial around a proxy), and, while the whole browser is on the tunnel,
// the front it fetches through. Read once per start, so the host restarts when any of it changes.
import { app } from 'electron'
import type { RouteService } from '../route/route-service.js'
import { NYM_PROFILE_ORIGIN, SHARED_ORIGIN } from '../route/route-hub.js'
import type { HostConfig } from '../../protocols/verifier-host/protocol.js'
import { answersFront, unproxiedGateways } from './proxy-check.js'
import { RefusedToStart } from './process-supervisor.js'

/** Empty under the test seam: a hermetic run has no real gateways to check
 * a proxy against, and the fallback would only ever add noise there. */
export async function unproxiedGatewaysFor (gateways: readonly string[], seamActive: boolean): Promise<string[]> {
  if (seamActive) return []
  return await unproxiedGateways(gateways, async (url) => await app.resolveProxy(url))
}

/**
 * Whether the default session has no proxy in front of it at all, checked
 * against a generic https URL rather than a real gateway: a CCIP-Read
 * destination is a name's own resolver contract's choice, not known until
 * long after the host has already started, so nothing narrower exists to
 * check yet. Reuses `unproxiedGateways`'s own timeout and fail-closed
 * (proxied) direction -- a check that cannot answer must never make
 * `guardedCcipRequest` go around a proxy that is actually there. `false`
 * (treated as proxied) under the test seam, same reasoning as
 * `unproxiedGatewaysFor`.
 */
export async function ccipDirectFor (seamActive: boolean): Promise<boolean> {
  if (seamActive) return false
  const unproxied = await unproxiedGateways(['https://example.com/'], async (url) => await app.resolveProxy(url))
  return unproxied.length > 0
}

/**
 * The tunnel's front the host fetches through while the whole browser is on the tunnel, once the requests made with no session
 * have been pointed at it (`app.setProxy`, which the host's checks of whether a proxy applies read); undefined otherwise.
 */
export async function tunnelFront (routes: RouteService | undefined): Promise<NonNullable<HostConfig['front']> | undefined> {
  if (routes === undefined) return undefined
  // In either direction: the sessions and the requests made with no session follow the setting before the host reads what applies.
  await routes.controller.settled()
  if (!routes.hub.isRouted(SHARED_ORIGIN)) return undefined
  const front = await routes.hub.front(SHARED_ORIGIN)
  // `app.setProxy` reaches a utility process's requests, which cannot be seen from here but through this answer: a host that would fetch around the tunnel is not started.
  const answer = await app.resolveProxy('https://example.com/')
  if (!answersFront(answer, front.port)) throw new RefusedToStart('the tunnel is on for the whole browser, but the requests the verifier makes were not pointed at it, so the verifier stays off')
  return { port: front.port, username: front.username, password: front.secret }
}

/**
 * The front of Nym's profile, which every fetch for a website with a tunnel on goes through (the host's routed fetch), whatever the
 * whole-browser setting says. Undefined when it cannot be had: such a website's fetches then fail, and are never made another way.
 */
export async function tunnelProfileFront (routes: RouteService | undefined): Promise<NonNullable<HostConfig['profileFront']> | undefined> {
  if (routes === undefined) return undefined
  try {
    const front = await routes.hub.front(NYM_PROFILE_ORIGIN)
    return { port: front.port, username: front.username, password: front.secret }
  } catch (error) {
    console.error('[verifier] the tunnel profile has no front, so its websites\' names cannot be read:', error)
    return undefined
  }
}
