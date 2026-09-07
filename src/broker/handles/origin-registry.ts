// The map of per-origin tables HandleTable owns, and the three primitives
// every HandleTable method needs against it: normalising a key, getting or
// creating a table, and reaping one that holds nothing at all. This is the
// seam every acquisition method (acquire/acquireDerived/lookup/run) and
// every teardown method (release/fail/abort/revoke/dropOrigin) shares.
// HandleTable keeps the operations; this keeps the map they all operate on
// -- the same division ./handle-store.ts draws between "one origin's state"
// and the map of origins.

import { originFromUrl } from '../policy/origin.js'
import { fail } from '../errors.js'
import { OriginTable } from './handle-store.js'
import type { HandleTableFault } from './handle-contracts.js'

export class OriginRegistry {
  readonly #tables = new Map<string, OriginTable>()

  /**
   * The isolation key, through the one definition of it (policy/origin.ts).
   *
   * Normalises rather than trusts: `https://app.example:443/path` and
   * `https://app.example` are one app, and keying on the raw string would give
   * it two tables -- two socket budgets to exhaust, and a revoke that reached
   * only one of them. A string that cannot be an origin at all (file:, data:,
   * blob:, a bare hostname) is a BROKER fault, not an app-visible denial: the
   * app never supplies its own origin, the broker derives it from the sender
   * frame (T3).
   *
   * Reported to `onFault` as well as thrown. errors.ts says an 'internal' error
   * is "a broker fault; should never be observed by an app, always logged", and
   * origin.ts documents a detached frame resolving to about:blank as an
   * EXPECTED condition -- so this fires in normal operation.
   */
  key (origin: string, onFault: (fault: HandleTableFault) => void): string {
    const canonical = originFromUrl(origin)
    if (canonical === null) {
      const error = fail('internal', 'handle table keyed on a string that is not an origin')
      onFault({ origin, handleId: null, error })
      throw error
    }
    return canonical
  }

  /** The table for a normalised key, or undefined. Never allocates -- a read must not create one for an origin that merely asked. */
  existing (key: string): OriginTable | undefined {
    return this.#tables.get(key)
  }

  /** The table for a normalised key, creating one if this is that origin's first handle. */
  getOrCreate (key: string): OriginTable {
    const existing = this.#tables.get(key)
    if (existing !== undefined) return existing

    const created = new OriginTable()
    this.#tables.set(key, created)
    return created
  }

  /**
   * Drops an origin's table once it holds nothing at all.
   *
   * Without this every origin the broker ever asked about keeps a permanent
   * row, each carrying a recently-closed ring of up to 576 ids. Tombstones and
   * live handles both count as "holds something", so this cannot discard a
   * revocation that still has to be enforced.
   */
  reap (key: string, table: OriginTable): void {
    if (table.dropping) return
    if (table.handles.size > 0 || table.inFlight > 0) return
    if (table.revokedGrants.size > 0 || table.grantOperations.size > 0) return
    // recentlyClosed counts as "holds something". Reaping a table that still
    // remembers ids would make an origin's own just-closed handle answer
    // 'denied' instead of 'closed' -- losing the distinction OriginTable.record
    // exists to draw. It is bounded per origin and cleared by dropOrigin, so
    // keeping it is a bound, not a leak.
    if (table.recentlyClosed.size > 0) return
    this.deleteIfCurrent(key, table)
  }

  /** Deletes `key`'s table, but only if it is still `table` -- a late registration racing a teardown must not have its fresh table pulled out from under it. */
  deleteIfCurrent (key: string, table: OriginTable): void {
    if (this.#tables.get(key) === table) this.#tables.delete(key)
  }

  /** Origins with a live table. Exists so HandleTable's no-allocation rule is testable. */
  size (): number {
    return this.#tables.size
  }
}
