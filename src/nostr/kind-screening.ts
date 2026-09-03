// Orivon's own signing policy layered on top of NIP-01, not a NIP itself.
// src/nostr/README.md: "Kinds 1/6/7 sign silently after the connect prompt;
// 0, 3, 5, 22242 and any delegation prompt every time." This table is that
// rule, made explicit and exhaustive rather than left as an inferred pattern
// -- a Nostr client that expects silent signing for a kind this table gets
// wrong is a real product bug, and the failure direction that matters is
// getting it backwards: an unscreened kind must default to 'prompt', never
// 'silent' (acceptance criterion 3).
//
// NOT THE ENFORCEMENT BOUNDARY. IdentityHandle.signEvent(event: object) is
// documented (capability-api.ts) as serialising and screening `kind` itself,
// broker-side -- because the broker must never trust a renderer's claim about
// its own event, the same reason signEvent takes a structured object instead
// of raw bytes to sign. This table's result travels with a signEvent call as
// a HINT only (see nip07.ts's NostrSigner), so a UI can show the right
// affordance before the signing call resolves; it carries no authority.

/** What this module asks a signer to do. Not a promise about what happens -- see the header. */
export type SignPrompt = 'silent' | 'prompt'

/**
 * Exhaustive rather than a computed rule (e.g. "odd kinds prompt") on
 * purpose: a lookup table is auditable at a glance, and adding a new kind
 * later is a one-line, reviewable diff instead of a re-derivation of some
 * clever formula.
 */
const SILENT_KINDS: ReadonlySet<number> = new Set([1, 6, 7])

/**
 * NIP-26's delegation tag (`["delegation", <delegator pubkey>, <conditions>,
 * <token>]`) can appear on an event of ANY kind, including an otherwise-
 * silent one -- it grants the delegatee the right to sign on the delegator's
 * behalf, which is exactly the kind of consequential action the silent path
 * exists to exclude. Checked by the tag's first element, matching NIP-26's
 * own wire shape.
 */
function hasDelegationTag (tags: readonly (readonly string[])[]): boolean {
  return tags.some((tag) => tag[0] === 'delegation')
}

/**
 * The only two inputs the table depends on: kind, and whether a delegation
 * tag is present. Takes this narrow a shape (not the full UnsignedNostrEvent)
 * so a caller that only has these two fields -- e.g. a future broker-side
 * re-implementation working from raw wire data -- does not need to construct
 * a whole event just to ask the question.
 */
export function screenEvent (event: { readonly kind: number, readonly tags: readonly (readonly string[])[] }): SignPrompt {
  if (hasDelegationTag(event.tags)) return 'prompt'
  return SILENT_KINDS.has(event.kind) ? 'silent' : 'prompt'
}
