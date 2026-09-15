// Wires createBroker (../index.ts) to a real renderer over Electron IPC.
//
// SCOPE: app.manifest, app.grants, app.requestGrant, fs.readFile, fs.writeFile, id.publicKey,
// id.sign, net.connect, net.connectSecure, net.udpBind, net.close, net.setNoDelay, net.setKeepAlive. See ./README.md
// for the two rules every method here enforces (origin attribution off the
// sending frame, bytes never over request/response IPC) and
// ../../contracts/ipc.ts for the timeout and no-transferables rules
// withTimeout() and dispatch() apply below. net.connect's, net.connectSecure's
// and net.udpBind's port delivery are the only transferables this file ever
// sends; everything else on CONTROL_CHANNEL is plain cloned data.
//
// TESTABLE WITHOUT ELECTRON, the way src/main/registry.ts is:
// `handleControlRequest`, `dispatch` and `registerBrokerIpc` take a
// `Broker` and structurally-typed event/ipcMain/`PortTransport` rather than
// reaching for `electron` themselves -- see README.md's Design notes for
// why. Only `brokerIpcSubsystem`, which nothing in ipc.test.ts calls,
// touches the real `ipcMain`/`MessageChannelMain` value imports below.

import { ipcMain, MessageChannelMain } from 'electron'
import type { MessagePortMain } from 'electron'
import { CONTROL_CHANNEL, PORT_CHANNEL, SYNC_CONTROL_CHANNEL } from '../../main/channels.js'
import { publishBroker } from '../../main/registry.js'
import type { Subsystem, SubsystemContext } from '../../main/registry.js'
import { createBroker } from '../index.js'
import type { Broker, CreateBrokerOptions } from '../broker-contracts.js'
import { dialTcp, listenTcp, nodeFs, resolveHost } from '../adapters/node-adapters.js'
import { dialTls } from '../adapters/tls-adapter.js'
import { bindUdp } from '../adapters/udp-adapter.js'
import { nodeLedgerStorage } from '../grants/node-ledger-storage.js'
import { createPortRegistry } from './port-registry.js'
import { deliverTcpSocket } from './socket-relay.js'
import { createDatagramRelay } from './datagram-relay.js'
import { deliverTcpServer } from './server-relay.js'
import { deliverPort } from './deliver-port.js'
import { createTokenBucketLimiter } from './token-bucket.js'
import type { RateLimiter } from './token-bucket.js'
import { createSyncFsPolicy } from './sync-fs-policy.js'
import { handleSyncFsReadRequest } from './sync-fs.js'
import type { SyncControlEvent, SyncFsPolicy } from './sync-fs.js'
import { originFromSenderFrame } from '../policy/origin.js'
import { fail } from '../errors.js'
import { toFailureResponse } from './response-envelope.js'
import {
  envelopeId, isAppRequestGrantParams, isControlMethod, isFsPathWithRecursiveParams, isFsReaddirParams,
  isFsReadFileParams, isFsRenameParams, isFsStatParams, isFsWriteFileParams,
  isIdPublicKeyParams, isIdSignParams,
  isNetCloseParams, isNetConnectParams, isNetSetKeepAliveParams, isNetSetNoDelayParams,
  isNetUdpBindParams, isRequestEnvelope, type RequestGrantCtx
} from './ipc-validation.js'
import type {
  PortDeliveryFrame, PortLike, PortPair, PortTransport, UdpSocketDescriptor
} from './port-transport.js'
import type { CapabilityRequest, RequestEnvelope, ResponseEnvelope } from '../../contracts/index.js'
import { LIMITS } from '../../contracts/index.js'

export { CONTROL_CHANNEL, PORT_CHANNEL }
export type {
  AppRequestGrantParams, ControlMethod, FsPathWithRecursiveParams, FsReaddirParams, FsReadFileParams, FsRenameParams,
  FsStatParams, FsWriteFileParams, IdPublicKeyParams, IdSignParams,
  NetConnectParams, NetCloseParams, NetSetKeepAliveParams, NetSetNoDelayParams, NetUdpBindParams, RequestGrantCtx
} from './ipc-validation.js'
export type {
  PortDeliveryFrame, PortLike, PortPair, PortTransport, SocketDescriptor, TcpServerDescriptor, UdpSocketDescriptor
} from './port-transport.js'

export interface ControlEvent {
  readonly senderFrame: PortDeliveryFrame | null
}

/** One request, dispatched to `broker` with the origin THIS FUNCTION derived -- never one from `payload`. */
async function dispatch (
  broker: Broker,
  origin: string,
  method: string,
  payload: unknown,
  event: ControlEvent,
  transport: PortTransport | undefined,
  requestGrantCtx: RequestGrantCtx | undefined
): Promise<unknown> {
  if (!isControlMethod(method)) throw fail('invalid', `unknown control method: ${method}`)

  switch (method) {
    case 'app.manifest':
      return await broker.app.manifest(origin)
    case 'app.grants':
      return await broker.app.grants(origin)
    // `capability` is not re-validated here (Rule 3: request-grant.ts's
    // isCapabilityKind is the one check). Only capability/patterns cross,
    // never the rest of `payload`, even one naming its own `origin` (T3).
    case 'app.requestGrant': {
      if (!isAppRequestGrantParams(payload)) throw fail('invalid', 'app.requestGrant requires { capability: string, patterns?: string[] }')
      if (requestGrantCtx?.requestGrant === undefined) throw fail('internal', 'requestGrant is not available -- request-grant subsystem failed to start')
      const request: CapabilityRequest = payload.patterns === undefined
        ? { capability: payload.capability }
        : { capability: payload.capability, patterns: payload.patterns }
      return await requestGrantCtx.requestGrant(origin, request)
    }
    case 'fs.readFile': {
      if (!isFsReadFileParams(payload)) throw fail('invalid', 'fs.readFile requires { path: string }')
      return await broker.fs.readFile(origin, payload.path)
    }
    case 'fs.writeFile': {
      if (!isFsWriteFileParams(payload)) throw fail('invalid', 'fs.writeFile requires { path: string, data: Uint8Array }')
      await broker.fs.writeFile(origin, payload.path, payload.data)
      return undefined
    }
    case 'fs.mkdir': {
      if (!isFsPathWithRecursiveParams(payload)) throw fail('invalid', 'fs.mkdir requires { path: string, recursive?: boolean }')
      await broker.fs.mkdir(origin, payload.path, payload.recursive === undefined ? undefined : { recursive: payload.recursive })
      return undefined
    }
    case 'fs.readdir': {
      if (!isFsReaddirParams(payload)) throw fail('invalid', 'fs.readdir requires { path: string }')
      return await broker.fs.readdir(origin, payload.path)
    }
    case 'fs.stat': {
      if (!isFsStatParams(payload)) throw fail('invalid', 'fs.stat requires { path: string }')
      return await broker.fs.stat(origin, payload.path)
    }
    case 'fs.rm': {
      if (!isFsPathWithRecursiveParams(payload)) throw fail('invalid', 'fs.rm requires { path: string, recursive?: boolean }')
      await broker.fs.rm(origin, payload.path, payload.recursive === undefined ? undefined : { recursive: payload.recursive })
      return undefined
    }
    case 'fs.rename': {
      if (!isFsRenameParams(payload)) throw fail('invalid', 'fs.rename requires { from: string, to: string }')
      await broker.fs.rename(origin, payload.from, payload.to)
      return undefined
    }
    // id.publicKey/sign carry no port transport of their own -- a plain
    // Uint8Array response, exactly fs.readFile's shape, unlike net.connect's
    // below.
    case 'id.publicKey': {
      if (!isIdPublicKeyParams(payload)) throw fail('invalid', 'id.publicKey requires { curve: string }')
      return await broker.id.publicKey(origin, { curve: payload.curve })
    }
    case 'id.sign': {
      if (!isIdSignParams(payload)) throw fail('invalid', 'id.sign requires { curve: string, payload: Uint8Array }')
      return await broker.id.sign(origin, { curve: payload.curve, payload: payload.payload })
    }
    case 'net.connect': {
      if (!isNetConnectParams(payload)) throw fail('invalid', 'net.connect requires { host: string, port: number }')
      if (transport === undefined) throw fail('internal', 'no port transport configured for this broker')
      const socket = await broker.net.connect(origin, { host: payload.host, port: payload.port })
      return await deliverTcpSocket(origin, socket, event, transport)
    }
    // A SIBLING of net.connect above, not a variant: the broker method
    // (checked against the separate https.connect grant and dialled via
    // node:tls -- ../net-capability.ts's own connectSecure) is the only
    // thing that differs. `broker.net.connectSecure` resolves to the exact
    // same FailableTcpSocket shape net.connect does, so everything past
    // that call -- the port pair, the byte-pump relay, the port delivery,
    // the descriptor -- is deliverTcpSocket, unchanged.
    case 'net.connectSecure': {
      if (!isNetConnectParams(payload)) throw fail('invalid', 'net.connectSecure requires { host: string, port: number }')
      if (transport === undefined) throw fail('internal', 'no port transport configured for this broker')
      const socket = await broker.net.connectSecure(origin, { host: payload.host, port: payload.port })
      return await deliverTcpSocket(origin, socket, event, transport)
    }
    // A114/d-0028: the server's own port is delivered the same way a
    // net.connect socket's is (deliverTcpServer, ./server-relay.ts); each
    // connection it later accepts arrives over THAT port as an
    // AcceptedMessage, not through another control-channel round trip.
    case 'net.listen': {
      if (!isNetUdpBindParams(payload)) throw fail('invalid', 'net.listen requires { port: number }')
      if (transport === undefined) throw fail('internal', 'no port transport configured for this broker')
      const server = await broker.net.listen(origin, { port: payload.port })
      return await deliverTcpServer(origin, server, event, transport)
    }
    case 'net.udpBind': {
      if (!isNetUdpBindParams(payload)) throw fail('invalid', 'net.udpBind requires { port: number }')
      if (transport === undefined) throw fail('internal', 'no port transport configured for this broker')
      const socket = await broker.net.udpBind(origin, { port: payload.port })

      const pair = transport.createPortPair()
      const relay = createDatagramRelay({
        origin,
        socket,
        port: pair.port1,
        registry: transport.registry,
        inboundWindow: LIMITS.inboundDatagramWindow,
        inboundWindowBytes: LIMITS.inboundDatagramWindowBytes,
        outboundWindow: LIMITS.outboundDatagramWindow
      })

      const abandon = async (reason: string): Promise<never> => {
        relay.stop('internal')
        try {
          await socket.close()
        } catch {
          // As net.connect's: the handle table already owns the release.
        }
        throw fail('internal', reason)
      }

      await deliverPort({
        origin,
        handleId: socket.id,
        frame: event.senderFrame,
        port2: pair.port2,
        abandon
      })

      const descriptor: UdpSocketDescriptor = {
        id: socket.id,
        localAddress: socket.localAddress,
        localPort: socket.localPort
      }
      return descriptor
    }
    case 'net.close': {
      if (!isNetCloseParams(payload)) throw fail('invalid', 'net.close requires { id: string }')
      // Idempotent, silent no-op for an id this origin was never handed --
      // matching TcpSocket.close()'s own contract (handle-contracts.md's
      // "Common shape" section) -- rather than distinguishing "wrong origin"
      // from "already gone", either of which would let an app probe for
      // handles it does not hold.
      const entry = transport?.registry.get(origin, payload.id)
      if (entry !== undefined) await entry.close()
      return undefined
    }
    case 'net.setNoDelay': {
      if (!isNetSetNoDelayParams(payload)) throw fail('invalid', 'net.setNoDelay requires { id: string, on: boolean }')
      // Same T11c ownership check and same silent-no-op contract as
      // net.close above, over the same registry -- a handle id from one
      // origin means nothing presented by another.
      const entry = transport?.registry.get(origin, payload.id)
      // 'invalid', not the silent no-op an unknown id gets: the app HOLDS this
      // handle, so calling a TCP-only option on it is its own bug rather than
      // a probe for handles it does not have, and telling it so leaks nothing.
      if (entry?.kind === 'udp') throw fail('invalid', 'setNoDelay is not available on a UDP socket')
      if (entry?.kind === 'server') throw fail('invalid', 'setNoDelay is not available on a TCP server')
      if (entry !== undefined) await entry.setNoDelay(payload.on)
      return undefined
    }
    case 'net.setKeepAlive': {
      if (!isNetSetKeepAliveParams(payload)) throw fail('invalid', 'net.setKeepAlive requires { id: string, on: boolean }')
      const entry = transport?.registry.get(origin, payload.id)
      if (entry?.kind === 'udp') throw fail('invalid', 'setKeepAlive is not available on a UDP socket')
      if (entry?.kind === 'server') throw fail('invalid', 'setKeepAlive is not available on a TCP server')
      if (entry !== undefined) await entry.setKeepAlive(payload.on, payload.initialDelayMs)
      return undefined
    }
  }
}

/**
 * Races `promise` against `timeoutMs`. ../../contracts/ipc.ts's rule 2: this
 * transport fails by SILENCE, and `timeoutMs` is a required field precisely
 * so nothing on this path can forget to bound the wait. The underlying
 * broker call is not cancelled when the timer wins -- there is no cancel
 * signal threaded through `dispatch` for this -- it is left to settle on its
 * own and its result is discarded; what matters is that the CALLER is never
 * left waiting past its own stated budget.
 */
async function withTimeout<T> (promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(fail('timeout', `control call exceeded its ${timeoutMs}ms budget`))
    }, timeoutMs)
    timer.unref()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) }
    )
  })
}

/** Default for a caller (chiefly tests) that passes no real limiter. Never rejects; holds no state. */
const ALLOW_ALL_LIMITER: RateLimiter = { tryConsume: () => true }

/**
 * The pure core: one request in, one response out. No Electron, no I/O --
 * everything that touches either is INJECTED (`broker`, `event`,
 * `transport`).
 *
 * Origin derivation happens here and ONLY here (DoD rule 1): `event.
 * senderFrame` is the sole source of the caller's identity. `envelope.
 * payload` is never inspected for anything resembling an origin.
 *
 * `transport` is optional so every call site that never touches net.connect/
 * net.close -- which is most of this file's own test suite -- does not need
 * one; dispatch() throws 'internal' if a call that needs it is ever made
 * without one, which is a wiring bug, not a capability decision.
 *
 * `limiter` and `requestGrantCtx` are optional the same way (never
 * throttled; 'internal' from dispatch() if app.requestGrant runs without
 * one) -- real wiring always supplies both, see `brokerIpcSubsystem`.
 */
export async function handleControlRequest (
  broker: Broker,
  event: ControlEvent,
  envelope: RequestEnvelope<unknown>,
  transport?: PortTransport,
  limiter?: RateLimiter,
  requestGrantCtx?: RequestGrantCtx
): Promise<ResponseEnvelope<unknown>> {
  // The envelope itself is untrusted, not just its payload. Reading
  // `envelope.id` off a null or non-object value throws a TypeError straight
  // out of the ipcMain.handle listener, which reaches the renderer as a
  // rejected invoke() carrying a raw V8 message instead of a ResponseEnvelope
  // -- the one shape every caller on this channel is entitled to. The same
  // defence-in-depth reason as dispatch()'s payload validation: a compromised
  // renderer process reaches this channel directly, without contextBridge.
  if (!isRequestEnvelope(envelope)) {
    return { id: envelopeId(envelope), ok: false, code: 'invalid', message: 'malformed request envelope' }
  }

  const origin = originFromSenderFrame(event.senderFrame)
  if (origin === null) {
    return { id: envelope.id, ok: false, code: 'denied', message: 'no authenticated origin for this frame' }
  }

  // A38's fix: checked here, before dispatch() ever runs, so a throttled
  // call never reaches the broker at all -- the same "reject immediately,
  // never queue" rule the in-flight cap already applies (handles.ts).
  if (!(limiter ?? ALLOW_ALL_LIMITER).tryConsume(origin)) {
    return { id: envelope.id, ok: false, code: 'limit', message: 'this origin is calling too frequently; wait and retry' }
  }

  try {
    const result = await withTimeout(dispatch(broker, origin, envelope.method, envelope.payload, event, transport, requestGrantCtx), envelope.timeoutMs)
    return { id: envelope.id, ok: true, result }
  } catch (error) {
    return toFailureResponse(envelope.id, error)
  }
}

/** The one method this module needs from `electron`'s real `IpcMain`. Structural, so a test double never needs the real type. */
export interface IpcMainLike {
  handle (
    channel: string,
    listener: (event: ControlEvent, envelope: RequestEnvelope<unknown>) => Promise<ResponseEnvelope<unknown>>
  ): void
}

/** Thin wiring: one `ipcMain.handle` registration over `handleControlRequest`, sharing one `PortTransport` and `RateLimiter` across every call. */
export function registerBrokerIpc (ipc: IpcMainLike, broker: Broker, transport: PortTransport, limiter?: RateLimiter, requestGrantCtx?: RequestGrantCtx): void {
  ipc.handle(CONTROL_CHANNEL, async (event, envelope) => await handleControlRequest(broker, event, envelope, transport, limiter, requestGrantCtx))
}

/**
 * The one method this module needs from `electron`'s real `IpcMain` for the
 * SYNCHRONOUS half, distinct from `IpcMainLike` above: `on`, not `handle`,
 * and the listener sets `event.returnValue` rather than returning a Promise
 * -- `ipcRenderer.sendSync`'s counterpart, never awaited on either side.
 */
export interface IpcMainOnLike {
  on (
    channel: string,
    listener: (event: SyncControlEvent & { returnValue: unknown }, payload: unknown) => void
  ): void
}

/** Thin wiring over `handleSyncFsReadRequest`, sharing `limiter` with `registerBrokerIpc` so this channel cannot be used to dodge CONTROL_CHANNEL's rate limit. */
export function registerSyncFsIpc (ipc: IpcMainOnLike, policy: SyncFsPolicy, limiter?: RateLimiter): void {
  ipc.on(SYNC_CONTROL_CHANNEL, (event, payload) => {
    event.returnValue = handleSyncFsReadRequest(policy, event, payload, limiter)
  })
}

/** A real `PortPair`, backed by an actual `MessageChannelMain`. The one place this module constructs one. */
function realPortPair (): PortPair {
  const { port1, port2 } = new MessageChannelMain()
  const wrapped: PortLike = {
    // `transfer` is `unknown[]` at this structural boundary (./port-transport.ts's
    // own PortPair.port2, `unknown` for the same reason) but is ALWAYS, in
    // production, an array of this module's own freshly-minted MessagePortMain
    // values -- the only thing anything in this file ever puts in one. Cast at
    // this one real-Electron call site rather than widening MessagePortMain's
    // own `.postMessage` signature.
    postMessage: (message, transfer) => { port1.postMessage(message, transfer as MessagePortMain[] | undefined) },
    onMessage: (listener) => { port1.on('message', (event) => { listener(event.data) }) },
    onClose: (listener) => { port1.on('close', listener) },
    close: () => { port1.close() }
  }
  port1.start()
  return { port1: wrapped, port2 }
}

// AI recommendation (open-questions.md A38), not an owner decision, and
// shared across all eight methods on purpose. See README.md's Design notes
// for the incident this replaced and the fairness risk it leaves open.
const CONTROL_RATE_LIMIT_CAPACITY = 200
const CONTROL_RATE_LIMIT_REFILL_PER_SECOND = 100

/**
 * Builds the production `Broker` and registers it on `ipcMain`. The one
 * place this module's `electron` value imports are used.
 *
 * `critical: true` (registry.ts's own doc on `Subsystem.critical`): if this
 * fails, no control channel is ever registered and every `orivon.*` call
 * from every app is unroutable for the rest of the run. `main/index.ts`
 * treats a critical failure here as fatal to startup rather than opening a
 * shell window with a dark capability layer (open-questions.md A51).
 */
export const brokerIpcSubsystem: Subsystem = {
  name: 'broker',
  critical: true,
  afterReady: (ctx: SubsystemContext) => {
    const realNow = (): number => Date.now()
    const deps: CreateBrokerOptions = {
      dial: dialTcp,
      // `dialTls` -- ADR-0017's real node:tls stack, no override, no new
      // dependency. net.connectSecure now has a control-channel case too
      // (dispatch()'s 'net.connectSecure', via deliverTcpSocket) -- this
      // stays the one place that real dialler is wired in.
      dialSecure: dialTls,
      bind: bindUdp,
      listen: listenTcp,
      resolve: resolveHost,
      now: realNow,
      fs: nodeFs(ctx.app.getPath('userData')),
      ledgerStorage: nodeLedgerStorage(ctx.app.getPath('userData')),
      // ADR-0010 key derivation is not implemented yet (broker/index.ts's
      // own header: "nothing below calls it yet") -- none of the six wired
      // control operations reach `orivon.id`.
      keychain: {
        getSeed: async () => { throw fail('internal', 'identity key derivation is not implemented yet (ADR-0010)') }
      }
    }
    const transport: PortTransport = { createPortPair: realPortPair, registry: createPortRegistry() }
    const limiter = createTokenBucketLimiter({
      capacity: CONTROL_RATE_LIMIT_CAPACITY,
      refillPerSecond: CONTROL_RATE_LIMIT_REFILL_PER_SECOND,
      now: realNow
    })
    const broker = createBroker(deps)
    // publishBroker (src/main/registry.ts) is the one sanctioned way to set
    // ctx.broker -- it throws instead of silently overwriting if this ever
    // runs twice, so a later subsystem is guaranteed to read this same
    // instance rather than a second, disagreeing one.
    publishBroker(ctx, broker)
    // `ctx` itself, not a captured `ctx.requestGrant` -- see RequestGrantCtx's own doc (ipc-validation.ts) for why.
    registerBrokerIpc(ipcMain, broker, transport, limiter, ctx)

    // ./sync-fs-policy.ts's createSyncFsPolicy calls straight through to
    // broker.fs.confineSync -- ADR-0016's synchronous grant-check/
    // confinement entry point on the SAME broker instance registerBrokerIpc
    // just wired, so a grant issued through any route (the app loader's
    // permission prompt later, src/main/dev-grant.ts's hook today) is live
    // for this channel the instant it lands on that one instance.
    registerSyncFsIpc(ipcMain, createSyncFsPolicy(broker), limiter)
  }
}
