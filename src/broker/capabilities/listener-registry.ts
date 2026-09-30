// Which TCP ports each origin holds a listener on, so `web.embed`'s local
// pattern (ADR-0047) can be answered synchronously. `net.ts` registers a
// listener when `orivon.net.listen` succeeds and drops it from the
// resource's own teardown, which every close path reaches: the app's
// `close`, a revoked or narrowed grant, and a listener that failed.

/** Built once by ../index.ts and handed to both `net.ts` (writes) and `embed.ts` (reads). */
export interface ListenerRegistry {
  /** Records `origin` (already canonical) as holding `port`; the returned function forgets it, and is safe to call twice. */
  readonly add: (origin: string, port: number) => () => void
  readonly holds: (origin: string, port: number) => boolean
  /**
   * Calls `listener(origin, port)` each time the count for a port reaches
   * zero, so a page shown from a listener that is gone can be closed
   * (ADR-0047). A listener that throws is skipped. Returns the unsubscribe.
   */
  readonly onLastForgotten: (listener: (origin: string, port: number) => void) => () => void
}

export function createListenerRegistry (): ListenerRegistry {
  // A count per port, not a flag: the operating system will not bind one
  // port twice, but a close and a fresh listen on the same port can overlap.
  const ports = new Map<string, Map<number, number>>()

  const subscribers = new Set<(origin: string, port: number) => void>()

  function announce (origin: string, port: number): void {
    for (const listener of [...subscribers]) {
      try {
        listener(origin, port)
      } catch {
        // One subscriber failing must not keep the others from hearing it.
      }
    }
  }

  function add (origin: string, port: number): () => void {
    const byPort = ports.get(origin) ?? new Map<number, number>()
    ports.set(origin, byPort)
    byPort.set(port, (byPort.get(port) ?? 0) + 1)
    let forgotten = false
    return () => {
      if (forgotten) return
      forgotten = true
      const left = (byPort.get(port) ?? 1) - 1
      if (left > 0) {
        byPort.set(port, left)
        return
      }
      byPort.delete(port)
      if (byPort.size === 0 && ports.get(origin) === byPort) ports.delete(origin)
      announce(origin, port)
    }
  }

  return {
    add,
    holds: (origin, port) => ports.get(origin)?.has(port) === true,
    onLastForgotten: (listener) => {
      subscribers.add(listener)
      return () => { subscribers.delete(listener) }
    }
  }
}
