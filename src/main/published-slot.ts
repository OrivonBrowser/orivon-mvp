// The one-time slot behind each field of `SubsystemContext` that a subsystem publishes. Split from registry.ts, which lists the fields.
import type { SubsystemContext } from './registry.js'

/**
 * One field on `SubsystemContext` that may be published exactly once.
 * `broker` and `loader` both need this guarantee for the same reason (Rule
 * 3): a second published value means two independently-constructed
 * instances disagreeing about one running app's state. Keyed by context
 * rather than stored as an ordinary field so the value can be exposed as a
 * get-only accessor -- a plain mutable field would let `ctx.broker = x`
 * compile, relying on every caller going through `publishBroker` by
 * convention alone.
 */
export function createPublishedSlot<T> (label: string, hazard: string): {
  get: (ctx: SubsystemContext) => T | undefined
  publish: (ctx: SubsystemContext, value: T) => void
} {
  const byContext = new WeakMap<SubsystemContext, T>()
  return {
    get: (ctx) => byContext.get(ctx),
    publish: (ctx, value) => {
      if (byContext.has(ctx)) throw new Error(`ctx.${label} is already published; ${hazard}`)
      byContext.set(ctx, value)
    }
  }
}

