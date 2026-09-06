// The per-origin handle table and the revocation cascade.
//
// Spec: docs/architecture/handle-contracts.md (SSCommon shape, SSRevocation,
// SSLimits). Where this file deviates, the deviation is recorded in that
// document and in docs/open-questions.md -- not only here, because a code
// comment is the one place a reader of the specification will not look
// (CLAUDE.md rules 1 and 3).
//
// THIS FILE HOLDS STATE, deliberately. It is src/broker/, not
// src/broker/policy/ -- the policy directory is pure by structural rule, and a
// handle table is by definition the state a capability check is re-run
// against. It still imports no electron and touches no socket, file or fd:
// everything that owns a real resource is INJECTED as a `destroy` callback.
// That is what keeps this testable, and it is why the table itself depends on
// no engine primitive -- only the destroy callbacks do. (ADR-0002's amendment
// is explicit that the migration ladder is Node -> Mojo, and that Wasmtime
// would be a DIFFERENT APP MODEL rather than a swap beneath a stable API. Do
// not restate a ladder here; the ADR owns it.)
//
// Split across five files (Rule 2, docs/development/code-guidelines.md):
// ./handle-contracts.ts (types), ./errors.ts (OrivonError), ./handle-store.ts
// (OriginTable, one origin's state), ./origin-registry.ts (the map of
// origins), and this file (the operations run against that map).
//
// THE FOUR PROPERTIES THIS EXISTS TO GUARANTEE, each one a failure that is
// silent when it goes wrong:
//
//   1. EVERY OPERATION RE-CHECKS OWNERSHIP (security-model.md T11c). A handle
//      id issued to one origin and presented by another is REJECTED, never
//      ignored. Capability is checked once at acquisition
//      (capability-api.md design rule 3); ownership is checked every time.
//
//   2. EVERY HANDLE RECORDS THE GRANT THAT AUTHORISED IT, captured at
//      acquisition, because that is what revocation walks. Derived handles --
//      a socket accepted from a server's `connections` stream -- take their
//      grant FROM THE PARENT RECORD and cannot be given another by the caller.
//
//   3. REVOCATION IS IMMEDIATE AND ABRUPT. Every handle in the grant's set
//      closes at once and every pending promise rejects with 'revoked',
//      without waiting for in-flight work. Waiting would make the revoke
//      button mean "this app can no longer do this, once it finishes what it
//      is doing", and completion time is entirely under the app's control -- a
//      hostile app keeps a connection alive indefinitely by never finishing.
//
//   4. LIMITS ARE ENFORCED BY REJECTION, NEVER BY QUEUEING (T11, T11b). An
//      unbounded queue on the broker's UI thread is precisely how one
//      misbehaving origin freezes every tab.

import { LIMITS } from '../contracts/index.js'
import type { GrantId, OrivonError, OrivonErrorCode } from '../contracts/index.js'
import { fail } from './errors.js'
import { OriginRegistry } from './origin-registry.js'
import {
  OriginTable,
  NOT_YOURS,
  REVOKED_GRANT_MEMORY,
  SOCKET_KINDS,
  remember,
  cancelOperation
} from './handle-store.js'
import type { PendingOperation } from './handle-store.js'
import type {
  AcquireDerivedRequest,
  AcquireRequest,
  CloseReason,
  DestroyResource,
  HandleEntry,
  HandleTableFault,
  HandleTableOptions,
  OperationScope,
  OriginCounts
} from './handle-contracts.js'

/** The per-origin handle table. One instance per browser session. */
export class HandleTable {
  readonly #registry = new OriginRegistry()
  readonly #onFault: (fault: HandleTableFault) => void

  constructor (options: HandleTableOptions = {}) {
    this.#onFault = options.onFault ?? ((): void => {})
  }

  /**
   * Registers a handle authorised directly by a grant, or by the user's
   * picker choice.
   *
   * Throws 'revoked' when the grant has been withdrawn or the session is being
   * torn down, 'limit' when the origin is at a cap, 'internal' when the origin
   * string is not one that may key storage. `request.destroy` is invoked with
   * 'failed' before any of those throw, so a refused acquisition cannot leak
   * the resource.
   */
  acquire (request: AcquireRequest): HandleEntry {
    try {
      const origin = this.#key(request.origin)
      const table = this.#table(origin)
      table.assertAcquirable(request.authorisedBy)
      table.assertCapacity(request.kind)
      return table.insert(origin, request.kind, request.authorisedBy, null, request.destroy)
    } catch (error) {
      this.#releaseUnregistered(request.origin, request.destroy)
      throw error
    }
  }

  /**
   * Registers a handle produced by another handle, inheriting the parent's
   * grant and becoming its child.
   *
   * Both edges are the specification's: "registered as a child of both the
   * server's grant AND the server handle itself". The grant edge is what a
   * revoke walks; the parent edge is what makes closing the server close the
   * sockets it produced.
   */
  acquireDerived (request: AcquireDerivedRequest): HandleEntry {
    try {
      const origin = this.#key(request.origin)
      const table = this.#table(origin)
      // The ownership check applies to the parent as well: an origin cannot
      // hang a handle off another origin's server.
      const parent = table.record(request.parentId)
      // Only a socket is ever derived, and only from another socket --
      // SSTcpServer's accepted connection is the case the specification
      // describes. The rule that matters is the parent's: an unconstrained
      // inherit is how a socket would come to carry `userSelected`, which puts
      // it in no grant's set, where no revoke could ever reach it. Stated as a
      // kind check rather than an authorisation check so that a FileHandle can
      // never become a parent even if it is grant-authorised.
      if (!SOCKET_KINDS.has(parent.entry.kind) || request.kind !== 'tcpSocket') {
        throw fail('internal', 'only a tcpSocket may be derived, and only from a socket')
      }
      table.assertAcquirable(parent.entry.authorisedBy)
      table.assertCapacity(request.kind)
      const entry = table.insert(origin, request.kind, parent.entry.authorisedBy, parent.entry.id, request.destroy)
      parent.children.add(entry.id)
      return entry
    } catch (error) {
      this.#releaseUnregistered(request.origin, request.destroy)
      throw error
    }
  }

  /**
   * The ownership re-check. Every operation on a handle goes through this or
   * through `run`.
   *
   * Throws 'closed' for a handle this origin held and has already closed, and
   * 'denied' -- uniformly, with one message -- for everything else.
   */
  lookup (origin: string, handleId: string): HandleEntry {
    // Deliberately does not create a table: a read must not allocate one per
    // origin that merely asked.
    const table = this.#registry.existing(this.#key(origin))
    if (table === undefined) throw fail('denied', NOT_YOURS, handleId)
    return table.record(handleId).entry
  }

  /**
   * Runs one operation under the origin's in-flight budget, cancelling it if
   * the authorisation behind it is withdrawn while it is running.
   *
   * `work` receives an AbortSignal that fires on revocation so it can tear the
   * real resource down. The promise this returns does not wait for `work` to
   * notice: it rejects with 'revoked' the moment the cascade reaches it, which
   * is what makes revocation abrupt rather than graceful.
   *
   * NOTE for whoever writes the connect path: cancelling an operation rejects
   * the caller's promise and fires the signal; it cannot stop `work` running to
   * completion. Registering the resource it produced is still safe, because
   * `acquire` refuses a withdrawn grant -- but `work` should check
   * `signal.aborted` and destroy the resource itself rather than relying on the
   * refusal to do it.
   */
  async run<T> (origin: string, scope: OperationScope, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = this.#key(origin)

    // Ownership first, so an unauthorised caller learns nothing about the
    // origin's budget, and so the error is the useful one. A handle-scoped
    // call must not allocate a table either -- `lookup` states that rule and
    // this is the other read path it has to hold for.
    let table: OriginTable
    let operations: Set<PendingOperation>
    if (scope.on === 'handle') {
      const existing = this.#registry.existing(key)
      if (existing === undefined) throw fail('denied', NOT_YOURS, scope.handleId)
      table = existing
      operations = table.record(scope.handleId).operations
    } else {
      const existing = this.#registry.existing(key)
      if (existing?.revokedGrants.has(scope.grantId) === true || existing?.dropping === true) {
        throw fail('revoked', 'the grant authorising this operation was withdrawn')
      }
      table = this.#table(key)
      // Deliberately allocated AFTER the in-flight check below would have
      // thrown -- see there.
      operations = new Set<PendingOperation>()
    }

    if (table.inFlight >= LIMITS.inFlightOperations) {
      // REJECT, do not queue (T11b). A queue here is a queue on the broker's
      // UI thread, and one origin filling it stops every other tab.
      throw fail('limit', `origin has ${String(LIMITS.inFlightOperations)} operations in flight`)
    }

    // Only now is the grant's bucket materialised. Creating it before the cap
    // check leaked one empty Set per grant id every time the cap was hit.
    if (scope.on === 'grant') operations = table.grantOperationsFor(scope.grantId)

    const controller = new AbortController()
    let cancel!: (error: OrivonError) => void
    // Promise.race attaches a handler to this immediately, so it can never
    // become an unhandled rejection even when `work` wins the race.
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject })
    const operation: PendingOperation = { controller, reject: cancel }

    operations.add(operation)
    table.inFlight += 1
    try {
      return await Promise.race([work(controller.signal), cancelled])
    } finally {
      operations.delete(operation)
      table.inFlight -= 1
      // Drop the grant's bucket once it empties. Otherwise the table keeps one
      // empty Set per grant id it has ever seen, which is a slow leak rather
      // than a bound -- and grant ids are not something this module verifies.
      if (scope.on === 'grant' && operations.size === 0 && table.grantOperations.get(scope.grantId) === operations) {
        table.grantOperations.delete(scope.grantId)
      }
      this.#reap(key, table)
    }
  }

  /**
   * The app closing a handle itself.
   *
   * IDEMPOTENT WITHOUT QUALIFICATION, per SSCommon shape's `close(): Promise
   * <void>  // idempotent`. Closing anything this origin does not currently
   * hold -- an id it closed a moment ago, an id it closed ten thousand handles
   * ago, an id that was never real, an id belonging to somebody else -- is a
   * silent no-op.
   *
   * The earlier version answered 'denied' for anything outside a bounded
   * memory of recently-closed ids, which meant close() started throwing after
   * roughly 576 open/close cycles. The torrent app reaches that in seconds, and
   * `orivon-node-shim` has to present Node's `socket.destroy()`, which never
   * throws and which real BitTorrent code calls defensively on an already-dead
   * socket. Silence costs nothing here: T11c is about OPERATIONS on a resource
   * -- read, write, derive, all of which still reject -- and a close that
   * closes nothing has not given the caller anything.
   *
   * Cascades to derived handles: closing a TcpServer closes every socket it
   * produced that is still open.
   */
  async release (origin: string, handleId: string): Promise<void> {
    const key = this.#key(origin)
    const table = this.#registry.existing(key)
    const record = table?.handles.get(handleId)
    if (table === undefined || record === undefined) return

    await table.closeTree(record, 'closed', this.#onFault)
    this.#reap(key, table)
  }

  /**
   * Registers the one listener told when this handle leaves the tables --
   * synchronously, ahead of its teardown. Silent no-op for a handle this
   * origin does not hold, including one already unlinked: registering late
   * must not invent a terminal reason it cannot know, and the resource's own
   * `closed` promise already carries the real one. See README.md's design
   * notes for why this hook exists.
   */
  onUnlink (origin: string, handleId: string, listener: (reason: CloseReason, code?: OrivonErrorCode) => void): void {
    const record = this.#registry.existing(this.#key(origin))?.handles.get(handleId)
    if (record !== undefined) record.unlink = listener
  }

  /**
   * The resource layer reporting that a handle died on its own.
   *
   * SSTcpSocket's close table requires `closed` to reject with 'reset' when the
   * peer resets, and every handle-contracts error other than 'denied' to carry
   * the real `platformCode`. Neither was expressible before: every removal path
   * was initiated by the app or by the user, so a peer RST was reported to the
   * app as a CLEAN CLOSE. That is the common way a socket ends.
   *
   * The destroy callback is told 'failed': the fd needs releasing, the wire
   * needs nothing.
   *
   * This module does not model half-close. `closed` settles when the handle is
   * released, and deciding that both directions have reached a terminal state
   * is the socket layer's job -- it calls `release` or `fail` when they have.
   */
  fail (origin: string, handleId: string, code: OrivonErrorCode, platformCode?: string): void {
    this.#closeWithError(origin, handleId, 'failed', fail(code, 'the handle failed', handleId, platformCode))
  }

  /**
   * The app itself discarding a handle (`writable.abort()`), as opposed to
   * `fail` reporting one that died on its own.
   *
   * The CloseReason handed to the destroy callback is 'aborted', not
   * 'failed' -- that is the whole difference from `fail` above. `fail`'s
   * 'failed' means the wire is already dead and must not be touched; an
   * app-initiated abort means the opposite, the wire is still live and an
   * ACTIVE reset is the entire point (handle-contracts.md's close table:
   * `writable.abort(e)` -> RST sent, `closed` rejects 'reset').
   */
  abort (origin: string, handleId: string): void {
    this.#closeWithError(origin, handleId, 'aborted', fail('reset', 'the app aborted this handle', handleId))
  }

  /**
   * Shared shape of `fail` and `abort`: both look up a record still owned by
   * `origin`, tear its whole tree down with a synthesized error rather than
   * an app request, and reap the table afterwards. They differ only in the
   * CloseReason passed to the injected destroy callback -- see `abort`'s doc.
   */
  #closeWithError (origin: string, handleId: string, reason: CloseReason, error: OrivonError): void {
    const key = this.#key(origin)
    const table = this.#registry.existing(key)
    if (table === undefined) throw fail('denied', NOT_YOURS, handleId)
    const record = table.record(handleId)

    void table.closeTree(record, reason, this.#onFault, error)
    this.#reap(key, table)
  }

  /**
   * The cascade. Withdraws one grant from one origin.
   *
   * Every handle the grant authorised closes at once, along with everything
   * derived from those handles, and every promise the app is awaiting on any
   * of them rejects with 'revoked'. Idempotent, and safe against an origin
   * holding zero handles or one the table has never seen.
   *
   * DOES NOT WAIT FOR TEARDOWN. The app is told synchronously, before any
   * destroy callback runs, and this promise settles as soon as that is done.
   * The broker awaits it on the UI thread to update the permissions panel, and
   * a destroy that never completes -- which is precisely the documented failure
   * mode of MessagePortMain teardown, silence rather than an error -- would
   * otherwise leave the permissions UI stuck mid-revoke with no timeout in the
   * path. That is T11b arriving through the door this module was built to shut.
   * Teardown failures are reported through `onFault`.
   *
   * userSelected handles are in no grant's set, so this cannot reach them --
   * the SSFileHandle exception is structural here, not a special case.
   */
  async revoke (origin: string, grantId: GrantId): Promise<void> {
    const key = this.#key(origin)
    const existing = this.#registry.existing(key)
    // Still tombstone it: the acquisition this is racing may not have built a
    // table yet, and it must be refused when it does.
    const table = existing ?? this.#table(key)
    remember(table.revokedGrants, grantId, REVOKED_GRANT_MEMORY)

    const pending = table.grantOperations.get(grantId)
    if (pending !== undefined) {
      for (const operation of Array.from(pending)) {
        cancelOperation(operation, fail('revoked', 'the grant authorising this operation was withdrawn'))
      }
      table.grantOperations.delete(grantId)
    }

    const ids = table.byGrant.get(grantId)
    if (ids !== undefined) {
      for (const id of Array.from(ids)) {
        const record = table.handles.get(id)
        // Absent means a sibling's cascade already took it -- a socket
        // reachable both as a member of this grant and as a child of a server.
        if (record !== undefined) void table.closeTree(record, 'revoked', this.#onFault)
      }
      // NOTHING IS DELETED HERE. closeTree removes each id from its grant's
      // set as it goes and drops the set once it empties, so by this point the
      // bucket is already gone if it should be. The earlier version deleted it
      // wholesale, which orphaned any row registered mid-cascade -- a destroy
      // callback re-entering acquire -- into no grant's set at all, where not
      // even a later revoke of the same grant could find it. Re-adding a
      // delete here is wrong twice over: `ids` is a stale reference by now, so
      // a guarded version would test the wrong set's size.
    }

    this.#reap(key, table)
    await Promise.resolve()
  }

  /**
   * The broker recording that the user has granted a capability.
   *
   * Clears the tombstone, so a capability the user withdrew and then granted
   * again works. Needed because nothing in the repository yet decides whether
   * a re-grant mints a fresh GrantId or reuses a stable one derived from
   * (origin, capability, pattern set) -- and under the stable reading a
   * permanent tombstone would silently make re-granting impossible, which is a
   * failure nobody would trace back to here. Cheap insurance either way; see
   * docs/open-questions.md A16.
   */
  grantIssued (origin: string, grantId: GrantId): void {
    const table = this.#registry.existing(this.#key(origin))
    table?.revokedGrants.delete(grantId)
  }

  /**
   * Session teardown: the app was closed, navigated away, or restarted.
   *
   * Unlike `revoke` this DOES take userSelected handles, which is the other
   * half of the SSFileHandle exception -- the picker choice outlives a grant
   * revocation but not the session.
   *
   * The reason reported is 'sessionEnded', not 'revoked'. Nobody withdrew
   * anything, and 'revoked' means RST with buffered data discarded: a user
   * clicking a link away from the torrent app would have reset every peer
   * connection and dropped a half-written piece on the floor.
   *
   * This one DOES await its teardowns, unlike `revoke` -- no UI is blocked on
   * it, and the table must not be handed out again until the previous session's
   * descriptors are actually gone. A destroy that hangs therefore leaves the
   * origin unusable until the process restarts. That is the safe direction (its
   * fds are still open) and it is reported through `onFault`.
   */
  async dropOrigin (origin: string): Promise<void> {
    const key = this.#key(origin)
    const existing = this.#registry.existing(key)
    if (existing === undefined) return
    existing.dropping = true

    for (const operations of existing.grantOperations.values()) {
      for (const operation of Array.from(operations)) {
        cancelOperation(operation, fail('revoked', 'the session holding this operation ended'))
      }
    }
    existing.grantOperations.clear()

    const teardowns: Array<Promise<void>> = []
    for (const record of Array.from(existing.handles.values())) {
      if (existing.handles.has(record.entry.id)) {
        teardowns.push(existing.closeTree(record, 'sessionEnded', this.#onFault))
      }
    }

    await Promise.all(teardowns)
    // Only now, so that a late registration is refused by `dropping` rather
    // than quietly building a fresh table for a session that has ended.
    this.#registry.deleteIfCurrent(key, existing)
  }

  /** What the origin currently holds. Drives the permissions UI. */
  counts (origin: string): OriginCounts {
    const existing = this.#registry.existing(this.#key(origin))
    return existing === undefined
      ? { sockets: 0, files: 0, identities: 0, handles: 0, inFlight: 0, grants: 0, revokedGrants: 0 }
      : existing.counts()
  }

  /** Origins with a live table. Exists so the no-allocation rule is testable. */
  originCount (): number {
    return this.#registry.size()
  }

  /** The isolation key for `origin`. See ./origin-registry.ts's `key` for why this normalises rather than trusts the raw string. */
  #key (origin: string): string {
    return this.#registry.key(origin, this.#onFault)
  }

  /** The table for an already-normalised key, creating one if this is that origin's first handle. */
  #table (key: string): OriginTable {
    return this.#registry.getOrCreate(key)
  }

  /** Drops `key`'s table once it holds nothing at all. See ./origin-registry.ts's `reap`. */
  #reap (key: string, table: OriginTable): void {
    this.#registry.reap(key, table)
  }

  /**
   * Releases a resource whose registration was refused. Never throws over the
   * error that caused the refusal -- that error is the one the caller needs.
   *
   * 'failed', not 'closed': the handle never existed, so there is no wire
   * effect to produce. Only the descriptor needs freeing.
   */
  #releaseUnregistered (origin: string, destroy: DestroyResource): void {
    try {
      const result = destroy('failed')
      if (result instanceof Promise) {
        void result.catch((error: unknown) => { this.#onFault({ origin, handleId: null, error }) })
      }
    } catch (error) {
      this.#onFault({ origin, handleId: null, error })
    }
  }
}
