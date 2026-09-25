// orivon.web's three entry points -- openContext, evaluate, close -- built
// the same shape as ./id.ts's createIdCapability: this file owns
// no state of its own beyond a handful of small bookkeeping maps (below),
// so createBroker (../index.ts) can call it exactly the way it already calls
// createIdCapability/createNetCapability.
//
// ADR-0019. THE HOST DOES THE ELECTRON WORK; THIS FILE STAYS ELECTRON-FREE
// (README.md's own rule for everything under src/broker/). `deps.
// webContextHost` (broker-contracts.ts's `WebContextHost`) is the one
// injected escape hatch, mirroring `Dial`/`Bind`/`Listen`'s own precedent
// for `net`.
//
// REVOCATION IS THE SAME MECHANISM `capabilities/net.ts` USES FOR A SOCKET,
// NOT A SECOND ONE: `handleTable.run(key, { on: 'grant', grantId }, ...)`
// around the open, and a HandleTable entry of kind 'webContext' acquired
// under `{ by: 'grant', grantId }` -- when the grant is revoked,
// `HandleTable.revoke` (called from `index.ts`'s own `grant`/`revoke`/
// `revokePersisted`, unconditionally, exactly as it already does for every
// other capability) tears this context down the identical way it tears a
// TcpSocket down: `closed` rejects 'revoked', and this file's own `destroy`
// callback runs. A pending `evaluate` rides the same cascade via
// `handleTable.run`'s own `{ on: 'handle', handleId }` scope, which is what
// lets `HandleTable.revoke`'s cancellation reach an in-flight evaluate too.

import { LIMITS } from '../../contracts/index.js'
import { fail, isOrivonErrorLike } from '../errors.js'
import { isExactWebContextOrigin } from '../policy/web-context-origin.js'
import { webContextResultRejection } from '../policy/web-context-result.js'
import type { HandleTable } from '../handles/handles.js'
import type { DestroyResource } from '../handles/handle-contracts.js'
import type { GrantLedger } from '../grants/grant-ledger.js'
import type { Broker, CreateBrokerOptions } from '../broker-contracts.js'

export interface WebCapabilityOptions {
  readonly deps: CreateBrokerOptions
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
  /** Origin normalisation plus the malformed-origin 'internal' throw -- ../index.ts's own `canonical`, shared rather than redefined here. */
  readonly canonical: (origin: string) => string
}

const MIN_DIMENSION = 1
const MAX_DIMENSION = 7680
const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080

function clampDimension (value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.trunc(value)))
}

/** UTF-8 byte length, the unit both `LIMITS.webContextScriptBytes` and `LIMITS.webContextResultBytes` are measured in. */
function utf8Bytes (text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Same shape as `../transport/ipc.ts`'s own `withTimeout`, deliberately
 * NOT reused: that one lives in `./transport/`, which this file (`src/broker/`
 * proper) may not import (../README.md's one-way rule), and it is sized to
 * `RequestEnvelope.timeoutMs`, a caller-supplied IPC budget -- this one is
 * sized to `LIMITS.webContextEvaluateMs`, a broker policy constant. Rejects
 * with a real OrivonError rather than leaving `work` to keep running past its
 * budget; `work` itself is not cancelled, the same accepted trade `withTimeout`
 * documents.
 *
 * Used for BOTH `openContext`'s own `host.open` and `evaluate`'s own
 * `host.evaluate` -- one budget, one wrapper, per code-guidelines.md's "one
 * implementation per idea" (the security review's Finding 2: `openContext`
 * had no timeout at all before this, while `evaluate` already did).
 */
async function withWebContextTimeout<T> (promise: Promise<T>, ms: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(fail('timeout', `evaluate exceeded its ${String(ms)}ms budget`)) }, ms)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) }
    )
  })
}

/** One evaluate's deadline: the caller's own when given, never above the platform's. */
function evaluateDeadline (timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return LIMITS.webContextEvaluateMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw fail('invalid', 'timeoutMs must be a positive integer')
  return Math.min(timeoutMs, LIMITS.webContextEvaluateMs)
}

/** Builds `Broker['web']` -- see this file's header for why it takes the broker's own state rather than owning any of it. */
export function createWebCapability ({ deps, handleTable, ledger, canonical }: WebCapabilityOptions): Broker['web'] {
  const host = deps.webContextHost

  // Per-handle-id bookkeeping. Keyed by the HandleTable's own opaque id
  // (never the host's own id, which an app never sees) -- see broker-
  // contracts.ts's WebContextHost doc for why this file holds no live
  // object reference to the real context, only these small maps.
  const hostIdByHandle = new Map<string, string>()
  // The reverse of the map above, ONLY so `host.onGone`'s callback -- which
  // knows only the host's own id, never this file's handle id or which
  // origin opened it -- can find its way back to a `handleTable.fail` call.
  // Populated and cleared in lockstep with `hostIdByHandle` below.
  const handleByHostId = new Map<string, { readonly handleId: string, readonly key: string }>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const busy = new Set<string>()

  // Finding 3 of the ADR-0019 security review: registered ONCE, for the
  // life of this broker, rather than per-context -- `WebContextHost.onGone`
  // is one listener slot, matching the one real host this file is ever
  // wired to. `host?.` guards the no-host-wired-in build the same way every
  // other method here does; `?.onGone` guards a fake host in a test that
  // predates this event (broker-contracts.ts's own doc on why it is
  // optional).
  host?.onGone?.((hostId, platformCode) => {
    const mapped = handleByHostId.get(hostId)
    if (mapped === undefined) return // already closed through another path
    // Reused, not invented: the SAME "resource died on its own" mechanism
    // evaluate's own timeout handling below already uses. 'reset' -- "the
    // peer terminated an established connection abruptly" -- is what a
    // socket's own I/O fault answers for the same shape of event (an
    // ECONNRESET, io-errors.ts's own mapping); a context's renderer dying
    // out from under it is that same shape, not a broker fault ('internal')
    // and not the app's own doing ('closed').
    try { handleTable.fail(mapped.key, mapped.handleId, 'reset', platformCode) } catch { /* already gone via another path */ }
  })

  function clearIdle (handleId: string): void {
    const timer = idleTimers.get(handleId)
    if (timer !== undefined) {
      clearTimeout(timer)
      idleTimers.delete(handleId)
    }
  }

  /** (Re)starts the idle timer -- LIMITS.webContextIdleMs with no `evaluate` closes the context on its own, RESOLVING `closed` (contracts/handles.ts's own doc: "resolves if the platform closes an idle context"), via the ordinary `close()` path (`handleTable.release`), never the revoked one. */
  function scheduleIdle (key: string, handleId: string): void {
    clearIdle(handleId)
    const timer = setTimeout(() => {
      idleTimers.delete(handleId)
      void handleTable.release(key, handleId)
    }, LIMITS.webContextIdleMs)
    timer.unref?.()
    idleTimers.set(handleId, timer)
  }

  async function openContext (
    origin: string,
    opts: { origin: string, width?: number, height?: number }
  ): Promise<{ id: string, origin: string }> {
    const key = canonical(origin)

    // 'invalid' checked BEFORE the grant lookup (capability-api.ts's own
    // doc order on OrivonWeb.openContext): a malformed context origin is the
    // caller's own mistake, distinct from -- and checked ahead of -- whether
    // a real origin is actually granted.
    if (!isExactWebContextOrigin(opts.origin)) {
      throw fail('invalid', 'origin must be an exact https origin, with no wildcard, path, userinfo, query or fragment')
    }

    // THE NARROWING, exactly as every other capability's own entry point:
    // what the user GRANTED, never what the manifest merely declared. A
    // DENIAL HERE MUST NOT LEAK WHY -- "never granted" and "granted, but for
    // a different origin" answer with the SAME 'denied' and no
    // `platformCode`, matching capabilities/id.ts's own requireGrantedCurve.
    const current = ledger.currentGrant(key, 'web.context')
    if (current === undefined || !current.patterns.includes(opts.origin)) {
      throw fail('denied', 'web.context is not granted to this origin for the requested context origin')
    }

    if (host === undefined) throw fail('internal', 'no web-context host is wired in for this build')

    const width = clampDimension(opts.width, DEFAULT_WIDTH)
    const height = clampDimension(opts.height, DEFAULT_HEIGHT)

    return await handleTable.run(key, { on: 'grant', grantId: current.id }, async (signal) => {
      if (signal.aborted) throw fail('revoked', 'the grant authorising this context was withdrawn')

      // Bounded by the SAME budget `evaluate` already uses (Finding 2: this
      // call had no timeout at all before -- `deps.webContextHost` is
      // Electron, and a hung `WebContentsView` creation would otherwise wait
      // forever). `openPromise` is kept apart from the awaited, timed race
      // so a LATE resolve is still reachable below: `work` itself is not
      // cancelled by a timeout (withWebContextTimeout's own doc), so the
      // host can still hand back a real context after the caller has
      // already given up on it.
      const openPromise = host.open(key, opts.origin, { width, height })
      let hostId: string
      try {
        hostId = await withWebContextTimeout(openPromise, LIMITS.webContextEvaluateMs)
      } catch (error) {
        if (isOrivonErrorLike(error) && error.code === 'timeout') {
          // Close whatever the host eventually opens, the moment it does --
          // this caller is never coming back for it, and leaving it open
          // would leak exactly the resource `LIMITS.webContexts` exists to
          // cap. Never awaited: nothing here is still around to await it.
          openPromise.then(
            (lateId) => { host.close(lateId).catch(() => {}) },
            () => { /* the host itself failed -- nothing to close */ }
          )
        }
        throw isOrivonErrorLike(error) ? error : fail('internal', 'the web-context host failed to open a context')
      }

      if (signal.aborted) {
        await host.close(hostId).catch(() => {})
        throw fail('revoked', 'the grant authorising this context was withdrawn')
      }

      let entryId: string | undefined
      const destroy: DestroyResource = async () => {
        if (entryId !== undefined) {
          clearIdle(entryId)
          hostIdByHandle.delete(entryId)
          busy.delete(entryId)
        }
        handleByHostId.delete(hostId)
        await host.close(hostId)
      }

      // A refused acquisition (the grant revoked in the window just above,
      // or LIMITS.webContexts already reached) calls `destroy` itself
      // (HandleTable.acquire's own contract), which closes `hostId` even
      // though `entryId` was never assigned -- exactly what this file needs,
      // and the reason `destroy` guards `entryId` rather than assuming it.
      const entry = handleTable.acquire({
        origin: key,
        kind: 'webContext',
        authorisedBy: { by: 'grant', grantId: current.id },
        destroy
      })
      entryId = entry.id
      hostIdByHandle.set(entry.id, hostId)
      handleByHostId.set(hostId, { handleId: entry.id, key })
      scheduleIdle(key, entry.id)

      return { id: entry.id, origin: opts.origin }
    })
  }

  async function evaluate (origin: string, opts: { id: string, script: string, timeoutMs?: number }): Promise<unknown> {
    const key = canonical(origin)

    // T11c's ownership re-check -- throws 'denied'/'closed' for an id this
    // origin does not currently hold, the SAME check every other handle-
    // scoped operation in this codebase runs before touching anything else.
    handleTable.lookup(key, opts.id)

    if (host === undefined) throw fail('internal', 'no web-context host is wired in for this build')
    const deadlineMs = evaluateDeadline(opts.timeoutMs)

    if (utf8Bytes(opts.script) > LIMITS.webContextScriptBytes) {
      throw fail('limit', `script exceeds ${String(LIMITS.webContextScriptBytes)} bytes`)
    }
    if (busy.has(opts.id)) throw fail('limit', 'another evaluate on this context is already running')

    const hostId = hostIdByHandle.get(opts.id)
    if (hostId === undefined) throw fail('internal', 'no host context is registered for this handle')

    clearIdle(opts.id)
    busy.add(opts.id)
    try {
      let result: unknown
      try {
        result = await handleTable.run(key, { on: 'handle', handleId: opts.id }, async () =>
          await withWebContextTimeout(host.evaluate(hostId, opts.script), deadlineMs))
      } catch (error) {
        // Already ours (the timeout above, or 'revoked' from handleTable.run's
        // own cascade) -- pass through unchanged. Anything else reaching here
        // is the host's raw rejection: contracts/handles.ts's own doc is
        // explicit that "a throw inside the script rejects 'invalid' carrying
        // the thrown message" -- an app mistake, not a broker fault, so it is
        // wrapped as 'invalid' rather than surfacing whatever shape Electron's
        // own executeJavaScript rejection happens to take.
        if (isOrivonErrorLike(error)) {
          // contracts/handles.ts: a timeout "AND CLOSES THE CONTEXT" -- a
          // running script cannot be interrupted any other way. Reused
          // rather than invented: handleTable.fail is the SAME "resource
          // died on its own" mechanism a socket's own I/O fault already
          // uses, which is what makes `closed` REJECT 'timeout' here too
          // instead of the ordinary resolve an idle or app-initiated close
          // gets -- see README.md's Design notes for why reject was chosen.
          // Guarded: a concurrent revoke may have already closed this exact
          // handle through its own cascade, in which case there is nothing
          // left to fail and the timeout is still the right thing to throw.
          if (error.code === 'timeout') {
            try { handleTable.fail(key, opts.id, 'timeout') } catch { /* already gone via another path */ }
          }
          throw error
        }
        throw fail('invalid', error instanceof Error ? error.message : String(error))
      }

      // A bare top-level `undefined` completion resolves `null`
      // (contracts/handles.ts's own carve-out); anything else must already
      // be strictly JSON-compatible -- checked structurally, not via
      // JSON.stringify, because Electron hands back real Date/Map/Set/...
      // instances and real NaN/Infinity, none of which JSON.stringify
      // would catch (see ../policy/web-context-result.ts's header).
      const value = result === undefined ? null : result
      const rejection = webContextResultRejection(value)
      if (rejection !== null) throw fail('invalid', `the script's result is not JSON-compatible (${rejection})`)

      const text = JSON.stringify(value) // safe: `value` just proved strictly JSON-compatible
      if (utf8Bytes(text) > LIMITS.webContextResultBytes) {
        throw fail('limit', `result exceeds ${String(LIMITS.webContextResultBytes)} bytes`)
      }
      return value
    } finally {
      busy.delete(opts.id)
      // Only reschedule if the context is still ours -- a revoke or an
      // explicit close during this evaluate already tore it down and
      // cleared its bookkeeping; scheduling a fresh idle timer for it here
      // would resurrect a timer for a context that no longer exists.
      if (hostIdByHandle.has(opts.id)) scheduleIdle(key, opts.id)
    }
  }

  async function close (origin: string, opts: { id: string }): Promise<void> {
    const key = canonical(origin)
    // Idempotent, matching Handle.close()'s own contract -- handleTable.
    // release is a silent no-op for an id this origin does not hold or has
    // already closed, exactly like every other handle's own close().
    await handleTable.release(key, opts.id)
  }

  /** See broker-contracts.ts's own doc on why this exists beyond ADR-0019's three named control methods. */
  async function awaitClose (origin: string, opts: { id: string }): Promise<void> {
    const key = canonical(origin)
    // Throws 'denied'/'closed' immediately for an id this origin does not
    // currently hold -- the same T11c ownership re-check `evaluate` runs.
    // Otherwise `entry.closed` IS the canonical promise `handleTable`
    // settles from `closeTree` (handle-store.ts), so awaiting it here
    // observes the real close, not a copy of it.
    const entry = handleTable.lookup(key, opts.id)
    await entry.closed
  }

  return { openContext, evaluate, close, awaitClose }
}
