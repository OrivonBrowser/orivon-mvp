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

import { net } from 'electron'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { publishInstallApp } from '../registry.js'
import { installFromHint } from './app-install.js'
import { createInstallConsentPrompt, createPerCapabilityConsentPrompt } from '../consent/install-consent-prompt.js'
import { createCapabilityPrompt, createReconsentPrompt, createRollbackChoicePrompt } from '../consent/update-outcomes-prompt.js'
import { grantableWithoutInstall, grantWithoutInstall } from './grant-without-install.js'
import { installGrantedOriginCsp } from './granted-origin-csp.js'
import { devModeEnabled } from '../dev/dev-mode.js'

const GRANT_MANIFEST_TIMEOUT_MS = 5_000

async function fetchGrantManifest (url: string): Promise<{ ok: boolean, status: number, text: string }> {
  const response = await net.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(GRANT_MANIFEST_TIMEOUT_MS) })
  return { ok: response.ok, status: response.status, text: await response.text() }
}

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
    const perCapabilityConsent = createPerCapabilityConsentPrompt()
    const reconsentPrompt = createReconsentPrompt()
    const capabilityPrompt = createCapabilityPrompt()
    const rollbackChoicePrompt = createRollbackChoicePrompt()
    publishInstallApp(ctx, async (hintingOrigin, hintedUrl) => {
      // A loopback origin can never reach installFromHint's own consent:
      // install-origin.ts refuses it for not being https and not being
      // public unicast, before a manifest is ever read. It is granted
      // without being installed instead (./grant-without-install.ts).
      if (grantableWithoutInstall(hintingOrigin, devModeEnabled())) {
        const outcome = await grantWithoutInstall(
          { broker, fetchManifest: fetchGrantManifest, consent, perCapabilityConsent },
          hintingOrigin
        )
        if (outcome.outcome === 'rejected') {
          console.warn(`[app-install] grant without installing refused for ${hintingOrigin}: ${outcome.reason}`)
        } else {
          // Before returning: the caller reloads the tab, and that reload's
          // document must already carry the installed-path CSP.
          installGrantedOriginCsp(broker, outcome.canonicalOrigin)
        }
        return outcome
      }
      return await installFromHint({ broker, loader, consent, perCapabilityConsent, reconsentPrompt, capabilityPrompt, rollbackChoicePrompt }, hintingOrigin, hintedUrl)
    })
  }
}
