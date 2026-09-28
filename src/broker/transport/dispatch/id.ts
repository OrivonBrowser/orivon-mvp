// id.publicKey / id.sign, split out of ../ipc.ts's dispatch() switch under
// code-guidelines.md Rule 2 -- see ./app.ts's header for the seam
// this and its siblings share.

import { fail } from '../../errors.js'
import type { Broker } from '../../broker-contracts.js'
import { isIdPublicKeyParams, isIdSignParams } from '../ipc-validation.js'
import type { ControlMethod } from '../ipc-validation.js'

/** The `id.*` slice of `ControlMethod` -- see ./app.ts's own `AppControlMethod` for why this is derived rather than retyped. */
export type IdControlMethod = Extract<ControlMethod, `id.${string}`>

/**
 * `id.*`'s dispatch cases, unchanged from ../ipc.ts's own switch. Neither
 * carries a port transport of its own -- a plain Uint8Array response,
 * exactly fs.readFile's shape, unlike net.connect's.
 */
export async function dispatchId (
  broker: Broker,
  origin: string,
  method: IdControlMethod,
  payload: unknown
): Promise<unknown> {
  switch (method) {
    case 'id.publicKey': {
      if (!isIdPublicKeyParams(payload)) throw fail('invalid', 'id.publicKey requires { curve: string }')
      return await broker.id.publicKey(origin, { curve: payload.curve })
    }
    case 'id.sign': {
      if (!isIdSignParams(payload)) throw fail('invalid', 'id.sign requires { curve: string, payload: Uint8Array }')
      return await broker.id.sign(origin, { curve: payload.curve, payload: payload.payload })
    }
    default: {
      // Exhaustiveness check, same reasoning and shape as ../ipc.ts's own
      // dispatch() and ./net.ts's dispatchNet (A185): if
      // IdControlMethod ever gains a member no case above names, `method` is
      // not assignable to `never` and this line fails to compile, instead of
      // the switch silently falling through and this function resolving
      // `undefined` for an operation that never ran.
      const unrouted: never = method
      throw fail('internal', `unrouted id control method: ${unrouted as string}`)
    }
  }
}
