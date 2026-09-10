import { beforeEach, describe, expect, it, vi } from 'vitest'

// orivon-surface.ts imports `contextBridge`/`ipcRenderer` directly from
// 'electron' at module scope (including a module-load-time
// `ipcRenderer.on(PORT_CHANNEL, ...)` call in socket-bridge.ts) -- outside a
// real Electron process, requiring 'electron' from plain Node returns a
// path string, not this shape, so the module cannot even be imported
// without mocking it first.
const invoke = vi.fn()
const on = vi.fn()
const sendSync = vi.fn()
let executeInMainWorld: ReturnType<typeof vi.fn> | undefined
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: (...args: unknown[]) => on(...args),
    sendSync: (...args: unknown[]) => sendSync(...args)
  },
  contextBridge: {
    exposeInMainWorld: (...args: unknown[]) => exposeInMainWorld(...args),
    get executeInMainWorld () { return executeInMainWorld },
    set executeInMainWorld (fn) { executeInMainWorld = fn }
  }
}))

const { exposeOrivon } = await import('../orivon-surface.js')

// socket-bridge.ts registers its PORT_CHANNEL listener exactly ONCE, at
// module load (orivon-surface.ts's module-level `createSocketBridge(...)`
// call, above) -- before any test's `beforeEach` runs. Capture it here,
// once, rather than searching `on.mock.calls` per test: `on.mockReset()`
// below wipes that call history on every test, but a listener reference
// captured now survives.
const portListener = on.mock.calls.find(([channel]) => channel === 'orivon:port')?.[1] as
  ((event: { ports: unknown[] }, payload: unknown) => void) | undefined

/**
 * Simulates a real executeInMainWorld: actually calls `installOrivon` (the
 * real one, via `func`) with a captured plain object as `target`, so the
 * resulting `orivon.net.connect` is the real wiring under test -- not a
 * mock standing in for it.
 */
function installViaFakeMainWorld (): Record<string, unknown> {
  const target: Record<string, unknown> = {}
  executeInMainWorld = vi.fn((opts: { func: (...args: unknown[]) => void, args: unknown[] }) => {
    opts.func(...opts.args, target)
  })
  return target
}

function okEnvelope (result: unknown): { id: string, ok: true, result: unknown } {
  return { id: 'r', ok: true, result }
}

beforeEach(() => {
  invoke.mockReset()
  on.mockReset()
  sendSync.mockReset()
  exposeInMainWorld.mockReset()
  executeInMainWorld = undefined
})

describe('exposeOrivon -- P-F10: the fail-closed fallback covers BOTH "absent" and "throws"', () => {
  it('falls back to exposeInMainWorld (no net) when executeInMainWorld is absent', () => {
    executeInMainWorld = undefined

    exposeOrivon()

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [name, surface] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe('orivon')
    expect(surface.net).toBeUndefined()
    expect(typeof (surface.app as Record<string, unknown>).manifest).toBe('function')
    expect(typeof (surface.id as Record<string, unknown>).publicKey).toBe('function')
    expect(typeof (surface.id as Record<string, unknown>).sign).toBe('function')
    // ADR-0016's sync call is present even in the net-less fallback --
    // ../preload/README.md's rule that a method always absent from
    // window.orivon is worse than one that is not there does not apply here:
    // this method is genuinely wired either way, unlike net.
    expect(typeof (surface.fs as Record<string, unknown>).readFileSync).toBe('function')
  })

  it('falls back to the SAME surface when executeInMainWorld exists but throws', () => {
    executeInMainWorld = vi.fn(() => { throw new Error('CSP refused it') })

    exposeOrivon()

    expect(executeInMainWorld).toHaveBeenCalledTimes(1)
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [, surface] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>]
    expect(surface.net).toBeUndefined()
  })

  it('does NOT fall back when executeInMainWorld exists and succeeds', () => {
    installViaFakeMainWorld()

    exposeOrivon()

    expect(exposeInMainWorld).not.toHaveBeenCalled()
  })
})

describe('exposeOrivon -- P-F4: a failure after net.connect cleans up the broker-side socket', () => {
  it('fires net.close when waitForPort never delivers (the 35s timeout)', async () => {
    vi.useFakeTimers()
    try {
      const target = installViaFakeMainWorld()
      invoke.mockImplementation(async (_channel: string, envelope: { method: string, payload: { id?: string } }) => {
        if (envelope.method === 'net.connect') {
          return okEnvelope({ id: 'sock-1', remoteAddress: '1.2.3.4', remotePort: 80, localAddress: '10.0.0.1', localPort: 1 })
        }
        return okEnvelope(undefined) // net.close and anything else: succeed immediately
      })

      exposeOrivon()
      const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<unknown> } }

      const connecting = orivon.net.connect({ host: 'x.example', port: 80 })
      const assertion = expect(connecting).rejects.toBeDefined()
      // socketBridge's own waitForPort timeout is a hardcoded 35s default,
      // independent of TIMEOUT_MS.net -- advance past both.
      await vi.advanceTimersByTimeAsync(35_001)
      await assertion

      const closeCalls = invoke.mock.calls.filter(([, envelope]) => (envelope as { method: string }).method === 'net.close')
      expect(closeCalls).toHaveLength(1)
      expect((closeCalls[0]?.[1] as { payload: { id: string } }).payload).toMatchObject({ id: 'sock-1' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('exposeOrivon -- P-F5: control-call failures are always OrivonError-shaped', () => {
  it('call() throws an OrivonError-shaped object (not a raw Error) when ipcRenderer.invoke rejects outright', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockRejectedValue(new Error("Error invoking remote method 'orivon:control': something internal"))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    exposeOrivon()
    const orivon = target.orivon as { app: { manifest: () => Promise<unknown> } }

    let reason: unknown
    try { await orivon.app.manifest() } catch (error) { reason = error }

    expect(reason).not.toBeInstanceOf(Error)
    expect(reason).toMatchObject({ name: 'OrivonError', code: 'internal' })
    // The real failure is still logged for debugging, just not handed to the page.
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('call() throws an OrivonError carrying the broker\'s real code when the broker replies with a failure envelope', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockResolvedValue({ id: 'r', ok: false, code: 'denied', message: 'outside the granted pattern' })

    exposeOrivon()
    const orivon = target.orivon as { app: { manifest: () => Promise<unknown> } }

    await expect(orivon.app.manifest()).rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
  })
})

describe('exposeOrivon -- P-F11: end-to-end wiring smoke, through the real contextBridge shape', () => {
  it('a successful net.connect resolves a socket with the descriptor fields intact', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockImplementation(async (_channel: string, envelope: { method: string }) => {
      if (envelope.method === 'net.connect') {
        return okEnvelope({ id: 'sock-2', remoteAddress: '93.184.216.34', remotePort: 443, localAddress: '10.0.0.5', localPort: 4321 })
      }
      return okEnvelope(undefined)
    })

    exposeOrivon()
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<Record<string, unknown>> } }
    const connecting = orivon.net.connect({ host: 'x.example', port: 443 })

    // Deliver the port over PORT_CHANNEL -- socket-bridge.ts's own listener.
    portListener?.({ ports: [fakeMessagePort()] }, { handleId: 'sock-2' })

    const socket = await connecting
    expect(socket.id).toBe('sock-2')
    expect(socket.remoteAddress).toBe('93.184.216.34')
    expect(socket.readable).toBeInstanceOf(ReadableStream)
    expect(socket.writable).toBeInstanceOf(WritableStream)
  })

  it('id.publicKey and id.sign round-trip through call() and installOrivon with the real payload shape', async () => {
    const target = installViaFakeMainWorld()
    const publicKey = new Uint8Array([4, 1, 2, 3])
    const signature = new Uint8Array([5, 5, 5])
    const seenEnvelopes: Array<{ method: string, payload: unknown }> = []
    invoke.mockImplementation(async (_channel: string, envelope: { method: string, payload: unknown }) => {
      seenEnvelopes.push({ method: envelope.method, payload: envelope.payload })
      if (envelope.method === 'id.publicKey') return okEnvelope(publicKey)
      if (envelope.method === 'id.sign') return okEnvelope(signature)
      return okEnvelope(undefined)
    })

    exposeOrivon()
    const orivon = target.orivon as {
      id: {
        publicKey: (opts: { curve: string }) => Promise<Uint8Array>
        sign: (opts: { curve: string, payload: Uint8Array }) => Promise<Uint8Array>
      }
    }
    const payload = new Uint8Array([9, 9])

    expect(await orivon.id.publicKey({ curve: 'P-256' })).toEqual(publicKey)
    expect(await orivon.id.sign({ curve: 'P-256', payload })).toEqual(signature)
    expect(seenEnvelopes).toEqual([
      { method: 'id.publicKey', payload: { curve: 'P-256' } },
      { method: 'id.sign', payload: { curve: 'P-256', payload } }
    ])
  })

  it('id.sign propagates a real OrivonError (e.g. "denied") rather than a raw rejection', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockResolvedValue({ id: 'r', ok: false, code: 'denied', message: 'id is not granted to this origin for this curve' })

    exposeOrivon()
    const orivon = target.orivon as { id: { sign: (opts: { curve: string, payload: Uint8Array }) => Promise<Uint8Array> } }

    await expect(orivon.id.sign({ curve: 'P-256', payload: new Uint8Array(1) }))
      .rejects.toMatchObject({ code: 'denied' })
  })
})

describe('exposeOrivon -- fs.readFileSync (ADR-0016)', () => {
  it('calls ipcRenderer.sendSync, not .invoke, and returns the bytes synchronously on success', () => {
    const target = installViaFakeMainWorld()
    const bytes = new Uint8Array([7, 7, 7])
    sendSync.mockReturnValue({ id: '', ok: true, result: bytes })

    exposeOrivon()
    const orivon = target.orivon as { fs: { readFileSync: (path: string) => Uint8Array } }
    const result = orivon.fs.readFileSync('/a/b.txt')

    expect(result).toBe(bytes)
    expect(invoke).not.toHaveBeenCalled()
    expect(sendSync).toHaveBeenCalledWith('orivon:control-sync', { path: '/a/b.txt' })
  })

  it('throws an OrivonError-shaped object (not a rejection) on a denial, with no platformCode', () => {
    const target = installViaFakeMainWorld()
    sendSync.mockReturnValue({ id: '', ok: false, code: 'denied', message: 'fs is not granted to this origin' })

    exposeOrivon()
    const orivon = target.orivon as { fs: { readFileSync: (path: string) => Uint8Array } }

    let caught: unknown
    try {
      orivon.fs.readFileSync('/a/b.txt')
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ name: 'OrivonError', code: 'denied' })
    expect((caught as { platformCode?: unknown }).platformCode).toBeUndefined()
  })

  it('a traversal attempt is refused the same way a legal path succeeds is proven -- as a denial, not a crash or a silent bypass', () => {
    const target = installViaFakeMainWorld()
    sendSync.mockReturnValue({ id: '', ok: false, code: 'denied', message: "the path is outside this app's files directory" })

    exposeOrivon()
    const orivon = target.orivon as { fs: { readFileSync: (path: string) => Uint8Array } }

    let caught: unknown
    try {
      orivon.fs.readFileSync('../../../etc/passwd')
    } catch (e) {
      caught = e
    }
    expect(sendSync).toHaveBeenCalledWith('orivon:control-sync', { path: '../../../etc/passwd' })
    expect(caught).toMatchObject({ name: 'OrivonError', code: 'denied' })
  })

  it('a notFound failure carries the errno as platformCode, matching the async fs.readFile shape', () => {
    const target = installViaFakeMainWorld()
    sendSync.mockReturnValue({ id: '', ok: false, code: 'notFound', message: 'the filesystem operation failed', platformCode: 'ENOENT' })

    exposeOrivon()
    const orivon = target.orivon as { fs: { readFileSync: (path: string) => Uint8Array } }

    let caught: unknown
    try {
      orivon.fs.readFileSync('/missing.txt')
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ name: 'OrivonError', code: 'notFound', platformCode: 'ENOENT' })
  })
})

/** A minimal stand-in for the DOM MessagePort wrapPort() adapts -- enough for postMessage/onmessage/close to be exercised without throwing. */
function fakeMessagePort (): { postMessage: () => void, onmessage: unknown, close: () => void } {
  return { postMessage: () => {}, onmessage: undefined, close: () => {} }
}
