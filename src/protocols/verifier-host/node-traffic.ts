// What the verifier host has read from one local node this session: how many reads are in flight and how many bytes
// came back. Counted where the host reads (node-link.ts) and posted to main at most once a second, so a popup that
// shows it costs the host nothing while nobody looks.

/** The reports are at least this far apart. */
export const TRAFFIC_EVERY_MS = 1_000

export interface TrafficSnapshot {
  readonly active: number
  readonly bytes: number
}

export interface NodeTraffic {
  /** A read starts. */
  begin: () => void
  /** A read ended without a response (it failed or was aborted). */
  end: () => void
  /** The response of a read that began: its body is counted as it is read, and the read ends with the body. */
  wrap: (response: Response) => Response
  snapshot: () => TrafficSnapshot
}

export interface TrafficOptions {
  readonly now?: () => number
  /** Runs `callback` once the interval has passed. */
  readonly later?: (callback: () => void, ms: number) => void
}

export function createNodeTraffic (report: (active: number, bytes: number) => void, options: TrafficOptions = {}): NodeTraffic {
  const now = options.now ?? Date.now
  const later = options.later ?? ((callback, ms) => { setTimeout(callback, ms).unref() })
  let active = 0
  let bytes = 0
  let reportedAt = Number.NEGATIVE_INFINITY
  let scheduled = false

  const send = (): void => {
    reportedAt = now()
    report(active, bytes)
  }
  const changed = (): void => {
    if (now() - reportedAt >= TRAFFIC_EVERY_MS) { send(); return }
    if (scheduled) return
    scheduled = true
    later(() => { scheduled = false; send() }, TRAFFIC_EVERY_MS)
  }
  const end = (): void => {
    active = Math.max(0, active - 1)
    changed()
  }

  return {
    begin: () => { active += 1; changed() },
    end,
    snapshot: () => ({ active, bytes }),
    wrap: (response) => {
      if (response.body === null) { end(); return response }
      const reader = response.body.getReader()
      let finished = false
      const finish = (): void => { if (!finished) { finished = true; end() } }
      const counted = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            const chunk = await reader.read()
            if (chunk.done) { controller.close(); finish(); return }
            bytes += chunk.value.byteLength
            controller.enqueue(chunk.value)
          } catch (error) {
            finish()
            controller.error(error)
          }
        },
        cancel: async (reason) => { finish(); await reader.cancel(reason) }
      })
      const wrapped = new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers })
      // `url` and `redirected` are read-only properties of a response made by `fetch`; a reader of the node's answers may ask where it came from.
      Object.defineProperty(wrapped, 'url', { value: response.url })
      Object.defineProperty(wrapped, 'redirected', { value: response.redirected })
      return wrapped
    }
  }
}
