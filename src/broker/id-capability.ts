// orivon.id's two entry points -- publicKey and sign -- built the same shape
// as ./net-capability.ts's createNetCapability: this file owns no state of
// its own, only the two functions, so createBroker (./index.ts) can call it
// exactly the way it already calls createNetCapability.
//
// SCOPE: publicKey and sign only. Both are the APP KEYS half of
// capability-api.ts's "Two kinds of identity" (per-origin, silent, no
// consent needed because they cannot link a user across apps) -- NOT
// requestIdentity, the NAMED IDENTITIES half, which is cross-origin by
// design and needs the connect-prompt UI. That UI does not exist yet, and
// this file does not attempt to stand in for it: preload/README.md's own
// rule is that a method which can only ever fail is worse than a method
// that is not there at all, and requestIdentity has no honest answer to
// give until the prompt exists.

import { derivePublicKey, signWithP256 } from './policy/derive-p256.js'
import { fail } from './errors.js'
import type { GrantLedger } from './grants/grant-ledger.js'
import type { Broker, CreateBrokerOptions } from './broker-contracts.js'

export interface IdCapabilityOptions {
  readonly deps: CreateBrokerOptions
  readonly ledger: GrantLedger
  /** Origin normalisation plus the malformed-origin 'internal' throw -- ./index.ts's own `canonical`, shared rather than redefined here. */
  readonly canonical: (origin: string) => string
}

/**
 * Checks `key` holds a live `id` grant naming `curve` among its patterns --
 * `manifest.ts`'s `IdCapability.curves` is what a `Grant`'s `patterns` are
 * for this capability kind, so membership is a plain string comparison, not
 * a host:port pattern match the way `tcp.connect`'s are.
 *
 * A DENIAL HERE MUST NOT LEAK WHY, matching `net.listen`'s own rule
 * (handle-contracts.md): "never granted" and "granted, but not for this
 * curve" answer with the SAME 'denied' and no `platformCode`, so an app
 * cannot tell the two apart by probing.
 */
function requireGrantedCurve (ledger: GrantLedger, key: string, curve: string): void {
  const grant = ledger.currentGrant(key, 'id')
  if (grant === undefined || !grant.patterns.includes(curve)) {
    throw fail('denied', 'id is not granted to this origin for this curve')
  }
}

/**
 * `curve` is app-controlled (capability-api.ts types it as a free-form
 * `string`) and re-validated at the actual derivation call regardless of
 * this cast (`derive-p256.ts`'s own `requireP256`, which is what actually
 * turns a wrong string into an 'invalid' or 'internal' rejection) -- the
 * cast only satisfies `derivePublicKey`/`signWithP256`'s stricter parameter
 * type, it grants nothing.
 */
function asP256 (curve: string): 'P-256' {
  return curve as 'P-256'
}

/** Builds `Broker['id']` -- see this file's header for why it takes the broker's own state rather than owning any of it. */
export function createIdCapability ({ deps, ledger, canonical }: IdCapabilityOptions): Broker['id'] {
  async function publicKey (origin: string, opts: { curve: string }): Promise<Uint8Array> {
    const key = canonical(origin)
    requireGrantedCurve(ledger, key, opts.curve)
    const seed = await deps.keychain.getSeed()
    return await derivePublicKey({ seed, label: 'app', scope: key, curve: asP256(opts.curve) })
  }

  async function sign (origin: string, opts: { curve: string, payload: Uint8Array }): Promise<Uint8Array> {
    const key = canonical(origin)
    requireGrantedCurve(ledger, key, opts.curve)
    const seed = await deps.keychain.getSeed()
    return await signWithP256({ seed, label: 'app', scope: key, curve: asP256(opts.curve) }, opts.payload)
  }

  return { publicKey, sign }
}
