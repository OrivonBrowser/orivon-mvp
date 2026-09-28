// secrets.available / secrets.encrypt / secrets.decrypt, split out of
// ../ipc.ts's dispatch() switch under code-guidelines.md Rule 2 -- see
// ./id.ts's header for the seam this and its siblings share.

import { fail } from '../../errors.js'
import type { Broker } from '../../broker-contracts.js'
import { isSecretsDecryptParams, isSecretsEncryptParams } from '../ipc-validation.js'
import type { ControlMethod } from '../ipc-validation.js'

/** The `secrets.*` slice of `ControlMethod` -- see ./app.ts's own `AppControlMethod` for why this is derived rather than retyped. */
export type SecretsControlMethod = Extract<ControlMethod, `secrets.${string}`>

/** `secrets.*`'s dispatch cases, unchanged from ../ipc.ts's own switch. Every
 * one is a plain Uint8Array/boolean response, exactly `id.*`'s shape. */
export async function dispatchSecrets (
  broker: Broker,
  origin: string,
  method: SecretsControlMethod,
  payload: unknown
): Promise<unknown> {
  switch (method) {
    case 'secrets.available':
      return await broker.secrets.available(origin)
    case 'secrets.encrypt': {
      if (!isSecretsEncryptParams(payload)) throw fail('invalid', 'secrets.encrypt requires { plaintext: Uint8Array }')
      return await broker.secrets.encrypt(origin, payload.plaintext)
    }
    case 'secrets.decrypt': {
      if (!isSecretsDecryptParams(payload)) throw fail('invalid', 'secrets.decrypt requires { ciphertext: Uint8Array }')
      return await broker.secrets.decrypt(origin, payload.ciphertext)
    }
    default: {
      // Exhaustiveness check, same reasoning and shape as ./id.ts's own.
      const unrouted: never = method
      throw fail('internal', `unrouted secrets control method: ${unrouted as string}`)
    }
  }
}
