// Wires ./request-grant.ts's transport-agnostic mechanism into the running
// app: publishes a bound `requestGrant` onto SubsystemContext (registry.ts),
// closing over THIS process's one Broker and the rendered dialog prompt
// (./request-grant-prompt.ts). Kept apart from request-grant.ts itself,
// which stays free of any Electron import (that file's own header) --
// importing electron here, instead, is what would otherwise force every
// plain-vitest unit test of the pure mechanism to mock it.
//
// NOTHING CALLS `ctx.requestGrant` YET. The only missing piece is a
// control-channel case in ../broker/transport/ipc.ts turning a page's
// `window.orivon.app.requestGrant(...)` into a call here with the origin
// taken from `event.senderFrame` (T3) -- out of scope for this change; see
// this lane's own PR body for why (a parallel lane owns that file this
// batch). Until that case exists, this subsystem is live, real production
// wiring with no caller, not a stub -- the same honest state
// docs/planning/unattended-build-queue.md item 4.1 anticipates ("whether
// requestGrant is reachable from a page yet, and if not why").

import type { Subsystem, SubsystemContext } from './registry.js'
import { publishRequestGrant } from './registry.js'
import { requestGrant } from './request-grant.js'
import { createGrantPrompt } from './request-grant-prompt.js'

export const requestGrantSubsystem: Subsystem = {
  name: 'request-grant',
  afterReady: (ctx: SubsystemContext) => {
    if (ctx.broker === undefined) {
      throw new Error('request-grant subsystem requires ctx.broker -- check its position in subsystems.ts')
    }
    const broker = ctx.broker
    const consent = createGrantPrompt(broker)
    publishRequestGrant(ctx, async (origin, request) => await requestGrant(broker, consent, origin, request))
  }
}
