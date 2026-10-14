// Tells the chrome that what it knows of an app's permissions may have changed: a first-visit question was dismissed,
// refused or given back, or a switch in the key popup moved. The chrome asks main again for the key's summary on every
// state push, so a change nothing else pushes for needs this one. No Electron.
const listeners = new Set<() => void>()

/** Calls `listener` on every announced change; returns the stop. */
export function onEntryChange (listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function announceEntryChange (): void {
  for (const listener of [...listeners]) listener()
}
