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
// manifest-hint.ts (S4-2) is the real production caller of ctx.installApp;
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
import { scoreLevelOverrideFor } from '../dev/score-levels.js'
import { withOriginQueue } from './origin-queue.js'
import { MAX_MANIFEST_BYTES } from '../../loader/manifest/manifest.js'

const GRANT_MANIFEST_TIMEOUT_MS = 5_000

/**
 * Reads at most `capBytes` of `response`'s body, decoding only what was
 * actually read -- F10: this used to read the WHOLE body to a string first
 * (`response.text()`), with `grantWithoutInstall`'s own `MAX_MANIFEST_BYTES`
 * check only running on the result, so a compromised loopback server
 * naming an unbounded manifest was read to completion in memory regardless
 * of that limit. Stops reading (and cancels the stream) the moment the
 * total crosses `capBytes`, which is already enough for
 * `grantWithoutInstall`'s own byte-length check to reject it -- the rest of
 * the body is never pulled at all. Falls back to `response.text()` only
 * when the runtime gives no readable stream to read incrementally from;
 * real Electron's `net.fetch` always does.
 */
export async function readCapped (response: Response, capBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader == null) return await response.text()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
      if (total > capBytes) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

async function fetchGrantManifest (url: string): Promise<{ ok: boolean, status: number, text: string }> {
  const response = await net.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(GRANT_MANIFEST_TIMEOUT_MS) })
  return { ok: response.ok, status: response.status, text: await readCapped(response, MAX_MANIFEST_BYTES) }
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
    // ADR-0037: an L4 site's grants read without warnings on every one of
    // these -- the developer-only override is the only source of L4 today
    // (../dev/score-levels.ts), always named as an override, never as
    // observed. reconsentPrompt/rollbackChoicePrompt take no level at all:
    // neither is about a grant's breadth.
    const consent = createInstallConsentPrompt(scoreLevelOverrideFor)
    const perCapabilityConsent = createPerCapabilityConsentPrompt(scoreLevelOverrideFor)
    const reconsentPrompt = createReconsentPrompt()
    const capabilityPrompt = createCapabilityPrompt(scoreLevelOverrideFor)
    const rollbackChoicePrompt = createRollbackChoicePrompt()
    publishInstallApp(ctx, async (hintingOrigin, hintedUrl) => {
      // A loopback origin can never reach installFromHint's own consent:
      // install-origin.ts refuses it for not being https and not being
      // public unicast, before a manifest is ever read. It is granted
      // without being installed instead (./grant-without-install.ts).
      if (grantableWithoutInstall(hintingOrigin, devModeEnabled())) {
        // F10: two tabs on the same loopback origin firing this near-
        // simultaneously used to run two grantWithoutInstall calls
        // interleaved -- registerApp and requestInstallConsent are not
        // written to tolerate a second call landing mid-flight, the same
        // reason installFromHint's own bundle path already serialises per
        // origin (A62). One queue, shared by name with the bundle path: an
        // origin can only ever be on ONE of the two paths at a time
        // (grantableWithoutInstall's own true/false split), so sharing the
        // queue costs nothing and closes the same race for both.
        const outcome = await withOriginQueue(hintingOrigin, async () => await grantWithoutInstall(
          { broker, fetchManifest: fetchGrantManifest, consent, perCapabilityConsent },
          hintingOrigin
        ))
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
