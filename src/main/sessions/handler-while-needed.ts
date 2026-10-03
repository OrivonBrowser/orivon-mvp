// A web-request handler that exists on its owner only while something needs it. Every handler on the default
// session costs each matching request a round trip through the main process, so a control that is switched off
// should cost none. Tied to Electron only through the handle type.
import type { WebRequestHandlerHandle } from './web-request-owner.js'

export interface HandlerWhileNeeded {
  /** Registers the handler if it is needed and not yet registered, removes it if it is registered and no longer needed.
   * Synchronous, so a setting changed in a listener reaches the very next request. */
  readonly sync: () => void
}

export function handlerWhileNeeded (needed: () => boolean, register: () => WebRequestHandlerHandle): HandlerWhileNeeded {
  let handle: WebRequestHandlerHandle | null = null
  return {
    sync: () => {
      const wanted = needed()
      if (wanted && handle === null) {
        handle = register()
      } else if (!wanted && handle !== null) {
        handle.remove()
        handle = null
      }
    }
  }
}
