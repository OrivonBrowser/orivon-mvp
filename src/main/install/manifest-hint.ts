// The discovery trigger's main-side half: turns a reported <link
// rel="orivon-manifest"> hint (src/preload/manifest-hint.ts, over
// MANIFEST_HINT_CHANNEL) into a call to the app loader's already-built
// installFromHint (./app-install.ts) -- nothing else in this tree calls it
// yet (that file's own header).
//
// ORIGIN COMES FROM event.senderFrame, NEVER THE REPORTED HREF (T3,
// ../broker/policy/origin.ts's own warning). The reported href is only ever
// used as installFromHint's `hintedUrl` argument, which already refuses
// unless it resolves to EXACTLY the frame-derived origin (app-install.ts's
// own header: a hostile page could otherwise name an unrelated origin, its
// bank say, and have this read THAT origin's grants).
//
// RATE-LIMITED PER ORIGIN so a page reloading itself in a loop cannot turn
// one visit into an unbounded stream of loader.load() calls, each a real
// network fetch -- reuses ../broker/transport/token-bucket.ts's own
// RateLimiter rather than a second, bespoke cooldown (code-guidelines.md
// Rule 3: the reason, bounding call FREQUENCY per origin, is the exact one
// that file already exists for).

import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { MANIFEST_HINT_CHANNEL } from '../channels.js'
import { callerKeyFromSenderFrame, isAttributedSession } from '../../broker/policy/origin.js'
import type { SenderFrameLike } from '../../broker/policy/origin.js'
import type { LoadResult } from '../../loader/index.js'
import type { GrantedWithoutInstall } from './grant-without-install.js'
import { createTokenBucketLimiter } from '../../broker/transport/token-bucket.js'
import type { RateLimiter } from '../../broker/transport/token-bucket.js'
import { dialogCallerFor } from './dialog-caller.js'
import type { DialogCaller } from '../consent/request-grant.js'
import type { TabScreens } from '../app-setup/tab-screens.js'
import { firstVisitNow, tabSetupNow } from '../app-setup/tab-setup-ref.js'
import type { Subsystem, SubsystemContext } from '../registry.js'
import type { FirstVisit } from './first-visit.js'
import { hintHost } from './hint-host.js'

/** The one shape this file needs from an ipcMain.on event -- structural, matching origin.ts's own SenderFrameLike so a test never needs a real Electron event. */
export interface ManifestHintEvent {
  readonly senderFrame: SenderFrameLike | null
  /**
   * The tab that reported the hint, when the caller has one. Optional and
   * structural so a test drives this listener with a plain object, exactly
   * as `senderFrame` already is. `mainFrame` is `isAttributedSession`'s own
   * comparison; `session` is read by the injected `attributed` predicate
   * (../../broker/policy/origin.js).
   */
  readonly sender?: { reload: () => void, isDestroyed: () => boolean, mainFrame: SenderFrameLike | null, session: unknown, stop?: () => void, getURL?: () => string }
}

/** What the first visit of an app needs of the shell, each read at the moment of use: both are published after this listener is wired. */
export interface HintVisits {
  readonly firstVisit: () => FirstVisit | undefined
  /** The screens for the tab that reported a hint, or undefined for one no window holds. */
  readonly screensFor: (sender: object, address: string) => TabScreens | undefined
}

/** The one method this module needs from electron's real `IpcMain` for this channel -- structural, matching ../broker/transport/ipc.ts's own IpcMainLike/IpcMainOnLike, so a test double never needs the real type. */
/** The published `ctx.installApp` (registry.ts) -- the ONE install entry point, already closing over the real consent prompt. */
export type InstallApp = (hintingOrigin: string, hintedUrl: string, caller?: DialogCaller) => Promise<LoadResult | GrantedWithoutInstall>

export interface IpcMainOnLike {
  on: (channel: string, listener: (event: ManifestHintEvent, hintedUrl: unknown) => void) => void
}

// A legitimate page fires this AT MOST ONCE per navigation
// (src/preload/manifest-hint.ts's own "first hint wins" latch) -- capacity
// and refill only need to absorb a burst of GENUINE reloads (a flaky
// connection retried by hand, a dev server restarting), not defend a tight
// budget. AI recommendation, not an owner decision -- easy to retune
// without touching any call site.
const HINT_RATE_LIMIT_CAPACITY = 5
const HINT_RATE_LIMIT_REFILL_PER_SECOND = 1 / 10

/**
 * Builds the `ipcMain.on` listener -- one per running app, closing over its
 * own rate limiter and `installApp`. Exported on its own so a test can drive
 * it with a fake ManifestHintEvent and an injected limiter, without ever
 * touching `ipcMain` (see registerManifestHintIpc for the real wiring).
 *
 * TAKES THE PUBLISHED `ctx.installApp`, NEVER `AppInstallDeps`.
 * `AppInstallDeps.consent` is optional and fails closed when omitted, so a
 * listener that assembled its own `{ broker, loader }` and called
 * `installFromHint` directly could silently produce an install where every
 * declared capability reads as declined and no dialog ever appears.
 * Fail-safe, but indistinguishable from working. Taking the one published
 * function makes that shape unrepresentable rather than merely discouraged.
 */
export function createManifestHintListener (
  installApp: InstallApp,
  limiter: RateLimiter = createTokenBucketLimiter({
    capacity: HINT_RATE_LIMIT_CAPACITY,
    refillPerSecond: HINT_RATE_LIMIT_REFILL_PER_SECOND,
    now: () => Date.now()
  }),
  attributed?: (sender: unknown, origin: string) => boolean,
  windowForSender?: (sender: unknown) => unknown,
  visits?: HintVisits
): (event: ManifestHintEvent, hintedUrl: unknown) => void {
  return (event, hintedUrl) => {
    if (typeof hintedUrl !== 'string') return
    const origin = callerKeyFromSenderFrame(event.senderFrame)
    if (origin === null) return
    // Same check, same reason, as ../../broker/transport/ipc.ts's own
    // CONTROL_CHANNEL handler -- see isAttributedSession's doc
    // (../../broker/policy/origin.js).
    if (attributed !== undefined && !isAttributedSession(event.senderFrame, event.sender, origin, attributed)) return
    if (!limiter.tryConsume(origin)) return

    const caller = dialogCallerFor(event.sender, windowForSender)

    const install = (): void => { installLegacy(installApp, event, origin, hintedUrl, caller) }
    const visit = visits?.firstVisit()
    if (visit === undefined || event.sender === undefined) { install(); return }
    const sender = event.sender
    // A page reporting its hint is a first visit when Orivon has never held its origin (ADR-0074): the person is
    // asked, then the files are downloaded and checked, before the tab is let into the app.
    visit.kindOf(origin)
      .then(async (kind) => {
        if (kind === 'declined') { console.log(`[orivon] ${origin} was refused; it stays a plain website`); return }
        const screens = kind === 'first' ? visits?.screensFor(sender, sender.getURL?.() ?? hintedUrl) : undefined
        if (screens === undefined) { install(); return }
        const host = hintHost({ stop: () => { sender.stop?.() }, reload: () => { sender.reload() }, getURL: () => sender.getURL?.() ?? hintedUrl }, screens)
        const result = await visit.run(origin, hintedUrl, caller, host)
        if (result.outcome === 'known') install()
        else if (result.outcome !== 'entered') console.log(`[orivon] manifest hint from ${origin} did not install: ${result.outcome}`)
      })
      .catch((error: unknown) => {
        console.error('[orivon] the first visit threw unexpectedly for a manifest hint', origin, error)
      })
  }
}

/**
 * The install path for an origin Orivon already holds, and for every origin when the first visit is not
 * wired (ADR-0074 has the order for a first visit).
 */
function installLegacy (installApp: InstallApp, event: ManifestHintEvent, origin: string, hintedUrl: string, caller: DialogCaller): void {
  // installFromHint documents itself as never rejecting outside its own
  // exhaustiveness guard (app-install.ts's own header) -- caught anyway,
  // matching src/main/tabs.ts's captureFavicon: an ipcMain.on listener
  // that throws becomes an unhandled rejection nothing in this process
  // catches, and this channel is reachable from any ordinary tab.
  installApp(origin, hintedUrl, caller)
    .then((result) => {
      // Driving needs-reconsent/needs-capability-prompt/needs-rollback-
      // choice/rejected toward a user-visible outcome is a later lane's
      // job (this file's own header), not this one's -- but a real
      // outcome nobody acts on yet must still be visible, never silently
      // dropped.
      // ADR-0018: isolation follows consent. The app-tab flag and the
      // partition are both fixed when a view is built, so the tab that
      // reported this hint was built before its origin was registered and
      // is still an ordinary one, running without its shims. `tab-view.ts`'s
      // own did-navigate handler rebuilds it on the next navigation -- so
      // one reload is what turns it into the app tab the person just
      // installed or consented to. Only on a NEW registration: a
      // registered origin's tab already carries its flag, and reloading
      // it again would loop.
      // Only while the tab is still on the page that reported the hint: the
      // person may have gone elsewhere while the question was open, and
      // that page is not the one that was asked about.
      const reloadable = caller.stillOn(origin)
      if (result.outcome === 'granted-without-install') {
        console.log(`[orivon] granted ${origin} without installing (newly registered: ${String(result.newlyRegistered)}, reloading: ${String(result.newlyRegistered && reloadable)})`)
        if (result.newlyRegistered && reloadable) event.sender?.reload()
        return
      }
      if (result.outcome === 'installed') {
        if (result.newlyRegistered === true && reloadable) {
          console.log(`[orivon] installed ${origin}; reloading the tab that reported it so it runs as the app`)
          event.sender?.reload()
        }
        return
      }
      if (result.outcome !== 'up-to-date') console.log(`[orivon] manifest hint from ${origin} did not install: ${result.outcome}`)
    })
    .catch((error: unknown) => {
      console.error('[orivon] installFromHint threw unexpectedly for a manifest hint', origin, error)
    })
}

/** Thin wiring: one `ipcMain.on` registration over createManifestHintListener. */
export function registerManifestHintIpc (
  ipc: IpcMainOnLike,
  installApp: InstallApp,
  attributed?: (sender: unknown, origin: string) => boolean,
  windowForSender?: (sender: unknown) => unknown,
  visits?: HintVisits
): void {
  ipc.on(MANIFEST_HINT_CHANNEL, createManifestHintListener(installApp, undefined, attributed, windowForSender, visits))
}

/**
 * Registered in subsystems.ts AFTER both brokerIpcSubsystem and
 * loaderSubsystem (that file's own header: it reads ctx.broker AND
 * ctx.loader). Not critical -- registry.ts's own doc on Subsystem.critical:
 * an unwired discovery trigger leaves the browser exactly as usable as
 * without it, never a capability enforcing nothing.
 */
export const manifestHintSubsystem: Subsystem = {
  name: 'manifest-hint',
  afterReady: (ctx: SubsystemContext) => {
    if (ctx.installApp === undefined) {
      // appInstallSubsystem publishes it, and skips publishing when
      // ctx.loader is absent -- loaderSubsystem is not critical
      // (src/loader/subsystem.ts), so an absent loader means this run's
      // discovery trigger is simply disabled, not a bug to throw on
      // (src/loader/README.md). One check instead of two, because there is
      // now one thing this subsystem needs rather than two it assembles.
      console.warn('[orivon] ctx.installApp is undefined; the manifest-hint discovery trigger is disabled this run')
      return
    }
    // A lazy read of ctx.windowForSender, same reason as ../../broker/
    // transport/ipc.ts's own brokerIpcSubsystem wiring: it is published in
    // main/index.ts once the shell exists, well after this subsystem's
    // afterReady runs.
    registerManifestHintIpc(ipcMain, ctx.installApp, ctx.senderAttributed, (sender) => ctx.windowForSender?.(sender as WebContents), {
      firstVisit: firstVisitNow,
      screensFor: (sender, address) => tabSetupNow()?.(sender as WebContents, address)
    })
  }
}
