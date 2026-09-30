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
}

export function createListenerRegistry (): ListenerRegistry {
  // A count per port, not a flag: the operating system will not bind one
  // port twice, but a close and a fresh listen on the same port can overlap.
  const ports = new Map<string, Map<number, number>>()

  function add (origin: string, port: number): () => void {
    const byPort = ports.get(origin) ?? new Map<number, number>()
    ports.set(origin, byPort)
    byPort.set(port, (byPort.get(port) ?? 0) + 1)
    let forgotten = false
    return () => {
      if (forgotten) return
      forgotten = true
      const left = (byPort.get(port) ?? 1) - 1
      if (left > 0) byPort.set(port, left)
      else byPort.delete(port)
      if (byPort.size === 0 && ports.get(origin) === byPort) ports.delete(origin)
    }
  }

  return { add, holds: (origin, port) => ports.get(origin)?.has(port) === true }
}
