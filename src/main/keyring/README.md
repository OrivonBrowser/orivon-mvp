# `src/main/keyring/`: the identity seed, OS-keyring-backed or session-only

**What lives here.** `seed-store.ts`: pure logic for generating, persisting, reading back and
rotating Orivon's own identity seed under `<userData>/identity/seed.json` — no `electron` import,
tested against a real temp directory the same way [`../sessions/notification-decisions.ts`](../sessions/notification-decisions.ts)
already is. `electron-keychain.ts`: the thin wiring that hands `SeedStore` Electron's real
`safeStorage` and exposes the result as a [`Keychain`](../../broker/secrets-contracts.ts)
([`ADR-0033`](../../../docs/decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md)).

**What it depends on.** [`../../contracts/`](../../contracts/) (types only),
[`../../broker/secrets-contracts.ts`](../../broker/secrets-contracts.ts) (the `Keychain` type
`electron-keychain.ts` builds), [`../../broker/grants/node-ledger-storage.ts`](../../broker/grants/node-ledger-storage.ts)'s
`writeFileAtomic` (reused, not reimplemented — code-guidelines.md Rule 3), and `electron`'s
`safeStorage` in `electron-keychain.ts` only.

**What it must never import.** [`../../renderer/`](../../renderer/) code, the same rule every
`src/main/` directory follows. `seed-store.ts` specifically must stay `electron`-free — it is
the half of this directory a plain vitest run actually exercises.

**Owner stream.** `broker` ([`ADR-0033`](../../../docs/decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md)),
alongside the rest of `orivon.secrets`. New as of this ADR.

## Design notes

**Why `SeedStore` is pure and `electron-keychain.ts` is a two-function wrapper around it,
rather than one file.** The same split `docs/development/code-guidelines.md`'s suffix
vocabulary already names elsewhere in `src/main/`: the decision (generate, or read back; when a
file is unreadable, never overwrite it) has no `electron` dependency of its own — it only needs
something SHAPED like `safeStorage`'s async trio, which `SafeStorageLike` names explicitly so a
test can hand it a fake. `electron-keychain.ts` supplies the real one and the real file path
(`ctx.app.getPath('userData')`, read at `src/broker/transport/ipc.ts`'s own construction site)
and nothing else.

**Why the seed file is never overwritten once something is there, even when it fails to
decrypt.** `#readExisting`'s own three-way result (`'absent'` / `'unreadable'` / `'ok'`) is the
whole mechanism: only `'absent'` — nothing at the path at all — reaches the code path that
writes. A file that exists but fails to parse, fails to decrypt, or decrypts to something
malformed reads as `'unreadable'`, which falls back to a **session-only** seed and leaves the
file exactly as it was. A transient fault (a locked keyring, a momentary disk error) must never
look identical to "nothing was ever written here" to this store, or the fix for one destroys the
other — confirmed by this directory's own test suite catching exactly that collapse once, before
the three-way split existed.

**Why the async `safeStorage` trio, never the sync one.** A keyring unlock can involve a real OS
prompt (Touch ID, a Keychain password, a KDE Wallet unlock) with human reaction time — the sync
API would block the main process, and every tab's `orivon.*` traffic with it, for however long
that takes. `isEncryptionAvailable()` (sync) is never called from this directory for the same
reason `isAsyncEncryptionAvailable()` exists as a separate method at all.

**Why `'basic_text'` and `'unknown'` (`getSelectedStorageBackend()`) both mean "no real
keyring," even though `isAsyncEncryptionAvailable()` can still report `true` for `'basic_text'`
on Linux.** `security-model.md`'s cross-platform note is explicit: a Linux machine with no
reachable keyring daemon must never fall back to plaintext storage silently. Electron's own
`'basic_text'` backend is exactly that silent plaintext fallback happening one layer down, inside
`safeStorage` itself — `isAsyncEncryptionAvailable()` alone cannot see that distinction, only
`getSelectedStorageBackend()` can, so both are checked together (`#keyringReachable`). `'unknown'`
gets the same treatment on the fail-closed principle stated in `seed-store.ts` itself: a backend
name this file has never heard of is treated as *not* a real keyring, never the reverse.

**Why re-encryption on `shouldReEncrypt` is fire-and-forget.** The seed the caller asked for has
already decrypted successfully by the time `shouldReEncrypt` is even read — nothing about the
current call depends on the rewrite completing. A failed re-encrypt costs one more rotation
prompt next launch, never a lost seed, so blocking `resolve()`'s caller on a write that only
tidies up an already-successful read would trade a real cost for no real benefit.
