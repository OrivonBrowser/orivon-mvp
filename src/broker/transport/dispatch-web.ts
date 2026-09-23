// web.openContext / web.evaluate / web.close / web.awaitClose, split out of
// ./ipc.ts's dispatch() switch under code-guidelines.md Rule 2 -- see
// ./dispatch-app.ts's header for the seam this and its siblings
// (dispatch-id.ts, dispatch-net.ts, dispatch-fs.ts) share.
//
// NO PORT TRANSPORT, UNLIKE net.connect -- exactly dispatch-id.ts's own
// precedent: a plain request/reply round trip over CONTROL_CHANNEL, since
// `orivon.web`'s own methods are all ID-ADDRESSED, JSON-shaped calls
// (broker-contracts.ts's WebContextHost doc), never a live handle object
// crossing the wire. `web.awaitClose` is the one exception to "request,
// then reply promptly": it is a deliberate long-poll, held open by
// ./ipc.ts's own withTimeout until `Broker['web'].awaitClose` settles or the
// caller's own budget runs out -- see web-context-contracts.ts's own doc on
// why `WebContext.closed` needs it at all.

import { fail } from '../errors.js'
import type { Broker } from '../broker-contracts.js'
import { isWebCloseParams, isWebEvaluateParams, isWebOpenContextParams } from './ipc-validation.js'
import type { ControlMethod } from './ipc-validation.js'

/** The `web.*` slice of `ControlMethod` -- see ./dispatch-app.ts's own `AppControlMethod` for why this is derived rather than retyped. */
export type WebControlMethod = Extract<ControlMethod, `web.${string}`>

/**
 * `web.*`'s dispatch cases. `origin` here is THIS CALLER's own origin
 * (derived from the sender frame, T3, by ./ipc.ts before dispatch() ever
 * runs) -- never to be confused with `payload.origin` on `web.openContext`,
 * which is the CONTEXT's own origin, an ordinary app-controlled string
 * `broker.web.openContext` itself validates and checks against the live
 * grant.
 */
export async function dispatchWeb (
  broker: Broker,
  origin: string,
  method: WebControlMethod,
  payload: unknown
): Promise<unknown> {
  switch (method) {
    case 'web.openContext': {
      if (!isWebOpenContextParams(payload)) {
        throw fail('invalid', 'web.openContext requires { origin: string, width?: number, height?: number }')
      }
      // exactOptionalPropertyTypes: `width`/`height` are included only when
      // the caller actually sent one, same flattening every other optional
      // field on this wire already uses (ipc-validation.ts's own precedent).
      const opts: { origin: string, width?: number, height?: number } = { origin: payload.origin }
      if (payload.width !== undefined) opts.width = payload.width
      if (payload.height !== undefined) opts.height = payload.height
      return await broker.web.openContext(origin, opts)
    }
    case 'web.evaluate': {
      if (!isWebEvaluateParams(payload)) throw fail('invalid', 'web.evaluate requires { id: string, script: string, timeoutMs?: number }')
      return await broker.web.evaluate(origin, payload.timeoutMs === undefined
        ? { id: payload.id, script: payload.script }
        : { id: payload.id, script: payload.script, timeoutMs: payload.timeoutMs })
    }
    case 'web.close': {
      if (!isWebCloseParams(payload)) throw fail('invalid', 'web.close requires { id: string }')
      await broker.web.close(origin, { id: payload.id })
      return undefined
    }
    case 'web.awaitClose': {
      // Shape-identical to web.close -- reused rather than a second
      // validator (code-guidelines.md Rule 3, this file's own precedent for
      // WebCloseParams).
      if (!isWebCloseParams(payload)) throw fail('invalid', 'web.awaitClose requires { id: string }')
      await broker.web.awaitClose(origin, { id: payload.id })
      return undefined
    }
    default: {
      // Exhaustiveness check, same reasoning and shape as ./dispatch-id.ts's
      // own dispatchId (A185): if WebControlMethod ever gains a member no
      // case above names, `method` is not assignable to `never` and this
      // line fails to compile.
      const unrouted: never = method
      throw fail('internal', `unrouted web control method: ${unrouted as string}`)
    }
  }
}
