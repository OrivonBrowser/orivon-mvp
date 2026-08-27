// The handle table's own vocabulary -- types and small pure helpers, split out
// of ./handles.ts so that file could stay under the 500-line guideline
// (docs/development/code-guidelines.md Rule 2). No state lives here.
//
// Spec: docs/architecture/handle-contracts.md. See ./handles.ts's header for
// why this directory holds state at all and what it may and may not import.

import type { GrantId } from '../contracts/index.js'

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
