// Picks the grant that authorises one `listen` or `udpBind` (ADR-0034), for
// ./net-listen.ts and ./net-udp.ts: the two differ downstream of this and
// nowhere upstream of it.

import type { BindScope, Grant } from '../../contracts/index.js'
import type { GrantLedger } from '../grants/grant-ledger.js'
import { fail } from '../errors.js'
import { bindCapabilitiesFor, chooseBindGrant, isBindScope } from '../policy/bind-scope.js'
import type { BindFamily, ChosenBind } from '../policy/bind-scope.js'

/**
 * The scope an app asked for: omitted is `'local'`, the narrower one, and
 * anything but exactly `'local'` or `'network'` is `'invalid'` here rather
 * than guessed at, whichever caller reached the broker.
 */
export function requestedScope (scope: unknown, method: string): BindScope {
  if (scope === undefined) return 'local'
  if (!isBindScope(scope)) throw fail('invalid', `${method}: scope must be 'local' or 'network'`)
  return scope
}

/**
 * The live grant that authorises binding `port` at `scope`, and the ranges it
 * allows. Read from the ledger (what the person GRANTED), never the manifest.
 * Every refusal is a bare 'denied': which grant is missing, or which port
 * missed, is never told to the app (policy/bind.ts).
 */
export function bindGrantFor (
  ledger: GrantLedger,
  origin: string,
  family: BindFamily,
  scope: BindScope,
  port: number
): ChosenBind<Grant> {
  const held: Grant[] = []
  for (const capability of bindCapabilitiesFor(family, scope)) {
    const grant = ledger.currentGrant(origin, capability)
    if (grant !== undefined) held.push(grant)
  }
  if (held.length === 0) throw fail('denied', `no ${family}.${scope === 'network' ? 'network' : 'local or network'} grant is held by this origin`)
  const chosen = chooseBindGrant(held, port)
  if (chosen === undefined) throw fail('denied', 'the bind was not authorised')
  return chosen
}
