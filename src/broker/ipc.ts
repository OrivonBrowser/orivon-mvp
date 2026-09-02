// Wires createBroker (./index.ts) to a real renderer over Electron IPC.
//
// SCOPE: app.manifest, app.grants, fs.readFile, fs.writeFile, net.connect,
// net.close. net.connect returns a plain descriptor over CONTROL_CHANNEL --
// never the socket, its streams, or its close function, which is exactly
// what a structured-clone response can't carry anyway -- and separately
// delivers a dedicated MessageChannelMain port to the calling frame over
// PORT_CHANNEL (../main/channels.js), tagged with the same handle id. Bytes
// then relay over THAT port via ./port-pump.js's credit-window pump, never
// through ipcMain.handle/ipcRenderer.invoke: contracts/ipc.ts's own header
// says per-message IPC is too slow for torrent-rate data.
//
// THE WRITE HALF (an app writing bytes out) IS NOT WIRED HERE -- see
// port-pump.ts's header for why: there is no wire message for it anywhere
// in contracts/ipc.ts, and inventing one would be a contracts decision made
// from inside this PR. Filed as an open question instead.
//
// THE RULE THIS FILE EXISTS TO ENFORCE (src/preload/README.md, T3, T13b):
// every call is attributed to the ORIGIN OF THE SENDING FRAME, derived via
// policy/origin.ts's originFromSenderFrame, NEVER to anything the renderer
// put in the message payload. A compromised renderer can still reach this
// channel directly (contextBridge only gates what a PAGE's JS can construct,
// not what a compromised renderer PROCESS can send over the underlying
// Chromium IPC pipe), so the envelope's `method` and `payload` are validated
// here defensively rather than trusted because the preload is well-behaved.
// net.close leans on the SAME derived origin for a second thing: ./port-
// registry.js only ever hands a socket back to the origin that opened it,
// so a renderer that learns another origin's handle id cannot close it
// (T11c).
//
// TWO RULES FROM SPIKE GATE 0 (../contracts/ipc.ts's header), both honoured
// below: every reply carries an explicit timeout (`withTimeout`, keyed off
// the envelope's required `timeoutMs`), and nothing on CONTROL_CHANNEL is a
// transferable -- every value there is plain data, structurally cloned. The
// one transferable in this file is PORT_CHANNEL's MessagePortMain itself,
// which is what that channel exists for.
//
// TESTABLE WITHOUT ELECTRON, the way src/main/registry.ts is: the functions
// that matter for correctness -- `handleControlRequest`, `dispatch`,
// `registerBrokerIpc` -- take a `Broker`, a structurally-typed event/ipcMain,
// and a structurally-typed `PortTransport` rather than reaching for
// `electron` themselves. Only `brokerIpcSubsystem`, which nothing in
// ipc.test.ts calls, touches the real `ipcMain`/`MessageChannelMain` value
// imports below -- confirmed safe to import at module scope under plain
// Node/vitest (electron resolves to a harmless string outside a real
// Electron process; destructuring a value from it yields `undefined`, which
// only breaks if actually called).

import { ipcMain, MessageChannelMain } from 'electron'
import { CONTROL_CHANNEL, PORT_CHANNEL } from '../main/channels.js'
import type { Subsystem, SubsystemContext } from '../main/registry.js'
import { createBroker } from './index.js'
import type { Broker, CreateBrokerOptions } from './index.js'
import { dialTcp, nodeFs, resolveHost } from './node-adapters.js'
import { createPortPump } from './port-pump.js'
import { createPortRegistry } from './port-registry.js'
import type { PortRegistry } from './port-registry.js'
import { originFromSenderFrame } from './policy/origin.js'
import type { SenderFrameLike } from './policy/origin.js'
import { fail, isOrivonErrorLike } from './errors.js'
import { isControlMethod, isFsReadFileParams, isFsWriteFileParams, isNetCloseParams, isNetConnectParams } from './ipc-validation.js'
import type { DataMessage, OrivonErrorCode, RequestEnvelope, ResponseEnvelope, StreamEndMessage } from '../contracts/index.js'
import { LIMITS } from '../contracts/index.js'

export { CONTROL_CHANNEL, PORT_CHANNEL }
export type { ControlMethod, FsReadFileParams, FsWriteFileParams, NetConnectParams, NetCloseParams } from './ipc-validation.js'

/**
 * What `orivon.net.connect` resolves to over CONTROL_CHANNEL. Deliberately
 * NOT a `TcpSocket`: `readable`, `writable`, `close` and `closed` do not
 * survive structured clone, and the actual bytes travel over the port
 * PORT_CHANNEL delivers separately, tagged with this same `id`.
 */
export interface SocketDescriptor {
  readonly id: string
  readonly remoteAddress: string
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number
}

/**
 * The shape of a real `MessagePortMain` this module needs, structurally --
 * a fake stands in for it in tests the same way `SenderFrameLike` lets a
 * literal stand in for `WebFrameMain`.
 */
export interface PortLike {
  postMessage: (message: DataMessage | StreamEndMessage) => void
  onMessage: (listener: (message: unknown) => void) => void
  close: () => void
}

/** `port1` (kept here, wired to the pump) and `port2` (handed to the calling frame's PORT_CHANNEL delivery). */
export interface PortPair {
  readonly port1: PortLike
  readonly port2: unknown
}

/**
 * Everything net.connect/net.close need beyond `broker` itself: a way to
 * mint a real port pair, and the per-origin registry (./port-registry.js)
 * a later net.close call looks a live socket up in. ONE instance lives for
 * the subsystem's whole lifetime (registerBrokerIpc creates it once); every
 * `dispatch` call shares it.
 */
export interface PortTransport {
  readonly createPortPair: () => PortPair
  readonly registry: PortRegistry<{ readonly close: () => Promise<void> }>
}

/**
 * The shape of Electron's `IpcMainInvokeEvent` this module reads: `
 * senderFrame`, widened with the one extra capability net.connect needs --
 * `postMessage`, to deliver PORT_CHANNEL's port to the SAME frame the
 * request came from. A real `WebFrameMain` satisfies this with room to
 * spare; `SenderFrameLike` (policy/origin.ts) alone would not, which is
 * why this type lives here rather than being reused unwidened.
 */
export interface PortDeliveryFrame extends SenderFrameLike {
  // Method shorthand, not a `postMessage: (...) => void` property -- like
  // IpcMainLike.handle above, this is what makes a real WebFrameMain (whose
  // own transfer parameter is the narrower MessagePortMain[]) assignable
  // here. TypeScript checks method-shorthand signatures bivariantly;
  // arrow-typed properties are checked strictly contravariant and would
  // reject it.
  postMessage (channel: string, message: unknown, transfer?: unknown[]): void
}

export interface ControlEvent {
  readonly senderFrame: PortDeliveryFrame | null
}

/**
 * Maps a raw error off `socket.readable` to a closed-enum code. Deliberately
 * narrow (this is the ONE call site that needs it): a real Node stream
 * wrapping a TCP socket (node-adapters.ts's dialOne, via Duplex.toWeb)
 * surfaces the underlying socket's own errors here, and ECONNRESET/EPIPE
 * are the only ones with a sharper code than 'internal' worth naming.
 */
function mapSocketReadError (error: unknown): OrivonErrorCode {
  const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset'
  if (code === 'ETIMEDOUT') return 'timeout'
  return 'internal'
}

/** One request, dispatched to `broker` with the origin THIS FUNCTION derived -- never one from `payload`. */
async function dispatch (
  broker: Broker,
  origin: string,
  method: string,
  payload: unknown,
  event: ControlEvent,
  transport: PortTransport | undefined
): Promise<unknown> {
  if (!isControlMethod(method)) throw fail('invalid', `unknown control method: ${method}`)

  switch (method) {
    case 'app.manifest':
      return await broker.app.manifest(origin)
    case 'app.grants':
      return await broker.app.grants(origin)
    case 'fs.readFile': {
      if (!isFsReadFileParams(payload)) throw fail('invalid', 'fs.readFile requires { path: string }')
      return await broker.fs.readFile(origin, payload.path)
    }
    case 'fs.writeFile': {
      if (!isFsWriteFileParams(payload)) throw fail('invalid', 'fs.writeFile requires { path: string, data: Uint8Array }')
      await broker.fs.writeFile(origin, payload.path, payload.data)
      return undefined
    }
    case 'net.connect': {
      if (!isNetConnectParams(payload)) throw fail('invalid', 'net.connect requires { host: string, port: number }')
      if (transport === undefined) throw fail('internal', 'no port transport configured for this broker')
      const socket = await broker.net.connect(origin, { host: payload.host, port: payload.port })

      const pair = transport.createPortPair()
      const pump = createPortPump({
        handleId: socket.id,
        readable: socket.readable,
        send: (message) => { pair.port1.postMessage(message) },
        initialCredit: LIMITS.readWindowBytes,
        mapError: mapSocketReadError
      })
      pair.port1.onMessage((raw) => {
        if (
          typeof raw === 'object' && raw !== null &&
          (raw as { kind?: unknown }).kind === 'credit' &&
          typeof (raw as { handleId?: unknown }).handleId === 'string' &&
          typeof (raw as { bytesConsumed?: unknown }).bytesConsumed === 'number'
        ) {
          pump.handleCredit(raw as { kind: 'credit', handleId: string, bytesConsumed: number })
        }
      })

      const cleanup = (): void => {
        transport.registry.remove(origin, socket.id)
        pair.port1.close()
      }
      socket.closed.then(
        () => { pump.stop(); cleanup() },
        (error: unknown) => { pump.stop(isOrivonErrorLike(error) ? error.code : 'internal'); cleanup() }
      )

      transport.registry.register(origin, socket.id, { close: socket.close })

      if (event.senderFrame === null) {
        // Unreachable in practice: handleControlRequest already denied a
        // null senderFrame before dispatch() ever runs. Guarded anyway
        // rather than asserted, since a thrown 'internal' here is a far
        // better failure mode than a crash if that ordering ever changes.
        throw fail('internal', 'no frame to deliver the port to')
      }
      event.senderFrame.postMessage(PORT_CHANNEL, { handleId: socket.id }, [pair.port2])

      const descriptor: SocketDescriptor = {
        id: socket.id,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        localAddress: socket.localAddress,
        localPort: socket.localPort
      }
      return descriptor
    }
    case 'net.close': {
      if (!isNetCloseParams(payload)) throw fail('invalid', 'net.close requires { id: string }')
      // Idempotent, silent no-op for an id this origin was never handed --
      // matching TcpSocket.close()'s own contract (handle-contracts.md
      // SSCommon shape) -- rather than distinguishing "wrong origin" from
      // "already gone", either of which would let an app probe for handles
      // it does not hold.
      const entry = transport?.registry.get(origin, payload.id)
      if (entry !== undefined) await entry.close()
      return undefined
    }
  }
}

/**
 * Races `promise` against `timeoutMs`. ../contracts/ipc.ts's rule 2: this
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

/**
 * Maps a thrown value to the failure branch of a `ResponseEnvelope`.
 *
 * DoD rule 4: a 'denied' crosses with no `platformCode`, whatever threw it.
 * `./errors.ts`'s `fail()` already enforces that at construction, but this
 * is the boundary the app actually crosses, so it is re-checked here rather
 * than trusted from upstream -- the same defence-in-depth reasoning as
 * dispatch()'s own payload validation.
 *
 * Anything that is not a recognised `OrivonError` is a BUG, not a capability
 * decision, and its message is never forwarded: it may name a file path, a
 * stack frame, or another internal detail an app has no business seeing
 * (mirrors errors.ts's own 'internal' contract -- "always logged", never
 * described to the caller beyond that).
 */
function toFailureResponse (id: string, error: unknown): ResponseEnvelope<never> {
  if (isOrivonErrorLike(error)) {
    const base = { id, ok: false as const, code: error.code, message: error.message }
    if (error.code !== 'denied' && error.platformCode !== undefined) {
      return { ...base, platformCode: error.platformCode }
    }
    return base
  }
  return { id, ok: false, code: 'internal', message: 'an internal error occurred' }
}

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
 */
export async function handleControlRequest (
  broker: Broker,
  event: ControlEvent,
  envelope: RequestEnvelope<unknown>,
  transport?: PortTransport
): Promise<ResponseEnvelope<unknown>> {
  const origin = originFromSenderFrame(event.senderFrame)
  if (origin === null) {
    return { id: envelope.id, ok: false, code: 'denied', message: 'no authenticated origin for this frame' }
  }

  try {
    const result = await withTimeout(dispatch(broker, origin, envelope.method, envelope.payload, event, transport), envelope.timeoutMs)
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

/** Thin wiring: one `ipcMain.handle` registration over `handleControlRequest`, sharing one `PortTransport` across every call. */
export function registerBrokerIpc (ipc: IpcMainLike, broker: Broker, transport: PortTransport): void {
  ipc.handle(CONTROL_CHANNEL, async (event, envelope) => await handleControlRequest(broker, event, envelope, transport))
}

/** A real `PortPair`, backed by an actual `MessageChannelMain`. The one place this module constructs one. */
function realPortPair (): PortPair {
  const { port1, port2 } = new MessageChannelMain()
  const wrapped: PortLike = {
    postMessage: (message) => { port1.postMessage(message) },
    onMessage: (listener) => { port1.on('message', (event) => { listener(event.data) }) },
    close: () => { port1.close() }
  }
  port1.start()
  return { port1: wrapped, port2 }
}

/** Builds the production `Broker` and registers it on `ipcMain`. The one place this module's `electron` value imports are used. */
export const brokerIpcSubsystem: Subsystem = {
  name: 'broker',
  afterReady: (ctx: SubsystemContext) => {
    const deps: CreateBrokerOptions = {
      dial: dialTcp,
      resolve: resolveHost,
      now: () => Date.now(),
      fs: nodeFs(ctx.app.getPath('userData')),
      // ADR-0010 key derivation is out of scope for this task (broker/
      // index.ts's own header: "nothing below calls it yet") -- none of the
      // six wired control operations reach `orivon.id`.
      keychain: {
        getSeed: async () => { throw fail('internal', 'identity key derivation is not implemented yet (ADR-0010)') }
      }
    }
    const transport: PortTransport = { createPortPair: realPortPair, registry: createPortRegistry() }
    registerBrokerIpc(ipcMain, createBroker(deps), transport)
  }
}
