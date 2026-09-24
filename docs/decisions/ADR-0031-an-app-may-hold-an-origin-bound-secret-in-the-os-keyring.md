# ADR-0031: An app may hold one origin-bound secret in the OS keyring; the identity seed itself still never leaves the broker

- **Status:** proposed
- **Date:** 2026-09-24
- **Type:** security
- **Decided by:** owner

## Decision

Orivon's own identity seed moves into Electron `safeStorage`, so `orivon.id.publicKey`/`sign`
survive a restart for the first time -- production's `keychain.getSeed` currently throws
`'internal'` unconditionally, even though the HKDF derivation it would feed
(`src/broker/policy/derive.ts`, `ADR-0010`) is fully built and tested. No app, ever, reaches this
seed. That half of `ADR-0003`'s "no app, ever" line is unchanged and this ADR does not touch it.

Orivon gains one new capability kind, `secrets`, and one new namespace, `orivon.secrets`
(`available`/`encrypt`/`decrypt`). A grant for `secrets` gives an app access to an
**origin-bound, derived** secret -- `HKDF-SHA256(seed, salt='orivon-secrets-v1', info=origin)`
feeding AES-256-GCM -- the same "the app gets a *derivative*, never the source" shape
`orivon.id`'s app keys already use for signing. The app holds ciphertext; it never holds, and
cannot derive, the seed itself. `ADR-0003`'s "no app, ever" is **amended in place** by this ADR to
say precisely that: the seed, never; an app's own derived secret, only with a grant.

## Context

`compatibility-matrix.md` listed "Secure seed storage (OS keyring, `safeStorage`)" as `❌ missing`,
naming the exact gap above. Two ported apps need the app-facing half specifically: Element
Desktop wraps its Matrix pickle key with `safeStorage` upstream and its own porting README asks
for "an app-facing secret-storage capability backed by the OS keyring... reconsider ADR-0003's
'no app, ever' line" as a named hand-off item; AirGap Vault's web build writes its BIP-39 seed
entropy to `localStorage` in plaintext for want of anything better. Both are asking for the same
thing this ADR grants: a keyring-backed secret that is theirs alone, not Orivon's identity seed.

## Alternatives considered

**Leave `ADR-0003`'s line as an absolute.** Leaves both ported apps with no better option than
plaintext `localStorage`, which is a strictly worse outcome for the person than a grantable,
origin-bound, keyring-backed secret ever could be.

**Let an app derive from the identity seed directly, the way `orivon.id` does for signing.** Signing
is safe to expose because a signature cannot be inverted back into the seed. Encryption is
different: an app holding `decrypt` for a key derived straight from the seed, with no isolation
of its own, converts "give this app the ability to decrypt its own data" into a standing
side-channel against the one secret `ADR-0003` names as untouchable, purely by how carefully every
future caller of that derivation happens to be written. A dedicated salt and a dedicated
derivation path (`'orivon-secrets-v1'` vs. `ADR-0010`'s own frozen `'orivon-kdf-v1'`) keeps the
two uses cryptographically unrelated: compromising the app-facing key can never touch the app-key
or named-identity derivations, and the reverse.

**Give an app the raw seed, with consent.** Rejected outright -- this is exactly what `ADR-0003`
exists to prevent, and would make every future `secrets` grant a single point of failure for the
one thing the rest of the security model is built to keep local and untouchable.

## Reasoning

The seed itself staying unreachable is not weakened by this ADR; it is what makes the new
capability safe to grant at all. `orivon.secrets` is deliberately shaped like `orivon.id`'s app
keys: per-origin, derived with a distinct, frozen salt, bytes in and bytes out, no encoding
opinion (`OrivonFs`'s A12 precedent). `available()` resolving `false` rather than throwing when
the seed is session-only (no reachable OS keyring) lets an app choose not to rely on persistence
rather than discover data loss after a restart -- the honest answer to a question an app is
entitled to ask before it commits anything to disk.

## Consequences

- `orivon.id` becomes usable end to end for the first time: identity survives a restart.
- Element's and AirGap Vault's ported-app hand-off items against this exact line are answered.
- A Linux machine with no reachable keyring (`safeStorage.isEncryptionAvailable()` false, or the
  selected backend is `basic_text`/`unknown`) gets a **session-only** seed: never written to disk
  in plaintext, told to the person once per session, and any `secrets` ciphertext made against it
  does not survive a restart -- `available()` says so up front.
- The wire format for `orivon.secrets` ciphertext is a one-way door once an app depends on it, the
  same status `ADR-0010`'s frozen construction already has; a version byte is reserved for a v2.
- `LIMITS.secretBytes` bounds a single `encrypt` call; an app needing bulk storage still wants
  `orivon.fs`, whose quota is declared and shown at grant time.

## Reversibility

- **Cost to reverse:** cheap before an app ships depending on `secrets`; expensive after, matching
  `ADR-0010`'s reasoning for its own frozen construction.
- **What would make us revisit:** a keyring-availability measurement that shows the session-only
  path triggering far more often than expected on the supported platforms; or a real app needing
  more than one secret per origin, which the current presence-only `SecretsCapability` has no
  field for.
