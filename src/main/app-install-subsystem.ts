// Publishes ctx.installApp -- app-install.ts's installFromHint, closed over
// this process's one Broker/Loader and the real install-time consent
// dialog (d-0025, S4-4's own item; ./install-consent-prompt.ts) -- for
// whoever builds the discovery-trigger listener (S4-2, docs/planning/
// step-4-app-loader-plan.md) to call. Kept apart from app-install.ts
// itself, which stays Electron-free -- the same split request-grant.ts/
// request-grant-subsystem.ts already use, and for the same reason:
// importing electron here, not there, is what keeps app-install.ts's own
// logic testable under plain vitest with no real dialog.
//
// NOTHING CALLS ctx.installApp YET -- same honest state
// requestGrantSubsystem's own header documents for ctx.requestGrant: live,
// real production wiring with no caller, not a stub.

import type { Subsystem, SubsystemContext } from './registry.js'
import { publishInstallApp } from './registry.js'
import { installFromHint } from './app-install.js'
import { createInstallConsentPrompt } from './install-consent-prompt.js'

export const appInstallSubsystem: Subsystem = {
  name: 'app-install',
  afterReady: (ctx: SubsystemContext) => {
    if (ctx.broker === undefined) {
      throw new Error('app-install subsystem requires ctx.broker -- check its position in subsystems.ts')
    }
    if (ctx.loader === undefined) {
      throw new Error('app-install subsystem requires ctx.loader -- check its position in subsystems.ts')
    }
    const broker = ctx.broker
    const loader = ctx.loader
    const consent = createInstallConsentPrompt()
    publishInstallApp(ctx, async (hintingOrigin, hintedUrl) => await installFromHint({ broker, loader, consent }, hintingOrigin, hintedUrl))
  }
}
