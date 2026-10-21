// The dials a page may still abandon (ADR-0071): `net.connect` and `net.connectSecure` calls that have not answered yet,
// found again by the id of their request. A page's request ids are small counters of its own, so a call is looked up by the
// frame that sent it and the origin derived for it as well, and a frame can cancel only a call it began.

export interface PendingDial {
  /** Aborts when the page cancels this call. */
  readonly signal: AbortSignal
  /** Forgets the call once it has answered or failed. */
  readonly end: () => void
}

export interface PendingDials {
  begin: (frame: object, origin: string, requestId: string) => PendingDial
  /** A no-op for a call nobody began, one that has ended, and one another frame or origin began. */
  cancel: (frame: object, origin: string, requestId: string) => void
}

export function createPendingDials (): PendingDials {
  const byFrame = new WeakMap<object, Map<string, AbortController>>()
  const keyOf = (origin: string, requestId: string): string => `${origin}\n${requestId}`

  return {
    begin: (frame, origin, requestId) => {
      let calls = byFrame.get(frame)
      if (calls === undefined) { calls = new Map(); byFrame.set(frame, calls) }
      const controller = new AbortController()
      const key = keyOf(origin, requestId)
      calls.set(key, controller)
      const table = calls
      return {
        signal: controller.signal,
        end: () => { if (table.get(key) === controller) table.delete(key) }
      }
    },
    cancel: (frame, origin, requestId) => {
      byFrame.get(frame)?.get(keyOf(origin, requestId))?.abort()
    }
  }
}
