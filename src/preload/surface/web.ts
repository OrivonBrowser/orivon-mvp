// orivon.web.openContext's page-facing bridge closure (ADR-0019), split out
// of ./orivon.ts under code-guidelines.md Rule 2, following ./net-
// surface.ts's own precedent -- see ./README.md's Design notes.
//
// `closed` IS A LIVE, PUSH-LIKE PROMISE despite `orivon.web` carrying no
// port channel of its own (unlike net.connect's own MessagePortMain relay,
// which is how a socket's `closed` learns of a revoke without polling).
// `watchClose` below builds it from a LOOPED `web.awaitClose` call instead
// -- see broker-contracts.ts's `WebContextHost` doc and web-context-
// contracts.ts's own doc on `BrokerWebMethods.awaitClose` for why that
// fourth control method exists at all: `contracts/handles.ts`'s
// `WebContext.closed` promises the same live behaviour every other Handle's
// `closed` already has, and there is no cheaper way to deliver it without a
// dedicated push channel this capability does not otherwise need.

import { call, TIMEOUT_MS } from './control-call.js'
import type { MainWorldWebContextBridge } from './main-world-bridges.js'

export type { MainWorldWebContextBridge } from './main-world-bridges.js'

interface WebContextDescriptor {
  readonly id: string
  readonly origin: string
}

/**
 * Resolves once `id`'s context actually leaves the broker's tables, or
 * rejects with the terminal OrivonError ('revoked' for a withdrawn grant,
 * matching `contracts/handles.ts`'s own doc on `WebContext.closed`).
 *
 * A SINGLE `call()` cannot express "wait however long that takes, which
 * might be never" -- `contracts/ipc.ts`'s rule 2 requires an explicit,
 * finite budget on every call. Each iteration is bounded by
 * `TIMEOUT_MS.webAwaitClose`; a code of 'timeout' from THIS LOCAL budget
 * (control-call.ts's own `raceTimeout`, not a real broker answer --
 * `web.awaitClose` never times out on its own) means only "poll again",
 * and anything else -- a resolve, or a genuine rejection such as
 * 'revoked'/'denied'/'closed' -- is final.
 */
async function watchClose (id: string): Promise<void> {
  for (;;) {
    try {
      await call('web.awaitClose', { id }, TIMEOUT_MS.webAwaitClose)
      return
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'timeout') throw error
    }
  }
}

/**
 * The one `web.openContext` closure handed into the main world (both
 * directly, in `exposeFallback`, and via `bridge.webOpenContext` for
 * `executeInMainWorld` -- ./orivon.ts's own two paths). `closed`'s
 * watch loop starts the instant the context exists, so a caller that never
 * calls `evaluate`/`close` and simply awaits `closed` still sees a real
 * signal.
 */
export async function webOpenContextBridge (
  opts: { origin: string, width?: number, height?: number }
): Promise<MainWorldWebContextBridge> {
  // exactOptionalPropertyTypes: width/height included only when the caller
  // actually passed one, matching every other optional field this codebase
  // sends over CONTROL_CHANNEL (transport/dispatch/web.ts's own precedent).
  const payload: { origin: string, width?: number, height?: number } = { origin: opts.origin }
  if (opts.width !== undefined) payload.width = opts.width
  if (opts.height !== undefined) payload.height = opts.height

  const descriptor = await call<WebContextDescriptor>('web.openContext', payload, TIMEOUT_MS.webOpen)
  const closed = watchClose(descriptor.id)
  // The watch loop's own eventual rejection must not become unhandled
  // before anything looks at `closed` -- the app may never await it, the
  // same reasoning handle-store.ts's own `closed` promise documents one
  // layer down (`void closed.catch((): void => {})`).
  closed.catch(() => {})

  return {
    id: descriptor.id,
    origin: descriptor.origin,
    closed,
    // The page's own budget stays TIMEOUT_MS.webEvaluate: a shorter
    // `timeoutMs` is enforced by the broker, which also closes the context.
    evaluate: async (script: string, options?: { readonly timeoutMs?: number }) => await call(
      'web.evaluate',
      options?.timeoutMs === undefined ? { id: descriptor.id, script } : { id: descriptor.id, script, timeoutMs: options.timeoutMs },
      TIMEOUT_MS.webEvaluate
    ),
    close: async () => { await call('web.close', { id: descriptor.id }, TIMEOUT_MS.webClose) }
  }
}
