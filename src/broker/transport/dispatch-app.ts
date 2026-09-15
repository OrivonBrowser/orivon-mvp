// app.manifest / app.grants / app.requestGrant, split out of ./ipc.ts's
// dispatch() switch under code-guidelines.md Rule 2 -- one capability's
// worth of dispatch cases, the same seam ./dispatch-fs.ts, ./dispatch-id.ts
// and ./dispatch-net.ts split along. See ./README.md's Design notes for why
// this seam, not another.

import { fail } from '../errors.js'
import type { Broker } from '../broker-contracts.js'
import type { CapabilityRequest } from '../../contracts/index.js'
import { isAppRequestGrantParams } from './ipc-validation.js'
import type { ControlMethod, RequestGrantCtx } from './ipc-validation.js'

/** The `app.*` slice of `ControlMethod` -- derived, not retyped, so a new app method added to ipc-validation.ts's union reaches this switch's exhaustiveness check automatically. */
export type AppControlMethod = Extract<ControlMethod, `app.${string}`>

/** `app.*`'s dispatch cases, unchanged from ./ipc.ts's own switch. */
export async function dispatchApp (
  broker: Broker,
  origin: string,
  method: AppControlMethod,
  payload: unknown,
  requestGrantCtx: RequestGrantCtx | undefined
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
      return await requestGrantCtx.requestGrant(origin, request)
    }
  }
}
