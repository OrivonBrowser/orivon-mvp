// The page's own half of ADR-0046: the connection handshake
// (`../preload/expose-child-host-connect.ts` is the isolated-world other
// half) and the remote-Worker adapter `spawn.ts`'s `launchChild()` uses once
// connected. No `electron` import: everything here is `window.postMessage`
// and a real, cross-process `MessagePort` Electron already handed the page.

import type { FromWorker, ToWorker, WorkerLike } from '../worker/protocol.js'
import type { HostStart, StartChildMessage } from '../worker/host-protocol.js'

const CONNECT_MESSAGE_TYPE = 'orivon:child-host:connect'
const PORT_MESSAGE_TYPE = 'orivon:child-host:port'
const DEFAULT_TIMEOUT_MS = 2000

/** What this file needs from `window` -- structural, so a test never touches the one real
 * global environment (`spawn.ts`'s own reason for `launchChild()`'s injectable Worker factory). */
export interface WindowLike {
  readonly location: { readonly origin: string }
  postMessage (message: unknown, targetOrigin: string, transfer?: Transferable[]): void
  addEventListener (type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener (type: 'message', listener: (event: MessageEvent) => void): void
}

function realWindow (): WindowLike | undefined {
  return typeof window === 'undefined' ? undefined : window as unknown as WindowLike
}

/**
 * One connection attempt: asks `win` for its app's child host and resolves
 * with the page's own end of the port, or undefined where nothing ever
 * answers within `timeoutMs` -- a page outside Orivon, a Worker's own nested
 * children (no `window` there at all, so `win` is undefined before this
 * ever runs), or a unit test. Exported (rather than only `hostConnection`
 * below) so a test can pass a fake `win` and a short timeout without
 * fighting the real singleton's cache.
 */
export function requestHostConnection (win: WindowLike | undefined = realWindow(), timeoutMs = DEFAULT_TIMEOUT_MS): Promise<MessagePort | undefined> {
  if (win === undefined) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let settled = false
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== win || event.origin !== win.location.origin) return
      const data = event.data as { type?: unknown } | null
      if (typeof data !== 'object' || data === null || data.type !== PORT_MESSAGE_TYPE) return
      finish(event.ports[0])
    }
    const finish = (port: MessagePort | undefined): void => {
      if (settled) return
      settled = true
      win.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(port)
    }
    win.addEventListener('message', onMessage)
    win.postMessage({ type: CONNECT_MESSAGE_TYPE }, win.location.origin)
    const timer = setTimeout(() => { finish(undefined) }, timeoutMs)
  })
}

let cached: Promise<MessagePort | undefined> | undefined

/** For the host itself (`../worker/host.ts`): its own children, a `spawnSync` it serves included,
 * are local Workers, so it never waits out a handshake nothing there answers. */
export function preferLocalWorkers (): void {
  cached = Promise.resolve(undefined)
}

/** The page's own connection to its app's child host, requested once and cached for the page's
 * whole lifetime (a fresh document -- a reload included -- gets a fresh module instance, so
 * there is nothing to invalidate this on). */
export function hostConnection (): Promise<MessagePort | undefined> {
  cached ??= requestHostConnection()
  return cached
}

/**
 * A child routed through the host, behind the exact interface `ChildProcess` already uses for a
 * same-process Worker (`../worker/protocol.ts`'s `WorkerLike`): `postMessage`, `onmessage`,
 * `terminate`. `hostPort` gets one new `MessagePort`, transferred inside a `start-child` message
 * along with `start` and whatever else the real start message will need (`extra`: a thread's own
 * `parentPort`, and any `transferList` the app asked for) -- ADR-0046's "per page port: start
 * requests carry a per-child MessagePort".
 */
export function createRemoteWorker (hostPort: MessagePort, start: HostStart, extra: readonly Transferable[] = []): WorkerLike {
  const { port1: local, port2: remote } = new MessageChannel()
  local.start()

  const adapter: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message: ToWorker) => { local.postMessage(message) },
    // No wire member for this in ToWorker: a real Worker's own terminate() is
    // a platform call, never a message, everywhere else this protocol is
    // used -- host-protocol.ts's ToHostChild is what gives it one for this
    // one extra hop.
    terminate: () => { local.postMessage({ type: 'terminate' }) }
  }
  local.onmessage = (event: MessageEvent<FromWorker>) => { adapter.onmessage?.(event) }

  const message: StartChildMessage = { type: 'start-child', port: remote, start, extra }
  hostPort.postMessage(message, [remote, ...extra])

  return adapter
}
