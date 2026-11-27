// The turns the windows of one resolver take at its node, shared out between the calls that want them: the node answers a few windows at
// once, whatever the lookups waiting for them, and no call is kept waiting for all of its windows by another that asked first.

/** Who a window is read for: one lookup, with all the scans it needs. A call has the resolver's turns in common with every other call. */
export type Call = object

export const newCall = (): Call => ({})

/** The turns a resolver's windows take at the node. */
export interface Launcher {
  /** Resolves true when the call may let a window go, false when `until` came first, and rejects when the signal fires. */
  acquire: (call: Call, wait: { until: number, now: () => number, signal?: AbortSignal | undefined }) => Promise<boolean>
  /** Gives the turn back, when the window it was for has been answered or failed. */
  release: (call: Call) => void
}

interface Waiting { call: Call, order: number, grant: () => void }

/**
 * Lets at most `slots` windows go at once. A turn goes to the call holding the fewest windows, then to the one that has waited
 * longest: no call keeps another waiting for all of its windows.
 */
export function createLauncher (slots: number): Launcher {
  let open = 0
  let arrivals = 0
  const held = new Map<Call, number>()
  const waiting: Waiting[] = []

  const take = (call: Call): void => { open++; held.set(call, (held.get(call) ?? 0) + 1) }
  const goesBefore = (a: Waiting, b: Waiting): boolean => {
    const left = held.get(a.call) ?? 0
    const right = held.get(b.call) ?? 0
    return left !== right ? left < right : a.order < b.order
  }

  function pump (): void {
    while (open < slots && waiting.length > 0) {
      let best = 0
      for (let index = 1; index < waiting.length; index++) {
        if (goesBefore(waiting[index] as Waiting, waiting[best] as Waiting)) best = index
      }
      const [next] = waiting.splice(best, 1) as [Waiting]
      take(next.call)
      next.grant()
    }
  }

  return {
    acquire (call, { until, now, signal }) {
      signal?.throwIfAborted()
      if (open < slots && waiting.length === 0) {
        take(call)
        return Promise.resolve(true)
      }
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const entry: Waiting = {
          call,
          order: arrivals++,
          grant: () => { clearTimeout(timer); signal?.removeEventListener('abort', leave); resolve(true) }
        }
        const unqueue = (): boolean => { const at = waiting.indexOf(entry); if (at >= 0) waiting.splice(at, 1); return at >= 0 }
        function leave (): void { if (unqueue()) { clearTimeout(timer); reject(signal?.reason) } }
        waiting.push(entry)
        signal?.addEventListener('abort', leave, { once: true })
        if (until !== Infinity) timer = setTimeout(() => { if (unqueue()) { signal?.removeEventListener('abort', leave); resolve(false) } }, Math.max(0, until - now()))
      })
    },
    release (call) {
      open--
      const left = (held.get(call) ?? 1) - 1
      if (left <= 0) held.delete(call)
      else held.set(call, left)
      pump()
    }
  }
}
