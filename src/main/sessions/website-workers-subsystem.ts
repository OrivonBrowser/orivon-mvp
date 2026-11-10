// Wires `website-workers.ts` and `app-workers.ts` into the serving of an app that runs where its website ran: before the shell
// serves such an origin, the guard on its worker scripts is armed and the workers and response caches a website of that address
// installed are removed.

import { session } from 'electron'
import type { Session } from 'electron'
import { join } from 'node:path'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { AppNotReady } from '../../loader/electron/app-partitions.js'
import { beforeAppSessionServes, onAppOriginRetired } from '../../loader/electron/serve.js'
import { couldRunAsWebsite } from '../shell/app-session.js'
import type { Profile } from '../route/site-partition.js'
import { profilePartitionsHolding } from '../route/site-partition.js'
import { sitePartitionForOrigin } from '../route/site-routes.js'
import { guardWorkerScripts, releaseWorkerScripts } from './app-workers.js'
import { clearedOriginsIn, clearedOriginsInMemory, prepareWebsiteWorkers } from './website-workers.js'

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

export const websiteWorkersSubsystem: Subsystem = {
  name: 'website-workers',
  afterReady: (ctx: SubsystemContext): void => {
    const clearedWorkers = ctx.privateSession ? clearedOriginsInMemory() : clearedOriginsIn(join(ctx.app.getPath('userData'), 'website-workers-cleared'))
    onAppOriginRetired((origin) => { clearedWorkers.forget(origin); releaseWorkerScripts(origin) })
    beforeAppSessionServes(async (_appSession, origin, from) => {
      if (!couldRunAsWebsite(origin)) return
      // Before the website's workers go: from here a worker script the shell does not serve is refused, so none is registered between the removal and the serving.
      guardWorkerScripts(origin)
      try {
        await prepareWebsiteWorkers(websiteSessionsOf(origin, ctx.routes?.store), origin, from, clearedWorkers)
      } catch (error) {
        throw new AppNotReady('the workers a website of this address installed could not be removed', 'Open it again in a moment.', { cause: error })
      }
    })
  }
}
