// One origin's side of a grant being replaced by another for the same
// capability (HandleTable.replaceGrant). A handle the new grant still covers
// is re-filed under it and keeps running; everything else is revoked, as a
// plain revoke of the old grant would have done to all of it. See
// README.md's Design notes for why an acquisition still in flight follows the
// new grant only when the new one covers everything the old one did.

import type { GrantId, Pattern } from '../../contracts/index.js'
import { fail } from '../errors.js'
import { cancelOperation } from './handle-store.js'
import { REVOKED_GRANT_MEMORY, remember } from './tombstones.js'
import type { HandleRecord, OriginTable } from './handle-store.js'
import type { HandleTableFault } from './handle-contracts.js'

/** Moves `record` from the grant set it is filed in to `grantId`'s. */
function refile (table: OriginTable, record: HandleRecord, grantId: GrantId): void {
  const previous = record.authorisation
  if (previous.by !== 'grant') return
  const from = table.byGrant.get(previous.grantId)
  from?.delete(record.entry.id)
  if (from !== undefined && from.size === 0) table.byGrant.delete(previous.grantId)
  const to = table.byGrant.get(grantId) ?? new Set<string>()
  to.add(record.entry.id)
  table.byGrant.set(grantId, to)
  record.authorisation = Object.freeze({ by: 'grant' as const, grantId })
}

/**
 * Whether the replacement still authorises `record`. A derived handle (an
 * accepted connection) is judged by the handle it came from: it has no
 * authority of its own, and closing its parent would close it anyway.
 */
function stillCovered (table: OriginTable, record: HandleRecord, patterns: readonly Pattern[], coversAll: boolean): boolean {
  const parent = record.entry.parentId === null ? undefined : table.handles.get(record.entry.parentId)
  const judge = parent ?? record
  return judge.stillCovered?.(patterns) ?? coversAll
}

export function replaceGrantIn (
  table: OriginTable,
  replaced: GrantId,
  replacement: GrantId,
  patterns: readonly Pattern[],
  coversAll: boolean,
  onFault: (fault: HandleTableFault) => void
): void {
  const ids = table.byGrant.get(replaced)
  for (const id of Array.from(ids ?? [])) {
    const record = table.handles.get(id)
    // Absent means a parent's cascade, earlier in this same loop, took it.
    if (record === undefined) continue
    if (stillCovered(table, record, patterns, coversAll)) refile(table, record, replacement)
    else void table.closeTree(record, 'revoked', onFault)
  }

  if (coversAll) {
    // Anything still in flight under the old grant was authorised by
    // patterns the new grant covers, so it lands under the new one, and a
    // revoke of the new one reaches it. Aliases stay flat: an older alias to
    // `replaced` is pointed straight at `replacement`.
    for (const [from, to] of table.grantAliases) if (to === replaced) table.grantAliases.set(from, replacement)
    table.grantAliases.set(replaced, replacement)
    return
  }

  // An acquisition in flight has no resource yet to judge, so it is treated
  // the way a revoke treats it.
  remember(table.revokedGrants, replaced, REVOKED_GRANT_MEMORY)
  const pending = table.grantOperations.get(replaced)
  for (const operation of Array.from(pending ?? [])) {
    cancelOperation(operation, fail('revoked', 'the grant authorising this operation was replaced'))
  }
  table.grantOperations.delete(replaced)
}

/** The grants whose in-flight work now answers to `grantId`, because it replaced them and kept everything they authorised. */
export function aliasesOf (table: OriginTable, grantId: GrantId): readonly GrantId[] {
  const aliases: GrantId[] = []
  for (const [from, to] of table.grantAliases) if (to === grantId) aliases.push(from)
  return aliases
}
