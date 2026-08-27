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
 * WIRE EFFECT from it, per handle-contracts.md SSTcpSocket's close table.
 *
 *   'closed'       the app called close(). FIN, buffered writes flushed.
 *   'revoked'      the user withdrew the grant. RST, buffered data discarded
 *                  on both sides -- the abruptness SSRevocation requires.
 *   'sessionEnded' the app navigated away, was closed, or restarted. FIN,
 *                  buffered writes FLUSHED. Distinct from 'revoked' because
 *                  nobody withdrew anything: sending an RST to every peer and
 *                  discarding a half-written torrent piece because a user
 *                  clicked a link is data loss, not enforcement.
 *   'failed'       the resource is ALREADY GONE -- the peer reset it, or the
 *                  acquisition that would have registered it was refused.
 *                  Release the fd and touch the wire not at all; a FIN here is
 *                  a write to a dead descriptor.
 *
 * A cascade propagates the reason that INITIATED it, so sockets accepted from
 * a server the app closed get 'closed', and the same sockets under a revoked
 * grant get 'revoked'.
 */
export type CloseReason = 'closed' | 'revoked' | 'sessionEnded' | 'failed'

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

/**
 * The registry's view of one live handle.
 *
 * BROKER-INTERNAL. DO NOT RETURN THIS TO A RENDERER. `closed` is a Promise and
 * is not structured-cloneable, so putting an entry in a ResponseEnvelope's
 * `result` either loses the field or throws depending on the path; and
 * `authorisedBy.grantId` is a grant-ledger identifier the page has no use for
 * and should not be handed. The app-facing shape is `Handle` in
 * src/contracts/handles.ts -- `{ id, closed, close() }` and nothing else. Use
 * `toWire()` to get the part that may cross.
 */
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

/**
 * The only part of a HandleEntry that may cross to a renderer.
 *
 * A function rather than a convention, because the path of least resistance
 * for a caller is to spread the entry into its response, and that is the wrong
 * one. See HandleEntry.
 */
export function toWire (entry: HandleEntry): { readonly id: string } {
  return { id: entry.id }
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
  readonly identities: number
  /** Every live row, whatever its kind. */
  readonly handles: number
  readonly inFlight: number
  /** Grants currently holding at least one live handle. */
  readonly grants: number
  /** Tombstones held, so the bound on them is testable rather than asserted. */
  readonly revokedGrants: number
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
  readonly platformCode?: string

  constructor (code: OrivonErrorCode, message: string, handleId?: string, platformCode?: string) {
    super(message)
    this.name = 'OrivonError'
    this.code = code
    // exactOptionalPropertyTypes: assigning `undefined` to an optional field is
    // not the same as leaving it absent, and `handleId` must be absent.
    if (handleId !== undefined) this.handleId = handleId
    // errors.ts: 'denied' is uniform across every reason for denial and must
    // never carry one. Enforced here rather than trusted to every call site,
    // because a single leak turns the permission boundary into a probe target.
    if (platformCode !== undefined && code !== 'denied') this.platformCode = platformCode
  }
}

function fail (code: OrivonErrorCode, message: string, handleId?: string, platformCode?: string): OrivonError {
  return new BrokerError(code, message, handleId, platformCode)
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
 */
const REVOKED_GRANT_MEMORY = LIMITS.concurrentSockets + LIMITS.concurrentFileHandles

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
  /**
   * Grants this origin held and no longer does.
   *
   * THE CASCADE IS NOT A ONE-SHOT SWEEP. Without this, an acquisition that
   * passed the policy check before the revoke and materialised after it -- the
   * ordinary connect path, which is exactly what OperationScope's 'grant' case
   * exists to describe -- registers a live handle under a withdrawn grant. The
   * permissions UI fires exactly one revoke, so nothing ever sweeps again.
   */
  readonly revokedGrants: Set<GrantId>
  /**
   * Set for the whole of dropOrigin, including while teardowns are still in
   * flight. Deleting the table synchronously and then awaiting was not enough:
   * a picker callback resolving one tick late simply built a NEW table for a
   * dead origin, and the fs.userSelected handle it registered survived the
   * session it is specified not to survive (SSFileHandle).
   */
  dropping: boolean
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
      this.#assertAcquirable(table, request.authorisedBy)
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
      this.#assertAcquirable(table, parent.entry.authorisedBy)
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
      const existing = this.#tables.get(key)
      if (existing === undefined) throw fail('denied', NOT_YOURS, scope.handleId)
      table = existing
      operations = this.#record(table, scope.handleId).operations
    } else {
      const existing = this.#tables.get(key)
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
    if (scope.on === 'grant') operations = this.#grantOperations(table, scope.grantId)

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
    const table = this.#tables.get(key)
    const record = table?.handles.get(handleId)
    if (table === undefined || record === undefined) return

    await this.#closeTree(table, record, 'closed')
    this.#reap(key, table)
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
    const key = this.#key(origin)
    const table = this.#tables.get(key)
    if (table === undefined) throw fail('denied', NOT_YOURS, handleId)
    const record = this.#record(table, handleId)

    void this.#closeTree(table, record, 'failed', fail(code, 'the handle failed', handleId, platformCode))
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
    const existing = this.#tables.get(key)
    // Still tombstone it: the acquisition this is racing may not have built a
    // table yet, and it must be refused when it does.
    const table = existing ?? this.#table(key)
    this.#remember(table.revokedGrants, grantId, REVOKED_GRANT_MEMORY)

    const pending = table.grantOperations.get(grantId)
    if (pending !== undefined) {
      for (const operation of Array.from(pending)) {
        this.#cancel(operation, fail('revoked', 'the grant authorising this operation was withdrawn'))
      }
      table.grantOperations.delete(grantId)
    }

    const ids = table.byGrant.get(grantId)
    if (ids !== undefined) {
      for (const id of Array.from(ids)) {
        const record = table.handles.get(id)
        // Absent means a sibling's cascade already took it -- a socket
        // reachable both as a member of this grant and as a child of a server.
        if (record !== undefined) void this.#closeTree(table, record, 'revoked')
      }
      // NOTHING IS DELETED HERE. #closeTree removes each id from its grant's
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
    const table = this.#tables.get(this.#key(origin))
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
    const existing = this.#tables.get(key)
    if (existing === undefined) return
    existing.dropping = true

    for (const operations of existing.grantOperations.values()) {
      for (const operation of Array.from(operations)) {
        this.#cancel(operation, fail('revoked', 'the session holding this operation ended'))
      }
    }
    existing.grantOperations.clear()

    const teardowns: Array<Promise<void>> = []
    for (const record of Array.from(existing.handles.values())) {
      if (existing.handles.has(record.entry.id)) teardowns.push(this.#closeTree(existing, record, 'sessionEnded'))
    }

    await Promise.all(teardowns)
    // Only now, so that a late registration is refused by `dropping` rather
    // than quietly building a fresh table for a session that has ended.
    if (this.#tables.get(key) === existing) this.#tables.delete(key)
  }

  /** What the origin currently holds. Drives the permissions UI. */
  counts (origin: string): OriginCounts {
    const existing = this.#tables.get(this.#key(origin))
    if (existing === undefined) {
      return { sockets: 0, files: 0, identities: 0, handles: 0, inFlight: 0, grants: 0, revokedGrants: 0 }
    }

    const live = census(existing)
    return {
      ...live,
      handles: existing.handles.size,
      inFlight: existing.inFlight,
      grants: existing.byGrant.size,
      revokedGrants: existing.revokedGrants.size
    }
  }

  /** Origins with a live table. Exists so the no-allocation rule is testable. */
  originCount (): number {
    return this.#tables.size
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
   *
   * Reported to `onFault` as well as thrown. errors.ts says an 'internal' error
   * is "a broker fault; should never be observed by an app, always logged", and
   * origin.ts documents a detached frame resolving to about:blank as an
   * EXPECTED condition -- so this fires in normal operation and was previously
   * recorded nowhere.
   */
  #key (origin: string): string {
    const canonical = originFromUrl(origin)
    if (canonical === null) {
      const error = fail('internal', 'handle table keyed on a string that is not an origin')
      this.#onFault({ origin, handleId: null, error })
      throw error
    }
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
      revokedGrants: new Set(),
      dropping: false,
      inFlight: 0
    }
    this.#tables.set(origin, created)
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
  #reap (key: string, table: OriginTable): void {
    if (table.dropping) return
    if (table.handles.size > 0 || table.inFlight > 0) return
    if (table.revokedGrants.size > 0 || table.grantOperations.size > 0) return
    // recentlyClosed counts as "holds something". Reaping a table that still
    // remembers ids would make an origin's own just-closed handle answer
    // 'denied' instead of 'closed' -- losing the distinction #record exists to
    // draw. It is bounded at CLOSED_ID_MEMORY per origin and cleared by
    // dropOrigin, so keeping it is a bound, not a leak.
    if (table.recentlyClosed.size > 0) return
    if (this.#tables.get(key) === table) this.#tables.delete(key)
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

  /** Is this authorisation still one the origin may register against? */
  #assertAcquirable (table: OriginTable, authorisedBy: Authorisation): void {
    if (table.dropping) {
      throw fail('revoked', 'the session holding this capability ended')
    }
    if (authorisedBy.by === 'grant' && table.revokedGrants.has(authorisedBy.grantId)) {
      throw fail('revoked', 'the grant authorising this handle was withdrawn')
    }
  }

  #assertCapacity (table: OriginTable, kind: HandleKind): void {
    const counts = census(table)

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

  #insert (
    table: OriginTable,
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
    while (table.handles.has(id) || table.recentlyClosed.has(id)) id = newHandleId()

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

    table.handles.set(id, record)
    if (authorisation.by === 'grant') {
      const set = table.byGrant.get(authorisation.grantId) ?? new Set<string>()
      set.add(id)
      table.byGrant.set(authorisation.grantId, set)
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
  #closeTree (table: OriginTable, root: HandleRecord, reason: CloseReason, failure?: OrivonError): Promise<void> {
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
      if (authorisedBy.by === 'grant') {
        const set = table.byGrant.get(authorisedBy.grantId)
        set?.delete(id)
        // Reclaimed here rather than left behind: an empty Set per grant id the
        // origin has ever held is a slow leak, not a bound.
        if (set !== undefined && set.size === 0) table.byGrant.delete(authorisedBy.grantId)
      }
      if (parentId !== null) table.handles.get(parentId)?.children.delete(id)
      this.#remember(table.recentlyClosed, id, CLOSED_ID_MEMORY)

      const error = failure ?? (reason === 'closed'
        ? fail('closed', 'the handle was closed', id)
        : fail('revoked', 'the grant authorising this handle was withdrawn', id))
      for (const operation of Array.from(record.operations)) {
        this.#cancel(operation, error)
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
        this.#onFault({ origin: record.entry.origin, handleId: record.entry.id, error })
        // A handle already told why it died does not change its story because
        // the teardown itself also failed.
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
    //
    // DELIBERATELY UNGUARDED, and this was checked rather than assumed. An
    // AbortSignal listener is broker code and may throw; a try/catch here does
    // not catch it, because EventTarget dispatch routes the throw to Node's
    // emitUncaughtException out of band rather than back through abort(). The
    // wrapper that was here first therefore caught nothing and implied a
    // protection it did not provide. What matters is verified instead: the
    // sweep continues and every remaining handle is still torn down (see the
    // test), and the exception stays loud, which SSWhat the shim must do rule 2
    // requires of anything touching error handling in security-relevant code.
    operation.controller.abort(error)
    operation.reject(error)
  }

  /** FIFO eviction. Sets iterate in insertion order, so the first is oldest. */
  #remember<T> (memory: Set<T>, value: T, bound: number): void {
    if (memory.has(value)) return
    if (memory.size >= bound) {
      const oldest = memory.values().next()
      if (oldest.done !== true) memory.delete(oldest.value)
    }
    memory.add(value)
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

/**
 * One counting pass over an origin's live rows.
 *
 * ONE implementation, used by both `counts()` and `#assertCapacity`. They had
 * a copy each: two answers to "how many sockets does this origin hold" that
 * had to agree, one of them documented as being the other, and only one of them
 * enforcing anything.
 */
function census (table: OriginTable): { sockets: number, files: number, identities: number } {
  let sockets = 0
  let files = 0
  let identities = 0
  for (const record of table.handles.values()) {
    if (SOCKET_KINDS.has(record.entry.kind)) sockets += 1
    else if (record.entry.kind === 'file') files += 1
    else identities += 1
  }
  return { sockets, files, identities }
}
