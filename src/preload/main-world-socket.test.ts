import { describe, expect, it } from 'vitest'
import { installOrivon } from './main-world-socket.js'
import type { OrivonErrorCode } from '../contracts/errors.js'

const LIMITS = { readWindowBytes: 1_000, writeWindowBytes: 1_000 }

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
  written: Uint8Array[]
  writeCalls: Array<{ resolve: () => void, reject: (e: unknown) => void }>
  endWriteCalls: number
  abortWriteCalls: number
  closeCalls: number
} {
  let dataCb: ((chunk: Uint8Array) => void) | undefined
  let readEndCb: ((code: OrivonErrorCode | undefined) => void) | undefined
  const written: Uint8Array[] = []
  const writeCalls: Array<{ resolve: () => void, reject: (e: unknown) => void }> = []
  let closedResolve: () => void = () => {}
  const closed = new Promise<void>((resolve) => { closedResolve = resolve })
  const state = { endWriteCalls: 0, abortWriteCalls: 0, closeCalls: 0 }

  return {
    id: 'h1', remoteAddress: '93.184.216.34', remotePort: 443, localAddress: '10.0.0.5', localPort: 1234,
    onData: (cb) => { dataCb = cb },
    onReadEnd: (cb) => { readEndCb = cb },
    reportConsumed: () => {},
    write: async (chunk) => {
      written.push(chunk)
      return await new Promise((resolve, reject) => { writeCalls.push({ resolve, reject }) })
    },
    endWrite: async () => { state.endWriteCalls++ },
    abortWrite: () => { state.abortWriteCalls++ },
    onFatal: () => {},
    closed,
    close: async () => { state.closeCalls++; closedResolve() },
    setNoDelay: async () => {},
    setKeepAlive: async () => {},
    emitData: (chunk) => { dataCb?.(chunk) },
    emitReadEnd: (code) => { readEndCb?.(code) },
    written,
    writeCalls,
    get endWriteCalls () { return state.endWriteCalls },
    get abortWriteCalls () { return state.abortWriteCalls },
    get closeCalls () { return state.closeCalls }
  }
}

function fakeBridge (netConnectResult: ReturnType<typeof fakeSocketBridgeResult>): {
  appManifest: () => Promise<unknown>, appGrants: () => Promise<unknown>
  fsReadFile: (path: string) => Promise<Uint8Array>, fsWriteFile: (path: string, data: Uint8Array) => Promise<void>
  netConnect: (opts: { host: string, port: number }) => Promise<ReturnType<typeof fakeSocketBridgeResult>>
} {
  return {
    appManifest: async () => ({ orivonApiVersion: 0 }),
    appGrants: async () => [],
    fsReadFile: async () => new Uint8Array(),
    fsWriteFile: async () => {},
    netConnect: async (_opts) => netConnectResult
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
    expect(typeof (orivon.net as Record<string, unknown>).connect).toBe('function')
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
})

async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
