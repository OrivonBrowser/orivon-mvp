// Shared fixtures for ipc.test.ts, ipc-rate-limit.test.ts and
// socket-relay.test.ts -- all three test handleControlRequest/
// createSocketRelay against the same Broker/ControlEvent/PortLike/
// FailableTcpSocket shapes (code-guidelines.md Rule 3: the reason for reuse
// is that all three exercise the same seams, not a stylistic preference).

import { vi } from 'vitest'
import type { ControlEvent, PortLike, PortPair, PortTransport } from '../ipc.js'
import type { Broker } from '../../broker-contracts.js'
import { createPortRegistry } from '../port-registry.js'
import type { Grant, Manifest, OrivonError, OrivonErrorCode } from '../../../contracts/index.js'
import type { CloseReason, FailableTcpSocket } from '../../handles/handle-contracts.js'
import type { RequestEnvelope } from '../../../contracts/ipc.js'

export const APP = 'https://app.example'
export const OTHER = 'https://other.example'

/** A ControlEvent whose senderFrame resolves to `origin` via originFromSenderFrame. */
export function frameFor (origin: string): ControlEvent {
  return { senderFrame: { url: `${origin}/index.html`, origin, postMessage: vi.fn() } }
}

export const NO_FRAME: ControlEvent = { senderFrame: null }

export function envelope (method: string, payload: unknown, timeoutMs = 1_000): RequestEnvelope<unknown> {
  return { id: 'req-1', method, payload, timeoutMs }
}

/** A promise that never settles -- models a broker call still in flight when a timeout fires. */
export function never<T> (): Promise<T> {
  return new Promise<T>(() => {})
}

export interface BrokerCall { readonly method: string, readonly origin: string, readonly args: unknown }

/**
 * A full `Broker`, every method recording its call into `calls` before
 * deferring to `overrides` (or rejecting "not stubbed" if the test never
 * asked for that method to succeed). `grant`/`revoke` are unused by ipc.ts
 * -- see broker/index.ts's own doc on why they have no orivon.*
 * counterpart -- and are never expected to be called here.
 *
 * `registerApp`/`versionFloorFor`/`rollbackAcknowledgedVersionFor`/
 * `acknowledgeRollback` are ALSO unreachable via orivon.* (same reason), but
 * app-install.test.ts's `installFromHint` calls all four directly as the
 * app loader's own seam into the broker -- stubbable here rather than a
 * second full fake Broker (code-guidelines.md Rule 3).
 */
export function stubBroker (
  calls: BrokerCall[],
  overrides: Partial<{
    manifest: (origin: string) => Promise<Manifest>
    grants: (origin: string) => Promise<readonly Grant[]>
    connect: (origin: string, opts: { host: string, port: number }) => Promise<FailableTcpSocket>
    readFile: (origin: string, path: string) => Promise<Uint8Array>
    writeFile: (origin: string, path: string, data: Uint8Array) => Promise<void>
    registerApp: (origin: string, manifest: Manifest) => Promise<void>
    versionFloorFor: (origin: string) => Promise<string>
    rollbackAcknowledgedVersionFor: (origin: string) => Promise<string | undefined>
    acknowledgeRollback: (origin: string, version: string) => Promise<void>
  }> = {}
): Broker {
  const notStubbed = async (): Promise<never> => { throw new Error('this stub method was not configured for this test') }
  return {
    app: {
      manifest: async (origin) => {
        calls.push({ method: 'app.manifest', origin, args: undefined })
        return await (overrides.manifest?.(origin) ?? notStubbed())
      },
      grants: async (origin) => {
        calls.push({ method: 'app.grants', origin, args: undefined })
        return await (overrides.grants?.(origin) ?? notStubbed())
      }
    },
    net: {
      connect: async (origin, opts) => {
        calls.push({ method: 'net.connect', origin, args: opts })
        return await (overrides.connect?.(origin, opts) ?? notStubbed())
      },
      // Present so this stub still satisfies `Broker`; no test here drives it.
      // The udp control method is a separate change (see the PR stack).
      udpBind: async (origin, opts) => {
        calls.push({ method: 'net.udpBind', origin, args: opts })
        return await notStubbed()
      }
    },
    fs: {
      readFile: async (origin, path) => {
        calls.push({ method: 'fs.readFile', origin, args: path })
        return await (overrides.readFile?.(origin, path) ?? notStubbed())
      },
      writeFile: async (origin, path, data) => {
        calls.push({ method: 'fs.writeFile', origin, args: { path, data } })
        await (overrides.writeFile?.(origin, path, data) ?? notStubbed())
      }
    },
    registerApp: async (origin, manifest) => {
      calls.push({ method: 'registerApp', origin, args: manifest })
      await (overrides.registerApp?.(origin, manifest) ?? notStubbed())
    },
    versionFloorFor: async (origin) => {
      calls.push({ method: 'versionFloorFor', origin, args: undefined })
      return await (overrides.versionFloorFor?.(origin) ?? notStubbed())
    },
    rollbackAcknowledgedVersionFor: async (origin) => {
      calls.push({ method: 'rollbackAcknowledgedVersionFor', origin, args: undefined })
      return await (overrides.rollbackAcknowledgedVersionFor?.(origin) ?? notStubbed())
    },
    acknowledgeRollback: async (origin, version) => {
      calls.push({ method: 'acknowledgeRollback', origin, args: version })
      await (overrides.acknowledgeRollback?.(origin, version) ?? notStubbed())
    },
    grant: () => { throw new Error('grant is not reachable via orivon.* and should never be called here') },
    revoke: async () => { throw new Error('revoke is not reachable via orivon.* and should never be called here') }
  }
}

/**
 * A controllable in-memory PortLike -- captures every postMessage, lets a
 * test simulate the renderer sending a message back (`emit`), and lets a
 * test simulate the renderer's own side of the port closing (`simulateClose`).
 *
 * `postMessage` THROWS once `close()` has been called, matching a real
 * `MessagePortMain`'s own behaviour -- a fake that instead accepted a
 * postMessage after close silently would let a caller that keeps posting
 * to a closed port pass its tests while crashing the real Electron main
 * process the moment it ran for real.
 */
export function fakePort (): PortLike & { readonly sent: unknown[], emit: (message: unknown) => void, simulateClose: () => void, isClosed: () => boolean } {
  let listener: ((message: unknown) => void) | undefined
  let closeListener: (() => void) | undefined
  let closed = false
  const sent: unknown[] = []
  return {
    postMessage: (message) => {
      if (closed) throw new Error('Object has been destroyed')
      sent.push(message)
    },
    onMessage: (l) => { listener = l },
    onClose: (l) => { closeListener = l },
    close: () => { closed = true },
    sent,
    emit: (message) => { listener?.(message) },
    simulateClose: () => { closeListener?.() },
    isClosed: () => closed
  }
}

export function fakePortPair (): { readonly pair: PortPair, readonly port1: ReturnType<typeof fakePort> } {
  const port1 = fakePort()
  return { pair: { port1, port2: 'fake-port2' }, port1 }
}

/** A PortTransport whose createPortPair always returns the SAME pair -- fine for tests that make at most one net.connect call. */
export function fakeTransport (pair: PortPair): PortTransport {
  return { createPortPair: () => pair, registry: createPortRegistry() }
}

export interface FakeSocket {
  readonly socket: FailableTcpSocket
  readonly closeSpy: ReturnType<typeof vi.fn>
  readonly failSpy: ReturnType<typeof vi.fn>
  readonly abortSpy: ReturnType<typeof vi.fn>
  readonly settleClosed: (error?: OrivonError) => void
  /** Fires whatever the socket's consumer registered via `onUnlink`, the way HandleTable's own unlink pass does. Leaves `closed` pending, which is the case that matters. */
  readonly unlink: (reason: CloseReason, code?: OrivonErrorCode) => void
}

/**
 * A FailableTcpSocket whose `readable`/`writable` a test controls directly
 * and whose `closed` a test settles on demand -- close()/fail() themselves
 * settle it, the same way the real ones do (index.ts's connect()).
 */
export function fakeTcpSocket (
  readable: ReadableStream<Uint8Array> = new ReadableStream({ start: (c) => { c.close() } }),
  writable: WritableStream<Uint8Array> = new WritableStream()
): FakeSocket {
  let settle: (error?: OrivonError) => void = () => {}
  let settled = false
  let unlinkListener: ((reason: CloseReason, code?: OrivonErrorCode) => void) | undefined
  const closed = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      if (settled) return
      settled = true
      if (error === undefined) resolve(); else reject(error)
    }
  })
  const closeSpy = vi.fn(async () => { settle() })
  const failSpy = vi.fn((code: OrivonErrorCode, platformCode?: string) => {
    const err = { name: 'OrivonError', message: 'the handle failed', code, platformCode } as OrivonError
    settle(err)
  })
  const abortSpy = vi.fn(() => {
    const err = { name: 'OrivonError', message: 'the app aborted this handle', code: 'reset' as OrivonErrorCode } as OrivonError
    settle(err)
  })
  const socket: FailableTcpSocket = {
    id: 'handle-1',
    closed,
    close: closeSpy,
    fail: failSpy,
    abort: abortSpy,
    readable,
    writable,
    remoteAddress: '93.184.216.34',
    remotePort: 443,
    localAddress: '10.0.0.5',
    localPort: 54321,
    setNoDelay: async () => {},
    setKeepAlive: async () => {},
    onUnlink: (listener) => { unlinkListener = listener }
  }
  return {
    socket,
    closeSpy,
    failSpy,
    abortSpy,
    settleClosed: settle,
    unlink: (reason, code) => { unlinkListener?.(reason, code) }
  }
}

/** Lets a fire-and-forget pump/wiring chain progress before assertions run. */
export async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
