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

import { net, session } from 'electron'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { publishAppUpdates, publishInstallApp } from '../registry.js'
import { publishFirstVisit, tabSetupNow } from '../app-setup/tab-setup-ref.js'
import { join } from 'node:path'
import { DeclinedApps, installDeclinedApps } from './declined-apps.js'
import { createFirstVisit } from './first-visit.js'
import { installFromHint } from './app-install.js'
import { createInstallConsentPrompt, createPerCapabilityConsentPrompt } from '../consent/install-consent-prompt.js'
import { createCapabilityPrompt, createReconsentPrompt, createRollbackChoicePrompt } from '../consent/update-outcomes-prompt.js'
import { createUpdatePrompts } from '../consent/update-offer-prompts.js'
import type { UpdateOutcomeDeps } from '../consent/update-outcomes.js'
import { createAppUpdates } from './app-updates.js'
import { dialogCallerFor } from './dialog-caller.js'
import { OPEN_TAB_CHECK_MS, startUpdateWatch } from './update-watch.js'
import { backgroundPinDelayMs, updateWatchMs } from '../verifier/test-seam.js'
import { grantableWithoutInstall, grantWithoutInstall } from './grant-without-install.js'
import { grantLocalFile } from './local-file-grant.js'
import { createLocalFileConsentPrompt } from '../consent/local-file-consent.js'
import { localFileApps } from '../local-files/local-file-apps.js'
import { localPartitionFor } from '../local-files/partition.js'
import type { DialogCaller } from '../consent/request-grant.js'
import { isLocalFileKey } from '../../broker/policy/origin.js'
import { defaultSessionGrantedOriginCsp, GRANTED_ORIGIN_CSP_FILTER } from './granted-origin-csp.js'
import { RUN_LAST, webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { devModeEnabled } from '../dev/dev-mode.js'
import { scoreLevelOverrideFor } from '../dev/score-levels.js'
import { extensionNamesForOrigin } from '../extensions/site-reach-runner.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { outsideOriginQueue, withOriginQueue } from './origin-queue.js'
import { blockOpenTabs } from '../app-setup/block-tabs.js'
import { pagesInPartitionOf } from '../app-setup/pages-in-partition.js'
import { MAX_MANIFEST_BYTES } from '../../loader/manifest/manifest.js'

const GRANT_MANIFEST_TIMEOUT_MS = 5_000

/**
 * Reads at most `capBytes` of `response`'s body, decoding only what was
 * actually read -- never the whole body first, so a compromised loopback
 * server naming an unbounded manifest is never read to completion in
 * memory. Stops reading (and cancels the stream) the moment the total
 * crosses `capBytes`, which is already enough for `grantWithoutInstall`'s
 * own byte-length check to reject it -- the rest of the body is never
 * pulled at all. Falls back to `response.text()` only when the runtime
 * gives no readable stream to read incrementally from; real Electron's
 * `net.fetch` always does.
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
  afterReady: (ctx: SubsystemContext): void | Promise<void> => {
    if (ctx.broker === undefined) {
      throw new Error('app-install subsystem requires ctx.broker -- check its position in subsystems.ts')
    }
    if (ctx.loader === undefined) {
      throw new Error('app-install subsystem requires ctx.loader -- check its position in subsystems.ts')
    }
    const broker = ctx.broker
    const loader = ctx.loader
    // One handler for every origin granted without installing, covering
    // whichever ones hold a grant at the time each response is answered --
    // no per-origin registration needed on top of it (granted-origin-csp.ts's
    // own header explains the mechanism; RUN_LAST so Orivon's policy is
    // applied after anything else on this session).
    webRequestOwnerFor(session.defaultSession).onHeadersReceived(RUN_LAST, GRANTED_ORIGIN_CSP_FILTER, () => true, defaultSessionGrantedOriginCsp(broker))
    // ADR-0037: an L4 site's grants read without warnings on every one of
    // these -- the developer-only override is the only source of L4 today
    // (../dev/score-levels.ts), always named as an override, never as
    // observed. reconsentPrompt/rollbackChoicePrompt take no level at all:
    // neither is about a grant's breadth.
    // The extensions disclosure (docs/planning/extensions-exploration.md), the same
    // shape ../consent/request-grant-subsystem.ts wires in.
    const extensionsOnSite = async (origin: string): Promise<readonly string[]> => {
      const extensions = ctx.extensions
      return extensions === undefined ? [] : await extensionNamesForOrigin(extensions, origin, isOriginServedFromCacheSync)
    }
    const consent = createInstallConsentPrompt(scoreLevelOverrideFor, extensionsOnSite)
    const perCapabilityConsent = createPerCapabilityConsentPrompt(scoreLevelOverrideFor, extensionsOnSite)
    const reconsentPrompt = createReconsentPrompt()
    const capabilityPrompt = createCapabilityPrompt(scoreLevelOverrideFor)
    const rollbackChoicePrompt = createRollbackChoicePrompt()
    const outcomeDeps: UpdateOutcomeDeps = { broker, loader, consent, perCapabilityConsent, reconsentPrompt, capabilityPrompt, rollbackChoicePrompt }
    // An installed app whose name moved is offered, never installed unasked (ADR-0056).
    const updates = createAppUpdates({
      outcome: outcomeDeps,
      verdictFor: async (id) => (await ctx.scoreVerdictFor?.(id)) ?? { status: 'off' },
      prompts: createUpdatePrompts(),
      reloadTabs: (origin) => { for (const tab of ctx.openTabs?.on(origin) ?? []) if (!tab.isDestroyed()) tab.reload() },
      persistQuiet: !ctx.privateSession
    })
    publishAppUpdates(ctx, updates)
    const installDeps: UpdateOutcomeDeps = {
      ...outcomeDeps,
      // Started outside the origin's queue: an unanswered question must not hold the queue the key's Update button needs.
      offerUpdate: async (result, caller) => {
        void outsideOriginQueue(async () => await updates.offered(result, caller)).catch((error: unknown) => { console.error('[app-updates] the update question failed', error) })
      },
      withdrawUpdate: updates.withdraw
    }
    // A name can move while a page stays open and no visit raises a hint for it: look again at every origin with an app tab open.
    startUpdateWatch({
      openOrigins: () => (ctx.openTabs?.origins() ?? []).filter((origin) => broker.app.isRegisteredSync(origin)),
      check: async (origin) => {
        // Only an app reached at a name moves without a visit; every other install is looked at on a visit.
        if ((await loader.pinFor(origin))?.content === undefined) return
        // The tab the person sees, so the question can be answered where it appears.
        const tab = ctx.openTabs?.on(origin)[0]
        await installFromHint(installDeps, origin, origin, tab === undefined ? undefined : dialogCallerFor(tab, (sender) => ctx.windowForSender?.(sender as never)), true)
      },
      intervalMs: updateWatchMs() ?? OPEN_TAB_CHECK_MS
    })
    // A page's first visit (ADR-0075): asks, lets the tab into the app at once with every file checked as it is served, and pins the app in the background. It
    // leaves alone the origins that never install: a local file, loopback and developer origins, anything not https.
    // The refusals are kept in `declined-apps.json`, and in memory only in a private session.
    const declined = new DeclinedApps(ctx.privateSession ? undefined : join(ctx.app.getPath('userData'), 'declined-apps.json'))
    installDeclinedApps(declined)
    const firstVisit = createFirstVisit({
      deps: { broker, loader, consent, perCapabilityConsent, capabilityPrompt, declined, blocked: blockOpenTabs({ tabsOn: (origin) => ctx.openTabs?.on(origin) ?? [], pagesOf: pagesInPartitionOf, setup: tabSetupNow }), askerFor: (origin) => { const tab = ctx.openTabs?.on(origin)[0]; return tab === undefined ? undefined : dialogCallerFor(tab, (sender) => ctx.windowForSender?.(sender as never)) }, backgroundDelayMs: backgroundPinDelayMs() },
      untouched: (origin) => isLocalFileKey(origin) || grantableWithoutInstall(origin, devModeEnabled()) || !origin.startsWith('https://'),
      servedFromCache: isOriginServedFromCacheSync
    })
    publishFirstVisit(firstVisit)
    const localFileConsent = createLocalFileConsentPrompt()
    const localFileRefusals = new Set<string>()
    publishInstallApp(ctx, async (hintingOrigin, hintedUrl, caller) => {
      // A file on this computer is no origin a loader can install or a server can vouch for: it is registered
      // against a manifest beside it and let use Orivon permissions by a double press (./local-file-grant.ts).
      if (isLocalFileKey(hintingOrigin)) {
        const records = localFileApps()
        if (records === undefined) return { outcome: 'rejected', reason: 'the record of local files is not available' }
        const inOwnSession = (asker: DialogCaller | undefined, key: string): boolean => {
          const partition = localPartitionFor(key)
          const contents = asker?.contents?.() as { session?: unknown } | undefined
          return partition !== undefined && contents?.session === session.fromPartition(partition)
        }
        const outcome = await withOriginQueue(hintingOrigin, async () => await grantLocalFile({ broker, records, consent: localFileConsent, inOwnSession, refused: localFileRefusals }, hintingOrigin, hintedUrl, caller))
        if (outcome.outcome === 'rejected') console.warn(`[app-install] permissions for a local file refused for ${hintingOrigin}: ${outcome.reason}`)
        return outcome
      }
      // A loopback origin can never reach installFromHint's own consent:
      // install-origin.ts refuses it for not being https and not being
      // public unicast, before a manifest is ever read. It is granted
      // without being installed instead (./grant-without-install.ts).
      if (grantableWithoutInstall(hintingOrigin, devModeEnabled())) {
        // Two tabs on the same loopback origin firing this near-
        // simultaneously must not run two grantWithoutInstall calls
        // interleaved -- registerApp and requestInstallConsent are not
        // written to tolerate a second call landing mid-flight, the same
        // reason installFromHint's own bundle path already serialises per
        // origin (A62). One queue, shared by name with the bundle path: an
        // origin can only ever be on ONE of the two paths at a time
        // (grantableWithoutInstall's own true/false split), so sharing the
        // queue costs nothing and closes the same race for both.
        const outcome = await withOriginQueue(hintingOrigin, async () => await grantWithoutInstall(
          { broker, fetchManifest: fetchGrantManifest, consent, perCapabilityConsent },
          hintingOrigin,
          caller
        ))
        if (outcome.outcome === 'rejected') {
          console.warn(`[app-install] grant without installing refused for ${hintingOrigin}: ${outcome.reason}`)
        }
        return outcome
      }
      const result = await installFromHint(installDeps, hintingOrigin, hintedUrl, caller)
      if (result.outcome === 'rejected') {
        console.warn(`[app-install] install refused for ${hintingOrigin}: ${result.reason}`)
      }
      return result
    })
    // An app allowed and not yet pinned is served again, checked, before any tab can ask for it (a restored tab included).
    return firstVisit.resume().catch((error: unknown) => { console.error('[app-install] apps allowed before a restart could not be served again', error) })
  }
}
