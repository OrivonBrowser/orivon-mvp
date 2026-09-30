// Which grant may authorise a bind at a given scope, and which interface that
// scope binds (ADR-0034). Sibling of ./bind.ts, which decides only whether
// ONE grant's ports cover a port; this decides which grants get asked.
import type { BindScope, CapabilityKind, Pattern } from '../../contracts/index.js'
import { checkBind } from './bind.js'
import type { PortRange } from './bind.js'

/** The two inbound families a scope applies to: `tcp.listen.*` and `udp.bind.*`. */
export type BindFamily = 'tcp.listen' | 'udp.bind'

/** The one interface a `'local'` bind opens. */
export const LOOPBACK_ADDRESS = '127.0.0.1'
/** The interface a `'network'` bind opens: every one. */
export const ANY_ADDRESS = '0.0.0.0'

/** True for exactly `'local'` and `'network'`: a wire value is untrusted, and anything else is refused, never coerced. */
export function isBindScope (value: unknown): value is BindScope {
  return value === 'local' || value === 'network'
}

/**
 * The address to bind for `scope`. ONLY `'network'` widens: any other value,
 * including one a caller typed wrongly, gets loopback, so a mistake here can
 * only ever narrow a socket.
 */
export function bindAddressFor (scope: BindScope): string {
  return scope === 'network' ? ANY_ADDRESS : LOOPBACK_ADDRESS
}

/**
 * The capabilities that may authorise a bind at `scope`, in the order they
 * are tried. `network` covers `local`, so a local bind may ride either, the
 * narrower first; a network bind rides `.network` alone, and a `.local` grant
 * never reaches it.
 */
export function bindCapabilitiesFor (family: BindFamily, scope: BindScope): readonly CapabilityKind[] {
  return scope === 'network' ? [`${family}.network`] : [`${family}.local`, `${family}.network`]
}

/** What `chooseBindGrant` returns: the grant that authorised the bind, and the ranges it allows the bind to use. */
export interface ChosenBind<G> {
  readonly grant: G
  readonly ranges: readonly PortRange[]
}

/**
 * The first of `grants` (already in preference order) whose ports cover
 * `port`, or `undefined` when none does. The bind is then made inside THAT
 * grant's ranges and tied to it, so revoking it closes the socket; a wider
 * grant beside it is not consulted again, and never lends its ranges to a
 * port the chosen one does not cover.
 */
export function chooseBindGrant<G extends { readonly patterns: readonly Pattern[] }> (
  grants: readonly G[],
  port: number
): ChosenBind<G> | undefined {
  for (const grant of grants) {
    const decision = checkBind(grant.patterns, port)
    if (decision.allowed) return { grant, ranges: decision.ranges }
  }
  return undefined
}
