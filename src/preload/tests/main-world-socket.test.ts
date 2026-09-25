import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import type { FileStat } from '../../contracts/handles.js'
import { LIMITS, fakeBridge, fakeSocketBridgeResult, tick } from './main-world-socket.test-helpers.js'

/** P-F6 below can run a whole `npm run build` inline -- always on a fresh CI
 * runner, where `npm test` runs before `npm run build` -- and vitest's 5 s
 * default is shorter than a cold build of the whole app. */
const INLINE_BUILD_TIMEOUT_MS = 120_000

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

  it('app.requestGrant delegates to bridge.appRequestGrant with the request unwrapped, and returns whatever it resolves', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const calls: unknown[] = []
    bridge.appRequestGrant = async (request) => { calls.push(request); return false }
    installOrivon(bridge, LIMITS, target)

    const orivon = target.orivon as { app: { requestGrant: (request: { capability: string, patterns?: readonly string[] }) => Promise<boolean> } }
    const granted = await orivon.app.requestGrant({ capability: 'fs' })

    expect(granted).toBe(false)
    expect(calls).toEqual([{ capability: 'fs' }])
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
      expect(caught).toBeInstanceOf(Error)
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

  // A152 (docs/open-questions.md): ../orivon-error.ts's isolated-world
  // toOrivonError deliberately rejects with a PLAIN OBJECT so it survives
  // contextBridge's promise-rejection marshalling -- but that marshalling
  // leaves it a plain object here too, never `instanceof Error`, which
  // breaks the contract (`OrivonError extends Error`) for every consumer,
  // not just src/shim/. installOrivon revives it into a real Error before
  // the page ever sees the rejection.
  it('A152: revives a bridge rejection that crossed as a plain object into a real Error', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.netConnect = async () => {
      throw { name: 'OrivonError', message: 'tcp.connect is not granted to this origin', code: 'denied' }
    }
    installOrivon(bridge, LIMITS, target)

    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<unknown> } }
    let caught: unknown
    try {
      await orivon.net.connect({ host: 'x.example', port: 443 })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('denied')
    expect((caught as { message?: string }).message).toBe('tcp.connect is not granted to this origin')
  })

  it('passes a rejection that does not look like an OrivonError through unchanged', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const boom = new Error('a real, ordinary failure')
    bridge.netConnect = async () => { throw boom }
    installOrivon(bridge, LIMITS, target)

    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<unknown> } }
    await expect(orivon.net.connect({ host: 'x.example', port: 443 })).rejects.toBe(boom)
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

  it('a net.connectSecure socket carries its handshake facts; a net.connect socket carries none', async () => {
    const target: Record<string, unknown> = {}
    const raw = new Uint8Array([48, 3])
    const secureResult = Object.assign(fakeSocketBridgeResult(), {
      tls: {
        authorized: false,
        authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        alpnProtocol: 'h2' as const,
        peerCertificate: {
          subject: { CN: 'node.lan' }, issuer: { CN: 'node.lan' }, valid_from: 'a', valid_to: 'b',
          serialNumber: '01', fingerprint: 'AA', fingerprint256: 'BB', raw
        }
      }
    })
    installOrivon(fakeBridge(fakeSocketBridgeResult(), undefined, undefined, secureResult), LIMITS, target)
    const orivon = target.orivon as { net: Record<string, (opts: unknown) => Promise<Record<string, unknown>>> }

    const secure = await orivon.net.connectSecure!({ host: 'node.lan', port: 50002, rejectUnauthorized: false })
    const plain = await orivon.net.connect!({ host: 'node.lan', port: 50001 })

    expect(secure).toMatchObject({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', alpnProtocol: 'h2' })
    const cert = secure.peerCertificate as { subject: Record<string, string>, raw: Uint8Array }
    expect(cert.subject).toEqual({ CN: 'node.lan' })
    expect(cert.raw).toEqual(raw)
    expect(Object.isFrozen(cert) && Object.isFrozen(cert.subject)).toBe(true)
    expect('authorized' in plain).toBe(false)
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

  // A152: this local toOrivonError never has to cross contextBridge again
  // (unlike ../orivon-error.ts's isolated-world twin) -- it builds a real
  // Error, so `OrivonError extends Error` (../../contracts/errors.ts) holds
  // for a stream error too, not only for the initial connect() rejection.
  it('A152: a stream error built from a fatal code is a real Error instance', async () => {
    const result = fakeSocketBridgeResult()
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(result), LIMITS, target)
    const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<{ readable: ReadableStream<Uint8Array> }> } }
    const socket = await orivon.net.connect({ host: 'x.example', port: 443 })
    const reader = socket.readable.getReader()

    result.emitFatal('reset')

    let caught: unknown
    try {
      await reader.read()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('reset')
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
  }, INLINE_BUILD_TIMEOUT_MS)
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
  // Recursive: src/preload is split into job folders (surface/, ports/,
  // routed/), and a non-recursive listing would stop seeing them. Tests are
  // excluded -- editing a test should never force a rebuild.
  return ['src/preload', 'src/contracts'].some((dir) => {
    const full = resolve(process.cwd(), dir)
    return readdirSync(full, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') && !name.includes('tests/'))
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
