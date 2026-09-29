// Publishes ctx.sessionForOrigin (registry.ts) -- the one answer to "which
// Electron session does this origin's documents belong in" every
// renderer-reachable broker channel needs before it may trust a frame's own
// claimed origin. Split into its own subsystem, listed before
// brokerIpcSubsystem in subsystems.ts, because the broker itself cannot
// compute this answer: it needs the loader's bundle-cache state
// (isOriginServedFromCacheSync), and src/broker/ must never import
// src/loader/ (../../broker/README.md). ../shell/tab-view.ts's
// partitionForTarget already combines the same two facts for a navigating
// tab; this reuses it rather than re-deriving the rule a second time.
import { session } from 'electron'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { publishSessionForOrigin } from '../registry.js'
import { partitionForTarget } from '../shell/tab-view.js'

/**
 * `ctx` is captured, not `ctx.broker` -- this runs before brokerIpcSubsystem
 * publishes it, and the closure below is only ever called later, once a
 * real request needs an answer, by which point it is there.
 */
export const sessionAttributionSubsystem: Subsystem = {
  name: 'session-attribution',
  afterReady: (ctx: SubsystemContext) => {
    publishSessionForOrigin(ctx, (origin) => {
      const partition = partitionForTarget(origin, ctx.broker)
      return partition === undefined ? session.defaultSession : session.fromPartition(partition)
    })
  }
}
