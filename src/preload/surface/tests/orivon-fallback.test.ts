import { beforeEach, describe, expect, it, vi } from 'vitest'

// exposeOrivon's exposeFallback() path -- split out of orivon.test.ts (Rule 2's
// line budget) since it is a self-contained concern: what window.orivon looks
// like, and does, when executeInMainWorld is absent or throws. See
// orivon.test.ts's own header for why 'electron' must be mocked before the
// module under test can even be imported.
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

const { exposeOrivon } = await import('../orivon.js')

/** `orivon.test.ts`'s own `installViaFakeMainWorld` -- only this file's "does NOT fall back" test needs it. */
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

describe('exposeOrivon -- the fail-closed fallback covers BOTH "absent" and "throws"', () => {
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
    // orivon.web.openContext (ADR-0019) needs no main-world stream wrapping
    // either -- surface/web.ts's own header -- so, like the extended fs
    // surface below, it is genuinely wired in the fallback too, not merely
    // present as an unreachable placeholder.
    expect(typeof (surface.web as Record<string, unknown>).openContext).toBe('function')
    // ADR-0016's sync call is present even in the net-less fallback --
    // ../preload/README.md's rule that a method always absent from
    // window.orivon is worse than one that is not there does not apply here:
    // this method is genuinely wired either way, unlike net.
    expect(typeof (surface.fs as Record<string, unknown>).readFileSync).toBe('function')
    // The extended fs surface (queue item 2.1) is not net -- it needs no
    // main-world stream wrapping, so it is wired identically in both the
    // fallback and the executeInMainWorld path, exactly like readFile/
    // writeFile above it.
    for (const method of ['mkdir', 'readdir', 'stat', 'rm', 'rename', 'open', 'userSelected']) {
      expect(typeof (surface.fs as Record<string, unknown>)[method]).toBe('function')
    }
  })

  // The fallback has no main-world caller-attribution filter (installOrivon's
  // guarded() never runs here) -- a page and an extension's MAIN-world script
  // are indistinguishable to it, so every capability-bearing method must
  // fail closed rather than forward, web.openContext included: refusing
  // before any CONTROL_CHANNEL call is made, the same as every other method
  // on this surface.
  it('web.openContext is refused on the fallback surface and never reaches the CONTROL_CHANNEL', async () => {
    executeInMainWorld = undefined
    invoke.mockResolvedValue(okEnvelope({ id: 'ctx-1', origin: 'https://example.com' }))

    exposeOrivon()

    const [, surface] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>]
    const openContext = (surface.web as { openContext: (origin: string, options?: { width?: number, height?: number }) => Promise<unknown> }).openContext
    await expect(openContext('https://example.com', { width: 800, height: 600 })).rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('falls back to the SAME fail-closed surface when executeInMainWorld exists but throws', () => {
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

  // The fallback surface has no caller-attribution filter at all (that
  // filter is installOrivon's own guarded(), which never runs on this path)
  // -- a MAIN-world extension script would otherwise reach the broker with
  // exactly the same access as the page whenever executeInMainWorld is
  // absent or throws. Every method below refuses instead.
  it('every async capability method on the fallback surface rejects "denied" without reaching invoke or sendSync', async () => {
    executeInMainWorld = undefined
    invoke.mockResolvedValue(okEnvelope('should never be seen'))

    exposeOrivon()

    const [, surface] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>]
    type AnyCall = (...args: unknown[]) => Promise<unknown>
    interface FallbackSurface {
      app: { manifest: AnyCall, grants: AnyCall, requestGrant: AnyCall }
      fs: { readFile: AnyCall, writeFile: AnyCall, mkdir: AnyCall, readdir: AnyCall, stat: AnyCall, rm: AnyCall, rename: AnyCall, open: AnyCall, userSelected: AnyCall }
      id: { publicKey: AnyCall, sign: AnyCall }
      secrets: { available: AnyCall, encrypt: AnyCall, decrypt: AnyCall }
      trust: { websiteScore: AnyCall }
      net: { lookup: AnyCall }
      web: { openContext: AnyCall, setEmbedScript: AnyCall }
    }
    const { app, fs, id, secrets, trust, net, web } = surface as unknown as FallbackSurface

    const calls: Array<Promise<unknown>> = [
      app.manifest(), app.grants(), app.requestGrant({ capability: 'net' }),
      fs.readFile('/a'), fs.writeFile('/a', new Uint8Array()), fs.mkdir('/a'), fs.readdir('/a'),
      fs.stat('/a'), fs.rm('/a'), fs.rename('/a', '/b'), fs.open('/a', 'r'), fs.userSelected(),
      id.publicKey({ curve: 'p256' }), id.sign({ curve: 'p256', payload: new Uint8Array() }),
      secrets.available(), secrets.encrypt(new Uint8Array()), secrets.decrypt(new Uint8Array()),
      trust.websiteScore('ipfs://bafy'),
      net.lookup({ hostname: 'x.example' }),
      web.openContext('https://example.com'), web.setEmbedScript('x')
    ]

    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
    }
    expect(invoke).not.toHaveBeenCalled()
    expect(sendSync).not.toHaveBeenCalled()
  })

  it('fs.readFileSync on the fallback surface throws "denied" synchronously, never calling sendSync', () => {
    executeInMainWorld = undefined

    exposeOrivon()

    const [, surface] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>]
    const readFileSync = (surface.fs as { readFileSync: (path: string) => Uint8Array }).readFileSync
    expect(() => readFileSync('/a')).toThrow(expect.objectContaining({ name: 'OrivonError', code: 'denied' }))
    expect(sendSync).not.toHaveBeenCalled()
  })

  it('logs once, to console.error, when the fallback (fail-closed) surface is exposed', () => {
    executeInMainWorld = undefined
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    exposeOrivon()

    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})
