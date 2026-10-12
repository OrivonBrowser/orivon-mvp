// Who is told when the scheme a `.eth` name is shown with changed. Apart from verifier-subsystem.ts so that a screen
// which draws an address can listen without importing the subsystem and Electron with it.
const listeners = new Set<() => void>()

/** Called when the scheme a `.eth` name is shown with changed, so what shows its address can draw it again; returns the unsubscribe. */
export function onNameSchemeChange (listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function announceNameSchemeChange (): void {
  for (const listener of [...listeners]) listener()
}
