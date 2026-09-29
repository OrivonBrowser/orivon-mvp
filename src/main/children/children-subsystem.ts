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
    const registry = createChildHostRegistry(getBroker, pool, tracker)

    ipcMain.on(CHILD_HOST_CONNECT_CHANNEL, (event) => { void registry.connect(event) })
    // Every host this process ever opened, whatever origin: nothing may
    // outlive the process (ADR-0046's own scope is one running app).
    app.on('before-quit', () => { void registry.closeAll() })
  }
}
