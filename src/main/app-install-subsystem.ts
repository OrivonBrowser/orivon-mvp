// Publishes ctx.installApp -- app-install.ts's installFromHint, closed over
// this process's one Broker/Loader and every real dialog S4-4/S4-5 built
// (d-0025's install-time consent, plus the reconsent/capability-widening/
// rollback-choice prompts driveLoadResult drives) -- for whoever builds the
// discovery-trigger listener (S4-2, docs/planning/step-4-app-loader-plan.md)
// to call. Kept apart from app-install.ts itself, which stays Electron-free
// -- the same split request-grant.ts/request-grant-subsystem.ts already
// use, and for the same reason: importing electron here, not there, is
// what keeps app-install.ts's own logic testable under plain vitest with
// no real dialog.
//
// manifest-hint.ts (S4-2) is now the real production caller of
// ctx.installApp -- corrected here since S4-5 touched this file anyway;
// see docs/open-questions.md A146 for the one gap that caller still has.

import type { Subsystem, SubsystemContext } from './registry.js'
import { publishInstallApp } from './registry.js'
import { installFromHint } from './app-install.js'
import { createInstallConsentPrompt } from './install-consent-prompt.js'
import { createCapabilityPrompt, createReconsentPrompt, createRollbackChoicePrompt } from './update-outcomes-prompt.js'

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
    const reconsentPrompt = createReconsentPrompt()
    const capabilityPrompt = createCapabilityPrompt()
    const rollbackChoicePrompt = createRollbackChoicePrompt()
    publishInstallApp(ctx, async (hintingOrigin, hintedUrl) =>
      await installFromHint({ broker, loader, consent, reconsentPrompt, capabilityPrompt, rollbackChoicePrompt }, hintingOrigin, hintedUrl))
  }
}
