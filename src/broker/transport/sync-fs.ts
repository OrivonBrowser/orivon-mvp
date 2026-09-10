// orivon.fs.readFileSync's main-process handler (ADR-0016, queue item 2.2).
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

import { originFromSenderFrame } from '../policy/origin.js'
import type { SenderFrameLike } from '../policy/origin.js'
import { mapIoError } from '../io-errors.js'
import type { ResponseEnvelope } from '../../contracts/ipc.js'
import type { RateLimiter } from './token-bucket.js'
import { toFailureResponse } from './response-envelope.js'

export interface SyncControlEvent {
  readonly senderFrame: SenderFrameLike | null
}

export interface SyncFsReadRequest { readonly path: string }

export function isSyncFsReadRequest (payload: unknown): payload is SyncFsReadRequest {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string'
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
 * error (ENOENT and friends); `handleSyncFsReadRequest` maps it through
 * ../io-errors.ts's `mapIoError`, the same translation `../index.ts`'s
 * `runFsIo` applies to the async path, so an app sees the identical closed
 * code either way.
 */
export interface SyncFsPolicy {
  confine: (origin: string, path: string) => string
  readFileSync: (resolvedPath: string) => Uint8Array
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
export function handleSyncFsReadRequest (
  policy: SyncFsPolicy,
  event: SyncControlEvent,
  payload: unknown,
  limiter?: RateLimiter
): ResponseEnvelope<Uint8Array> {
  const origin = originFromSenderFrame(event.senderFrame)
  if (origin === null) {
    return { id: NO_ID, ok: false, code: 'denied', message: 'no authenticated origin for this frame' }
  }

  if (limiter !== undefined && !limiter.tryConsume(origin)) {
    return { id: NO_ID, ok: false, code: 'limit', message: 'this origin is calling too frequently; wait and retry' }
  }

  if (!isSyncFsReadRequest(payload)) {
    return { id: NO_ID, ok: false, code: 'invalid', message: 'fs.readFileSync requires { path: string }' }
  }

  try {
    const resolved = policy.confine(origin, payload.path)
    let bytes: Uint8Array
    try {
      bytes = policy.readFileSync(resolved)
    } catch (error) {
      throw mapIoError(error, 'fs')
    }
    return { id: NO_ID, ok: true, result: bytes }
  } catch (error) {
    return toFailureResponse(NO_ID, error)
  }
}
