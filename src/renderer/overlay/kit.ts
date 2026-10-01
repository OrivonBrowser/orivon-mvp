// What an overlay page is written against. It reaches main only through the
// bridge the preload exposes (src/preload/overlay.ts), and touches no DOM at
// load, so the parts that decide what a failing page looks like are unit-tested.

/** What a page sees of its overlay. */
export interface Overlay {
  readonly name: string
  readonly platform: string
  /** Sends a command to this overlay's handler in main. The reply is whatever the handler returns, or undefined when it refuses. */
  request: <T = unknown>(command: unknown) => Promise<T>
  /** Events main sends with `overlays.send`. Returns the unsubscribe. */
  onEvent: (listener: (event: unknown) => void) => () => void
  close: () => void
  /** The page lost the window's focus and closes itself: main then treats a click that follows on the toolbar as the same gesture, not a new one. */
  closeOnBlur: () => void
}

export interface OverlayPage {
  /** Builds the page inside `root` and returns what to call on every show. The kit already reports height and closes on Escape. */
  mount: (root: HTMLElement, overlay: Overlay) => { shown: (payload: unknown) => void }
}

/** `window.orivonOverlay`, as src/preload/overlay.ts exposes it. */
export interface OverlayBridge {
  readonly name: string
  readonly platform: string
  ready: () => Promise<unknown>
  request: (command: unknown) => Promise<unknown>
  size: (height: number) => void
  close: (reason: 'request' | 'escape' | 'blur') => void
  onEvent: (listener: (message: unknown) => void) => () => void
}

declare global {
  interface Window {
    orivonOverlay?: OverlayBridge
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** An overlay that can also be handed events main held while the page loaded, which arrive with the first show. */
export interface ReplayableOverlay extends Overlay {
  replay: (events: readonly unknown[]) => void
}

export function createOverlay (bridge: OverlayBridge): ReplayableOverlay {
  const listeners = new Set<(event: unknown) => void>()
  return {
    name: bridge.name,
    platform: bridge.platform,
    request: async <T>(command: unknown): Promise<T> => await bridge.request(command) as T,
    onEvent: (listener) => {
      listeners.add(listener)
      const unsubscribe = bridge.onEvent((message) => {
        if (isRecord(message) && message['type'] === 'event') listener(message['event'])
      })
      return () => { listeners.delete(listener); unsubscribe() }
    },
    replay: (events) => {
      for (const event of events) {
        for (const listener of [...listeners]) {
          try { listener(event) } catch (error) { console.error(`[overlay] "${bridge.name}" failed on a held event`, error) }
        }
      }
    },
    close: () => { bridge.close('request') },
    closeOnBlur: () => { bridge.close('blur') }
  }
}

/** The events a `ready` reply carries, in the order they were sent. */
export function readyEvents (reply: unknown): unknown[] {
  return isRecord(reply) && Array.isArray(reply['events']) ? reply['events'] : []
}

/** The payload of a `{ type: 'show', payload }` message, or of a `ready` reply that carries a waiting show. */
export function shownPayload (message: unknown, type: 'show' | 'ready'): { payload: unknown } | null {
  if (!isRecord(message)) return null
  if (type === 'show') return message['type'] === 'show' ? { payload: message['payload'] } : null
  return message['shown'] === true ? { payload: message['payload'] } : null
}

/**
 * Mounts `page` into `root` so that a page that throws, while mounting or on
 * a later show, leaves a small error state and never a blank overlay. The
 * error state replaces the page's nodes, so the next show clears the root and
 * builds the page again rather than staying broken for the rest of the
 * view's life (a menu view is kept warm across many opens).
 */
export function mountPage (
  page: OverlayPage | undefined,
  root: HTMLElement,
  overlay: Overlay,
  showError: (root: HTMLElement) => void
): { shown: (payload: unknown) => void } {
  const fail = (error: unknown): void => {
    console.error(`[overlay] page "${overlay.name}" failed`, error)
    try { showError(root) } catch (again) { console.error('[overlay] the error state failed too', again) }
  }
  if (page === undefined) {
    fail(new Error('no page is registered for this overlay'))
    return { shown: () => {} }
  }
  let mounted: { shown: (payload: unknown) => void } | undefined
  const build = (): void => {
    try {
      mounted = page.mount(root, overlay)
    } catch (error) {
      mounted = undefined
      fail(error)
    }
  }
  build()
  return {
    shown (payload) {
      if (mounted === undefined) {
        root.replaceChildren()
        build()
        if (mounted === undefined) return
      }
      try { mounted.shown(payload) } catch (error) {
        mounted = undefined
        fail(error)
      }
    }
  }
}
