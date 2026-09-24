// orivon.secrets's three entry points -- built the same shape as
// ./id-capability.ts's createIdCapability: this file owns no state of its
// own, only the three functions, so createBroker (./index.ts) can call it
// exactly the way it already calls createIdCapability.
//
// ADR-0031: an origin-bound secret derived from the SAME seed `id` already
// uses, under a DIFFERENT salt (./policy/secret-seal.ts's own header). The
// seed itself never crosses this file's boundary any more than it crosses
// id-capability.ts's.

import { openSecret, sealSecret } from './policy/secret-seal.js'
import { LIMITS } from '../contracts/index.js'
import { fail } from './errors.js'
import type { GrantLedger } from './grants/grant-ledger.js'
import type { Broker, CreateBrokerOptions } from './broker-contracts.js'

export interface SecretsCapabilityOptions {
  readonly deps: CreateBrokerOptions
  readonly ledger: GrantLedger
  /** Origin normalisation plus the malformed-origin 'internal' throw -- ./index.ts's own `canonical`, shared rather than redefined here. */
  readonly canonical: (origin: string) => string
}

/** A DENIAL HERE MUST NOT LEAK WHY, matching every other capability's rule
 * (handle-contracts.md): "never granted" carries no detail an app could
 * use to probe the boundary. */
function requireGrant (ledger: GrantLedger, key: string): void {
  if (ledger.currentGrant(key, 'secrets') === undefined) {
    throw fail('denied', 'secrets is not granted to this origin')
  }
}

/** `Keychain.isPersistent` is OPTIONAL (see its own doc, secrets-contracts.ts)
 * -- an absent method is exactly the case this answers `false` for, the
 * fail-closed default a missing signal must produce here. */
async function seedIsPersistent (deps: CreateBrokerOptions): Promise<boolean> {
  return (await deps.keychain.isPersistent?.()) ?? false
}

/** Builds `Broker['secrets']` -- see this file's header for why it takes the broker's own state rather than owning any of it. */
export function createSecretsCapability ({ deps, ledger, canonical }: SecretsCapabilityOptions): Broker['secrets'] {
  async function available (origin: string): Promise<boolean> {
    const key = canonical(origin)
    if (ledger.currentGrant(key, 'secrets') === undefined) return false
    return await seedIsPersistent(deps)
  }

  async function encrypt (origin: string, plaintext: Uint8Array): Promise<Uint8Array> {
    const key = canonical(origin)
    requireGrant(ledger, key)
    if (plaintext.byteLength > LIMITS.secretBytes) {
      throw fail('limit', `plaintext exceeds LIMITS.secretBytes (${LIMITS.secretBytes})`)
    }
    if (!await seedIsPersistent(deps)) {
      throw fail('unavailable', 'no OS keyring is reachable this session; the seed would not survive a restart')
    }
    const seed = await deps.keychain.getSeed()
    return await sealSecret(seed, key, plaintext)
  }

  async function decrypt (origin: string, ciphertext: Uint8Array): Promise<Uint8Array> {
    const key = canonical(origin)
    requireGrant(ledger, key)
    const seed = await deps.keychain.getSeed()
    return await openSecret(seed, key, ciphertext)
  }

  return { available, encrypt, decrypt }
}
