import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import type { MainWorldDatagram, MainWorldUdpBridge } from '../main-world-socket.js'
import type { OrivonErrorCode } from '../../contracts/errors.js'
import type { SendRefusal } from '../../contracts/handles.js'

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
  udpResult?: ReturnType<typeof fakeUdpBridgeResult>
): {
  appManifest: () => Promise<unknown>, appGrants: () => Promise<unknown>
  fsReadFile: (path: string) => Promise<Uint8Array>, fsWriteFile: (path: string, data: Uint8Array) => Promise<void>
  netConnect: (opts: { host: string, port: number }) => Promise<ReturnType<typeof fakeSocketBridgeResult>>
  netUdpBind: (opts: { port: number }) => Promise<MainWorldUdpBridge>
} {
  return {
    appManifest: async () => ({ orivonApiVersion: 0 }),
    appGrants: async () => [],
    fsReadFile: async () => new Uint8Array(),
    fsWriteFile: async () => {},
    netConnect: async (_opts) => netConnectResult,
    netUdpBind: async (_opts) => udpResult ?? fakeUdpBridgeResult()
  }
}

/** A MainWorldUdpBridge double whose callbacks the test drives by hand. */
export function fakeUdpBridgeResult (): MainWorldUdpBridge & {
  emit: (datagram: MainWorldDatagram) => void
  emitDropped: (inbound: number, outbound: number) => void
  emitRefusal: (refusal: SendRefusal) => void
  emitEnd: (code?: OrivonErrorCode) => void
  readonly sent: MainWorldDatagram[]
  readonly consumed: Array<{ datagrams: number, bytes: number }>
} {
  let onDatagram: (d: MainWorldDatagram) => void = () => {}
  let onDropped: (i: number, o: number) => void = () => {}
  let onRefusal: (r: SendRefusal) => void = () => {}
  let onReadEnd: (code: OrivonErrorCode | undefined) => void = () => {}
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
    onFatal: () => {},
    reportConsumed: (datagrams, bytes) => { consumed.push({ datagrams, bytes }) },
    send: async (datagram) => { sent.push(datagram) },
    closed: new Promise<void>(() => {}),
    close: async () => {},
    emit: (datagram) => { onDatagram(datagram) },
    emitDropped: (inbound, outbound) => { onDropped(inbound, outbound) },
    emitRefusal: (refusal) => { onRefusal(refusal) },
    emitEnd: (code) => { onReadEnd(code) },
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
    // LIMITS.inboundDatagramWindow is 8 -- no wire-level credit window paces
    // refusals the way it paces inbound datagrams, so an app that never reads
    // `refusals` must not let the broker's refusals pin unbounded memory here.
    // Nine refusals fired at an unread stream must leave exactly eight
    // queued, the ninth dropped rather than growing the queue past the mark.
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })

    for (let i = 0; i < 9; i += 1) udp.emitRefusal({ address: '10.0.0.5', port: 4321 + i, code: 'denied' })

    const reader = (socket.refusals as ReadableStream<SendRefusal>).getReader()
    const drained: SendRefusal[] = []
    for (let i = 0; i < 8; i += 1) drained.push((await reader.read()).value as SendRefusal)

    expect(drained).toHaveLength(8)
    expect(drained.map((r) => r.port)).toEqual([4321, 4322, 4323, 4324, 4325, 4326, 4327, 4328])
    reader.releaseLock()
  })
})
