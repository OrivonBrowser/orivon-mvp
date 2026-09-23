import { describe, expect, it, vi } from 'vitest'

// net.connectSecure through the real preload wiring -- orivon-surface.ts's
// bridge closures, net-surface.ts's descriptor handling and installOrivon --
// with only `electron` mocked, the way ./orivon-surface.test.ts does it: the
// page's TLS options must reach CONTROL_CHANNEL as given, and the reply's
// handshake facts must land on the page's socket.

const invoke = vi.fn()
const on = vi.fn()
let executeInMainWorld: ReturnType<typeof vi.fn> | undefined

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: (...args: unknown[]) => on(...args),
    sendSync: vi.fn()
  },
  contextBridge: {
    exposeInMainWorld: vi.fn(),
    get executeInMainWorld () { return executeInMainWorld },
    set executeInMainWorld (fn) { executeInMainWorld = fn }
  }
}))

const { exposeOrivon } = await import('../orivon-surface.js')

// Registered once, at module load (socket-bridge.ts) -- captured before any reset.
const portListener = on.mock.calls.find(([channel]) => channel === 'orivon:port')?.[1] as
  ((event: { ports: unknown[] }, payload: unknown) => void) | undefined

function installViaFakeMainWorld (): Record<string, unknown> {
  const target: Record<string, unknown> = {}
  executeInMainWorld = vi.fn((opts: { func: (...args: unknown[]) => void, args: unknown[] }) => {
    opts.func(...opts.args, target)
  })
  return target
}

describe('net.connectSecure end to end through the preload', () => {
  it('sends the page\'s TLS options as given, and puts the reply\'s handshake facts on the socket', async () => {
    const target = installViaFakeMainWorld()
    const sent: unknown[] = []
    const peerCertificate = {
      subject: { CN: 'electrum.example' }, issuer: { CN: 'Private CA' }, valid_from: 'a', valid_to: 'b',
      serialNumber: '0A', fingerprint: 'AA', fingerprint256: 'BB', raw: new Uint8Array([48, 1])
    }
    invoke.mockImplementation(async (_channel: string, envelope: { method: string, payload: unknown }) => {
      if (envelope.method !== 'net.connectSecure') return { id: 'r', ok: true, result: undefined }
      sent.push(envelope.payload)
      return {
        id: 'r',
        ok: true,
        result: {
          id: 'sock-tls', remoteAddress: '93.184.216.34', remotePort: 50002, localAddress: '10.0.0.5', localPort: 4000,
          tls: { authorized: true, alpnProtocol: false, peerCertificate }
        }
      }
    })
    exposeOrivon()
    const orivon = target.orivon as { net: { connectSecure: (opts: unknown) => Promise<Record<string, unknown>> } }
    const options = { host: 'electrum.example', port: 50002, ca: 'PEM', servername: 'electrum.example', alpnProtocols: ['h2'] }

    const connecting = orivon.net.connectSecure(options)
    portListener?.({ ports: [{ postMessage: () => {}, onmessage: undefined, close: () => {} }] }, { handleId: 'sock-tls' })
    const socket = await connecting

    expect(sent).toEqual([options])
    expect(socket).toMatchObject({ id: 'sock-tls', authorized: true, alpnProtocol: false, peerCertificate })
    expect('authorizationError' in socket).toBe(false)
  })
})
