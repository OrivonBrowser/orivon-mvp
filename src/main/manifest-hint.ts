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
import { MANIFEST_HINT_CHANNEL } from './channels.js'
import { originFromSenderFrame } from '../broker/policy/origin.js'
import type { SenderFrameLike } from '../broker/policy/origin.js'
import { installFromHint } from './app-install.js'
import type { AppInstallDeps } from './app-install.js'
import { createTokenBucketLimiter } from '../broker/transport/token-bucket.js'
import type { RateLimiter } from '../broker/transport/token-bucket.js'
import type { Subsystem, SubsystemContext } from './registry.js'

/** The one shape this file needs from an ipcMain.on event -- structural, matching origin.ts's own SenderFrameLike so a test never needs a real Electron event. */
export interface ManifestHintEvent {
  readonly senderFrame: SenderFrameLike | null
}

/** The one method this module needs from electron's real `IpcMain` for this channel -- structural, matching ../broker/transport/ipc.ts's own IpcMainLike/IpcMainOnLike, so a test double never needs the real type. */
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
 * own rate limiter and `deps`. Exported on its own so a test can drive it
 * with a fake ManifestHintEvent and an injected limiter, without ever
 * touching `ipcMain` (see registerManifestHintIpc for the real wiring).
 */
export function createManifestHintListener (
  deps: AppInstallDeps,
  limiter: RateLimiter = createTokenBucketLimiter({
    capacity: HINT_RATE_LIMIT_CAPACITY,
    refillPerSecond: HINT_RATE_LIMIT_REFILL_PER_SECOND,
    now: () => Date.now()
  })
): (event: ManifestHintEvent, hintedUrl: unknown) => void {
  return (event, hintedUrl) => {
    if (typeof hintedUrl !== 'string') return
    const origin = originFromSenderFrame(event.senderFrame)
    if (origin === null) return
    if (!limiter.tryConsume(origin)) return

    // installFromHint documents itself as never rejecting outside its own
    // exhaustiveness guard (app-install.ts's own header) -- caught anyway,
    // matching src/main/tabs.ts's captureFavicon: an ipcMain.on listener
    // that throws becomes an unhandled rejection nothing in this process
    // catches, and this channel is reachable from any ordinary tab.
    installFromHint(deps, origin, hintedUrl)
      .then((result) => {
        // Driving needs-reconsent/needs-capability-prompt/needs-rollback-
        // choice/rejected toward a user-visible outcome is a later lane's
        // job (this file's own header), not this one's -- but a real
        // outcome nobody acts on yet must still be visible, never silently
        // dropped.
        if (result.outcome !== 'installed') {
          console.log(`[orivon] manifest hint from ${origin} did not install: ${result.outcome}`)
        }
      })
      .catch((error: unknown) => {
        console.error('[orivon] installFromHint threw unexpectedly for a manifest hint', origin, error)
      })
  }
}

/** Thin wiring: one `ipcMain.on` registration over createManifestHintListener. */
export function registerManifestHintIpc (ipc: IpcMainOnLike, deps: AppInstallDeps): void {
  ipc.on(MANIFEST_HINT_CHANNEL, createManifestHintListener(deps))
}

/**
 * Registered in subsystems.ts AFTER both brokerIpcSubsystem and
 * loaderSubsystem (that file's own header: it reads ctx.broker AND
 * ctx.loader). Not critical -- registry.ts's own doc on Subsystem.critical:
 * an unwired discovery trigger leaves the browser exactly as usable as
 * before this lane existed, never a capability enforcing nothing.
 */
export const manifestHintSubsystem: Subsystem = {
  name: 'manifest-hint',
  afterReady: (ctx: SubsystemContext) => {
    if (ctx.broker === undefined) {
      throw new Error('manifest-hint subsystem requires ctx.broker -- check its position in subsystems.ts')
    }
    if (ctx.loader === undefined) {
      // loaderSubsystem is not critical (src/loader/subsystem.ts) -- an
      // absent loader means this run's discovery trigger is simply
      // disabled, not a bug to throw on (src/loader/README.md).
      console.warn('[orivon] ctx.loader is undefined; the manifest-hint discovery trigger is disabled this run')
      return
    }
    registerManifestHintIpc(ipcMain, { broker: ctx.broker, loader: ctx.loader })
  }
}
