// One subscription to whichever share registry is bound, for the three things that draw from it (tab badges, the
// chip's state, the bar). The registry is bound by another installer, so the subscription is made on first use and
// moved when the binding changes.
import { onShareRegistryBound, shareRegistry } from '../bindings.js'
import type { ShareRegistry } from '../types.js'

const listeners = new Set<() => void>()
let bound: ShareRegistry | undefined
let unsubscribe: (() => void) | undefined

const fire = (): void => {
  for (const listener of [...listeners]) {
    try { listener() } catch (error) { console.error('[screen-share] an indicator failed to update:', error) }
  }
}

/** Follows the registry that is bound now. */
function follow (): void {
  const registry = shareRegistry()
  if (registry === bound) return
  unsubscribe?.()
  bound = registry
  unsubscribe = registry.onChange(fire)
}

/** Calls `listener` after any share starts or ends. Returns the removal. */
export function onShareChange (listener: () => void): () => void {
  listeners.add(listener)
  follow()
  return () => { listeners.delete(listener) }
}

/** The registry was bound or replaced: follow it and tell every listener to read again. */
export function shareRegistryRebound (): void {
  follow()
  fire()
}

onShareRegistryBound(shareRegistryRebound)
