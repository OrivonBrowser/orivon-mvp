# ADR-0010: Key derivation is frozen at v1, and versioned by its salt

- **Status:** accepted
- **Date:** 2026-08-27
- **Type:** security
- **Decided by:** owner

## Decision

Every Orivon key is derived from the user's root seed by **length-prefixed HKDF-SHA-256**:

```
salt = "orivon-kdf-v1"                          the version tag rides in the salt
info = LP(label) || LP(scope) || LP(curve)      LP(s) = uint32be(utf8ByteLength(s)) || utf8(s)
okm  = HKDF-SHA-256(ikm = seed, salt, info, L = 48)
d    = (be(okm) mod (n - 1)) + 1                -> 32 bytes, big-endian
```

with `label` one of `'app'` or `'identity'`, and:

- `label = 'app'` → `scope` is the **canonical origin**, as produced by
  `originFromSenderFrame()` in `src/broker/policy/origin.ts` (arriving in the `broker-01`
  stream). Two traps here, both of which issue the user a different key or the wrong user's key:
  - Not `URL.origin` — `open-questions.md` A14 deliberately deviates from it (a trailing DNS
    dot is stripped), so the two disagree on real inputs.
  - Not the bare `originFromUrl()` underneath it either. The frame variant cross-checks the
    committed URL against the frame's own origin and denies when they disagree; deriving from
    the URL alone hands a CSP-sandboxed, opaque-origin document the embedding app's whole grant
    set, this identity key included (`security-model.md` T3, T13b).
- `label = 'identity'` → `scope` is an **opaque, broker-generated identityId**. Never a
  user-typed name and never derived from one.

This construction is **frozen**. It is pinned by
[`src/broker/policy/derive-vectors.json`](../../src/broker/policy/derive-vectors.json), checked
two ways in CI: the unit tests prove the WebCrypto implementation reproduces the table, and
`scripts/check-vectors.mjs` proves an independent `node:crypto` implementation reproduces it too.

A change to any line above is a **v2**: bump `KDF_SALT`, *add* rows beside the existing ones,
and write the migration. Never edit a frozen row.

## Context

`capability-api.md` and `security-model.md` T8b both require "a distinct secret per
`(label, curve)` via length-prefixed HKDF", and `build-plan.md` step 4 requires golden vectors.
Neither document specifies the salt string, the field order, the OKM length, or the reduction —
so the implementation in `stream/broker-06-keys` had to choose all four. Under Rule 1 those
choices are load-bearing and reversible only at cost, which is what this ADR records.

What makes them one-way rather than merely awkward: **key export and backup are out of scope for
the MVP** (`ADR-0003`, `mvp-scope.md`). While that holds, a user has no copy of their key and no
way to restore one. So a derivation change does not fail loudly — it silently issues every user a
new identity, orphaning their Nostr follows and posts on an npub they can no longer produce. The
damage is invisible when introduced and permanent by the time anyone notices.

State that boundary carefully: export/backup is excluded from **this MVP**, and `ADR-0003` names
it as the first thing to add afterwards. It is not a permanent property of Orivon. When it ships,
migration becomes possible and the absolute freeze here relaxes into an ordinary versioned-KDF
story — which is exactly what the salt tag exists to support.

This ADR also closes the `identityId` question, which had no definition anywhere in the
repository: it appeared once, as a single table cell in `capability-api.md`.

## Alternatives considered

**Take 256 bits and retry when the value is out of range.** Exactly uniform, and the textbook
answer. Rejected: the retry branch fires with probability ~2⁻³² on P-256, so it would ship
untested and stay unreachable for the life of the product. An untestable branch in key derivation
is a worse risk than the bias it removes. 384 bits reduced into `[1, n-1]` is FIPS 186-5 A.2.1
("extra random bits"), which requires ≥64 bits of headroom and gets 128, leaving a bias around
2⁻¹²⁸.

**Put the version tag in `info` rather than the salt.** Works identically. Rejected because it
would sit alongside three caller-supplied fields, where it reads as a fourth domain separator
rather than as the thing that versions the whole scheme. In the salt there is exactly one place
to look, and changing it is visibly a scheme change.

**Concatenate the fields without length prefixes.** Rejected outright: `("app", "abc")` and
`("ap", "pabc")` produce identical `info`, so one scalar would serve two schemes and void the
security argument for both (T8b). This is asserted at the byte level in the test suite.

**Use `value.length` for the prefix instead of the UTF-8 byte length.** Not a real alternative,
but recorded because it is the specific mistake this construction invites: the two coincide for
ASCII and differ for everything else, so the substitution passes an all-ASCII vector table while
changing the key for every non-ASCII scope. It was confirmed to survive the original 18-test
suite. The table now carries two deliberately multi-byte rows, and the suite asserts they stay.

**Derive secp256k1 public keys here too, via a pure-JS curve library.** Deferred, not rejected on
principle — see below.

**Let `identityId` be a user-supplied name.** Rejected: renaming an identity, or merely changing
its case, would issue a different npub with no way to recover the old one. The display name is
stored beside the identity instead, and never participates in derivation.

## Reasoning

The construction is deliberately boring. HKDF-SHA-256 is in every engine Orivon might ever run
on, the reduction is the FIPS-sanctioned one, and every parameter that could drift is pinned by a
vector row.

**WebCrypto rather than `node:crypto`** because `globalThis.crypto.subtle` exists in browsers,
Node and WASI alike. `ADR-0002` makes the capability layer the durable asset and the Electron
shell disposable; reaching for `node:crypto` here would tie the durable half to the disposable
one.

**Two implementations, one table.** The vectors' value depends entirely on their having been
computed by something other than the code under test. That was previously a claim in a comment,
referring to a reference implementation that was never checked in — unfalsifiable, and because
the table is frozen forever, its provenance could never have been re-established later.
`scripts/check-vectors.mjs` makes it checkable. It is a **verifier with no write mode**, which
matters: a generator can be pointed at a failing row and re-run, and that is precisely the move
the freeze forbids.

## Consequences

- The five original vector rows and the two encoding rows are permanent. CI fails on any change
  to the derivation, which is the intent.
- `curve` is the only app-controlled input on this surface (the contract types it as a free-form
  `string`), so it is validated against a **null-prototype** table via `Object.hasOwn`. An
  ordinary object literal lets inherited keys — `__proto__`, `constructor`, `toString` — walk
  past an `=== undefined` guard. `noUncheckedIndexedAccess` does not catch this: TypeScript
  models missing own-properties, not the prototype chain.
- Adding a curve is additive and safe. Removing or renaming one orphans every key derived under
  it, so it is a v2 event.
- Callers must pass a canonical scope. Two spellings of the same origin are two identities, and
  neither the type system nor this layer can tell them apart — the coupling to `origin.ts` is
  documented on `DeriveRequest.scope` and cannot be enforced there.
- A degenerate seed (every byte identical) is refused. The realistic trigger is a `safeStorage`
  read failing soft and returning zeros, which would otherwise hand every affected user the same
  identity.

### Accepted risks

**The reduction is not constant time.** `bytesToBigInt` and the `%` that follows are JavaScript
BigInt operations, whose timing varies with the values involved, and the scalar is secret. This
is the one piece of arithmetic the file does not delegate to an audited implementation.

Accepted rather than fixed, for two reasons. The exposure is thin: the reduction runs in the main
process behind async IPC, and a single 384-bit modulo's variance sits far below that path's noise
floor. And the available fix is worse than the defect — hand-writing constant-time bigint
arithmetic here is the same hazard the file refuses when it declines to hand-roll scalar
multiplication. **Do not close this by hand-rolling.** The real fix is an audited constant-time
curve library, which is the `nostr` stream's decision below.

**The seed is read in full on every derivation.** `isDegenerateSeed` scans the whole buffer
rather than returning at the first differing byte, so it has no data-dependent branch — but it
does mean the root secret is walked once per call in addition to being handed to WebCrypto. That
is inherent to checking it at all, and checking it is the point.

**`encodeDeriveInfo` is exported for its test.** It takes three plain strings and returns the
public `info` byte string; it touches no key material. The export is a testability concession,
not a capability, and nothing outside `derive.test.ts` may call it.

## Reversibility

- **Cost to reverse:** one-way door while `ADR-0003` holds. There is no export, so users cannot
  be migrated; a v2 can only add keys beside the v1 ones and ask the user to move their identity
  by hand. It relaxes to **moderate** once identity export ships.
- **What would make us revisit:**
  - **Export/backup shipping** (`ADR-0003` names it as the first post-MVP addition). That makes a
    real migration possible and is the trigger for treating a v2 as ordinary work.
  - **A third curve, or a curve removal.** Additive is safe; removal is not.
  - **The `nostr` stream needing secp256k1 public keys.** This is scheduled, not hypothetical.
    `derivePublicKey()` serves P-256 only, and refuses secp256k1 with `'internal'` pointing at
    `src/nostr/`, which needs a secp256k1 implementation regardless because WebCrypto cannot
    produce a BIP-340 Schnorr signature either.

    Note for whoever picks that up, because the earlier draft of `derive.ts` got this wrong: the
    constraint is **not** "add no dependency" — no such rule exists. CLAUDE.md Rule 8 is "pure-JS
    dependencies only" (nothing needing a compiler at install time) and Rule 6 is "do not
    reinvent without a written reason". A pure-JS audited curve library such as `@noble/curves`
    satisfies both. The argument for staying on WebCrypto in the policy layer is
    engine-independence (`ADR-0002`), not dependency count, and it applies with much less force
    one layer up. Adopting such a library there would also let secp256k1 gain real public-key
    vectors and would close the timing risk above. **Owner decision, 2026-08-27: not in this PR;
    decide it in the `nostr` stream, with its own ADR.**
  - **A weakness found in the construction itself.** Then a v2 is forced regardless of cost, and
    the salt tag is what makes it expressible.
