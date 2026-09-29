// Registers ADR-0046 into the running app: the page tracker watches every
// real page from the moment the process starts, and the one channel a
// tab's preload asks on to reach its app's child host.

import { app, ipcMain } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { CHILD_HOST_CONNECT_CHANNEL } from '../channels.js'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { createChildHostPool } from './child-host.js'
import { createPageTracker } from './page-tracker.js'
import { watchPages } from './watch-pages.js'
import { createChildHostRegistry } from './registry.js'

export const childrenSubsystem: Subsystem = {
  name: 'children',
  afterReady: (ctx: SubsystemContext) => {
    const getBroker = (): Broker => {
      if (ctx.broker === undefined) throw new Error('children subsystem requires ctx.broker -- check its position in subsystems.ts')
      return ctx.broker
    }

    const tracker = createPageTracker()
    watchPages(app, tracker)

    const pool = createChildHostPool(getBroker)
    const registry = createChildHostRegistry(getBroker, pool, tracker, () => ctx.senderAttributed)

    // F5: an uncaught rejection here reaches index.ts's own
    // `unhandledRejection` handler, which is `app.exit(1)` -- the whole
    // browser, for a failure as ordinary as the host's first document load
    // losing a race with the app quitting. `registry.connect` itself never
    // rejects for anything a page could trigger (README.md's own sender
    // check), only for a build or a delivery that failed.
    ipcMain.on(CHILD_HOST_CONNECT_CHANNEL, (event) => {
      registry.connect(event).catch((error: unknown) => { console.error('[children] a child-host connect failed', error) })
    })
    // Every host this process ever opened, whatever origin: nothing may
    // outlive the process (ADR-0046's own scope is one running app).
    app.on('before-quit', () => { void registry.closeAll() })
  }
}
