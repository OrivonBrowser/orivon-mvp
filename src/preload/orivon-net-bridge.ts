import { ipcRenderer } from 'electron'
import { PORT_CHANNEL } from '../main/channels.js'
import { createSocketBridge } from './socket-bridge.js'
import type { IpcRendererLike } from './socket-bridge.js'
import { createSocketPort, wrapPort } from './socket-port.js'
import type { PortLike } from './socket-port.js'
import { createDatagramPort } from './datagram-port.js'
import { createServerPort } from './server-port.js'
import type { AcceptedConnection } from './server-port.js'
import type { MainWorldServerBridge, MainWorldSocketBridge, MainWorldUdpBridge } from './main-world-bridges.js'
import { TIMEOUT_MS, call } from './orivon-call.js'

// The net.* bridge closures orivon-surface.ts's exposeOrivon() hands into
// the main world -- split out of that file under code-guidelines.md Rule 2
// (by concern: "how the net capability crosses the isolated-world/main-world
// boundary", separate from "which closures exist for app/fs/id" and the
// exposure wiring, which that file still owns).

/**
 * What `net.connect`'s CONTROL_CHANNEL reply actually carries -- deliberately
 * NOT imported from ../broker/transport/port-transport.ts's SocketDescriptor: this
 * directory's own README forbids importing src/broker/ at all (a preload
 * runs in the renderer process; broker logic cannot run there), so the
 * shape is repeated at this trust boundary rather than shared across it.
 */
interface SocketDescriptor {
  readonly id: string
  readonly remoteAddress: string
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number
}

/** `net.udpBind`'s reply. Repeated at this trust boundary for the same reason SocketDescriptor is. */
interface UdpSocketDescriptor {
  readonly id: string
  readonly localAddress: string
  readonly localPort: number
}

/** `net.listen`'s reply. Repeated at this trust boundary for the same reason SocketDescriptor is. */
interface TcpServerDescriptor {
  readonly id: string
  readonly localAddress: string
  readonly localPort: number
}

const socketBridge = createSocketBridge({ ipcRenderer: ipcRenderer as unknown as IpcRendererLike, portChannel: PORT_CHANNEL, wrapPort })

/**
 * The one net.connect closure handed into the main world. Correlates the
 * CONTROL_CHANNEL descriptor with its separately-delivered PORT_CHANNEL
 * port (socketBridge.waitForPort handles either arrival order), then wraps
 * that port in a SocketPort (./socket-port.ts) -- the whole per-socket state
 * machine main-world-socket.ts needs, plus the three control-channel
 * operations (close/setNoDelay/setKeepAlive) net.connect itself doesn't
 * expose.
 */
export async function netConnectBridge (opts: { host: string, port: number }): Promise<MainWorldSocketBridge> {
  const descriptor = await call<SocketDescriptor>('net.connect', opts, TIMEOUT_MS.net)
  try {
    return buildBridgeResult(descriptor, await socketBridge.waitForPort(descriptor.id))
  } catch (error) {
    // The broker already registered this socket against the concurrentSockets
    // cap the instant net.connect replied -- if anything after that fails
    // (most plausibly waitForPort's own 35s timeout racing a slow-but-real
    // dial), nothing else on this side ever tells it to release the slot.
    // Best-effort and fire-and-forget: this cleanup's own failure must not
    // shadow the real error the caller is about to see.
    call('net.close', { id: descriptor.id }, TIMEOUT_MS.net).catch(() => {})
    throw error
  }
}

/**
 * net.connectSecure's own bridge closure -- a SIBLING of netConnectBridge
 * above, not a second implementation: the CONTROL_CHANNEL method name is
 * the only difference. `net.connectSecure` resolves to the exact same
 * SocketDescriptor shape net.connect does (ipc.ts's deliverTcpSocket is
 * shared by both on the broker side), so buildBridgeResult below is reused
 * unchanged rather than copied (code-guidelines.md Rule 3).
 */
export async function netConnectSecureBridge (opts: { host: string, port: number }): Promise<MainWorldSocketBridge> {
  const descriptor = await call<SocketDescriptor>('net.connectSecure', opts, TIMEOUT_MS.net)
  try {
    return buildBridgeResult(descriptor, await socketBridge.waitForPort(descriptor.id))
  } catch (error) {
    // Same reasoning as netConnectBridge's own catch: release the slot the
    // broker already counted this socket against.
    call('net.close', { id: descriptor.id }, TIMEOUT_MS.net).catch(() => {})
    throw error
  }
}

function buildBridgeResult (descriptor: SocketDescriptor, port: PortLike): MainWorldSocketBridge {
  const socketPort = createSocketPort({ handleId: descriptor.id, port })

  return {
    id: descriptor.id,
    remoteAddress: descriptor.remoteAddress,
    remotePort: descriptor.remotePort,
    localAddress: descriptor.localAddress,
    localPort: descriptor.localPort,
    onData: socketPort.onData,
    onReadEnd: socketPort.onReadEnd,
    reportConsumed: socketPort.reportConsumed,
    write: socketPort.write,
    endWrite: socketPort.endWrite,
    abortWrite: socketPort.abortWrite,
    onFatal: socketPort.onFatal,
    closed: socketPort.closed,
    close: async () => {
      await call('net.close', { id: descriptor.id }, TIMEOUT_MS.net)
      socketPort.dispose()
    },
    setNoDelay: async (on) => { await call('net.setNoDelay', { id: descriptor.id, on }, TIMEOUT_MS.net) },
    setKeepAlive: async (on, initialDelayMs) => {
      // exactOptionalPropertyTypes: an explicit `initialDelayMs: undefined`
      // is not the same as omitting the key.
      const payload = initialDelayMs === undefined
        ? { id: descriptor.id, on }
        : { id: descriptor.id, on, initialDelayMs }
      await call('net.setKeepAlive', payload, TIMEOUT_MS.net)
    }
  }
}

/**
 * `net.udpBind`'s counterpart to netConnectBridge, and it correlates the same
 * two channels the same way -- ./socket-bridge.ts is kind-agnostic, so the
 * caller is what knows which kind of port it asked for.
 */
export async function netUdpBindBridge (opts: { port: number }): Promise<MainWorldUdpBridge> {
  const descriptor = await call<UdpSocketDescriptor>('net.udpBind', opts, TIMEOUT_MS.net)
  try {
    return buildUdpBridgeResult(descriptor, await socketBridge.waitForPort(descriptor.id))
  } catch (error) {
    // Same reasoning as netConnectBridge's: the broker counted this socket
    // against concurrentSockets the instant it replied, and nothing else on
    // this side would ever release the slot.
    call('net.close', { id: descriptor.id }, TIMEOUT_MS.net).catch(() => {})
    throw error
  }
}

/**
 * `net.listen`'s own bridge closure -- A114/d-0028's page-reachable half.
 * Correlates the two channels exactly as netUdpBindBridge does; unlike
 * that one, the "port" it correlates is not the socket's own bytes but the
 * SERVER's own accept-demand/AcceptedMessage channel (./server-port.ts).
 */
export async function netListenBridge (opts: { port: number }): Promise<MainWorldServerBridge> {
  const descriptor = await call<TcpServerDescriptor>('net.listen', opts, TIMEOUT_MS.net)
  try {
    return buildServerBridgeResult(descriptor, await socketBridge.waitForPort(descriptor.id))
  } catch (error) {
    // Same reasoning as netConnectBridge's/netUdpBindBridge's own catch: the
    // broker counted this server against concurrentSockets the instant it
    // replied, and nothing else on this side would ever release the slot.
    call('net.close', { id: descriptor.id }, TIMEOUT_MS.net).catch(() => {})
    throw error
  }
}

/**
 * Builds ONE accepted connection's own bridge -- reusing buildBridgeResult
 * unchanged (code-guidelines.md Rule 3): an accepted socket and a dialled
 * one are the same thing once accepted, so this just reshapes
 * AcceptedConnection's fields into the SocketDescriptor shape
 * buildBridgeResult already expects. `connection.port` is already a
 * ./socket-port.ts PortLike -- ./server-port.ts wrapped the raw transferred
 * MessagePort the instant its AcceptedMessage arrived.
 */
function buildAcceptedBridge (connection: AcceptedConnection): MainWorldSocketBridge {
  return buildBridgeResult(
    {
      id: connection.socketId,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
      localAddress: connection.localAddress,
      localPort: connection.localPort
    },
    connection.port
  )
}

function buildServerBridgeResult (descriptor: TcpServerDescriptor, port: PortLike): MainWorldServerBridge {
  const serverPort = createServerPort({ handleId: descriptor.id, port })

  return {
    id: descriptor.id,
    localAddress: descriptor.localAddress,
    localPort: descriptor.localPort,
    onConnection: (cb) => { serverPort.onAccepted((connection) => { cb(buildAcceptedBridge(connection)) }) },
    onReadEnd: serverPort.onReadEnd,
    reportAccepted: serverPort.reportAccepted,
    closed: serverPort.closed,
    close: async () => {
      await call('net.close', { id: descriptor.id }, TIMEOUT_MS.net)
      serverPort.dispose()
    }
  }
}

function buildUdpBridgeResult (descriptor: UdpSocketDescriptor, port: PortLike): MainWorldUdpBridge {
  const datagramPort = createDatagramPort({ handleId: descriptor.id, port })

  return {
    id: descriptor.id,
    localAddress: descriptor.localAddress,
    localPort: descriptor.localPort,
    onDatagram: datagramPort.onDatagram,
    onReadEnd: datagramPort.onReadEnd,
    onDropped: datagramPort.onDropped,
    onRefusal: datagramPort.onRefusal,
    onFatal: datagramPort.onFatal,
    reportConsumed: datagramPort.reportConsumed,
    send: datagramPort.send,
    closed: datagramPort.closed,
    close: async () => {
      await call('net.close', { id: descriptor.id }, TIMEOUT_MS.net)
      datagramPort.dispose()
    }
  }
}
