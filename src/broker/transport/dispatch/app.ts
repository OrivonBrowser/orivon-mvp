// app.manifest / app.grants / app.requestGrant and the scheme-routing calls, split out of ../ipc.ts's
// dispatch() switch under code-guidelines.md Rule 2 -- one capability's
// worth of dispatch cases, the same seam ./fs.ts, ./id.ts
// and ./net.ts split along. See ./README.md's Design notes for why
// this seam, not another.

import { fail } from '../../errors.js'
import type { Broker } from '../../broker-contracts.js'
import type { CapabilityRequest } from '../../../contracts/index.js'
import { isAppRequestGrantParams, isAppSchemeParams } from '../ipc-validation.js'
import type { ControlMethod, RequestGrantCaller, RequestGrantCtx, SchemeCtx } from '../ipc-validation.js'

/** The `app.*` slice of `ControlMethod` -- derived, not retyped, so a new app method added to ipc-validation.ts's union reaches this switch's exhaustiveness check automatically. */
export type AppControlMethod = Extract<ControlMethod, `app.${string}`>

/**
 * `app.*`'s dispatch cases, unchanged from ../ipc.ts's own switch except for
 * `caller` (A146, docs/architecture/security-model.md): built by ../ipc.ts
 * from the real sending frame, before this ever runs, so
 * `requestGrantCtx.requestGrant`'s own dialog can be parented to the calling
 * tab and discounted if that tab is gone by the time it resolves. `app.
 * manifest`/`app.grants` never look at it -- only `app.requestGrant` shows a
 * dialog.
 */
export async function dispatchApp (
  broker: Broker,
  origin: string,
  method: AppControlMethod,
  payload: unknown,
  requestGrantCtx: (RequestGrantCtx & SchemeCtx) | undefined,
  caller: RequestGrantCaller,
  abandoned?: AbortSignal
): Promise<unknown> {
  switch (method) {
    case 'app.manifest':
      return await broker.app.manifest(origin)
    case 'app.grants':
      return await broker.app.grants(origin)
    // `capability` is not re-validated here (Rule 3: request-grant.ts's
    // isCapabilityKind is the one check). Only capability/patterns cross,
    // never the rest of `payload`, even one naming its own `origin` (T3).
    case 'app.requestGrant': {
      if (!isAppRequestGrantParams(payload)) throw fail('invalid', 'app.requestGrant requires { capability: string, patterns?: string[] }')
      if (requestGrantCtx?.requestGrant === undefined) throw fail('internal', 'requestGrant is not available -- request-grant subsystem failed to start')
      const request: CapabilityRequest = payload.patterns === undefined
        ? { capability: payload.capability }
        : { capability: payload.capability, patterns: payload.patterns }
      return await requestGrantCtx.requestGrant(origin, request, caller, abandoned)
    }
    // Scheme routing (d-0596). Only an app that holds a grant can be handed a link, so these three answer 'denied' to an
    // origin that holds none rather than saying anything about which schemes exist.
    case 'app.nextOpenUrl': {
      const host = schemeHostFor(broker, origin, requestGrantCtx)
      return await host.nextUrl(origin, abandoned ?? new AbortController().signal, caller.contents?.())
    }
    case 'app.requestSchemeHandler': {
      if (!isAppSchemeParams(payload)) throw fail('invalid', 'app.requestSchemeHandler requires { scheme: string }')
      return await schemeHostFor(broker, origin, requestGrantCtx).requestHandler(origin, payload.scheme, caller)
    }
    case 'app.isSchemeHandler': {
      if (!isAppSchemeParams(payload)) throw fail('invalid', 'app.isSchemeHandler requires { scheme: string }')
      return await schemeHostFor(broker, origin, requestGrantCtx).isHandler(origin, payload.scheme)
    }
    default: {
      // Exhaustiveness check, same reasoning and shape as ../ipc.ts's own
      // dispatch() and ./net.ts's dispatchNet (A185): if
      // AppControlMethod ever gains a member no case above names, `method`
      // is not assignable to `never` and this line fails to compile, instead
      // of the switch silently falling through and this function resolving
      // `undefined` for an operation that never ran.
      const unrouted: never = method
      throw fail('internal', `unrouted app control method: ${unrouted as string}`)
    }
  }
}

function schemeHostFor (broker: Broker, origin: string, ctx: SchemeCtx | undefined): NonNullable<SchemeCtx['schemeHost']> {
  if (!broker.app.hasGrantsSync(origin)) throw fail('denied', 'this app holds no grant, so no link can be sent to it')
  if (ctx?.schemeHost === undefined) throw fail('internal', 'scheme routing is not available -- the shell has not wired it')
  return ctx.schemeHost
}
