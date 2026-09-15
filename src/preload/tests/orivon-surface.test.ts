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
  it('falls back to exposeInMainWorld (net.lookup only, no stream methods) when executeInMainWorld is absent', () => {
    executeInMainWorld = undefined

    exposeOrivon()

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [name, surface] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe('orivon')
    // net.lookup (d-0030) needs no main-world stream wrapping -- it resolves
    // to plain data, never a live handle -- so it is genuinely wired in the
    // fallback surface, exactly like fs.readFile below it. connect/
    // connectSecure/udpBind are not: each would resolve to something that
    // is not a real TcpSocket/UdpSocket without the main-world stream
    // wrapper, which is exactly the failure mode this fallback exists to
    // avoid shipping (exposeOrivon's own doc).
    const net = surface.net as Record<string, unknown>
    expect(typeof net.lookup).toBe('function')
    expect(net.connect).toBeUndefined()
    expect(net.connectSecure).toBeUndefined()
    expect(net.udpBind).toBeUndefined()
    expect(typeof (surface.app as Record<string, unknown>).manifest).toBe('function')
    expect(typeof (surface.app as Record<string, unknown>).requestGrant).toBe('function')
    expect(typeof (surface.id as Record<string, unknown>).publicKey).toBe('function')
    expect(typeof (surface.id as Record<string, unknown>).sign).toBe('function')
    // ADR-0016's sync call is present even in the net-less fallback --
    // ../preload/README.md's rule that a method always absent from
    // window.orivon is worse than one that is not there does not apply here:
    // this method is genuinely wired either way, unlike net.
    expect(typeof (surface.fs as Record<string, unknown>).readFileSync).toBe('function')
    // The extended fs surface (queue item 2.1) is not net -- it needs no
    // main-world stream wrapping, so it is wired identically in both the
    // fallback and the executeInMainWorld path, exactly like readFile/
    // writeFile above it.
    for (const method of ['mkdir', 'readdir', 'stat', 'rm', 'rename']) {
      expect(typeof (surface.fs as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('falls back to the SAME surface when executeInMainWorld exists but throws', () => {
    executeInMainWorld = vi.fn(() => { throw new Error('CSP refused it') })

    exposeOrivon()

    expect(executeInMainWorld).toHaveBeenCalledTimes(1)
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [, surface] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>]
    const net = surface.net as Record<string, unknown>
    expect(typeof net.lookup).toBe('function')
    expect(net.connect).toBeUndefined()
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

  it('the same cleanup fires for net.connectSecure -- netConnectSecureBridge is not a second, divergent copy', async () => {
    vi.useFakeTimers()
    try {
      const target = installViaFakeMainWorld()
      invoke.mockImplementation(async (_channel: string, envelope: { method: string, payload: { id?: string } }) => {
        if (envelope.method === 'net.connectSecure') {
          return okEnvelope({ id: 'sock-secure-1', remoteAddress: '1.2.3.4', remotePort: 443, localAddress: '10.0.0.1', localPort: 1 })
        }
        return okEnvelope(undefined)
      })

      exposeOrivon()
      const orivon = target.orivon as { net: { connectSecure: (opts: unknown) => Promise<unknown> } }

      const connecting = orivon.net.connectSecure({ host: 'x.example', port: 443 })
      const assertion = expect(connecting).rejects.toBeDefined()
      await vi.advanceTimersByTimeAsync(35_001)
      await assertion

      const closeCalls = invoke.mock.calls.filter(([, envelope]) => (envelope as { method: string }).method === 'net.close')
      expect(closeCalls).toHaveLength(1)
      expect((closeCalls[0]?.[1] as { payload: { id: string } }).payload).toMatchObject({ id: 'sock-secure-1' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('exposeOrivon -- P-F5: control-call failures are always OrivonError-shaped', () => {
  // UPDATED FOR A152 (docs/open-questions.md): this used to assert
  // `not.toBeInstanceOf(Error)`, matching ../orivon-error.ts's own
  // isolated-world `call()` throwing a plain object -- correct as far as
  // it went, but `installViaFakeMainWorld` above calls installOrivon's
  // `func` directly, in this SAME realm, with no real contextBridge
  // crossing to lose or restore an Error's prototype. A152 fixed
  // installOrivon (../main-world-socket.ts's `callRevived`) to rebuild a
  // real Error from any OrivonError-shaped rejection a `bridge.*` call
  // produces, precisely so a page sees a real Error whether or not the
  // crossing that ran ahead of it happened to preserve one -- so a page
  // now DOES see `instanceof Error` here too, restoring the contract
  // (`OrivonError extends Error`, ../../contracts/errors.ts) for every
  // orivon.* consumer, not only src/shim/.
  it('call()\'s failure is OrivonError-shaped, and installOrivon hands the page a real Error built from it', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockRejectedValue(new Error("Error invoking remote method 'orivon:control': something internal"))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    exposeOrivon()
    const orivon = target.orivon as { app: { manifest: () => Promise<unknown> } }

    let reason: unknown
    try { await orivon.app.manifest() } catch (error) { reason = error }

    expect(reason).toBeInstanceOf(Error)
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

  it('a successful net.connectSecure calls the "net.connectSecure" method, not "net.connect", and resolves a socket with the descriptor fields intact', async () => {
    const target = installViaFakeMainWorld()
    const seenMethods: string[] = []
    invoke.mockImplementation(async (_channel: string, envelope: { method: string }) => {
      seenMethods.push(envelope.method)
      if (envelope.method === 'net.connectSecure') {
        return okEnvelope({ id: 'sock-3', remoteAddress: '93.184.216.34', remotePort: 443, localAddress: '10.0.0.5', localPort: 4322 })
      }
      return okEnvelope(undefined)
    })

    exposeOrivon()
    const orivon = target.orivon as { net: { connectSecure: (opts: unknown) => Promise<Record<string, unknown>> } }
    const connecting = orivon.net.connectSecure({ host: 'x.example', port: 443 })

    portListener?.({ ports: [fakeMessagePort()] }, { handleId: 'sock-3' })

    const socket = await connecting
    expect(socket.id).toBe('sock-3')
    expect(socket.readable).toBeInstanceOf(ReadableStream)
    expect(socket.writable).toBeInstanceOf(WritableStream)
    expect(seenMethods).toContain('net.connectSecure')
    expect(seenMethods).not.toContain('net.connect')
  })

  it('net.connectSecure propagates a real OrivonError (e.g. "denied") rather than a raw rejection', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockResolvedValue({ id: 'r', ok: false, code: 'denied', message: 'https.connect is not granted to this origin' })

    exposeOrivon()
    const orivon = target.orivon as { net: { connectSecure: (opts: unknown) => Promise<unknown> } }

    await expect(orivon.net.connectSecure({ host: 'x.example', port: 443 }))
      .rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
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

  it('net.lookup round-trips through call() and installOrivon -- plain data, no PORT_CHANNEL involved', async () => {
    const target = installViaFakeMainWorld()
    const answers = [{ address: '93.184.216.34', family: 'IPv4' }, { address: '2606:2800:220:1::1', family: 'IPv6' }]
    const seenEnvelopes: Array<{ method: string, payload: unknown }> = []
    invoke.mockImplementation(async (_channel: string, envelope: { method: string, payload: unknown }) => {
      seenEnvelopes.push({ method: envelope.method, payload: envelope.payload })
      if (envelope.method === 'net.lookup') return okEnvelope(answers)
      return okEnvelope(undefined)
    })

    exposeOrivon()
    const orivon = target.orivon as { net: { lookup: (opts: { hostname: string }) => Promise<unknown> } }

    // No portListener delivery step (unlike net.connect's own test above):
    // this resolves the instant the CONTROL_CHANNEL reply arrives.
    expect(await orivon.net.lookup({ hostname: 'api.example.com' })).toEqual(answers)
    expect(seenEnvelopes).toEqual([{ method: 'net.lookup', payload: { hostname: 'api.example.com' } }])
  })

  it('net.lookup propagates a real OrivonError (e.g. "denied") rather than a raw rejection', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockResolvedValue({ id: 'r', ok: false, code: 'denied', message: 'the hostname was not authorised by any held network grant' })

    exposeOrivon()
    const orivon = target.orivon as { net: { lookup: (opts: { hostname: string }) => Promise<unknown> } }

    await expect(orivon.net.lookup({ hostname: 'what-i-stole.attacker.example' }))
      .rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
  })

  it('app.requestGrant round-trips through call() and installOrivon, with patterns present or omitted', async () => {
    const target = installViaFakeMainWorld()
    const seenEnvelopes: Array<{ method: string, payload: unknown }> = []
    invoke.mockImplementation(async (_channel: string, envelope: { method: string, payload: unknown }) => {
      seenEnvelopes.push({ method: envelope.method, payload: envelope.payload })
      return okEnvelope(true)
    })

    exposeOrivon()
    const orivon = target.orivon as {
      app: { requestGrant: (request: { capability: string, patterns?: readonly string[] }) => Promise<boolean> }
    }

    expect(await orivon.app.requestGrant({ capability: 'tcp.connect', patterns: ['*:443'] })).toBe(true)
    expect(await orivon.app.requestGrant({ capability: 'fs' })).toBe(true)
    expect(seenEnvelopes).toEqual([
      { method: 'app.requestGrant', payload: { capability: 'tcp.connect', patterns: ['*:443'] } },
      { method: 'app.requestGrant', payload: { capability: 'fs' } }
    ])
  })

  it('app.requestGrant resolves false rather than throwing when the broker declines (its own contract, not an error)', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockResolvedValue(okEnvelope(false))

    exposeOrivon()
    const orivon = target.orivon as { app: { requestGrant: (request: { capability: string }) => Promise<boolean> } }

    expect(await orivon.app.requestGrant({ capability: 'fs' })).toBe(false)
  })

  it('fs.mkdir/readdir/stat/rm/rename round-trip through call() and installOrivon with the real payload shape', async () => {
    const target = installViaFakeMainWorld()
    const entries = ['a.txt', 'sub']
    const stat = { size: 3, isFile: true, isDirectory: false, mtimeMs: 123 }
    const seenEnvelopes: Array<{ method: string, payload: unknown }> = []
    invoke.mockImplementation(async (_channel: string, envelope: { method: string, payload: unknown }) => {
      seenEnvelopes.push({ method: envelope.method, payload: envelope.payload })
      if (envelope.method === 'fs.readdir') return okEnvelope(entries)
      if (envelope.method === 'fs.stat') return okEnvelope(stat)
      return okEnvelope(undefined)
    })

    exposeOrivon()
    const orivon = target.orivon as {
      fs: {
        mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
        readdir: (path: string) => Promise<readonly string[]>
        stat: (path: string) => Promise<unknown>
        rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>
        rename: (from: string, to: string) => Promise<void>
      }
    }

    await orivon.fs.mkdir('a/b', { recursive: true })
    expect(await orivon.fs.readdir('a')).toEqual(entries)
    expect(await orivon.fs.stat('a/b.txt')).toEqual(stat)
    await orivon.fs.rm('a/b', { recursive: true })
    await orivon.fs.rename('old.txt', 'new.txt')

    expect(seenEnvelopes).toEqual([
      { method: 'fs.mkdir', payload: { path: 'a/b', recursive: true } },
      { method: 'fs.readdir', payload: { path: 'a' } },
      { method: 'fs.stat', payload: { path: 'a/b.txt' } },
      { method: 'fs.rm', payload: { path: 'a/b', recursive: true } },
      { method: 'fs.rename', payload: { from: 'old.txt', to: 'new.txt' } }
    ])
  })

  it('fs.rm propagates a real OrivonError (e.g. "denied") rather than a raw rejection', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockResolvedValue({ id: 'r', ok: false, code: 'denied', message: "the path is outside this app's files directory" })

    exposeOrivon()
    const orivon = target.orivon as { fs: { rm: (path: string) => Promise<void> } }

    await expect(orivon.fs.rm('../../etc/passwd')).rejects.toMatchObject({ code: 'denied' })
  })
})

describe('exposeOrivon -- P-F11 continued: net.listen (A114, d-0028)', () => {
  it('a successful net.listen resolves a TcpServer, and an AcceptedMessage on its own port yields a real TcpSocket', async () => {
    const target = installViaFakeMainWorld()
    invoke.mockImplementation(async (_channel: string, envelope: { method: string }) => {
      if (envelope.method === 'net.listen') {
        return okEnvelope({ id: 'srv-1', localAddress: '0.0.0.0', localPort: 4001 })
      }
      return okEnvelope(undefined)
    })

    exposeOrivon()
    const orivon = target.orivon as { net: { listen: (opts: unknown) => Promise<{ id: string, localAddress: string, localPort: number, connections: ReadableStream }> } }
    const listening = orivon.net.listen({ port: 4001 })

    // Deliver the SERVER's own port over PORT_CHANNEL -- socket-bridge.ts's
    // listener is kind-agnostic (its own header), the same one net.connect's
    // test above uses.
    const serverPort = fakeMessagePort() as { postMessage: () => void, onmessage?: (e: { data: unknown }) => void, close: () => void }
    portListener?.({ ports: [serverPort] }, { handleId: 'srv-1' })

    const server = await listening
    expect(server.id).toBe('srv-1')
    expect(server.localAddress).toBe('0.0.0.0')
    expect(server.localPort).toBe(4001)

    const reader = server.connections.getReader()
    const reading = reader.read()
    await Promise.resolve() // let pull() fire and post the reused accept-demand credit message

    // The accepted connection's OWN port, delivered inline on the AcceptedMessage
    // (A114/d-0028) -- never a second PORT_CHANNEL round trip.
    const acceptedPort = fakeMessagePort()
    serverPort.onmessage?.({
      data: {
        kind: 'accepted', handleId: 'srv-1', socketId: 'acc-1',
        remoteAddress: '1.2.3.4', remotePort: 5555, localAddress: '10.0.0.5', localPort: 4001,
        port: acceptedPort
      }
    })

    const { value: socket } = (await reading) as { value: { id: string, readable: unknown, writable: unknown } }
    expect(socket.id).toBe('acc-1')
    expect(socket.readable).toBeInstanceOf(ReadableStream)
    expect(socket.writable).toBeInstanceOf(WritableStream)
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
