// The grant check for a connection that goes through a route (../route/), where
// no name is resolved on this machine. THE ONE THING THAT DIFFERS from
// ./connect.ts's checkConnect, stated first:
//
//   A hostname is matched by NAME, as ./connect-secure.ts does, because the
//   address it would resolve to is chosen by the proxy, not by this machine.
//
// An address literal still goes through checkConnect, which needs no resolver
// for one, so the address-class rules (T12) hold for every literal. What a name
// that points into the local network reaches is the proxy's decision: the
// residual security-model.md records for the route.

import type { OrivonErrorCode, Pattern } from '../../contracts/index.js'
import { classifyAddress } from './address.js'
import { normalizeHost } from './canonical-host.js'
import { LOCALHOST } from './connect-patterns.js'
import { checkConnect, connectStillAuthorised } from './connect.js'
import type { ConnectDenialReason } from './connect.js'
import { checkConnectSecure } from './connect-secure.js'
import type { ConnectSecureDenialReason } from './connect-secure.js'
import { preflightConnect } from './connect-preflight.js'

export interface RoutedConnectAllowed {
  readonly allowed: true
  /** What to hand the route: the canonical name, or the one checked address literal. */
  readonly host: string
}

export interface RoutedConnectDenied {
  readonly allowed: false
  readonly code: Extract<OrivonErrorCode, 'denied'>
  /** LOCAL LOG ONLY, like every denial reason in this directory. */
  readonly reason: ConnectDenialReason | ConnectSecureDenialReason
}

export type RoutedConnectDecision = RoutedConnectAllowed | RoutedConnectDenied

/** A resolver that must never run: a literal needs none, and a name is not resolved here. */
export const NO_RESOLVER = async (): Promise<readonly string[]> => {
  throw new Error('a routed connection resolves no name on this machine')
}

/** This machine, by a name or a literal that needs no resolver: `localhost`, or a loopback address. The `.localhost` subtree is not included, because only the exact name is answered without DNS (./connect.ts). */
export function isLoopbackTarget (host: string): boolean {
  const normalized = normalizeHost(host)
  return normalized === LOCALHOST || classifyAddress(normalized) === 'loopback'
}

export async function checkRoutedConnect (patterns: readonly Pattern[], hostArg: string, port: number): Promise<RoutedConnectDecision> {
  const pre = preflightConnect(patterns, hostArg, port)
  if (!pre.ok) return { allowed: false, code: 'denied', reason: pre.reason }

  if (pre.isLiteral) {
    const decision = await checkConnect(patterns, hostArg, port, NO_RESOLVER)
    const [address] = decision.allowed ? decision.addresses : []
    return address === undefined
      ? { allowed: false, code: 'denied', reason: decision.allowed ? 'empty-resolution' : decision.reason }
      : { allowed: true, host: address }
  }

  const decision = checkConnectSecure(patterns, hostArg, port)
  return decision.allowed ? { allowed: true, host: decision.host } : { allowed: false, code: 'denied', reason: decision.reason }
}

/**
 * Whether `patterns` still authorise a connection already open to `host`, the
 * value `checkRoutedConnect` handed back: what a replacement grant must pass
 * for the socket to stay open.
 */
export function routedStillAuthorised (patterns: readonly Pattern[], host: string, port: number): boolean {
  return classifyAddress(host) === 'unparseable'
    ? checkConnectSecure(patterns, host, port).allowed
    : connectStillAuthorised(patterns, host, host, port)
}
