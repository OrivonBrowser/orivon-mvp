// The per-origin table: the state one origin's handles live in, and the
// operations that only ever need that one table. Split out of ./handles.ts
// (docs/development/code-guidelines.md Rule 2) as a real class rather than as
// free functions taking a table parameter -- the nine operations below used
// to be HandleTable's own #-private methods, and #-privacy was what stopped
// anything outside that class from mutating a table without the ownership
// check HandleTable performs first. A bare exported function taking an
// OriginTable would have given that up. Giving OriginTable its own methods
// keeps the state and its mutators in one place instead of splitting an
// invariant across a file boundary -- see ./handles.ts for two examples
// (`insert`/`closeTree` here, `record.children` written in ./handles.ts and
// cleaned up here).
//
// BROKER-INTERNAL. Nothing outside ./handles.ts should construct or hold a
// bare OriginTable -- HandleTable is the ownership boundary; this class is the
// state it owns, not a second entry point to it.

import { LIMITS } from '../contracts/index.js'
import type { GrantId, OrivonError } from '../contracts/index.js'
import { fail } from './errors.js'
import type {
  Authorisation,
  CloseReason,
  DestroyResource,
  HandleEntry,
  HandleKind,
  HandleTableFault,
  OriginCounts
} from './handle-contracts.js'

/**
 * ONE message for every "this origin does not hold that handle" answer,
 * whether the id is unknown, belongs to another origin, or was never valid.
 *
 * If those differed an app could ask "does this id exist somewhere else?" and
 * enumerate other origins' handle ids one probe at a time. errors.ts's
 * uniformity rule for `denied` applies to the message as well as the code.
 */
export const NOT_YOURS = 'no such handle for this origin'

/**
 * How many recently-closed ids an origin remembers, so that using a handle it
 * has just closed answers 'closed' rather than 'denied', and so that closing
 * twice is a no-op rather than an error.
 *
 * BOUNDED on purpose: an unbounded set of dead ids is a memory leak an app
 * drives by opening and closing in a loop. The bound is the sum of the two
 * per-kind budgets -- large enough that an origin operating inside its limits
 * always recognises an id it just closed, and derived from the specification's
 * own numbers rather than invented. Past the bound the answer degrades to
 * 'denied', which is the safe direction.
 */
const CLOSED_ID_MEMORY = LIMITS.concurrentSockets + LIMITS.concurrentFileHandles

/**
 * A budget for IdentityHandles, which SSLimits caps nowhere.
 *
 * NOT IN THE SPECIFICATION, and flagged as an AI decision. An unbounded row
 * count is T11 whatever the row holds. Derived rather than invented: an origin
 * gets as many identities as files, which is already absurdly generous -- the
 * v0 surface has one identity kind ('nostr') and a real app holds one.
 *
 * A PER-KIND budget, not a cap on total rows. The first version of this was a
 * total-row backstop, which had the failure mode backwards: 576 identity
 * handles -- free to acquire, capped by nothing -- exhausted the total and left
 * the origin unable to open a single socket or file, while counts() truthfully
 * reported zero sockets. A backstop that lets the uncapped kind consume the
 * capped kinds' budgets is not a backstop.
 */
const MAX_IDENTITY_HANDLES = LIMITS.concurrentFileHandles

/**
 * How many revoked grant ids an origin remembers, so that an acquisition which
 * lands after the cascade has swept is refused rather than registered.
 *
 * BOUNDED for the same reason CLOSED_ID_MEMORY is, and to the same derived
 * value. Past the bound the oldest tombstone is forgotten, which fails OPEN --
 * so the bound has to exceed any plausible number of grants one origin holds.
 * It does, by two orders of magnitude: a Grant is keyed on (origin, capability,
 * pattern set) over six capability kinds (manifest.ts SSCapabilityKind).
 *
 * Exported: revoke() lives on HandleTable (./handles.ts), because it also
 * touches #tables directly, but the bound it tombstones against belongs here
 * with the table it bounds.
 */
export const REVOKED_GRANT_MEMORY = LIMITS.concurrentSockets + LIMITS.concurrentFileHandles

/**
 * Kinds that consume the socket budget.
 *
 * DEVIATION FROM THE SPECIFICATION, flagged: SSLimits enumerates "TcpSocket +
 * UdpSocket + accepted connections", which omits the LISTENING socket of a
 * TcpServer. A listener is an open fd like any other, manifest `listen`
 * patterns are port RANGES rather than single ports, and leaving servers
 * uncounted would let one origin hold unbounded listeners inside its declared
 * range. Counting it is strictly more conservative and costs a real app one
 * slot out of 512.
 *
 * Exported: acquireDerived() on HandleTable checks a parent's kind against
 * this set before letting a handle inherit its grant.
 */
export const SOCKET_KINDS: ReadonlySet<HandleKind> = new Set<HandleKind>(['tcpSocket', 'tcpServer', 'udpSocket'])

export interface PendingOperation {
  readonly controller: AbortController
  readonly reject: (error: OrivonError) => void
}

export interface HandleRecord {
  readonly entry: HandleEntry
  /** Derived handles, by id. Closing this record closes all of them. */
  readonly children: Set<string>
  readonly operations: Set<PendingOperation>
  readonly destroy: DestroyResource
  readonly resolveClosed: () => void
  readonly rejectClosed: (error: OrivonError) => void
}

/**
 * FIFO eviction. Sets iterate in insertion order, so the first is oldest.
 * Stateless -- exported so ./handles.ts's revoke() can tombstone a grant id
 * against REVOKED_GRANT_MEMORY with the same eviction rule closeTree() uses
 * below for recently-closed ids.
 */
export function remember<T> (memory: Set<T>, value: T, bound: number): void {
  if (memory.has(value)) return
  if (memory.size >= bound) {
    const oldest = memory.values().next()
    if (oldest.done !== true) memory.delete(oldest.value)
  }
  memory.add(value)
}

/**
 * Stateless -- exported so ./handles.ts's revoke() and dropOrigin() can cancel
 * an operation the same way closeTree() below does.
 *
 * DELIBERATELY UNGUARDED, and this was checked rather than assumed. An
 * AbortSignal listener is broker code and may throw; a try/catch here does
 * not catch it, because EventTarget dispatch routes the throw to Node's
 * emitUncaughtException out of band rather than back through abort(). The
 * wrapper that was here first therefore caught nothing and implied a
 * protection it did not provide. What matters is verified instead: the
 * sweep continues and every remaining handle is still torn down (see the
 * test), and the exception stays loud, which SSWhat the shim must do rule 2
 * requires of anything touching error handling in security-relevant code.
 */
export function cancelOperation (operation: PendingOperation, error: OrivonError): void {
  // Abort first, so work that checks the signal can start tearing down before
  // it learns its caller has already been told.
  operation.controller.abort(error)
  operation.reject(error)
}

/**
 * 128 bits from the platform CSPRNG, as hex.
 *
 * UNGUESSABILITY IS DEFENCE IN DEPTH, NOT THE SECURITY BOUNDARY. The boundary
 * is the per-origin ownership check in `record()` below. If guessing an id
 * were enough to use a handle, a handle would be a bearer capability --
 * exactly what SSCommon shape forbids, and exactly why handles are not
 * transferable. A counter or a timestamp would still be refused by the
 * ownership check, but it would also hand an attacker a valid id to present,
 * and every layer above would then be one bug away from honouring it.
 */
function newHandleId (): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * One origin's handles, and the operations that touch only this table.
 *
 * See the file header for why this is a class rather than an interface plus
 * free functions: the methods below are the ownership-sensitive core that
 * HandleTable used to hold as #-private methods, kept together with the state
 * they mutate rather than split across a file boundary.
 */
export class OriginTable {
  readonly handles = new Map<string, HandleRecord>()
  /** grantId -> the ids it authorised. userSelected handles are in NO set here. */
  readonly byGrant = new Map<GrantId, Set<string>>()
  /** Operations attributed to a grant rather than a handle: acquisitions in flight. */
  readonly grantOperations = new Map<GrantId, Set<PendingOperation>>()
  readonly recentlyClosed = new Set<string>()
  /**
   * Grants this origin held and no longer does.
   *
   * THE CASCADE IS NOT A ONE-SHOT SWEEP. Without this, an acquisition that
   * passed the policy check before the revoke and materialised after it -- the
   * ordinary connect path, which is exactly what OperationScope's 'grant' case
   * exists to describe -- registers a live handle under a withdrawn grant. The
   * permissions UI fires exactly one revoke, so nothing ever sweeps again.
   */
  readonly revokedGrants = new Set<GrantId>()
  /**
   * Set for the whole of dropOrigin, including while teardowns are still in
   * flight. Deleting the table synchronously and then awaiting was not enough:
   * a picker callback resolving one tick late simply built a NEW table for a
   * dead origin, and the fs.userSelected handle it registered survived the
   * session it is specified not to survive (SSFileHandle).
   */
  dropping = false
  inFlight = 0

  /** The ownership check itself. See HandleTable.lookup. */
  record (handleId: string): HandleRecord {
    const record = this.handles.get(handleId)
    if (record !== undefined) return record

    if (this.recentlyClosed.has(handleId)) {
      throw fail('closed', 'the handle is already closed', handleId)
    }
    throw fail('denied', NOT_YOURS, handleId)
  }

  /** Is this authorisation still one the origin may register against? */
  assertAcquirable (authorisedBy: Authorisation): void {
    if (this.dropping) {
      throw fail('revoked', 'the session holding this capability ended')
    }
    if (authorisedBy.by === 'grant' && this.revokedGrants.has(authorisedBy.grantId)) {
      throw fail('revoked', 'the grant authorising this handle was withdrawn')
    }
  }

  assertCapacity (kind: HandleKind): void {
    const counts = this.#census()

    if (SOCKET_KINDS.has(kind) && counts.sockets >= LIMITS.concurrentSockets) {
      throw fail('limit', `origin holds ${String(LIMITS.concurrentSockets)} sockets`)
    }
    // Counted however the user authorised it: the userSelected exception is to
    // the revocation cascade, not to the limits. An open fd is an open fd.
    if (kind === 'file' && counts.files >= LIMITS.concurrentFileHandles) {
      throw fail('limit', `origin holds ${String(LIMITS.concurrentFileHandles)} file handles`)
    }
    if (kind === 'identity' && counts.identities >= MAX_IDENTITY_HANDLES) {
      throw fail('limit', `origin holds ${String(MAX_IDENTITY_HANDLES)} identity handles`)
    }
  }

  insert (
    origin: string,
    kind: HandleKind,
    authorisedBy: Authorisation,
    parentId: string | null,
    destroy: DestroyResource
  ): HandleEntry {
    let id = newHandleId()
    // Astronomically unlikely at 128 bits, and free to rule out. An overwrite
    // here would orphan a live record: destroy never called, `closed` never
    // settling -- exactly the silent class this file exists to prevent.
    while (this.handles.has(id) || this.recentlyClosed.has(id)) id = newHandleId()

    let resolveClosed!: () => void
    let rejectClosed!: (error: OrivonError) => void
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = () => { resolve() }
      rejectClosed = reject
    })
    // The app may never look at `closed`. An unhandled rejection on it would
    // take the broker down for a socket the user deliberately revoked, so it
    // is always handled here -- the app's own handler still sees it.
    void closed.catch((): void => {})

    // Copied, not retained. `authorisedBy` is the caller's object and indexes
    // `byGrant`; a caller mutating it afterwards would desynchronise the row
    // from the revocation index that has to find it.
    const authorisation: Authorisation = Object.freeze(
      authorisedBy.by === 'grant'
        ? { by: 'grant' as const, grantId: authorisedBy.grantId }
        : { by: 'userSelected' as const }
    )

    const entry: HandleEntry = Object.freeze({ id, origin, kind, authorisedBy: authorisation, parentId, closed })
    const record: HandleRecord = {
      entry,
      children: new Set(),
      operations: new Set(),
      destroy,
      resolveClosed,
      rejectClosed
    }

    this.handles.set(id, record)
    if (authorisation.by === 'grant') {
      const set = this.byGrant.get(authorisation.grantId) ?? new Set<string>()
      set.add(id)
      this.byGrant.set(authorisation.grantId, set)
    }
    return entry
  }

  /**
   * Unlinks a handle and everything derived from it, then tears the resources
   * down.
   *
   * The unlink pass and the promise rejections are SYNCHRONOUS, before any
   * destroy callback runs. That ordering is what makes revocation immediate:
   * the app is told the moment the cascade reaches it, however slow the real
   * teardown is, and the returned promise is only for a caller that wants to
   * know the resources are actually gone.
   *
   * `onFault` is a parameter rather than stored on this class -- OriginTable
   * has no reference back to the HandleTable that owns the callback.
   */
  closeTree (
    root: HandleRecord,
    reason: CloseReason,
    onFault: (fault: HandleTableFault) => void,
    failure?: OrivonError
  ): Promise<void> {
    const doomed: HandleRecord[] = []
    const stack: HandleRecord[] = [root]

    while (stack.length > 0) {
      const record = stack.pop()
      if (record === undefined) break
      // Deleting here is also the visited check: a socket reachable both
      // through its grant and through its parent is torn down once.
      if (!this.handles.delete(record.entry.id)) continue
      doomed.push(record)
      for (const childId of record.children) {
        const child = this.handles.get(childId)
        if (child !== undefined) stack.push(child)
      }
    }

    for (const record of doomed) {
      const { id, authorisedBy, parentId } = record.entry
      if (authorisedBy.by === 'grant') {
        const set = this.byGrant.get(authorisedBy.grantId)
        set?.delete(id)
        // Reclaimed here rather than left behind: an empty Set per grant id the
        // origin has ever held is a slow leak, not a bound.
        if (set !== undefined && set.size === 0) this.byGrant.delete(authorisedBy.grantId)
      }
      if (parentId !== null) this.handles.get(parentId)?.children.delete(id)
      remember(this.recentlyClosed, id, CLOSED_ID_MEMORY)

      const error = failure ?? (reason === 'closed'
        ? fail('closed', 'the handle was closed', id)
        : fail('revoked', 'the grant authorising this handle was withdrawn', id))
      for (const operation of Array.from(record.operations)) {
        cancelOperation(operation, error)
      }
      record.operations.clear()

      // `closed` settles now for anything the app did not ask for -- it must
      // not have to wait for an RST to be told the capability is gone. A clean
      // close settles after the teardown, so that resolving means the resource
      // really is released.
      if (reason !== 'closed') record.rejectClosed(error)
    }

    const teardowns = doomed.map(async (record) => {
      try {
        await record.destroy(reason)
        if (reason === 'closed') record.resolveClosed()
      } catch (error) {
        onFault({ origin: record.entry.origin, handleId: record.entry.id, error })
        // A handle already told why it died does not change its story because
        // the teardown itself also failed.
        if (reason === 'closed') {
          record.rejectClosed(fail('internal', 'the handle could not be released cleanly', record.entry.id))
        }
      }
    })

    return Promise.all(teardowns).then((): void => {})
  }

  grantOperationsFor (grantId: GrantId): Set<PendingOperation> {
    const existing = this.grantOperations.get(grantId)
    if (existing !== undefined) return existing

    const created = new Set<PendingOperation>()
    this.grantOperations.set(grantId, created)
    return created
  }

  /** What this origin currently holds. Drives the permissions UI. */
  counts (): OriginCounts {
    const live = this.#census()
    return {
      ...live,
      handles: this.handles.size,
      inFlight: this.inFlight,
      grants: this.byGrant.size,
      revokedGrants: this.revokedGrants.size
    }
  }

  /**
   * One counting pass over this origin's live rows.
   *
   * ONE implementation, used by both `counts()` and `assertCapacity()`. They
   * had a copy each: two answers to "how many sockets does this origin hold"
   * that had to agree, one of them documented as being the other, and only one
   * of them enforcing anything.
   */
  #census (): { sockets: number, files: number, identities: number } {
    let sockets = 0
    let files = 0
    let identities = 0
    for (const record of this.handles.values()) {
      if (SOCKET_KINDS.has(record.entry.kind)) sockets += 1
      else if (record.entry.kind === 'file') files += 1
      else identities += 1
    }
    return { sockets, files, identities }
  }
}
