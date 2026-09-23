// Shared fixtures for main-world-socket.test.ts and main-world-socket-udp.
// test.ts (split out of one file that exceeded docs/development/
// code-guidelines.md's 800-line test limit -- the UDP describe block moved
// out whole, since it is the one concern in that file with no TCP-socket
// dependency). Not *.test.ts, so vitest does not collect it as its own suite.

import type {
  MainWorldDatagram, MainWorldDirectoryBridge, MainWorldFileBridge, MainWorldServerBridge,
  MainWorldSocketBridge, MainWorldUdpBridge, MainWorldWebContextBridge
} from '../main-world-socket.js'
import type { OrivonErrorCode } from '../../contracts/errors.js'
import type { FileStat, SendRefusal } from '../../contracts/handles.js'
import type { ResponseEnvelope } from '../../contracts/ipc.js'

export const LIMITS = {
  readWindowBytes: 1_000, writeWindowBytes: 1_000,
  inboundDatagramWindow: 8, outboundDatagramWindow: 4
}

/** A fake SocketPort-shaped bridge result -- everything main-world-socket.ts needs from bridge.netConnect(). */
export function fakeSocketBridgeResult (): {
  id: string, remoteAddress: string, remotePort: number, localAddress: string, localPort: number
  onData: (cb: (chunk: Uint8Array) => void) => void
  onReadEnd: (cb: (code: OrivonErrorCode | undefined, platformCode?: string) => void) => void
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
  emitReadEnd: (code?: OrivonErrorCode, platformCode?: string) => void
  emitFatal: (code: OrivonErrorCode) => void
  written: Uint8Array[]
  writeCalls: Array<{ resolve: () => void, reject: (e: unknown) => void }>
  reportConsumedCalls: number[]
  endWriteCalls: number
  abortWriteCalls: number
  closeCalls: number
} {
  let dataCb: ((chunk: Uint8Array) => void) | undefined
  let readEndCb: ((code: OrivonErrorCode | undefined, platformCode?: string) => void) | undefined
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
    emitReadEnd: (code, platformCode) => { readEndCb?.(code, platformCode) },
    emitFatal: (code) => { fatalCb?.(code) },
    written,
    writeCalls,
    reportConsumedCalls,
    get endWriteCalls () { return state.endWriteCalls },
    get abortWriteCalls () { return state.abortWriteCalls },
    get closeCalls () { return state.closeCalls }
  }
}

/** A fake `bridge.fsOpen()` result -- everything `buildFile` (main-world-socket.ts) needs. */
export function fakeFileBridgeResult (overrides: Partial<MainWorldFileBridge> = {}): MainWorldFileBridge {
  return {
    id: 'f1',
    read: async () => new Uint8Array([1, 2, 3]),
    write: async () => 3,
    stat: async () => ({ size: 3, isFile: true, isDirectory: false, mtimeMs: 0 }),
    truncate: async () => {},
    sync: async () => {},
    close: async () => {},
    ...overrides
  }
}

/** A fake `bridge.webOpenContext()` result (ADR-0019) -- everything `buildWebContext` (main-world-socket.ts) needs. */
export function fakeWebContextBridgeResult (overrides: Partial<MainWorldWebContextBridge> = {}): MainWorldWebContextBridge {
  return {
    id: 'ctx1',
    origin: 'https://example.com',
    closed: new Promise(() => {}),
    evaluate: async () => 'https://example.com',
    close: async () => {},
    ...overrides
  }
}

/** A fake `bridge.fsUserSelectedDirectory()` result (A195) -- everything `buildDirectory` (main-world-socket.ts) needs. */
export function fakeDirectoryBridgeResult (overrides: Partial<MainWorldDirectoryBridge> = {}): MainWorldDirectoryBridge {
  return {
    id: 'd1',
    readdir: async () => ['a.txt'],
    stat: async () => ({ size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }),
    mkdir: async () => {},
    rm: async () => {},
    rename: async () => {},
    readFile: async () => new Uint8Array([1, 2, 3]),
    writeFile: async () => {},
    open: async () => fakeFileBridgeResult(),
    close: async () => {},
    ...overrides
  }
}

export function fakeBridge (
  netConnectResult: ReturnType<typeof fakeSocketBridgeResult>,
  udpResult?: ReturnType<typeof fakeUdpBridgeResult>,
  fsReadFileSync: (path: string) => ResponseEnvelope<Uint8Array> = () => ({ id: '', ok: true, result: new Uint8Array() }),
  netConnectSecureResult: ReturnType<typeof fakeSocketBridgeResult> = fakeSocketBridgeResult(),
  serverResult?: ReturnType<typeof fakeServerBridgeResult>
): {
  appManifest: () => Promise<unknown>, appGrants: () => Promise<unknown>
  appRequestGrant: (request: { capability: string, patterns?: readonly string[] }) => Promise<boolean>
  fsReadFile: (path: string) => Promise<Uint8Array>, fsWriteFile: (path: string, data: Uint8Array) => Promise<void>
  fsReadFileSync: (path: string) => ResponseEnvelope<Uint8Array>
  fsMkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
  fsReaddir: (path: string) => Promise<readonly string[]>
  fsStat: (path: string) => Promise<FileStat>
  fsRm: (path: string, opts?: { recursive?: boolean }) => Promise<void>
  fsRename: (from: string, to: string) => Promise<void>
  fsOpen: (path: string, flags: string) => Promise<MainWorldFileBridge>
  fsUserSelected: (opts?: { multiple?: boolean }) => Promise<readonly MainWorldFileBridge[]>
  fsUserSelectedDirectory: () => Promise<MainWorldDirectoryBridge | null>
  idPublicKey: (curve: string) => Promise<Uint8Array>, idSign: (curve: string, payload: Uint8Array) => Promise<Uint8Array>
  webOpenContext: (opts: { origin: string, width?: number, height?: number }) => Promise<MainWorldWebContextBridge>
  netConnect: (opts: { host: string, port: number }) => Promise<ReturnType<typeof fakeSocketBridgeResult>>
  netConnectSecure: (opts: { host: string, port: number }) => Promise<ReturnType<typeof fakeSocketBridgeResult>>
  netUdpBind: (opts: { port: number }) => Promise<MainWorldUdpBridge>
  netListen: (opts: { port: number }) => Promise<MainWorldServerBridge>
  netLookup: (opts: { hostname: string }) => Promise<ReadonlyArray<{ address: string, family: 'IPv4' | 'IPv6' }>>
} {
  return {
    appManifest: async () => ({ orivonApiVersion: 0 }),
    appGrants: async () => [],
    appRequestGrant: async () => true,
    fsReadFile: async () => new Uint8Array(),
    fsWriteFile: async () => {},
    fsReadFileSync,
    fsMkdir: async () => {},
    fsReaddir: async () => [],
    fsStat: async () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }),
    fsRm: async () => {},
    fsRename: async () => {},
    fsOpen: async () => fakeFileBridgeResult(),
    // Present so this fake still satisfies installOrivon's bridge shape --
    // main-world-socket-fs.test.ts is the one that drives fs.userSelected
    // specifically; every other caller here only needs fsOpen.
    fsUserSelected: async () => [fakeFileBridgeResult()],
    // Same story, one level down (A195) -- main-world-socket-fs.test.ts's
    // own folder-shape tests are the ones that drive this directly.
    fsUserSelectedDirectory: async () => fakeDirectoryBridgeResult(),
    idPublicKey: async () => new Uint8Array(),
    idSign: async () => new Uint8Array(),
    // Present so this fake still satisfies installOrivon's bridge shape --
    // no test in this file drives web.openContext (main-world-socket-web.
    // test.ts, this lane's own sibling, does).
    webOpenContext: async () => fakeWebContextBridgeResult(),
    netConnect: async (_opts) => netConnectResult,
    // A SEPARATE fake result by default (its own fakeSocketBridgeResult(),
    // not netConnectResult) -- reusing the same one would let a bug that
    // called bridge.netConnect instead of bridge.netConnectSecure pass
    // silently, since both fields would then resolve to an identical object.
    netConnectSecure: async (_opts) => netConnectSecureResult,
    netUdpBind: async (_opts) => udpResult ?? fakeUdpBridgeResult(),
    netListen: async (_opts) => serverResult ?? fakeServerBridgeResult(),
    // Present so this fake still satisfies installOrivon's bridge shape --
    // no test in this file drives net.lookup (main-world-lookup.test.ts,
    // this lane's own sibling, does).
    netLookup: async () => []
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

/** A MainWorldServerBridge double whose callbacks the test drives by hand -- ./fakeUdpBridgeResult's counterpart for net.listen (A114, d-0028). */
export function fakeServerBridgeResult (): MainWorldServerBridge & {
  emitConnection: (socket: MainWorldSocketBridge) => void
  emitEnd: (code?: OrivonErrorCode) => void
  readonly reportAcceptedCalls: number
  readonly closeCalls: number
} {
  let onConnection: (socket: MainWorldSocketBridge) => void = () => {}
  let onReadEnd: (code: OrivonErrorCode | undefined) => void = () => {}
  const state = { reportAcceptedCalls: 0, closeCalls: 0 }
  return {
    id: 's1',
    localAddress: '0.0.0.0',
    localPort: 6881,
    onConnection: (cb) => { onConnection = cb },
    onReadEnd: (cb) => { onReadEnd = cb },
    reportAccepted: () => { state.reportAcceptedCalls++ },
    closed: new Promise<void>(() => {}),
    close: async () => { state.closeCalls++ },
    emitConnection: (socket) => { onConnection(socket) },
    emitEnd: (code) => { onReadEnd(code) },
    get reportAcceptedCalls () { return state.reportAcceptedCalls },
    get closeCalls () { return state.closeCalls }
  }
}

export async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
