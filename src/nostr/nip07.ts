// The window.nostr surface (NIP-07), built against a STUBBED signer by
// owner's explicit decision -- see the open question this lane files in
// docs/open-questions.md for the secp256k1/BIP-340 gap this defers.
//
// SIGNER BOUNDARY. `sign` is injected, never implemented here: this file
// contains no secp256k1 or Schnorr math, only structured calls to whatever
// signing capability the caller provides. `orivonIdentitySigner` below is
// the REAL wiring -- it still has zero crypto in it, because it only forwards
// a structured event to IdentityHandle.signEvent, exactly the "no raw signing
// oracle" design src/nostr/README.md requires (a raw bytes-in/bytes-out
// signer would let ANY caller of `sign` extract a signature over
// attacker-chosen bytes, which is precisely what the structured form exists
// to prevent). A test supplies a third kind of `sign` -- a plain stub with
// no orivon.id involved at all.
//
// EACH CALL RE-ACQUIRES THE IDENTITY (via orivon.id.requestIdentity), rather
// than caching a handle across getPublicKey/signEvent calls. This assumes
// the broker remembers a once-connected origin and resolves subsequent
// requestIdentity calls for it without re-prompting -- consistent with
// capability-api.ts's Design Rule 3 ("checked ONCE, at acquisition") and
// with requestIdentity's own doc comment ("triggers the connect prompt",
// not "always prompts"). Not re-verified against a running broker in this
// lane (nothing wires window.nostr into a page yet) -- worth confirming
// against the real implementation once it exists.

import type { IdentityHandle, Orivon } from '../contracts/index.js'
import { fail } from './errors.js'
import { toLowercaseHex } from './hex.js'
import { screenEvent, type SignPrompt } from './kind-screening.js'
import { computeEventId, validateUnsignedEvent } from './nip01.js'
import type { SignedNostrEvent, UnsignedNostrEvent } from './nip01.js'

export type { SignedNostrEvent, UnsignedNostrEvent } from './nip01.js'
export type { SignPrompt } from './kind-screening.js'

/** e.g. 'nostr' -- matches IdentityHandle.kind's own doc comment example exactly. */
const NOSTR_IDENTITY_KIND = 'nostr'

/**
 * The injected signing capability. `hint` is screenEvent's verdict, passed
 * along for a real implementation's own UI purposes ONLY -- see
 * kind-screening.ts's header for why it carries no authority and must not be
 * trusted as the actual prompt-or-not decision.
 */
export type NostrSigner = (event: UnsignedNostrEvent, hint: SignPrompt) => Promise<SignedNostrEvent>

export interface RelayPolicy {
  readonly read: boolean
  readonly write: boolean
}

/** The object injected into a page as `window.nostr`. */
export interface WindowNostr {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>
  getRelays(): Promise<Record<string, RelayPolicy>>
}

async function requestNostrIdentity (orivon: Orivon): Promise<IdentityHandle> {
  const handle = await orivon.id.requestIdentity({ kind: NOSTR_IDENTITY_KIND })
  if (handle === null) {
    throw fail('denied', 'the user declined to connect a Nostr identity to this origin')
  }
  return handle
}

/**
 * createNostrProvider(orivon, { sign }) -- the exact shape acceptance
 * criterion 1 specifies. `sign` is the only injected dependency: getPublicKey
 * reaches `orivon.id` directly because reading a public key involves no
 * signature, only IdentityHandle.publicKey().
 */
export function createNostrProvider (orivon: Orivon, deps: { sign: NostrSigner }): WindowNostr {
  return {
    async getPublicKey () {
      const handle = await requestNostrIdentity(orivon)
      return toLowercaseHex(await handle.publicKey())
    },

    async signEvent (event) {
      // Runtime-validated even though the parameter is typed, because this
      // method is reachable from an arbitrary web page's JS, where TypeScript
      // types do not exist. Rejects BEFORE calling the signer -- an app
      // should not be able to trigger a connect prompt or a signing attempt
      // with a malformed event.
      validateUnsignedEvent(event)
      const hint = screenEvent(event)

      const signed = await deps.sign(event, hint)

      // Defense in depth, not the security boundary (that is the signer's
      // job, ultimately the broker's): if the id the signer returned does
      // not match the event's own fields, something in the chain is broken,
      // and returning it to the calling app would hand out a signature over
      // one event under an id that describes another.
      const expectedId = await computeEventId({
        pubkey: signed.pubkey,
        created_at: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content
      })
      if (signed.id !== expectedId) {
        throw fail('internal', 'signer returned an event whose id does not match its own fields')
      }

      return signed
    },

    async getRelays () {
      // Orivon has no relay-list capability anywhere in capability-api.ts
      // (CLAUDE.md Rule 4: nothing invented here to fill the gap). This
      // implements the NIP-07 method surface honestly rather than silently
      // omitting it -- an empty map is a valid, honest answer, not a stub
      // masquerading as a real one.
      return {}
    }
  }
}

/**
 * The real signing path, wired to orivon.id -- still zero crypto: it only
 * acquires the identity and forwards the structured event to
 * IdentityHandle.signEvent, which is where any real signature would come
 * from once the broker-side secp256k1/Schnorr gap this lane files is closed.
 */
export function orivonIdentitySigner (orivon: Orivon): NostrSigner {
  return async (event) => {
    const handle = await requestNostrIdentity(orivon)
    // IdentityHandle.signEvent is typed `(event: object) => Promise<object>`
    // in src/contracts/ deliberately (capability-api.ts is generic across
    // any named-identity protocol, not Nostr-specific) -- this cast is the
    // one place that generic contract meets this module's concrete shape.
    return (await handle.signEvent(event)) as SignedNostrEvent
  }
}
