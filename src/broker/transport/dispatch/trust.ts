// trust.websiteScore, split out of ../ipc.ts's dispatch() switch under code-guidelines.md Rule 2 -- see ./id.ts's
// header for the seam this and its siblings share.

import { fail } from '../../errors.js'
import type { Broker } from '../../broker-contracts.js'
import { isTrustWebsiteScoreParams } from '../ipc-validation.js'
import type { ControlMethod, TrustCtx } from '../ipc-validation.js'

/** The `trust.*` slice of `ControlMethod` -- see ./app.ts's own `AppControlMethod` for why this is derived rather than retyped. */
export type TrustControlMethod = Extract<ControlMethod, `trust.${string}`>

/**
 * The grant is checked here, in the broker, before the lookup runs: an app that never held `trust.score` learns
 * nothing from the call, not even whether a provider is chosen. The lookup is read from `ctx` on every call (see
 * `TrustCtx`), and a context without one is a wiring fault, never an answer.
 */
export async function dispatchTrust (
  broker: Broker,
  origin: string,
  method: TrustControlMethod,
  payload: unknown,
  ctx: TrustCtx | undefined
): Promise<unknown> {
  switch (method) {
    case 'trust.websiteScore': {
      if (!isTrustWebsiteScoreParams(payload)) throw fail('invalid', 'trust.websiteScore requires { address: string }')
      broker.trust.requireScoreGrant(origin)
      if (ctx?.websiteScore === undefined) throw fail('internal', 'websiteScore is not available -- the shell has not wired the score lookup')
      return await ctx.websiteScore(origin, payload.address)
    }
    default: {
      // Exhaustiveness check, same reasoning and shape as ./secrets.ts's own.
      const unrouted: never = method
      throw fail('internal', `unrouted trust control method: ${unrouted as string}`)
    }
  }
}
