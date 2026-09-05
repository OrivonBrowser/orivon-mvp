import type { PortLike } from './socket-port.js'

// The only file in this directory touching ipcRenderer.on(PORT_CHANNEL).
// Solves one problem: net.connect's CONTROL_CHANNEL reply (a
// SocketDescriptor) and PORT_CHANNEL's port delivery for the same handle
// travel over two different Electron channels, and Electron gives no
// ordering guarantee between them (../broker/ipc.ts sends the port via
// senderFrame.postMessage before returning its own reply, but nothing on
// this side may assume that arrives first). Both orders are handled.
//
// ORPHAN SAFETY, BOTH DIRECTIONS: a port that arrives and is never claimed
// (its own net.connect() caller already gave up locally, e.g. its
// CONTROL_CHANNEL invoke() timed out first) is closed once waitTimeoutMs
// elapses, not held forever. A waiter that is never delivered a port
// rejects the same way, rather than hanging the caller indefinitely --
// contracts/ipc.ts's own rule 2, applied to a channel that carries no
// timeoutMs field of its own.

/** The one method this module needs from Electron's real `IpcRenderer`. Structural, so a test double never needs the real type. */
export interface IpcRendererLike {
  on: (channel: string, listener: (event: { readonly ports?: readonly unknown[] }, payload: unknown) => void) => void
}

export interface SocketBridgeOptions {
  readonly ipcRenderer: IpcRendererLike
  readonly portChannel: string
  /** Adapts a real (DOM) `MessagePort` -- Electron's own conversion of the transferred `MessagePortMain` -- to this module's PortLike. */
  readonly wrapPort: (raw: unknown) => PortLike
  readonly waitTimeoutMs?: number
}

export interface SocketBridge {
  /** Resolves with the port for `handleId`, however it arrives -- already here, or later. */
  waitForPort: (handleId: string) => Promise<PortLike>
}

const DEFAULT_WAIT_TIMEOUT_MS = 35_000

export function createSocketBridge (options: SocketBridgeOptions): SocketBridge {
  const { ipcRenderer, portChannel, wrapPort, waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = options

  const arrived = new Map<string, PortLike>()
  const arrivedTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const waiters = new Map<string, { resolve: (port: PortLike) => void }>()

  ipcRenderer.on(portChannel, (event, payload) => {
    const handleId = (payload as { handleId?: unknown }).handleId
    if (typeof handleId !== 'string') return
    const raw = event.ports?.[0]
    if (raw === undefined) return
    const port = wrapPort(raw)

    const waiter = waiters.get(handleId)
    if (waiter !== undefined) {
      waiters.delete(handleId)
      waiter.resolve(port)
      return
    }
    arrived.set(handleId, port)
    arrivedTimers.set(handleId, setTimeout(() => {
      arrivedTimers.delete(handleId)
      if (arrived.delete(handleId)) port.close()
    }, waitTimeoutMs))
  })

  return {
    waitForPort (handleId) {
      const existing = arrived.get(handleId)
      if (existing !== undefined) {
        arrived.delete(handleId)
        const timer = arrivedTimers.get(handleId)
        if (timer !== undefined) { clearTimeout(timer); arrivedTimers.delete(handleId) }
        return Promise.resolve(existing)
      }
      return new Promise<PortLike>((resolve, reject) => {
        waiters.set(handleId, { resolve })
        setTimeout(() => {
          if (waiters.delete(handleId)) {
            reject(new Error(`no port delivered for handle ${handleId} within ${waitTimeoutMs}ms`))
          }
        }, waitTimeoutMs)
      })
    }
  }
}
