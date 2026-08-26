// The per-origin handle table and the revocation cascade.
//
// Implements docs/architecture/handle-contracts.md SSCommon shape,
// SSRevocation and SSLimits. That document is the specification; this file
// must not diverge from it.
//
// THIS FILE HOLDS STATE, deliberately. It is src/broker/, not
// src/broker/policy/ -- the policy directory is pure by structural rule, and a
// handle table is by definition the state a capability check is re-run
// against. It still imports no electron and touches no socket, file or fd:
// everything that owns a real resource is INJECTED as a `destroy` callback.
// That is what keeps this testable, and what lets the same table survive the
// Node -> Wasmtime -> Chromium/Mojo transitions ADR-0002 plans for. Only the
// destroy callbacks change.
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
import { originFromUrl } from './policy/origin.js'

/**
 * What kind of resource a handle names.
 *
 * Mirrors the five interfaces in handle-contracts.md. It exists here rather
 * than in src/contracts/ because it is an implementation concern -- an app
 * never names a kind, it calls `orivon.net.connect` and receives a TcpSocket.
 */
export type HandleKind = 'tcpSocket' | 'tcpServer' | 'udpSocket' | 'file' | 'identity'

/**
 * What authorises a handle to exist.
 *
 * A DISCRIMINATED UNION rather than `grantId: string | null`, because the
 * `userSelected` case is the one exception to the revocation cascade
 * (handle-contracts.md SSFileHandle) and a nullable field lets a caller fall
 * into it by accident -- a failed grant lookup yielding null would silently
 * mint a handle no revoke can ever reach. Here the exception has to be
 * spelled out in words at the call site.
 */
export type Authorisation =
  | { readonly by: 'grant', readonly grantId: GrantId }
  /**
   * A FileHandle from `orivon.fs.userSelected`. The user's one-time choice at
   * the OS picker IS the authorisation, so revoking the standing `fs` grant
   * does not close it. It is session-scoped, not a standing grant of its own:
   * `dropOrigin` takes it, which is what "does not survive a restart" means.
   */
  | { readonly by: 'userSelected' }

/**
 * Why a handle is being torn down. The injected destroy callback decides the
 * wire effect from it, per handle-contracts.md SSTcpSocket's close table:
 * 'closed' is a FIN, 'revoked' is an RST with buffered data discarded.
 *
 * A cascade propagates the reason that INITIATED it, so sockets accepted from
 * a server the app closed get 'closed', and the same sockets under a revoked
 * grant get 'revoked'.
 */
export type CloseReason = 'closed' | 'revoked'

/**
 * Releases the real resource. Injected -- this module never imports electron
 * and never touches an fd.
 *
 * CALLED EXACTLY ONCE, ALWAYS, including when the acquisition that would have
 * registered the handle is itself refused. A caller has usually already
 * created the socket by the time it registers it, so an acquisition that threw
 * without releasing would leak one fd per attempt against a limit an attacker
 * can hit in a loop.
 *
 * IT MUST SETTLE. The table imposes no timeout on it -- it has no clock policy
 * of its own -- and `release()` waits for it, so a destroy that hangs hangs the
 * app's `close()`. Anything that talks to a MessagePortMain to do its teardown
 * needs its own timeout (handle-contracts.md SSWhat the shim must do, rule 3:
 * that transport's failure mode is silence, not an error). Revocation is not
 * affected either way -- the app is told before any of these run.
 */
export type DestroyResource = (reason: CloseReason) => void | Promise<void>

/** The registry's view of one live handle. */
export interface HandleEntry {
  /** Opaque, per-origin, not forgeable across origins (T11c). */
  readonly id: string
  /** The canonical origin, which may differ from the string the caller passed. */
  readonly origin: string
  readonly kind: HandleKind
  /** Captured at acquisition. This is what SSRevocation walks. */
  readonly authorisedBy: Authorisation
  /** The handle this one was derived from, or null if it was acquired directly. */
  readonly parentId: string | null
  /**
   * Resolves on a clean close, rejects with an OrivonError otherwise --
   * 'revoked' when a grant was withdrawn, 'internal' when the teardown itself
   * failed. Handed straight to the app-facing handle object.
   */
  readonly closed: Promise<void>
}

export interface AcquireRequest {
  readonly origin: string
  readonly kind: HandleKind
  readonly authorisedBy: Authorisation
  readonly destroy: DestroyResource
}

/**
 * A handle produced by another handle: a socket accepted from a TcpServer's
 * `connections` stream.
 *
 * There is deliberately no `authorisedBy` field. The grant is read from the
 * parent record, so "derived handles inherit the parent's grant" is
 * structurally true rather than a rule every call site has to remember.
 */
export interface AcquireDerivedRequest {
  readonly origin: string
  readonly kind: HandleKind
  readonly parentId: string
  readonly destroy: DestroyResource
}

/**
 * What an in-flight operation is attributed to.
 *
 * `handle` is the ordinary case. `grant` covers an acquisition still in
 * flight -- a connect that has passed the policy check but has no handle yet.
 * Without it those calls would escape the in-flight cap entirely, which is the
 * cap that keeps the broker responsive, and revoking mid-connect would leave
 * the app awaiting a promise for a capability it no longer holds.
 *
 * The table cannot and does not verify that the grant exists: the grant ledger
 * is a different component, and the caller has already checked it. This is an
 * accounting and cancellation tag, not an authorisation.
 */
export type OperationScope =
  | { readonly on: 'handle', readonly handleId: string }
  | { readonly on: 'grant', readonly grantId: GrantId }

export interface OriginCounts {
  /** TcpSocket + TcpServer + UdpSocket + accepted connections. */
  readonly sockets: number
  readonly files: number
  /** Every live row, whatever its kind. */
  readonly handles: number
  readonly inFlight: number
}

export interface HandleTableFault {
  readonly origin: string
  /** Null when the resource was never registered -- a refused acquisition. */
  readonly handleId: string | null
  readonly error: unknown
}

export interface HandleTableOptions {
  /**
   * Called when an injected destroy callback fails. The enum says an
   * 'internal' error is "a broker fault; should never be observed by an app,
   * always logged" -- this is the always-logged half. Swallowing a failed
   * teardown in security code would hide exactly the case where a socket the
   * user revoked is still open.
   */
  readonly onFault?: (fault: HandleTableFault) => void
}

/**
 * The concrete OrivonError. src/contracts/ declares it as an interface because
 * that directory emits no runtime code; somebody has to construct it.
 *
 * NOTE for the broker stream: when src/broker/errors.ts exists, this moves
 * there unchanged. It is local now only because this branch may create two
 * files.
 *
 * No `platformCode` is ever set here. This module never touches a real socket
 * so it has no errno to report, and 'denied' must never carry one in any case
 * (errors.ts: a denial that varied by reason turns the permission boundary
 * itself into a probe target).
 */
class BrokerError extends Error implements OrivonError {
  readonly code: OrivonErrorCode
  readonly handleId?: string

  constructor (code: OrivonErrorCode, message: string, handleId?: string) {
    super(message)
    this.name = 'OrivonError'
    this.code = code
    // exactOptionalPropertyTypes: assigning `undefined` to an optional field is
    // not the same as leaving it absent, and `handleId` must be absent.
    if (handleId !== undefined) this.handleId = handleId
  }
}

function fail (code: OrivonErrorCode, message: string, handleId?: string): OrivonError {
  return new BrokerError(code, message, handleId)
}

/**
 * ONE message for every "this origin does not hold that handle" answer,
 * whether the id is unknown, belongs to another origin, or was never valid.
 *
 * If those differed an app could ask "does this id exist somewhere else?" and
 * enumerate other origins' handle ids one probe at a time. The uniformity rule
 * errors.ts states for `denied` applies to the message as well as the code.
 */
const NOT_YOURS = 'no such handle for this origin'

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
 * A backstop on total live rows per origin.
 *
 * NOT IN THE SPECIFICATION, and flagged as an AI decision. SSLimits caps
 * sockets and files but says nothing about IdentityHandles, which would leave
 * one kind of row unbounded -- and an unbounded row count is T11 whatever the
 * row holds. The value is derived, not invented: an origin can hold no more
 * rows than the sum of the budgets it is already allowed. The only case it
 * ever bites is an origin already holding 512 sockets and 64 files that then
 * asks for an identity, which no real app does.
 */
const MAX_LIVE_HANDLES = LIMITS.concurrentSockets + LIMITS.concurrentFileHandles

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
 */
const SOCKET_KINDS: ReadonlySet<HandleKind> = new Set<HandleKind>(['tcpSocket', 'tcpServer', 'udpSocket'])

interface PendingOperation {
  readonly controller: AbortController
  readonly reject: (error: OrivonError) => void
}

interface HandleRecord {
  readonly entry: HandleEntry
  /** Derived handles, by id. Closing this record closes all of them. */
  readonly children: Set<string>
  readonly operations: Set<PendingOperation>
  readonly destroy: DestroyResource
  readonly resolveClosed: () => void
  readonly rejectClosed: (error: OrivonError) => void
}

interface OriginTable {
  readonly handles: Map<string, HandleRecord>
  /** grantId -> the ids it authorised. userSelected handles are in NO set here. */
  readonly byGrant: Map<GrantId, Set<string>>
  /** Operations attributed to a grant rather than a handle: acquisitions in flight. */
  readonly grantOperations: Map<GrantId, Set<PendingOperation>>
  readonly recentlyClosed: Set<string>
  inFlight: number
}

/**
 * 128 bits from the platform CSPRNG, as hex.
 *
 * UNGUESSABILITY IS DEFENCE IN DEPTH, NOT THE SECURITY BOUNDARY. The boundary
 * is the per-origin ownership check in `record()`. If guessing an id were
 * enough to use a handle, a handle would be a bearer capability -- exactly
 * what SSCommon shape forbids, and exactly why handles are not transferable.
 * A counter or a timestamp would still be refused by the ownership check, but
 * it would also hand an attacker a valid id to present, and every layer above
 * would then be one bug away from honouring it.
 */
function newHandleId (): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The per-origin handle table. One instance per browser session. */
export class HandleTable {
  readonly #tables = new Map<string, OriginTable>()
  readonly #onFault: (fault: HandleTableFault) => void

  constructor (options: HandleTableOptions = {}) {
    this.#onFault = options.onFault ?? ((): void => {})
  }

  /**
   * Registers a handle authorised directly by a grant, or by the user's
   * picker choice.
   *
   * Throws 'limit' when the origin is at a cap, 'internal' when the origin
   * string is not one that may key storage. `request.destroy` is invoked
   * before either throw, so a refused acquisition cannot leak the resource.
   */
  acquire (request: AcquireRequest): HandleEntry {
    try {
      const origin = this.#key(request.origin)
      const table = this.#table(origin)
      this.#assertCapacity(table, request.kind)
      return this.#insert(table, origin, request.kind, request.authorisedBy, null, request.destroy)
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
      const parent = this.#record(table, request.parentId)
      this.#assertCapacity(table, request.kind)
      const entry = this.#insert(table, origin, request.kind, parent.entry.authorisedBy, parent.entry.id, request.destroy)
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
    const table = this.#tables.get(this.#key(origin))
    if (table === undefined) throw fail('denied', NOT_YOURS, handleId)
    return this.#record(table, handleId).entry
  }

  /**
   * Runs one operation under the origin's in-flight budget, cancelling it if
   * the authorisation behind it is withdrawn while it is running.
   *
   * `work` receives an AbortSignal that fires on revocation so it can tear the
   * real resource down. The promise this returns does not wait for `work` to
   * notice: it rejects with 'revoked' the moment the cascade reaches it, which
   * is what makes revocation abrupt rather than graceful.
   */
  async run<T> (origin: string, scope: OperationScope, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = this.#key(origin)
    const table = this.#table(key)

    // Ownership first, so an unauthorised caller learns nothing about the
    // origin's budget, and so the error is the useful one.
    const operations = scope.on === 'handle'
      ? this.#record(table, scope.handleId).operations
      : this.#grantOperations(table, scope.grantId)

    if (table.inFlight >= LIMITS.inFlightOperations) {
      // REJECT, do not queue (T11b). A queue here is a queue on the broker's
      // UI thread, and one origin filling it stops every other tab.
      throw fail('limit', `origin has ${String(LIMITS.inFlightOperations)} operations in flight`)
    }

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
    }
  }

  /**
   * The app closing a handle itself. Idempotent, and never rejects because the
   * teardown failed -- a failed teardown is reported on `closed` and to
   * `onFault`, so that `close()` stays the idempotent no-throw call
   * SSCommon shape describes.
   *
   * Cascades to derived handles: closing a TcpServer closes every socket it
   * produced that is still open.
   */
  async release (origin: string, handleId: string): Promise<void> {
    const table = this.#tables.get(this.#key(origin))
    if (table === undefined) throw fail('denied', NOT_YOURS, handleId)
    const record = table.handles.get(handleId)

    if (record === undefined) {
      // Already closed by this origin: the idempotent case, a no-op.
      if (table.recentlyClosed.has(handleId)) return
      throw fail('denied', NOT_YOURS, handleId)
    }

    await this.#closeTree(table, record, 'closed')
  }

  /**
   * The cascade. Withdraws one grant from one origin.
   *
   * Every handle the grant authorised closes at once, along with everything
   * derived from those handles, and every promise the app is awaiting on any
   * of them rejects with 'revoked'. Idempotent, and safe against an origin
   * holding zero handles or one the table has never seen.
   *
   * userSelected handles are in no grant's set, so this cannot reach them --
   * the SSFileHandle exception is structural here, not a special case.
   */
  async revoke (origin: string, grantId: GrantId): Promise<void> {
    const key = this.#key(origin)
    const existing = this.#tables.get(key)
    if (existing === undefined) return

    // Acquisitions in flight under this grant have no handle to cascade from.
    const pending = existing.grantOperations.get(grantId)
    if (pending !== undefined) {
      for (const operation of Array.from(pending)) {
        this.#cancel(operation, fail('revoked', 'the grant authorising this operation was withdrawn'))
      }
      existing.grantOperations.delete(grantId)
    }

    const ids = existing.byGrant.get(grantId)
    if (ids === undefined) return

    const teardowns: Array<Promise<void>> = []
    for (const id of Array.from(ids)) {
      const record = existing.handles.get(id)
      // Absent means a sibling's cascade already took it -- a socket reachable
      // both as a member of this grant and as a child of a server in it.
      if (record !== undefined) teardowns.push(this.#closeTree(existing, record, 'revoked'))
    }
    existing.byGrant.delete(grantId)

    await Promise.all(teardowns)
  }

  /**
   * Session teardown: the app was closed, navigated away, or restarted.
   *
   * Unlike `revoke` this DOES take userSelected handles, which is the other
   * half of the SSFileHandle exception -- the picker choice outlives a grant
   * revocation but not the session. The reason reported is 'revoked' because
   * from the handle's point of view the authorisation behind it is gone.
   */
  async dropOrigin (origin: string): Promise<void> {
    const key = this.#key(origin)
    const existing = this.#tables.get(key)
    if (existing === undefined) return

    for (const operations of existing.grantOperations.values()) {
      for (const operation of Array.from(operations)) {
        this.#cancel(operation, fail('revoked', 'the session holding this operation ended'))
      }
    }
    existing.grantOperations.clear()

    const teardowns: Array<Promise<void>> = []
    for (const record of Array.from(existing.handles.values())) {
      if (existing.handles.has(record.entry.id)) teardowns.push(this.#closeTree(existing, record, 'revoked'))
    }

    this.#tables.delete(key)
    await Promise.all(teardowns)
  }

  /** What the origin currently holds. Drives the limit checks and the UI. */
  counts (origin: string): OriginCounts {
    const existing = this.#tables.get(this.#key(origin))
    if (existing === undefined) return { sockets: 0, files: 0, handles: 0, inFlight: 0 }

    let sockets = 0
    let files = 0
    for (const record of existing.handles.values()) {
      if (SOCKET_KINDS.has(record.entry.kind)) sockets += 1
      else if (record.entry.kind === 'file') files += 1
    }
    return { sockets, files, handles: existing.handles.size, inFlight: existing.inFlight }
  }

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
   */
  #key (origin: string): string {
    const canonical = originFromUrl(origin)
    if (canonical === null) throw fail('internal', 'handle table keyed on a string that is not an origin')
    return canonical
  }

  #table (origin: string): OriginTable {
    const existing = this.#tables.get(origin)
    if (existing !== undefined) return existing

    const created: OriginTable = {
      handles: new Map(),
      byGrant: new Map(),
      grantOperations: new Map(),
      recentlyClosed: new Set(),
      inFlight: 0
    }
    this.#tables.set(origin, created)
    return created
  }

  #grantOperations (table: OriginTable, grantId: GrantId): Set<PendingOperation> {
    const existing = table.grantOperations.get(grantId)
    if (existing !== undefined) return existing

    const created = new Set<PendingOperation>()
    table.grantOperations.set(grantId, created)
    return created
  }

  /** The ownership check itself. See `lookup`. */
  #record (table: OriginTable, handleId: string): HandleRecord {
    const record = table.handles.get(handleId)
    if (record !== undefined) return record

    if (table.recentlyClosed.has(handleId)) {
      throw fail('closed', 'the handle is already closed', handleId)
    }
    throw fail('denied', NOT_YOURS, handleId)
  }

  #assertCapacity (table: OriginTable, kind: HandleKind): void {
    if (table.handles.size >= MAX_LIVE_HANDLES) {
      throw fail('limit', `origin holds ${String(MAX_LIVE_HANDLES)} handles`)
    }

    const counts = { sockets: 0, files: 0 }
    for (const record of table.handles.values()) {
      if (SOCKET_KINDS.has(record.entry.kind)) counts.sockets += 1
      else if (record.entry.kind === 'file') counts.files += 1
    }

    if (SOCKET_KINDS.has(kind) && counts.sockets >= LIMITS.concurrentSockets) {
      throw fail('limit', `origin holds ${String(LIMITS.concurrentSockets)} sockets`)
    }
    // Counted however the user authorised it: the userSelected exception is to
    // the revocation cascade, not to the limits. An open fd is an open fd.
    if (kind === 'file' && counts.files >= LIMITS.concurrentFileHandles) {
      throw fail('limit', `origin holds ${String(LIMITS.concurrentFileHandles)} file handles`)
    }
  }

  #insert (
    table: OriginTable,
    origin: string,
    kind: HandleKind,
    authorisedBy: Authorisation,
    parentId: string | null,
    destroy: DestroyResource
  ): HandleEntry {
    const id = newHandleId()

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

    const entry: HandleEntry = Object.freeze({ id, origin, kind, authorisedBy, parentId, closed })
    const record: HandleRecord = {
      entry,
      children: new Set(),
      operations: new Set(),
      destroy,
      resolveClosed,
      rejectClosed
    }

    table.handles.set(id, record)
    if (authorisedBy.by === 'grant') {
      const set = table.byGrant.get(authorisedBy.grantId) ?? new Set<string>()
      set.add(id)
      table.byGrant.set(authorisedBy.grantId, set)
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
   */
  #closeTree (table: OriginTable, root: HandleRecord, reason: CloseReason): Promise<void> {
    const doomed: HandleRecord[] = []
    const stack: HandleRecord[] = [root]

    while (stack.length > 0) {
      const record = stack.pop()
      if (record === undefined) break
      // Deleting here is also the visited check: a socket reachable both
      // through its grant and through its parent is torn down once.
      if (!table.handles.delete(record.entry.id)) continue
      doomed.push(record)
      for (const childId of record.children) {
        const child = table.handles.get(childId)
        if (child !== undefined) stack.push(child)
      }
    }

    for (const record of doomed) {
      const { id, authorisedBy, parentId } = record.entry
      if (authorisedBy.by === 'grant') table.byGrant.get(authorisedBy.grantId)?.delete(id)
      if (parentId !== null) table.handles.get(parentId)?.children.delete(id)
      this.#remember(table, id)

      const error = reason === 'revoked'
        ? fail('revoked', 'the grant authorising this handle was withdrawn', id)
        : fail('closed', 'the handle was closed', id)
      for (const operation of Array.from(record.operations)) {
        this.#cancel(operation, error)
      }
      record.operations.clear()

      // `closed` rejects now for a revoke -- the app must not have to wait for
      // an RST to be told the capability is gone. A clean close settles it
      // after the teardown, so that resolving means the resource really is
      // released.
      if (reason === 'revoked') record.rejectClosed(error)
    }

    const teardowns = doomed.map(async (record) => {
      try {
        await record.destroy(reason)
        if (reason === 'closed') record.resolveClosed()
      } catch (error) {
        this.#onFault({ origin: record.entry.origin, handleId: record.entry.id, error })
        // A revoked handle has already been told 'revoked'; a broker fault
        // during teardown does not change what the app is told about it.
        if (reason === 'closed') {
          record.rejectClosed(fail('internal', 'the handle could not be released cleanly', record.entry.id))
        }
      }
    })

    return Promise.all(teardowns).then((): void => {})
  }

  #cancel (operation: PendingOperation, error: OrivonError): void {
    // Abort first, so work that checks the signal can start tearing down
    // before it learns its caller has already been told.
    operation.controller.abort(error)
    operation.reject(error)
  }

  #remember (table: OriginTable, handleId: string): void {
    if (table.recentlyClosed.size >= CLOSED_ID_MEMORY) {
      // Sets iterate in insertion order, so this is the oldest id.
      const oldest = table.recentlyClosed.values().next()
      if (oldest.done !== true) table.recentlyClosed.delete(oldest.value)
    }
    table.recentlyClosed.add(handleId)
  }

  /**
   * Releases a resource whose registration was refused. Never throws over the
   * error that caused the refusal -- that error is the one the caller needs.
   */
  #releaseUnregistered (origin: string, destroy: DestroyResource): void {
    try {
      const result = destroy('closed')
      if (result instanceof Promise) {
        void result.catch((error: unknown) => { this.#onFault({ origin, handleId: null, error }) })
      }
    } catch (error) {
      this.#onFault({ origin, handleId: null, error })
    }
  }
}
