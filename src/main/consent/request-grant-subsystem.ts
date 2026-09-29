// Wires ./request-grant.ts's transport-agnostic mechanism into the running
// app: publishes a bound `requestGrant` onto SubsystemContext (registry.ts),
// closing over THIS process's one Broker and the rendered dialog prompt
// (./request-grant-prompt.ts). Kept apart from request-grant.ts itself,
// which stays free of any Electron import (that file's own header) --
// importing electron here, instead, is what would otherwise force every
// plain-vitest unit test of the pure mechanism to mock it.
//
// REACHED FROM A REAL PAGE. `../broker/transport/ipc.ts`'s
// `app.requestGrant` control case turns a page's
// `window.orivon.app.requestGrant(...)` into a call here, with the origin
// taken from `event.senderFrame` and never from the payload (T3). That
// origin argument is the whole security boundary of this seam: a page that
// could name its own origin could grant itself anything.

import type { Subsystem, SubsystemContext } from '../registry.js'
import { publishRequestGrant } from '../registry.js'
import { requestGrant } from './request-grant.js'
import { createGrantPrompt } from './request-grant-prompt.js'
import { scoreLevelOverrideFor } from '../dev/score-levels.js'
import { extensionNamesForOrigin } from '../extensions/site-reach-runner.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'

export const requestGrantSubsystem: Subsystem = {
  name: 'request-grant',
  afterReady: (ctx: SubsystemContext) => {
    if (ctx.broker === undefined) {
      throw new Error('request-grant subsystem requires ctx.broker -- check its position in subsystems.ts')
    }
    const broker = ctx.broker
    // ADR-0037: same developer-only override as app-install-subsystem.ts.
    // The extensions disclosure (docs/planning/extensions-exploration.md): listed
    // fresh from ctx.extensions on every prompt, never cached -- extensions
    // are installed and enabled far less often than a grant prompt fires,
    // but a stale list would still be the wrong list to show. extensionsSubsystem
    // runs before this one (../subsystems.ts), so ctx.extensions is already
    // published by the time a real page can trigger a prompt.
    const extensionsOnSite = async (origin: string): Promise<readonly string[]> => {
      const extensions = ctx.extensions
      return extensions === undefined ? [] : await extensionNamesForOrigin(extensions, origin, isOriginServedFromCacheSync)
    }
    const consent = createGrantPrompt(broker, scoreLevelOverrideFor, extensionsOnSite)
    publishRequestGrant(ctx, async (origin, request) => await requestGrant(broker, consent, origin, request))
  }
}
