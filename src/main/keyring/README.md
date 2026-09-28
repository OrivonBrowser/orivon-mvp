# `src/main/keyring/`: the identity seed, OS-keyring-backed or session-only

**What lives here.** `seed-store.ts` generates, persists, reads back and rotates Orivon's own
identity seed under `<userData>/identity/seed.json`. `electron-keychain.ts` hands it Electron's
real `safeStorage` and exposes the result as a
[`Keychain`](../../broker/secrets-contracts.ts)
([`ADR-0033`](../../../docs/decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md)).
No reachable keyring means a session-only seed, never plaintext on disk
([`security-model.md`](../../../docs/architecture/security-model.md) §Cross-platform note).

**Tied to Electron.** `electron-keychain.ts` only; `seed-store.ts` takes a `SafeStorageLike` and
is tested against a real temp directory.

**What it depends on.** [`../../contracts/`](../../contracts/) (types),
[`../../broker/secrets-contracts.ts`](../../broker/secrets-contracts.ts),
[`../../broker/grants/node-ledger-storage.ts`](../../broker/grants/node-ledger-storage.ts)'s
`writeFileAtomic`, and `electron`'s `safeStorage` in `electron-keychain.ts` only.

**What it must never import.** [`../../renderer/`](../../renderer/) code. `seed-store.ts` must
stay `electron`-free: it is the half a plain vitest run exercises.

**Owner stream.** `broker`, with the rest of `orivon.secrets`.

## Design notes

`seed-store.ts`'s comments hold its traps: an unreadable file is never overwritten (the
`'absent'`/`'unreadable'`/`'ok'` split), only async `safeStorage` calls are made, the backend
name is checked too, and a re-encrypt is fire-and-forget.
