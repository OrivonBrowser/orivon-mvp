// Event plumbing shared by the routed XMLHttpRequest and EventSource:
// `on*` handler attributes, and re-dispatching a native delegate's events on
// the object the page holds. `installRoutedEvents` is SERIALISED into the
// main world (see ./wire.ts's header) and publishes `events` on the
// shared slot.
import type { FetchRouteTarget, RoutedSlot } from './types.js'

export function installRoutedEvents (
  isAppTab: boolean,
  target: FetchRouteTarget = typeof window === 'undefined' ? {} : window as unknown as FetchRouteTarget
): void {
  if (!isAppTab) return
  const slot = (target as Record<symbol, RoutedSlot | undefined>)[Symbol.for('orivon.routed-network')]
  if (slot === undefined) return

  const handlers = new WeakMap<EventTarget, Map<string, { value: unknown }>>()

  function getHandler (owner: EventTarget, type: string): unknown {
    return handlers.get(owner)?.get(type)?.value ?? null
  }

  /** An event-handler attribute: its listener is registered at the first assignment, so it keeps its place among addEventListener listeners, as the platform's does. */
  function setHandler (owner: EventTarget, type: string, value: unknown): void {
    let map = handlers.get(owner)
    if (map === undefined) { map = new Map(); handlers.set(owner, map) }
    let entry = map.get(type)
    if (entry === undefined) {
      const slotEntry = { value: null as unknown }
      entry = slotEntry
      map.set(type, slotEntry)
      owner.addEventListener(type, (event) => {
        const handler = slotEntry.value
        if (typeof handler === 'function') handler.call(owner, event)
        else if (typeof handler === 'object' && handler !== null && typeof (handler as EventListenerObject).handleEvent === 'function') (handler as EventListenerObject).handleEvent(event)
      })
    }
    entry.value = typeof value === 'function' || (typeof value === 'object' && value !== null) ? value : null
  }

  function copy (event: Event): Event {
    if (typeof MessageEvent === 'function' && event instanceof MessageEvent) {
      return new MessageEvent(event.type, { data: event.data, origin: event.origin, lastEventId: event.lastEventId })
    }
    if (typeof ProgressEvent === 'function' && event instanceof ProgressEvent) {
      return new ProgressEvent(event.type, { lengthComputable: event.lengthComputable, loaded: event.loaded, total: event.total })
    }
    return new Event(event.type)
  }

  function forward (from: EventTarget, to: EventTarget, types: readonly string[], accept?: (event: Event) => boolean): () => void {
    const listener = (event: Event): void => {
      if (accept === undefined || accept(event)) to.dispatchEvent(copy(event))
    }
    for (const type of types) from.addEventListener(type, listener)
    return () => { for (const type of types) from.removeEventListener(type, listener) }
  }

  slot.events = { getHandler, setHandler, forward }
}
