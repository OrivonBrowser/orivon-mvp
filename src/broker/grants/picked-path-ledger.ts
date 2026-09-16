// The per-origin state a `userSelected` pick needs -- kept apart from
// GrantLedger the same way GrantLedger itself is kept apart from HandleTable
// (../index.ts's own header: "the manifest and grants, kept apart on
// purpose"). A pick is not a Grant: it carries no CapabilityKind, needs no
// manifest to re-validate against (nothing about it can widen or narrow --
// the picker choice IS the whole authorisation, capability-api.ts's own
// `userSelected` doc), and grant-ledger.ts had no line budget left to grow
// a third concern into (code-guidelines.md Rule 2 -- it sits at its 500-line
// ceiling as landed by A184).
//
// SHARES STORAGE WITH GrantLedger, per D-0007: "P4-3 and P4-4 now share a
// surface" -- both read/write the same per-origin file through the same
// injected `LedgerStorage`, just a different slice of it
// (../grants/node-ledger-storage.ts's own header explains how one write
// preserves the other's half). This class is the SEPARATE STATE CLASS that
// surface is coordinated through, not a second store.

import type { LedgerStorage, PersistedPick } from './ledger-storage.js'
import { isPersistableOrigin } from '../policy/origin.js'

/** One pick, with the id it is addressed by -- `PersistedPick` plus the key `LedgerStorage` stores it under. */
export interface PickedPath extends PersistedPick {
  readonly id: string
}

/**
 * 128 bits from the platform CSPRNG, as hex -- same construction as
 * handle-store.ts's `newHandleId` and grant-ledger.ts's `newGrantId`. This id
 * does double duty: it is both the key `LedgerStorage` persists a pick
 * under AND the `pickId` a live handle's `Authorisation` carries
 * (../handles/handle-contracts.js), which is what lets one revoke reach a
 * pick whether or not the app happens to be loaded this session.
 */
function newPickId (): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * What each origin holds: hydrated lazily from `LedgerStorage` on first
 * touch, exactly like `GrantLedger`'s own `#record` -- there is no re-
 * validation step to run first (unlike a restored Grant, a restored pick
 * needs no manifest to check it against), so hydration here is a plain
 * disk read, not `grant-persistence.ts`'s `hydrateGrants`.
 */
export class PickedPathLedger {
  readonly #origins = new Map<string, Map<string, PersistedPick>>()
  readonly #storage: LedgerStorage | undefined

  constructor (storage?: LedgerStorage) {
    this.#storage = storage
  }

  #record (origin: string): Map<string, PersistedPick> {
    const existing = this.#origins.get(origin)
    if (existing !== undefined) return existing
    const created = new Map<string, PersistedPick>()
    for (const [id, pick] of Object.entries(this.#storage?.readPickedPaths(origin) ?? {})) {
      created.set(id, pick)
    }
    this.#origins.set(origin, created)
    return created
  }

  /**
   * Records a successful pick -- the OS picker resolving, never a grant
   * (capability-api.ts: "the user's choice IS the consent"). Persists
   * immediately, same as `GrantLedger.grant`, so the settings list survives
   * a restart from the moment of the pick, not from the next explicit save.
   */
  record (origin: string, kind: PersistedPick['kind'], path: string, pickedAt: number, appName: string | undefined): PickedPath {
    const id = newPickId()
    const pick: PersistedPick = { kind, path, pickedAt }
    this.#record(origin).set(id, pick)
    this.#persist(origin, appName)
    return { id, ...pick }
  }

  /** Every pick this origin holds, for the live settings-list read of a LOADED app -- `app.pickedPaths` in ../broker-contracts.ts. */
  listFor (origin: string): readonly PickedPath[] {
    return Array.from(this.#record(origin), ([id, pick]) => ({ id, ...pick }))
  }

  /**
   * Withdraws one pick, by id -- addressed the same way `GrantLedger.
   * revokePersisted` addresses a capability, and for the same reason: the
   * settings list's revoke button must work whether or not this origin is
   * loaded this session, and a pick has no other stable handle once the
   * live one it may have authorised is gone. Returns whether anything was
   * actually removed.
   *
   * DOES NOT TOUCH THE HANDLE TABLE -- that cascade is
   * `HandleTable.revokeUserSelected` (../handles/handles.ts), a SEPARATE
   * call this method's own caller (`../index.ts`'s `revokeUserSelectedPath`)
   * makes alongside this one. Kept apart for the same reason `GrantLedger.
   * revoke` and `HandleTable.revoke` are two calls, not one: this class has
   * no HandleTable reference, the same boundary `GrantLedger`'s own header
   * draws.
   */
  revoke (origin: string, pickId: string): boolean {
    const removed = this.#record(origin).delete(pickId)
    if (removed) this.#persist(origin)
    return removed
  }

  /** Skips loopback and plain-http origins (T13c), the same guard `grant-persistence.ts`'s `persistGrants` applies -- a dev fixture's picks must not survive past its own session either. */
  #persist (origin: string, appName?: string): void {
    if (this.#storage === undefined || !isPersistableOrigin(origin)) return
    const record = this.#origins.get(origin)
    const picks: Record<string, PersistedPick> = {}
    for (const [id, pick] of record ?? []) picks[id] = pick
    this.#storage.writePickedPaths(origin, picks, appName)
  }
}
