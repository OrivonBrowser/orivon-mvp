// Wires `website-workers.ts`, `app-workers.ts` and `worker-settle.ts` into the serving of an app that runs where its website ran:
// before the shell serves such an origin the guard on its worker scripts is armed and the workers a website of that address
// installed are removed; once it serves it, the origin settles (the host is told, the website's open pages load again, what they
// could have written goes), and only then does a worker's answer count as the app's.

import { rmSync } from 'node:fs'
import { session } from 'electron'
import type { Session, WebContents } from 'electron'
import { join } from 'node:path'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { AppNotReady, onServingChange, servedOrigins } from '../../loader/electron/app-partitions.js'
import { isCarryPageUrl } from '../../loader/electron/carry-page.js'
import { beforeAppSessionServes, onAppOriginRetired } from '../../loader/electron/serve.js'
import { couldRunAsWebsite, runsAsWebsite } from '../shell/app-session.js'
import { pagesOfOrigin } from '../app-setup/pages-of-origin.js'
import type { Profile } from '../route/site-partition.js'
import { profilePartitionsHolding } from '../route/site-partition.js'
import { sitePartitionForOrigin } from '../route/site-routes.js'
import { servedKnownToHost } from '../verifier/shell-serves.js'
import { guardWorkerScripts, releaseWorkerScripts } from './app-workers.js'
import { documentAnsweredByShell } from './session-attribution.js'
import { forNewlyServed, isEnteringPage, reloadStalePage } from './stale-pages.js'
import { CLEARED_MARKS_DIRECTORY, LEGACY_CLEARED_MARKS_DIRECTORY, clearedOriginsIn, clearedOriginsInMemory, forgetWebsiteWorkers, prepareWebsiteWorkers } from './website-workers.js'
import { beginSettling, forgetSettling, retryDelayMs, settleAttempts, settleServedOrigin } from './worker-settle.js'
import type { SettleLimits } from './worker-settle.js'

/** How long each wait of the settling may take before the origin stays unsettled and a worker's answer is denied the grants. Provisional: field reports of a slow host would settle it. */
const LIMITS: SettleLimits = { hostMs: 10_000, pageMs: 15_000, enteringMs: 10_000, clearMs: 15_000 }

/**
 * Every session a website at `origin` may have installed workers in: the shared one, the profile its own entry names, and any
 * profile it has storage in (a tab's choice put it there once). The workers of a website are cleared in all of them, since the
 * app runs in whichever of them the person's entry or a tab's choice picks.
 */
function websiteSessionsOf (origin: string, store: { isApart: (origin: string, profile: Profile) => boolean } | undefined): Session[] {
  const names = new Set<string>(store === undefined ? [] : profilePartitionsHolding(origin, (o, p) => store.isApart(o, p)))
  const own = sitePartitionForOrigin(origin)
  if (own !== undefined) names.add(own)
  return [session.defaultSession, ...[...names].map((name) => session.fromPartition(name))]
}

function originOfAddress (address: string): string | undefined {
  try {
    const { origin } = new URL(address)
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/** Loads `page` again and resolves once the new document has committed, or the page is gone. */
async function reloadAndWait (page: WebContents): Promise<void> {
  if (page.isDestroyed()) return
  await new Promise<void>((resolve) => {
    const done = (): void => { page.removeListener('did-navigate', done); page.removeListener('destroyed', done); resolve() }
    page.on('did-navigate', done)
    page.on('destroyed', done)
    reloadStalePage(page)
  })
}

/** Resolves once `page` no longer shows a document of `origin` (a first visit emptied it), or is gone. */
async function leftOrigin (page: WebContents, origin: string): Promise<void> {
  const left = (): boolean => page.isDestroyed() || originOfAddress(page.getURL()) !== origin
  if (left()) return
  await new Promise<void>((resolve) => {
    const check = (): void => { if (left()) { page.removeListener('did-navigate', check); page.removeListener('destroyed', check); resolve() } }
    page.on('did-navigate', check)
    page.on('destroyed', check)
  })
}

export const websiteWorkersSubsystem: Subsystem = {
  name: 'website-workers',
  afterReady: (ctx: SubsystemContext): void => {
    const userData = ctx.app.getPath('userData')
    // Marks an earlier build wrote say nothing about the guard: they are not read, and are removed.
    if (!ctx.privateSession) {
      try { rmSync(join(userData, LEGACY_CLEARED_MARKS_DIRECTORY), { recursive: true, force: true }) } catch { /* A mark that stays is never read. */ }
    }
    const clearedWorkers = ctx.privateSession ? clearedOriginsInMemory() : clearedOriginsIn(join(userData, CLEARED_MARKS_DIRECTORY))
    onAppOriginRetired((origin) => { clearedWorkers.forget(origin); releaseWorkerScripts(origin); forgetSettling(origin) })

    const settle = (origin: string): void => {
      settleServedOrigin<WebContents>(origin, {
        hostKnows: servedKnownToHost,
        pagesOf: pagesOfOrigin,
        // The hidden page of the storage carry is the shell's own: a reload would end the carry it is in the middle of.
        isOwnDocument: (page) => documentAnsweredByShell(page) || isCarryPageUrl(page.getURL()),
        isEntering: isEnteringPage,
        reload: reloadAndWait,
        leftDocument: async (page) => { await leftOrigin(page, originOfAddress(origin) ?? origin) },
        clear: async (target) => { for (const where of websiteSessionsOf(target, ctx.routes?.store)) await forgetWebsiteWorkers(where, target) },
        limits: LIMITS,
        log: (message, error) => { console.warn(message, error) }
      }).then((settled) => {
        if (settled || !servedOrigins().includes(origin)) return
        setTimeout(() => { settle(origin) }, retryDelayMs(settleAttempts(origin))).unref()
      }).catch((error: unknown) => { console.error('[workers] settling an origin failed:', error) })
    }
    forNewlyServed({ served: () => servedOrigins().filter(runsAsWebsite), onServingChange }, settle)

    beforeAppSessionServes(async (_appSession, origin, from) => {
      if (!couldRunAsWebsite(origin)) return
      // Before the website's workers go: from here a worker script the shell does not serve is refused, so none is registered between the removal and the serving, and no worker's answer counts until the origin settles.
      guardWorkerScripts(origin)
      beginSettling(origin)
      try {
        await prepareWebsiteWorkers(websiteSessionsOf(origin, ctx.routes?.store), origin, from, clearedWorkers)
      } catch (error) {
        throw new AppNotReady('the workers a website of this address installed could not be removed', 'Open it again in a moment.', { cause: error })
      }
    })
  }
}
