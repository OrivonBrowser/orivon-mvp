// Dialling for the routed network path, through the origin's socket
// allowance. `installRoutedDial` is SERIALISED into the main world (see
// ./routed-wire.ts's header) and publishes `dial` on the shared slot.
//
// A browser queues requests past its connection limit; it never fails them.
// So a dial refused with 'limit' waits in a FIFO queue and retries when a
// routed socket from this page closes, or after a short back-off (the
// allowance is per origin, and the rate limiter answers 'limit' too), up to a
// bounded wait. README.md's Design notes have the numbers.
import type { FetchRouteSocket, FetchRouteTarget, RoutedSlot, RoutedSocket } from './fetch-route-types.js'

/** Mirrors the literals `installRoutedDial` keeps inside its own body; see ./routed-wire.ts's ROUTED_MAX_HEAD_BYTES for why they exist twice. */
export const ROUTED_QUEUE_MAX_WAIT_MS = 120_000
export const ROUTED_LIMIT_RETRY_MS = 500

export function installRoutedDial (
  isAppTab: boolean,
  target: FetchRouteTarget = typeof window === 'undefined' ? {} : window as unknown as FetchRouteTarget
): void {
  if (!isAppTab) return
  const slot = (target as Record<symbol, RoutedSlot | undefined>)[Symbol.for('orivon.routed-network')]
  if (slot?.wire === undefined || target.orivon?.net === undefined) return
  // Fresh bindings, so the narrowing above holds inside every nested function.
  const wire = slot.wire
  const net = target.orivon.net

  const QUEUE_MAX_WAIT_MS = 120_000
  const LIMIT_RETRY_MS = 500

  /** Waiting dials, oldest first. Only the head is ever woken, so a freed slot costs one retry, not one per waiter. */
  const waiters: Array<{ wake: () => void }> = []
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  function wakeHead (): void {
    if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined }
    waiters[0]?.wake()
  }

  function armRetry (): void {
    if (retryTimer !== undefined || waiters.length === 0) return
    retryTimer = setTimeout(() => { retryTimer = undefined; waiters[0]?.wake() }, LIMIT_RETRY_MS)
  }

  function waitTurn (front: boolean, signal: AbortSignal | undefined, deadline: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const leave = (): void => {
        const at = waiters.indexOf(entry)
        if (at !== -1) waiters.splice(at, 1)
        clearTimeout(expiry)
        signal?.removeEventListener('abort', onAbort)
        if (at === 0) { if (retryTimer !== undefined) clearTimeout(retryTimer); retryTimer = undefined; armRetry() }
      }
      const entry = { wake: () => { leave(); resolve() } }
      const onAbort = (): void => { leave(); reject(wire.abortReason(signal)) }
      const expiry = setTimeout(() => {
        leave()
        reject(wire.networkError(`no connection slot came free within ${QUEUE_MAX_WAIT_MS} ms`))
      }, Math.max(0, deadline - Date.now()))
      if (front) waiters.unshift(entry)
      else waiters.push(entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      armRetry()
    })
  }

  /** Re-reads the live flag; a plain `signal?.aborted` check is narrowed to a stale value across awaits. */
  function aborted (signal: AbortSignal | undefined): boolean { return signal !== undefined && signal.aborted }

  function codeOf (error: unknown): string | undefined {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    return typeof code === 'string' ? code : undefined
  }

  function wrap (raw: FetchRouteSocket): RoutedSocket {
    const reader = raw.readable.getReader()
    const writer = raw.writable.getWriter()
    // Nothing else observes these; unobserved, an abrupt close would surface
    // as the page's own unhandledrejection.
    reader.closed.catch(() => {})
    writer.closed.catch(() => {})
    let closing: Promise<void> | undefined
    return {
      reader,
      write: async (bytes) => { await writer.write(bytes) },
      // The queue is woken only once the broker has released the socket, so
      // the retry it triggers finds the slot actually free.
      close: async () => { closing ??= raw.close().catch(() => {}).then(wakeHead); await closing }
    }
  }

  async function open (url: URL, signal: AbortSignal | undefined, firstHop: boolean): Promise<RoutedSocket | undefined> {
    const secure = url.protocol === 'https:'
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
    const port = url.port !== '' ? Number(url.port) : secure ? 443 : 80
    const deadline = Date.now() + QUEUE_MAX_WAIT_MS
    let queued = waiters.length > 0
    // A waiter refused again after its turn keeps the head of the queue; a
    // first refusal joins the back, so arrival order is kept.
    let woken = false
    for (;;) {
      if (queued) { await waitTurn(woken, signal, deadline); woken = true }
      if (aborted(signal)) throw wire.abortReason(signal)
      const dialling = (secure ? net.connectSecure : net.connect)({ host, port })
      try {
        const raw = await new Promise<FetchRouteSocket>((resolve, reject) => {
          const onAbort = (): void => { reject(wire.abortReason(signal)) }
          signal?.addEventListener('abort', onAbort, { once: true })
          dialling.then(resolve, reject).finally(() => { signal?.removeEventListener('abort', onAbort) })
        })
        return wrap(raw)
      } catch (error) {
        if (aborted(signal)) {
          dialling.then((late) => { void late.close().catch(() => {}).then(wakeHead) }, () => {})
          throw wire.abortReason(signal)
        }
        const code = codeOf(error)
        if (code === 'limit') { queued = true; continue }
        if (code === 'denied' && firstHop) return undefined
        throw wire.networkError(`${url.host} refused (${code ?? (error instanceof Error ? error.message : String(error))})`)
      }
    }
  }

  slot.dial = { open }
}
