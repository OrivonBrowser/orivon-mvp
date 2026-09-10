import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import type { MainWorldDatagram, MainWorldUdpBridge } from '../main-world-socket.js'
import type { OrivonErrorCode } from '../../contracts/errors.js'
import type { FileStat, SendRefusal } from '../../contracts/handles.js'
import type { ResponseEnvelope } from '../../contracts/ipc.js'

const LIMITS = {
  readWindowBytes: 1_000, writeWindowBytes: 1_000,
  inboundDatagramWindow: 8, outboundDatagramWindow: 4
}

/** A fake SocketPort-shaped bridge result -- everything main-world-socket.ts needs from bridge.netConnect(). */
function fakeSocketBridgeResult (): {
  id: string, remoteAddress: string, remotePort: number, localAddress: string, localPort: number
  onData: (cb: (chunk: Uint8Array) => void) => void
  onReadEnd: (cb: (code: OrivonErrorCode | undefined) => void) => void
  reportConsumed: (n: number) => void
  write: (chunk: Uint8Array) => Promise<void>
  endWrite: () => Promise<void>
  abortWrite: () => void
  onFatal: (cb: (code: OrivonErrorCode) => void) => void
  closed: Promise<void>
  close: () => Promise<void>
  setNoDelay: (on: boolean) => Promise<void>
  setKeepAlive: (on: boolean, ms?: number) => Promise<void>
  emitData: (chunk: Uint8Array) => void
  emitReadEnd: (code?: OrivonErrorCode) => void
  emitFatal: (code: OrivonErrorCode) => void
  written: Uint8Array[]
  writeCalls: Array<{ resolve: () => void, reject: (e: unknown) => void }>
  reportConsumedCalls: number[]
  endWriteCalls: number
  abortWriteCalls: number
  closeCalls: number
} {
  let dataCb: ((chunk: Uint8Array) => void) | undefined
  let readEndCb: ((code: OrivonErrorCode | undefined) => void) | undefined
  let fatalCb: ((code: OrivonErrorCode) => void) | undefined
  const written: Uint8Array[] = []
  const writeCalls: Array<{ resolve: () => void, reject: (e: unknown) => void }> = []
  const reportConsumedCalls: number[] = []
  let closedResolve: () => void = () => {}
  const closed = new Promise<void>((resolve) => { closedResolve = resolve })
  const state = { endWriteCalls: 0, abortWriteCalls: 0, closeCalls: 0 }

  return {
    id: 'h1', remoteAddress: '93.184.216.34', remotePort: 443, localAddress: '10.0.0.5', localPort: 1234,
    onData: (cb) => { dataCb = cb },
    onReadEnd: (cb) => { readEndCb = cb },
    reportConsumed: (n) => { reportConsumedCalls.push(n) },
    write: async (chunk) => {
      written.push(chunk)
      return await new Promise((resolve, reject) => { writeCalls.push({ resolve, reject }) })
    },
    endWrite: async () => { state.endWriteCalls++ },
    abortWrite: () => { state.abortWriteCalls++ },
    onFatal: (cb) => { fatalCb = cb },
    closed,
    close: async () => { state.closeCalls++; closedResolve() },
    setNoDelay: async () => {},
    setKeepAlive: async () => {},
    emitData: (chunk) => { dataCb?.(chunk) },
    emitReadEnd: (code) => { readEndCb?.(code) },
    emitFatal: (code) => { fatalCb?.(code) },
    written,
    writeCalls,
    reportConsumedCalls,
    get endWriteCalls () { return state.endWriteCalls },
    get abortWriteCalls () { return state.abortWriteCalls },
    get closeCalls () { return state.closeCalls }
  }
}

function fakeBridge (
  netConnectResult: ReturnType<typeof fakeSocketBridgeResult>,
  udpResult?: ReturnType<typeof fakeUdpBridgeResult>,
  fsReadFileSync: (path: string) => ResponseEnvelope<Uint8Array> = () => ({ id: '', ok: true, result: new Uint8Array() }),
  netConnectSecureResult: ReturnType<typeof fakeSocketBridgeResult> = fakeSocketBridgeResult()
): {
  appManifest: () => Promise<unknown>, appGrants: () => Promise<unknown>
  fsReadFile: (path: string) => Promise<Uint8Array>, fsWriteFile: (path: string, data: Uint8Array) => Promise<void>
  fsReadFileSync: (path: string) => ResponseEnvelope<Uint8Array>
  fsMkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
  fsReaddir: (path: string) => Promise<readonly string[]>
  fsStat: (path: string) => Promise<FileStat>
  fsRm: (path: string, opts?: { recursive?: boolean }) => Promise<void>
  fsRename: (from: string, to: string) => Promise<void>
  idPublicKey: (curve: string) => Promise<Uint8Array>, idSign: (curve: string, payload: Uint8Array) => Promise<Uint8Array>
  netConnect: (opts: { host: string, port: number }) => Promise<ReturnType<typeof fakeSocketBridgeResult>>
  netConnectSecure: (opts: { host: string, port: number }) => Promise<ReturnType<typeof fakeSocketBridgeResult>>
  netUdpBind: (opts: { port: number }) => Promise<MainWorldUdpBridge>
} {
  return {
    appManifest: async () => ({ orivonApiVersion: 0 }),
    appGrants: async () => [],
    fsReadFile: async () => new Uint8Array(),
    fsWriteFile: async () => {},
    fsReadFileSync,
    fsMkdir: async () => {},
    fsReaddir: async () => [],
    fsStat: async () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }),
    fsRm: async () => {},
    fsRename: async () => {},
    idPublicKey: async () => new Uint8Array(),
    idSign: async () => new Uint8Array(),
    netConnect: async (_opts) => netConnectResult,
    // A SEPARATE fake result by default (its own fakeSocketBridgeResult(),
    // not netConnectResult) -- reusing the same one would let a bug that
    // called bridge.netConnect instead of bridge.netConnectSecure pass
    // silently, since both fields would then resolve to an identical object.
    netConnectSecure: async (_opts) => netConnectSecureResult,
    netUdpBind: async (_opts) => udpResult ?? fakeUdpBridgeResult()
  }
}

/** A MainWorldUdpBridge double whose callbacks the test drives by hand. */
export function fakeUdpBridgeResult (): MainWorldUdpBridge & {
  emit: (datagram: MainWorldDatagram) => void
  emitDropped: (inbound: number, outbound: number) => void
  emitRefusal: (refusal: SendRefusal) => void
  emitEnd: (code?: OrivonErrorCode) => void
  emitFatal: (code: OrivonErrorCode) => void
  readonly sent: MainWorldDatagram[]
  readonly consumed: Array<{ datagrams: number, bytes: number }>
} {
  let onDatagram: (d: MainWorldDatagram) => void = () => {}
  let onDropped: (i: number, o: number) => void = () => {}
  let onRefusal: (r: SendRefusal) => void = () => {}
  let onReadEnd: (code: OrivonErrorCode | undefined) => void = () => {}
  let onFatal: (code: OrivonErrorCode) => void = () => {}
  const sent: MainWorldDatagram[] = []
  const consumed: Array<{ datagrams: number, bytes: number }> = []
  return {
    id: 'u1',
    localAddress: '0.0.0.0',
    localPort: 6881,
    onDatagram: (cb) => { onDatagram = cb },
    onReadEnd: (cb) => { onReadEnd = cb },
    onDropped: (cb) => { onDropped = cb },
    onRefusal: (cb) => { onRefusal = cb },
    onFatal: (cb) => { onFatal = cb },
    reportConsumed: (datagrams, bytes) => { consumed.push({ datagrams, bytes }) },
    send: async (datagram) => { sent.push(datagram) },
    closed: new Promise<void>(() => {}),
    close: async () => {},
    emit: (datagram) => { onDatagram(datagram) },
    emitDropped: (inbound, outbound) => { onDropped(inbound, outbound) },
    emitRefusal: (refusal) => { onRefusal(refusal) },
    emitEnd: (code) => { onReadEnd(code) },
    emitFatal: (code) => { onFatal(code) },
    sent,
    consumed
  }
}

describe('installOrivon', () => {
  it('builds the whole window.orivon object, not just net', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())

    installOrivon(bridge, LIMITS, target)

    const orivon = target.orivon as Record<string, unknown>
    expect(orivon.version).toBe(0)
    expect(typeof (orivon.app as Record<string, unknown>).manifest).toBe('function')
    expect(typeof (orivon.fs as Record<string, unknown>).readFile).toBe('function')
    expect(typeof (orivon.id as Record<string, unknown>).publicKey).toBe('function')
    expect(typeof (orivon.id as Record<string, unknown>).sign).toBe('function')
    expect(typeof (orivon.net as Record<string, unknown>).connect).toBe('function')
  })

  it('id.publicKey/sign delegate to the bridge closures with the curve (and payload) unwrapped from opts', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const publicKeyCalls: string[] = []
    const signCalls: Array<{ curve: string, payload: Uint8Array }> = []
    bridge.idPublicKey = async (curve) => { publicKeyCalls.push(curve); return new Uint8Array([1]) }
    bridge.idSign = async (curve, payload) => { signCalls.push({ curve, payload }); return new Uint8Array([2]) }
    installOrivon(bridge, LIMITS, target)

    const orivon = target.orivon as {
      id: {
        publicKey: (opts: { curve: string }) => Promise<Uint8Array>
        sign: (opts: { curve: string, payload: Uint8Array }) => Promise<Uint8Array>
      }
    }
    const payload = new Uint8Array([9, 9])
    const publicKey = await orivon.id.publicKey({ curve: 'P-256' })
    const signature = await orivon.id.sign({ curve: 'P-256', payload })

    expect(publicKeyCalls).toEqual(['P-256'])
    expect(signCalls).toEqual([{ curve: 'P-256', payload }])
    expect(publicKey).toEqual(new Uint8Array([1]))
    expect(signature).toEqual(new Uint8Array([2]))
  })

  it('fs.mkdir/readdir/stat/rm/rename delegate to the matching bridge closures, args intact', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const calls: unknown[] = []
    bridge.fsMkdir = async (path, opts) => { calls.push(['mkdir', path, opts]) }
    bridge.fsReaddir = async (path) => { calls.push(['readdir', path]); return ['a.txt'] }
    bridge.fsStat = async (path) => { calls.push(['stat', path]); return { size: 1, isFile: true, isDirectory: false, mtimeMs: 1 } }
    bridge.fsRm = async (path, opts) => { calls.push(['rm', path, opts]) }
    bridge.fsRename = async (from, to) => { calls.push(['rename', from, to]) }
    installOrivon(bridge, LIMITS, target)

    const orivon = target.orivon as {
      fs: {
        mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
        readdir: (path: string) => Promise<readonly string[]>
        stat: (path: string) => Promise<FileStat>
        rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>
        rename: (from: string, to: string) => Promise<void>
      }
    }

    await orivon.fs.mkdir('a', { recursive: true })
    expect(await orivon.fs.readdir('a')).toEqual(['a.txt'])
    expect(await orivon.fs.stat('a/f.txt')).toEqual({ size: 1, isFile: true, isDirectory: false, mtimeMs: 1 })
    await orivon.fs.rm('a', { recursive: true })
    await orivon.fs.rename('old', 'new')

    expect(calls).toEqual([
      ['mkdir', 'a', { recursive: true }],
      ['readdir', 'a'],
      ['stat', 'a/f.txt'],
      ['rm', 'a', { recursive: true }],
      ['rename', 'old', 'new']
    ])
  })

  it('orivon.id is frozen, same as app/fs', () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)
    expect(Object.isFrozen((target.orivon as { id: unknown }).id)).toBe(true)
  })

  describe('fs.readFileSync (ADR-0016)', () => {
    it('delegates to bridge.fsReadFileSync with the path unwrapped, and returns the ok envelope\'s result WITHOUT a Promise wrapper', () => {
      const target: Record<string, unknown> = {}
      const calls: string[] = []
      const bytes = new Uint8Array([1, 2, 3])
      const bridge = fakeBridge(fakeSocketBridgeResult(), undefined, (path) => {
        calls.push(path)
        return { id: '', ok: true, result: bytes }
      })
      installOrivon(bridge, LIMITS, target)

      const orivon = target.orivon as { fs: { readFileSync: (path: string) => Uint8Array } }
      const result = orivon.fs.readFileSync('/a/b.txt')

      expect(calls).toEqual(['/a/b.txt'])
      expect(result).toBe(bytes)
      // Not a thenable -- api.fs.readFileSync is deliberately not `async`
      // (see installOrivon's own comment on this closure). Whether the
      // surrounding contextBridge proxy preserves that synchronicity too is
      // unproven here; this only proves this file's own wiring does not
      // introduce a Promise that was not already there.
      expect(typeof (result as unknown as { then?: unknown }).then).not.toBe('function')
    })

    // bridge.fsReadFileSync itself NEVER throws (see its own doc): a real
    // Electron launch found that a value thrown across contextBridge's
    // function-proxy boundary loses everything but `.message`. This test
    // proves installOrivon builds the real OrivonError from the RETURNED
    // failure envelope instead, entirely on this side of that boundary.
    it('builds and throws a real OrivonError from a failure envelope, synchronously, never a rejection', () => {
      const target: Record<string, unknown> = {}
      const bridge = fakeBridge(fakeSocketBridgeResult(), undefined, () => (
        { id: '', ok: false, code: 'denied', message: 'fs is not granted to this origin' }
      ))
      installOrivon(bridge, LIMITS, target)

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

    it('carries platformCode through for a non-denied failure, matching the async fs.readFile shape', () => {
      const target: Record<string, unknown> = {}
      const bridge = fakeBridge(fakeSocketBridgeResult(), undefined, () => (
        { id: '', ok: false, code: 'notFound', message: 'the filesystem operation failed', platformCode: 'ENOENT' }
      ))
      installOrivon(bridge, LIMITS, target)

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

  it('net.connect resolves to a TcpSocket-shaped object with real WHATWG streams', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    installOrivon(bridge, LIMITS, target)

    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<Record<string, unknown>> } }
    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })

    expect(socket.id).toBe('h1')
    expect(socket.remoteAddress).toBe('93.184.216.34')
    expect(socket.remotePort).toBe(443)
    expect(socket.readable).toBeInstanceOf(ReadableStream)
    expect(socket.writable).toBeInstanceOf(WritableStream)
    expect(socket.closed).toBeInstanceOf(Promise)
    expect(typeof socket.close).toBe('function')
  })

  it('net.connectSecure resolves through the SAME buildSocket path as net.connect, via its own bridge closure', async () => {
    const target: Record<string, unknown> = {}
    const secureResult = fakeSocketBridgeResult()
    secureResult.id = 'h-secure'
    secureResult.remotePort = 443
    // A DIFFERENT default net.connect result, so a bug wiring connectSecure
    // to bridge.netConnect instead of bridge.netConnectSecure would return
    // this ('h1') rather than the fixture below and fail the id assertion.
    const bridge = fakeBridge(fakeSocketBridgeResult(), undefined, undefined, secureResult)
    installOrivon(bridge, LIMITS, target)

    const orivon = target.orivon as { net: { connectSecure: (opts: unknown) => Promise<Record<string, unknown>> } }
    const socket = await orivon.net.connectSecure({ host: 'x.example', port: 443 })

    expect(socket.id).toBe('h-secure')
    expect(socket.readable).toBeInstanceOf(ReadableStream)
    expect(socket.writable).toBeInstanceOf(WritableStream)
    expect(typeof socket.close).toBe('function')
  })

  it('runs the exact fixture-app sequence: write, writer.close(), then read to completion', async () => {
    const result = fakeSocketBridgeResult()
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(result), LIMITS, target)
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<{ readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, close: () => Promise<void> }> } }
    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })

    const sent = new TextEncoder().encode('hello')
    const writer = socket.writable.getWriter()
    const writePromise = writer.write(sent)
    result.writeCalls[0]?.resolve() // the bridge "accepts" the write
    await writePromise
    const closePromise = writer.close()
    await tick()
    expect(result.endWriteCalls).toBe(1)
    await closePromise

    result.emitData(sent)
    result.emitReadEnd()

    const reader = socket.readable.getReader()
    const { value, done } = await reader.read()
    expect(done).toBe(false)
    expect(value).toEqual(sent)
    const second = await reader.read()
    expect(second.done).toBe(true)

    await socket.close()
    expect(result.closeCalls).toBe(1)
  })

  it('writable.abort() reaches bridge.abortWrite', async () => {
    const result = fakeSocketBridgeResult()
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(result), LIMITS, target)
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<{ writable: WritableStream<Uint8Array> }> } }
    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })

    const writer = socket.writable.getWriter()
    await writer.abort(new Error('page aborted')).catch(() => {})

    expect(result.abortWriteCalls).toBe(1)
  })

  it('a read-end with no code closes the readable cleanly (EOF)', async () => {
    const result = fakeSocketBridgeResult()
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(result), LIMITS, target)
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<{ readable: ReadableStream<Uint8Array> }> } }
    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })

    result.emitReadEnd()
    const reader = socket.readable.getReader()
    const { done } = await reader.read()

    expect(done).toBe(true)
  })

  it('a read-end WITH a code errors the readable', async () => {
    const result = fakeSocketBridgeResult()
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(result), LIMITS, target)
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<{ readable: ReadableStream<Uint8Array> }> } }
    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })

    result.emitReadEnd('revoked')

    const reader = socket.readable.getReader()
    await expect(reader.read()).rejects.toMatchObject({ code: 'revoked' })
  })

  it('declares no free identifier the function does not itself define (serialisation safety)', () => {
    const source = installOrivon.toString()
    // A crude but real guard against the bundler-hoisting hazard this file's
    // own header warns about: executeInMainWorld serialises this function's
    // source text and re-evaluates it fresh in the main world, so it must
    // never reference an import, a module-level const, or anything from an
    // enclosing closure.
    expect(source).not.toMatch(/\brequire\s*\(/)
    expect(source).not.toMatch(/\bimport\s*\(/)
  })

  it('P-F7: freezes window.orivon so a page script cannot replace net.connect', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)

    const desc = Object.getOwnPropertyDescriptor(target, 'orivon')
    expect(desc?.writable).toBe(false)
    expect(desc?.configurable).toBe(false)

    const orivon = target.orivon as { net: { connect: unknown } }
    expect(() => { orivon.net.connect = (): void => {} }).toThrow(TypeError)
    expect(typeof orivon.net.connect).toBe('function')

    // Nested groups are frozen too, not just the top-level object.
    expect(Object.isFrozen(orivon.net)).toBe(true)
    expect(Object.isFrozen((target.orivon as { app: unknown }).app)).toBe(true)
    expect(Object.isFrozen((target.orivon as { fs: unknown }).fs)).toBe(true)
  })

  it('P-F7: each socket object is frozen too, but its streams stay functional', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<Record<string, unknown>> } }

    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })

    expect(Object.isFrozen(socket)).toBe(true)
    expect(() => { socket.close = async (): Promise<void> => {} }).toThrow(TypeError)
    // Frozen is shallow -- the stream OBJECTS referenced by the frozen
    // property slots are not themselves frozen, and remain fully usable.
    expect(typeof (socket.readable as ReadableStream).getReader).toBe('function')
    expect(typeof (socket.writable as WritableStream).getWriter).toBe('function')
  })

  it('P-F3: onFatal errors BOTH readable and writable', async () => {
    const result = fakeSocketBridgeResult()
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(result), LIMITS, target)
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<{ readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> }> } }
    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })
    const reader = socket.readable.getReader()
    const writer = socket.writable.getWriter()

    result.emitFatal('reset')

    await expect(reader.read()).rejects.toMatchObject({ code: 'reset' })
    await expect(writer.write(new Uint8Array([1]))).rejects.toMatchObject({ code: 'reset' })
  })

  it('P-F3: an ERRORED (not clean) read-end also errors the writable side, not just the readable', async () => {
    const result = fakeSocketBridgeResult()
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(result), LIMITS, target)
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<{ writable: WritableStream<Uint8Array> }> } }
    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })
    const writer = socket.writable.getWriter()

    result.emitReadEnd('revoked')

    await expect(writer.write(new Uint8Array([1]))).rejects.toMatchObject({ code: 'revoked' })
  })

  it('P-F2: close() reflects on both streams even with nothing in flight', async () => {
    const result = fakeSocketBridgeResult()
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(result), LIMITS, target)
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<{ readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, close: () => Promise<void> }> } }
    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })
    const reader = socket.readable.getReader()

    await socket.close()

    const { done } = await reader.read()
    expect(done).toBe(true)
    await expect(socket.writable.getWriter().write(new Uint8Array([1]))).rejects.toBeDefined()
  })

  it('P-F13: pull() must not credit the whole window when desiredSize is null (an errored/closed controller)', async () => {
    const OriginalReadableStream = globalThis.ReadableStream
    let capturedPull: ((controller: { desiredSize: number | null }) => void) | undefined
    class SpyReadableStream {
      constructor (source: { start?: (c: unknown) => void, pull?: (c: { desiredSize: number | null }) => void }) {
        capturedPull = source.pull
        source.start?.({ enqueue: () => {}, close: () => {}, error: () => {} })
      }
    }
    // @ts-expect-error -- a deliberately narrower test double, restored in `finally`
    globalThis.ReadableStream = SpyReadableStream

    try {
      const result = fakeSocketBridgeResult()
      const target: Record<string, unknown> = {}
      installOrivon(fakeBridge(result), LIMITS, target)
      const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<unknown> } }
      await orivon.net.connect({ host: 'x.example', port: 443 })

      result.emitData(new Uint8Array(5)) // far short of a full window
      capturedPull?.({ desiredSize: null })

      expect(result.reportConsumedCalls).toEqual([]) // conservative: nothing credited, never the whole window
    } finally {
      globalThis.ReadableStream = OriginalReadableStream
    }
  })

  it('P-F6: the SHIPPED bundle\'s installOrivon has no free identifier, not just the per-module transform\'s copy', () => {
    const builtPath = resolve(process.cwd(), 'out/preload/app.js')
    if (isStale(builtPath)) execSync('npm run build', { stdio: 'ignore' })
    const bundled = readFileSync(builtPath, 'utf8')

    const source = extractFunctionSource(bundled, 'installOrivon')

    // `new Function` here runs code extracted from THIS REPO'S OWN build
    // output (out/preload/app.js, produced by `npm run build` above from
    // our own source) -- never external or attacker-controlled input. This
    // is the mechanism the finding asks for: prove the shipped bundle has
    // no free identifier by actually executing it, the same way
    // executeInMainWorld does in the real main world.
    //
    // Reconstruct it with ONLY the globals it is entitled to at serialisation
    // time (executeInMainWorld's real main-world scope), then actually RUN
    // it -- not just eyeball the text -- so a free identifier anywhere in
    // its nested closures (buildSocket, its renamed toOrivonError2, ...)
    // surfaces as a real ReferenceError, the same way it would in the page.
    const factory = new Function(
      'ReadableStream', 'WritableStream', 'ByteLengthQueuingStrategy',
      `"use strict";\n${source}\nreturn installOrivon;`
    )
    const reconstructed = factory(ReadableStream, WritableStream, ByteLengthQueuingStrategy) as typeof installOrivon

    const result = fakeSocketBridgeResult()
    const target: Record<string, unknown> = {}
    expect(() => { reconstructed(fakeBridge(result), LIMITS, target) }).not.toThrow()

    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<{ readable: unknown, writable: unknown }> } }
    return orivon.net.connect({ host: 'x.example', port: 443 }).then((socket) => {
      expect(socket.readable).toBeInstanceOf(ReadableStream)
      expect(socket.writable).toBeInstanceOf(WritableStream)
    })
  })
})


/**
 * Whether `out/preload/app.js` needs rebuilding before it can be trusted as
 * "the SHIPPED bundle".
 *
 * An existence check alone is not enough, and this test failed on `main`
 * exactly that way: a leftover `out/` from before installOrivon existed is
 * present, so no rebuild was triggered, and the assertion failed against a
 * bundle that predated the code under test. Mtimes are what actually answer
 * the question the test is asking.
 */
function isStale (builtPath: string): boolean {
  if (!existsSync(builtPath)) return true
  const builtAt = statSync(builtPath).mtimeMs
  // Both directories, because the bundle inlines contracts/ as well as this
  // file's own sources -- a stale contracts constant would be just as wrong.
  return ['src/preload', 'src/contracts'].some((dir) => {
    const full = resolve(process.cwd(), dir)
    return readdirSync(full)
      .filter((name) => name.endsWith('.ts'))
      .some((name) => statSync(join(full, name)).mtimeMs > builtAt)
  })
}

/** Finds `functionName`'s full declaration text in `source` by brace/paren balancing -- a regex alone cannot find the body's opening brace past a default-parameter expression that itself contains `{}` (installOrivon's own `target = ... ? {} : window`). */
function extractFunctionSource (source: string, functionName: string): string {
  const declIndex = source.indexOf(`function ${functionName}`)
  if (declIndex === -1) throw new Error(`${functionName} not found in bundle`)
  const parenOpen = source.indexOf('(', declIndex)
  const parenClose = findMatching(source, parenOpen, '(', ')')
  const braceOpen = source.indexOf('{', parenClose)
  const braceClose = findMatching(source, braceOpen, '{', '}')
  return source.slice(declIndex, braceClose + 1)
}

function findMatching (source: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === openChar) depth++
    else if (source[i] === closeChar) {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`no matching '${closeChar}' found`)
}

async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('installOrivon -- net.udpBind', () => {
  function bindTarget (udp = fakeUdpBridgeResult()): {
    orivon: { net: { udpBind: (opts: unknown) => Promise<Record<string, unknown>> } }
    udp: ReturnType<typeof fakeUdpBridgeResult>
  } {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult(), udp), LIMITS, target)
    return { orivon: target.orivon as never, udp }
  }

  it('resolves to a UdpSocket-shaped object with real WHATWG streams', async () => {
    const { orivon } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })

    expect(socket.id).toBe('u1')
    expect(socket.localAddress).toBe('0.0.0.0')
    expect(socket.localPort).toBe(6881)
    expect(socket.readable).toBeInstanceOf(ReadableStream)
    expect(socket.writable).toBeInstanceOf(WritableStream)
  })

  it('delivers inbound datagrams whole, one chunk per packet', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.readable as ReadableStream<MainWorldDatagram>).getReader()

    udp.emit({ data: new Uint8Array([1, 2]), address: '10.0.0.9', port: 1234, family: 'IPv4' })
    const { value } = await reader.read()

    expect(value).toEqual({ data: new Uint8Array([1, 2]), address: '10.0.0.9', port: 1234, family: 'IPv4' })
    reader.releaseLock()
  })

  // The trap: a number copied once at acquisition reads zero forever, and an
  // app checking it would conclude it had lost nothing.
  it('exposes both loss counters as live getters, not values frozen at bind', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })

    expect(socket.droppedInbound).toBe(0)
    expect(socket.droppedOutbound).toBe(0)
    udp.emitDropped(4, 7)

    expect(socket.droppedInbound).toBe(4)
    expect(socket.droppedOutbound).toBe(7)
  })

  it('keeps the counters readable through Object.freeze', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    expect(Object.isFrozen(socket)).toBe(true)
    udp.emitDropped(1, 2)
    expect(socket.droppedInbound).toBe(1)
  })

  it('sends what the page writes', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const writer = (socket.writable as WritableStream<MainWorldDatagram>).getWriter()

    await writer.write({ data: new Uint8Array([9]), address: '93.184.216.34', port: 6881, family: 'IPv4' })

    expect(udp.sent).toEqual([{ data: new Uint8Array([9]), address: '93.184.216.34', port: 6881, family: 'IPv4' }])
    writer.releaseLock()
  })

  it('reports what the page drained, so the broker can release credit', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.readable as ReadableStream<MainWorldDatagram>).getReader()

    udp.emit({ data: new Uint8Array(12), address: 'a', port: 1, family: 'IPv4' })
    await reader.read()
    await tick()

    expect(udp.consumed).toContainEqual({ datagrams: 1, bytes: 12 })
    reader.releaseLock()
  })

  it('errors both streams when the read side ends abruptly', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.readable as ReadableStream<MainWorldDatagram>).getReader()

    udp.emitEnd('reset')

    await expect(reader.read()).rejects.toMatchObject({ code: 'reset' })
    await expect((socket.writable as WritableStream<MainWorldDatagram>).getWriter().closed)
      .rejects.toMatchObject({ code: 'reset' })
  })

  it('does not throw when a genuine read-end arrives after onFatal already errored the controllers', async () => {
    // onFatal's own controller calls are all try/catch-guarded for exactly
    // this race; onReadEnd's were not, so a belated 'end' after a silence
    // timeout already errored the stream would throw on an already-errored
    // controller instead of being a harmless no-op.
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.readable as ReadableStream<MainWorldDatagram>).getReader()

    udp.emitFatal('timeout')

    expect(() => { udp.emitEnd() }).not.toThrow()
    await expect(reader.read()).rejects.toMatchObject({ code: 'timeout' })
  })

  // A87: a refused send never rejects `writable` -- this is how the app
  // actually learns which of its own writes was refused and why.
  it('delivers a refused send on `refusals`, carrying its destination and code', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.refusals as ReadableStream<SendRefusal>).getReader()

    udp.emitRefusal({ address: '10.0.0.5', port: 4321, code: 'denied' })
    const { value } = await reader.read()

    expect(value).toEqual({ address: '10.0.0.5', port: 4321, code: 'denied' })
    reader.releaseLock()
  })

  it('drops a refusal rather than growing the queue once it is full', async () => {
    // `refusals` reports OUTBOUND send refusals, so it is sized off
    // LIMITS.outboundDatagramWindow (4), not the inbound window -- no
    // wire-level credit window paces refusals the way it paces inbound
    // datagrams, so an app that never reads `refusals` must not let the
    // broker's refusals pin unbounded memory here. Five refusals fired at an
    // unread stream must leave exactly four queued, the fifth dropped rather
    // than growing the queue past the mark.
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.refusals as ReadableStream<SendRefusal>).getReader()

    for (let i = 0; i < 5; i += 1) udp.emitRefusal({ address: '10.0.0.5', port: 4321 + i, code: 'denied' })

    const drained: SendRefusal[] = []
    for (let i = 0; i < 4; i += 1) drained.push((await reader.read()).value as SendRefusal)
    expect(drained.map((r) => r.port)).toEqual([4321, 4322, 4323, 4324])

    // The fifth refusal (port 4325) must have been dropped outright rather
    // than merely left queued behind the four already drained -- a sentinel
    // enqueued now lands in the read right after them only if the queue was
    // actually empty, which is what distinguishes "dropped" from "unread".
    udp.emitRefusal({ address: '10.0.0.5', port: 9999, code: 'denied' })
    expect((await reader.read()).value).toEqual({ address: '10.0.0.5', port: 9999, code: 'denied' })
    reader.releaseLock()
  })
})
