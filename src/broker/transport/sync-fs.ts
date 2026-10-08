// The main-process handler for the page's synchronous fs calls (ADR-0016): readFileSync
// and the path-based twin the page's shim calls over SYNC_CONTROL_CHANNEL.
// Sibling of ./ipc.ts's handleControlRequest, but never behind an `await`:
// ipcRenderer.sendSync blocks the renderer until this function returns, so
// nothing on this path may suspend -- see ADR-0016 for why that block is the
// required behaviour, not a cost to hide.
//
// WHY THE POLICY CHECK IS INJECTED (`SyncFsPolicy`) RATHER THAN A DIRECT
// CALL ONTO `Broker` HERE: this file stays Electron-free and testable with a
// fake policy (below), the same reason `./ipc.ts`'s `handleControlRequest`
// takes a structural `Broker`/`event`/`transport` instead of reaching for
// `electron` itself. `./sync-fs-policy.ts`'s `createSyncFsPolicy` is the
// production implementation, and it is a thin pass-through onto
// `../index.ts`'s own `Broker.fs.confineSync` -- ADR-0016's synchronous
// grant-check/confinement entry point, added alongside this file, reusing
// `confineForOrigin` itself rather than a second implementation of it.
//
// TESTABLE WITHOUT ELECTRON, same reason and same shape as
// ./ipc.ts's handleControlRequest: `SyncControlEvent`, `SyncFsPolicy` and
// `RateLimiter` are all structural.

import { callerKeyFromSenderFrame, isAttributedSession } from '../policy/origin.js'
import type { SenderFrameLike } from '../policy/origin.js'
import { mapIoError } from '../io-errors.js'
import type { ResponseEnvelope } from '../../contracts/ipc.js'
import type { BrokerFsSyncMethods } from '../fs-contracts.js'
import type { RateLimiter } from './token-bucket.js'
import { toFailureResponse } from './response-envelope.js'

export interface SyncControlEvent {
  readonly senderFrame: SenderFrameLike | null
  /** `isAttributedSession`'s own `mainFrame` comparison (policy/origin.ts),
   * plus `session` for the injected `attributed` predicate to read -- this
   * channel never reloads a tab (unlike ./ipc.ts's CONTROL_CHANNEL), so it
   * needs neither `reload` nor `isDestroyed`. */
  readonly sender: {
    readonly mainFrame: SenderFrameLike | null
    readonly session: unknown
  }
}

/** The seven names the page's synchronous twin has (`handle`-based calls are not among them). */
export type SyncFsOp = 'stat' | 'readFile' | 'writeFile' | 'mkdir' | 'readdir' | 'rm' | 'rename'

export interface SyncFsRequest {
  readonly op: SyncFsOp
  readonly args: readonly unknown[]
}

const SYNC_FS_OPS: ReadonlySet<string> = new Set<SyncFsOp>(['stat', 'readFile', 'writeFile', 'mkdir', 'readdir', 'rm', 'rename'])

function isRecursiveOptions (value: unknown): boolean {
  if (value === undefined) return true
  return typeof value === 'object' && value !== null &&
    ((value as { recursive?: unknown }).recursive === undefined || typeof (value as { recursive?: unknown }).recursive === 'boolean')
}

/** The shape of `args` each op takes, mirroring `ipc-validation.ts`'s per-method checks for the async channel. */
function argsMatch (op: SyncFsOp, args: readonly unknown[]): boolean {
  const isString = (value: unknown): boolean => typeof value === 'string'
  switch (op) {
    case 'stat':
    case 'readFile':
    case 'readdir':
      return args.length === 1 && isString(args[0])
    case 'writeFile':
      return args.length === 2 && isString(args[0]) && args[1] instanceof Uint8Array
    case 'mkdir':
    case 'rm':
      return args.length >= 1 && args.length <= 2 && isString(args[0]) && isRecursiveOptions(args[1])
    case 'rename':
      return args.length === 2 && isString(args[0]) && isString(args[1])
  }
}

export function isSyncFsRequest (payload: unknown): payload is SyncFsRequest {
  if (typeof payload !== 'object' || payload === null) return false
  const { op, args } = payload as { op?: unknown, args?: unknown }
  return typeof op === 'string' && SYNC_FS_OPS.has(op) && Array.isArray(args) && argsMatch(op as SyncFsOp, args)
}

/**
 * The policy decision plus the raw read, both synchronous by construction.
 *
 * `confine` throws an OrivonError on refusal (a missing `fs` grant or a
 * `policy/paths.ts` confinement failure both surface as `'denied'`, matching
 * ../index.ts's own `confineForOrigin`) and returns the resolved, confined
 * absolute path on success -- never a raw Node error, so this handler need
 * not guess whether a thrown value already carries the closed error enum.
 *
 * `readFileSync` is the raw disk read. It is expected to throw a RAW Node
 * error (ENOENT and friends); `handleSyncFsRequest` maps it through
 * ../io-errors.ts's `mapIoError`, the same translation `../index.ts`'s
 * `runFsIo` applies to the async path, so an app sees the identical closed
 * code either way.
 */
export interface SyncFsPolicy {
  confine: (origin: string, path: string) => string
  readFileSync: (resolvedPath: string) => Uint8Array
  /**
   * Every other op, confined and quota-checked by the broker itself
   * (`Broker.fs.sync`): refusals arrive as OrivonErrors, disk failures raw,
   * mapped here like `readFileSync`'s.
   */
  sync: BrokerFsSyncMethods
}

/**
 * sendSync has no reply to correlate: exactly one call is ever in flight per
 * invocation, unlike CONTROL_CHANNEL's invoke/reply pairs, which need `id`
 * to match a reply to its request. Every ResponseEnvelope this file builds
 * carries this instead -- ../../contracts/ipc.ts does not special-case an
 * empty id; it exists only for the async channel's own matching.
 */
const NO_ID = ''

/**
 * One request in, one response out, synchronously -- no Electron, no I/O
 * beyond what `policy` performs.
 *
 * Checks run in the same order `handleControlRequest` uses for parity: no
 * authenticated origin, then the rate limit (shared with CONTROL_CHANNEL via
 * the same `limiter` instance, so this path cannot be used to dodge it),
 * then payload shape, then the policy decision itself.
 */
export function handleSyncFsRequest (
  policy: SyncFsPolicy,
  event: SyncControlEvent,
  payload: unknown,
  limiter?: RateLimiter,
  attributed?: (sender: unknown, origin: string) => boolean
): ResponseEnvelope<unknown> {
  const origin = callerKeyFromSenderFrame(event.senderFrame)
  if (origin === null) {
    return { id: NO_ID, ok: false, code: 'denied', message: 'no authenticated origin for this frame' }
  }

  // Same check, same reason, as ./ipc.ts's own CONTROL_CHANNEL handler --
  // see isAttributedSession's doc (policy/origin.ts).
  if (attributed !== undefined && !isAttributedSession(event.senderFrame, event.sender, origin, attributed)) {
    return { id: NO_ID, ok: false, code: 'denied', message: 'this document is not in the session its origin belongs to' }
  }

  if (limiter !== undefined && !limiter.tryConsume(origin)) {
    return { id: NO_ID, ok: false, code: 'limit', message: 'this origin is calling too frequently; wait and retry' }
  }

  if (!isSyncFsRequest(payload)) {
    return { id: NO_ID, ok: false, code: 'invalid', message: 'the synchronous fs channel requires { op, args } with a known op' }
  }

  try {
    return { id: NO_ID, ok: true, result: runOp(policy, origin, payload) }
  } catch (error) {
    return toFailureResponse(NO_ID, error)
  }
}

/** One op, run to completion. A raw Node error is mapped here; an OrivonError from the broker passes through `mapIoError` unchanged. */
function runOp (policy: SyncFsPolicy, origin: string, { op, args }: SyncFsRequest): unknown {
  if (op === 'readFile') {
    const resolved = policy.confine(origin, args[0] as string)
    try {
      return policy.readFileSync(resolved)
    } catch (error) {
      throw mapIoError(error, 'fs')
    }
  }
  try {
    switch (op) {
      case 'stat': return policy.sync.stat(origin, args[0] as string)
      case 'readdir': return policy.sync.readdir(origin, args[0] as string)
      case 'writeFile': policy.sync.writeFile(origin, args[0] as string, args[1] as Uint8Array); return undefined
      case 'mkdir': policy.sync.mkdir(origin, args[0] as string, args[1] as { recursive?: boolean } | undefined); return undefined
      case 'rm': policy.sync.rm(origin, args[0] as string, args[1] as { recursive?: boolean } | undefined); return undefined
      case 'rename': policy.sync.rename(origin, args[0] as string, args[1] as string); return undefined
    }
  } catch (error) {
    throw mapIoError(error, 'fs')
  }
}
