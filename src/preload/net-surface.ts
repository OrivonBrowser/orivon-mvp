// net.connect / net.connectSecure / net.udpBind's page-facing bridge
// closures, split out of ./orivon-surface.ts under code-guidelines.md Rule 2
// -- the net.* surface a `net.listen`/`net.lookup` lane would otherwise have
// grown alongside every other capability's code. See ./README.md's Design
// notes for the rest of this split.

import { ipcRenderer } from 'electron'
import { PORT_CHANNEL } from '../main/channels.js'
import { call, TIMEOUT_MS } from './control-call.js'
import { createSocketBridge } from './socket-bridge.js'
import type { IpcRendererLike } from './socket-bridge.js'
import { createSocketPort } from './socket-port.js'
import { createDatagramPort } from './datagram-port.js'
import type { PortLike } from './socket-port.js'
import type { MainWorldSocketBridge, MainWorldUdpBridge } from './main-world-socket.js'

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

/** Adapts a real (DOM) `MessagePort` -- Electron's own conversion of the transferred `MessagePortMain` -- to ./socket-port.ts's PortLike. */
function wrapPort (raw: unknown): PortLike {
  const port = raw as MessagePort
  return {
    postMessage: (message) => { port.postMessage(message) },
    // Assigning .onmessage (rather than addEventListener) implicitly starts
    // the port per the WHATWG spec -- no separate port.start() needed.
    onMessage: (listener) => { port.onmessage = (event) => { listener(event.data) } },
    close: () => { port.close() }
  }
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
 * SocketDescriptor shape net.connect does (../broker/transport/dispatch-net.ts's
 * deliverTcpSocket is shared by both on the broker side), so buildBridgeResult
 * below is reused unchanged rather than copied (code-guidelines.md Rule 3).
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
