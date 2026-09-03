// NIP-01 event canonicalisation and id computation, and nothing else --
// no relay wire protocol, no filters, no kind-range classification, none of
// which any acceptance criterion here needs.
//
// id = sha256(utf8(JSON.stringify([0, pubkey, created_at, kind, tags, content])))
//
// JSON.stringify (no indent argument) already matches NIP-01's serialization
// rule exactly: it inserts no whitespace, and it escapes exactly the
// characters NIP-01 names (", \, and the control characters \n \r \t \b \f,
// with \u00XX for any other control character below 0x20) while leaving
// every other Unicode character as literal UTF-8. There is no hand-rolled
// escaping here because there is nothing for it to do that JSON.stringify
// does not already do correctly -- verified against an independent
// Python/Node cross-check, see nip01.test.ts's header.
//
// WebCrypto, not node:crypto, for the same portability reason as
// src/broker/policy/derive.ts and bundle-hash.ts: globalThis.crypto.subtle is
// a global in browsers, Node and WASI alike (ADR-0002), and this module runs
// injected into an arbitrary web page, not in the main process.

import { fail } from './errors.js'
import { toLowercaseHex } from './hex.js'

/**
 * The fields a NIP-07 caller supplies to signEvent -- deliberately NOT
 * including id, pubkey or sig, which are outputs the signer attaches, never
 * inputs an app provides (NIP-07: "takes an event object, adds id, pubkey
 * and sig and returns it"). Trusting a caller-supplied id or pubkey here
 * would let an untrusted page ask a signer to attest to bytes it never
 * actually derived.
 */
export interface UnsignedNostrEvent {
  readonly created_at: number
  readonly kind: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
}

/** The full event NIP-07's signEvent() returns. */
export interface SignedNostrEvent extends UnsignedNostrEvent {
  readonly id: string
  readonly pubkey: string
  readonly sig: string
}

const MAX_KIND = 65535
const PUBKEY_HEX = /^[0-9a-f]{64}$/

/**
 * Runtime validation, not just a type assertion -- this is the boundary
 * where an arbitrary web page's signEvent(event) argument first lands, and
 * TypeScript's types do not survive that crossing. Throws (code 'invalid')
 * rather than coercing, so a malformed event never silently becomes a
 * different, unintended one.
 */
export function validateUnsignedEvent (event: unknown): asserts event is UnsignedNostrEvent {
  if (typeof event !== 'object' || event === null) {
    throw fail('invalid', 'event must be an object')
  }
  const { created_at, kind, tags, content } = event as Record<string, unknown>

  if (!Number.isInteger(created_at) || (created_at as number) < 0) {
    throw fail('invalid', `created_at must be a non-negative integer, got ${JSON.stringify(created_at)}`)
  }
  if (!Number.isInteger(kind) || (kind as number) < 0 || (kind as number) > MAX_KIND) {
    throw fail('invalid', `kind must be an integer in 0..${MAX_KIND}, got ${JSON.stringify(kind)}`)
  }
  if (!Array.isArray(tags) || !tags.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string'))) {
    throw fail('invalid', 'tags must be an array of string arrays')
  }
  if (typeof content !== 'string') {
    throw fail('invalid', `content must be a string, got ${JSON.stringify(content)}`)
  }
}

/**
 * NOT exported: pubkey validity is specific to computeEventId's contract
 * (NIP-01 requires LOWERCASE hex -- see computeEventId's header comment for
 * why that case is load-bearing), whereas validateUnsignedEvent's fields are
 * meaningful on their own wherever an UnsignedNostrEvent shows up.
 */
function validatePubkeyHex (pubkey: unknown): asserts pubkey is string {
  if (typeof pubkey !== 'string' || !PUBKEY_HEX.test(pubkey)) {
    throw fail('invalid', `pubkey must be 64 lowercase hex characters, got ${JSON.stringify(pubkey)}`)
  }
}

const UTF8 = new TextEncoder()

/**
 * The event whose id computeEventId derives. pubkey is not part of
 * UnsignedNostrEvent (an app never supplies it) but IS part of what gets
 * hashed, so this is its own shape rather than UnsignedNostrEvent-plus-a-cast.
 */
export type EventForId = UnsignedNostrEvent & { readonly pubkey: string }

/**
 * sha256(JSON.stringify([0, pubkey, created_at, kind, tags, content])), as
 * lowercase hex. Re-validates its input rather than trusting the caller --
 * this is a hashing routine a signer's correctness depends on, so it does
 * not assume validateUnsignedEvent already ran upstream.
 *
 * PUBKEY CASE IS LOAD-BEARING, not cosmetic. "abc..." and "ABC..." are the
 * same key but serialize to two different JSON strings, so an uppercase
 * pubkey silently produces a DIFFERENT, wrong id rather than an error --
 * exactly the kind of footgun bundle-hash.ts's byte-vs-code-unit warning
 * exists to name. Rejected outright rather than lowercased for the caller,
 * because a signer that quietly normalises the input is a signer whose
 * caller cannot tell whether it verified anything.
 */
export async function computeEventId (event: EventForId): Promise<string> {
  validateUnsignedEvent(event)
  validatePubkeyHex(event.pubkey)

  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const digest = await globalThis.crypto.subtle.digest('SHA-256', UTF8.encode(serialized) as Uint8Array<ArrayBuffer>)
  return toLowercaseHex(new Uint8Array(digest))
}
