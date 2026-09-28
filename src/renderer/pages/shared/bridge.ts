// The page's line to main: src/preload/internal.ts exposes it only when this
// document is the page the shell opened. What a page may ask is decided in
// main, on every call.

export interface OrivonInternal {
  readonly page: string
  request: (domain: string, command: unknown) => Promise<unknown>
  /** Returns the unsubscribe. */
  onEvent: (listener: (topic: string, payload: unknown) => void) => () => void
  readonly platform: string
}

declare global {
  interface Window {
    orivonInternal?: OrivonInternal
  }
}

/** A missing bridge means the preload did not run, not that the page is
 * unprivileged: a hard failure, like the other pages'. */
export function internalBridge (): OrivonInternal {
  const bridge = window.orivonInternal
  if (bridge === undefined) throw new Error('orivonInternal not exposed -- the preload did not run')
  return bridge
}
