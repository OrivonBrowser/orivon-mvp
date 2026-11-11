// Whether Chromium's own resolver is held at this computer's DNS: the name relay holds it while it is active, so that none of
// Chromium's availability probes, which go straight to the Secure DNS provider, shows that provider this computer's address, and so
// that Orivon's own Quad9 check pauses. The installer of the privacy controls applies the choice again when the hold ends. Pure
// state: no `electron`.

let held = false
const listeners = new Set<() => void>()

export function resolverHeld (): boolean {
  return held
}

/** Holds the resolver, or lets the Secure DNS setting apply again; listeners hear of a change only. */
export function holdResolver (next: boolean): void {
  if (next === held) return
  held = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[privacy] applying the resolver hold failed:', error)
    }
  }
}

/** Calls `listener` whenever the hold starts or ends. Returns the call that removes it. */
export function onResolverHold (listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
