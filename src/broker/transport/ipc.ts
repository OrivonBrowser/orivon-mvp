// Wires createBroker (../index.ts) to a real renderer over Electron IPC:
// validates the envelope, derives the origin, rate-limits, times out, and
// routes to the per-capability dispatcher (./dispatch-app.ts, ./dispatch-fs.ts,
// ./dispatch-id.ts, ./dispatch-net.ts -- see ./README.md's Design notes for
// why dispatch lives there and wiring stays here). See ./README.md for the
// two rules every method enforces (origin attribution off the sending
// frame, bytes never over request/response IPC) and ../../contracts/ipc.ts
// for the timeout and no-transferables rules withTimeout() and dispatch()
// below apply.
//
// TESTABLE WITHOUT ELECTRON, the way src/main/registry.ts is:
// `handleControlRequest`, `dispatch` and `registerBrokerIpc` take a
// `Broker` and structurally-typed event/ipcMain/`PortTransport` rather than
// reaching for `electron` themselves -- see README.md's Design notes for
// why. Only `brokerIpcSubsystem`, which nothing in ipc.test.ts calls,
// touches the real `ipcMain`/`MessageChannelMain` value imports below.

import { dialog, ipcMain, MessageChannelMain } from 'electron'
import type { MessagePortMain } from 'electron'
import { CONTROL_CHANNEL, PORT_CHANNEL, SYNC_CONTROL_CHANNEL } from '../../main/channels.js'
import { publishBroker } from '../../main/registry.js'
import type { Subsystem, SubsystemContext } from '../../main/registry.js'
import { createBroker } from '../index.js'
import type { Broker, CreateBrokerOptions } from '../broker-contracts.js'
import { dialTcp, listenTcp, nodeFs, resolveHost, resolveLookup } from '../adapters/node-adapters.js'
import { dialTls } from '../adapters/tls-adapter.js'
import { bindUdp } from '../adapters/udp-adapter.js'
import { nodeLedgerStorage } from '../grants/node-ledger-storage.js'
import { createWebContextHost } from '../../main/sessions/web-context-host.js'
import { createPortRegistry } from './port-registry.js'
import type { RateLimiter } from './token-bucket.js'
import { admitControlCall, createControlLimiter } from './control-limiter.js'
import type { ControlLimiter } from './control-limiter.js'
import { createSyncFsPolicy } from './sync-fs-policy.js'
import { handleSyncFsReadRequest } from './sync-fs.js'
import type { SyncControlEvent, SyncFsPolicy } from './sync-fs.js'
import { originFromSenderFrame } from '../policy/origin.js'
import { fail } from '../errors.js'
import { toFailureResponse } from './response-envelope.js'
import { dispatchApp } from './dispatch-app.js'
import { dispatchFs } from './dispatch-fs.js'
import type { FsTransport } from './dispatch-fs.js'
import { dispatchId } from './dispatch-id.js'
import { dispatchNet } from './dispatch-net.js'
import { dispatchWeb } from './dispatch-web.js'
import { envelopeId, isControlMethod, isRequestEnvelope, type RequestGrantCtx } from './ipc-validation.js'
import type { ControlEvent, PortLike, PortPair, PortTransport } from './port-transport.js'
import type { RequestEnvelope, ResponseEnvelope } from '../../contracts/index.js'

export { CONTROL_CHANNEL, PORT_CHANNEL }
export type {
  AppRequestGrantParams, ControlMethod, FsPathWithRecursiveParams, FsReaddirParams, FsReadFileParams, FsRenameParams,
  FsStatParams, FsWriteFileParams, IdPublicKeyParams, IdSignParams,
  NetConnectParams, NetCloseParams, NetSetKeepAliveParams, NetSetNoDelayParams, NetUdpBindParams, RequestGrantCtx,
  WebCloseParams, WebEvaluateParams, WebOpenContextParams
} from './ipc-validation.js'
export type {
  ControlEvent, PortDeliveryFrame, PortLike, PortPair, PortTransport, SocketDescriptor, TcpServerDescriptor,
  UdpSocketDescriptor
} from './port-transport.js'
export type { FsControlMethod, FsHandleDescriptor, FsTransport } from './dispatch-fs.js'
export type { WebControlMethod } from './dispatch-web.js'

/**
 * One request, dispatched to `broker` with the origin THIS FUNCTION derived
 * -- never one from `payload`. Routes by capability prefix to
 * ./dispatch-app.ts, ./dispatch-fs.ts, ./dispatch-id.ts and ./dispatch-net.ts
 * -- each case group below narrows `method` to that module's own slice of
 * `ControlMethod`, so the call is exactly as type-checked as the single
 * switch this replaced.
 */
async function dispatch (
  broker: Broker,
  origin: string,
  method: string,
  payload: unknown,
  event: ControlEvent,
  transport: PortTransport | undefined,
  requestGrantCtx: RequestGrantCtx | undefined,
  fsTransport: FsTransport | undefined,
  abandoned: AbortSignal
): Promise<unknown> {
  if (!isControlMethod(method)) throw fail('invalid', `unknown control method: ${method}`)

  switch (method) {
    case 'app.manifest':
    case 'app.grants':
    case 'app.requestGrant':
      return await dispatchApp(broker, origin, method, payload, requestGrantCtx)
    case 'fs.readFile':
    case 'fs.writeFile':
    case 'fs.mkdir':
    case 'fs.readdir':
    case 'fs.stat':
    case 'fs.rm':
    case 'fs.rename':
    case 'fs.open':
    case 'fs.read':
    case 'fs.write':
    case 'fs.fstat':
    case 'fs.truncate':
    case 'fs.sync':
    case 'fs.close':
    case 'fs.userSelected':
    case 'fs.dirReaddir':
    case 'fs.dirStat':
    case 'fs.dirMkdir':
    case 'fs.dirRm':
    case 'fs.dirRename':
    case 'fs.dirReadFile':
    case 'fs.dirWriteFile':
    case 'fs.dirOpen':
      return await dispatchFs(broker, origin, method, payload, fsTransport, abandoned)
    case 'id.publicKey':
    case 'id.sign':
      return await dispatchId(broker, origin, method, payload)
    case 'net.connect':
    case 'net.connectSecure':
    case 'net.udpBind':
    case 'net.listen':
    case 'net.close':
    case 'net.setNoDelay':
    case 'net.setKeepAlive':
    case 'net.lookup':
      return await dispatchNet(broker, origin, method, payload, event, transport)
    case 'web.openContext':
    case 'web.evaluate':
    case 'web.close':
    case 'web.awaitClose':
      return await dispatchWeb(broker, origin, method, payload)
    default: {
      // Exhaustiveness check: if ControlMethod (ipc-validation.ts) ever
      // gains a member no case above names, `method` is not assignable to
      // `never` here and THIS LINE FAILS TO COMPILE -- the guard A185's
      // brief asked for, because nothing else in this switch does (no
      // `assertNever`, no keyed `Record`) and a missed case would otherwise
      // resolve silently to `undefined` instead of a compile error.
      const unrouted: never = method
      throw fail('internal', `unrouted control method: ${unrouted as string}`)
    }
  }
}

/**
 * Races `work` against `timeoutMs`. ../../contracts/ipc.ts's rule 2: this
 * transport fails by SILENCE, and `timeoutMs` is a required field precisely
 * so nothing on this path can forget to bound the wait. The underlying
 * broker call is not cancelled when the timer wins; it is left to settle on
 * its own and its result is discarded. What matters is that the CALLER is
 * never left waiting past its own stated budget. `abandoned` fires when the
 * timer wins, so a call that produces a resource the caller will now never
 * hear about can release it (dispatch-fs.ts's `fs.userSelected`).
 */
async function withTimeout<T> (work: (abandoned: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const abandoned = new AbortController()
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abandoned.abort()
      reject(fail('timeout', `control call exceeded its ${timeoutMs}ms budget`))
    }, timeoutMs)
    timer.unref()
    work(abandoned.signal).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) }
    )
  })
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
 *
 * `limiter`, `requestGrantCtx` and `fsTransport` are optional the same way
 * (never throttled; 'internal' from dispatch() if a call needing one of the
 * last two runs without it) -- real wiring always supplies every one of
 * them, see `brokerIpcSubsystem`.
 */
export async function handleControlRequest (
  broker: Broker,
  event: ControlEvent,
  envelope: RequestEnvelope<unknown>,
  transport?: PortTransport,
  limiter?: ControlLimiter,
  requestGrantCtx?: RequestGrantCtx,
  fsTransport?: FsTransport
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

  // Checked before dispatch() ever runs, so a throttled call never reaches
  // the broker at all (A38). Which budget a method draws on, and why one of
  // them paces instead of refusing: ./control-limiter.ts.
  if (!(await admitControlCall(limiter, origin, envelope.method))) {
    return { id: envelope.id, ok: false, code: 'limit', message: 'this origin is calling too frequently; wait and retry' }
  }

  try {
    const result = await withTimeout(
      async (abandoned) => await dispatch(broker, origin, envelope.method, envelope.payload, event, transport, requestGrantCtx, fsTransport, abandoned),
      envelope.timeoutMs
    )
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

/** Thin wiring: one `ipcMain.handle` registration over `handleControlRequest`, sharing one `PortTransport`, `FsTransport` and `ControlLimiter` across every call. */
export function registerBrokerIpc (
  ipc: IpcMainLike,
  broker: Broker,
  transport: PortTransport,
  limiter?: ControlLimiter,
  requestGrantCtx?: RequestGrantCtx,
  fsTransport?: FsTransport
): void {
  ipc.handle(CONTROL_CHANNEL, async (event, envelope) =>
    await handleControlRequest(broker, event, envelope, transport, limiter, requestGrantCtx, fsTransport))
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
    // `transfer` is `readonly unknown[]` at this structural boundary
    // (./port-transport.ts's own PortPair.port2, `unknown` for the same
    // reason) but is ALWAYS, in production, an array of this module's own
    // freshly-minted MessagePortMain values -- the only thing anything in
    // this file ever puts in one (server-relay.ts's AcceptedMessage.port,
    // the sole BrokerToRendererMessage member that carries a transferable
    // -- contracts/ipc.ts's own header rule 1). Cast at this one real-
    // Electron call site rather than widening MessagePortMain's own
    // `.postMessage` signature.
    // PASSING `undefined` AS THE TRANSFER LIST IS NOT THE SAME AS OMITTING
    // IT. Electron's MessagePortMain binding validates the argument when it
    // is present at all, so `postMessage(message, undefined)` throws
    // "transferables must be an array of MessagePorts" -- and that is every
    // ordinary data message, not just an accept. A plain object PortLike
    // accepts `undefined` happily, so unit tests cannot see this; the real
    // e2e caught it as every socket byte pump failing at once.
    postMessage: (message, transfer) => {
      if (transfer === undefined) port1.postMessage(message)
      else port1.postMessage(message, transfer as MessagePortMain[])
    },
    onMessage: (listener) => { port1.on('message', (event) => { listener(event.data) }) },
    onClose: (listener) => { port1.on('close', listener) },
    close: () => { port1.close() }
  }
  port1.start()
  return { port1: wrapped, port2 }
}

/**
 * The text `pickPath`'s real `dialog.showOpenDialog` call shows. Kept as a
 * pure function, separate from the `electron` call itself, so it is
 * testable the same way the rest of this file is (this file's own header,
 * "TESTABLE WITHOUT ELECTRON") -- `dialog` is a real Electron value import
 * and cannot be exercised from this suite.
 *
 * FOLDER WORDING IS OWNER-APPROVED VERBATIM (`d-0032`, 2026-09-16): three
 * drafts were proposed, and the owner chose the strongest, on the reasoning
 * that "read and write" understated what a folder grant really lets an app
 * do. `message`'s "including files you add to it later" is the load-bearing
 * phrase -- the thing people misread about a folder pick -- and is not
 * trimmed for length. FILE/multi-file wording follows the same voice but is
 * DERIVED, not separately owner-reviewed word for word: `permissions.ts`'s
 * `describePickedPath` carries the identical reasoning for why it says
 * "change" rather than claim a delete a `FileHandle` cannot perform.
 *
 * `message` is macOS-only (Electron's own `OpenDialogOptions` doc); passed
 * unconditionally because Electron silently ignores it elsewhere rather
 * than erroring, confirmed against Electron's own docs (context7,
 * 2026-09-16) before writing this.
 */
export function describePickerDialog (opts: { directory: boolean, multiple: boolean, appName: string | undefined }): { title: string, buttonLabel: string, message: string } {
  const named = opts.appName === undefined ? undefined : `"${opts.appName}"`
  if (opts.directory) {
    return {
      title: named === undefined ? 'Choose a folder to access' : `Choose a folder for ${named} to access`,
      buttonLabel: 'Allow access to this folder',
      message: 'This app will be able to read, change and delete everything in this folder, including files you add to it later.'
    }
  }
  if (opts.multiple) {
    return {
      title: named === undefined ? 'Choose files to access' : `Choose files for ${named} to access`,
      buttonLabel: 'Allow access to these files',
      message: 'This app will be able to read and change these files, including emptying them.'
    }
  }
  return {
    title: named === undefined ? 'Choose a file to access' : `Choose a file for ${named} to access`,
    buttonLabel: 'Allow access to this file',
    message: 'This app will be able to read and change this file, including emptying it.'
  }
}

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
      resolveLookup,
      now: realNow,
      fs: nodeFs(ctx.app.getPath('userData')),
      ledgerStorage: nodeLedgerStorage(ctx.app.getPath('userData')),
      // orivon.fs.userSelected's real OS picker (L5-userselected). Carries
      // the owner-approved/derived wording (d-0032) from describePickerDialog
      // above -- see that function's own doc for what is verbatim-approved
      // and what is derived.
      pickPath: async ({ directory, multiple, appName }) => {
        const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = directory
          ? ['openDirectory']
          : (multiple ? ['openFile', 'multiSelections'] : ['openFile'])
        const { title, buttonLabel, message } = describePickerDialog({ directory, multiple, appName })
        const result = await dialog.showOpenDialog({ properties, title, buttonLabel, message })
        return result.canceled ? { canceled: true } : { canceled: false, paths: result.filePaths }
      },
      // ADR-0010 key derivation is not implemented yet (broker/index.ts's
      // own header: "nothing below calls it yet") -- none of the six wired
      // control operations reach `orivon.id`.
      keychain: {
        getSeed: async () => { throw fail('internal', 'identity key derivation is not implemented yet (ADR-0010)') }
      },
      // ADR-0019's Electron escape hatch. A LAZY GETTER, not `ctx.broker`
      // itself -- `deps` is built here to CONSTRUCT the broker a few lines
      // below, so `ctx.broker` is not published yet; `web-context-host.ts`'s
      // own header explains why this must stay a thunk, resolved only once
      // `web.openContext` actually runs, well after `publishBroker` below.
      webContextHost: createWebContextHost(() => {
        if (ctx.broker === undefined) throw fail('internal', 'the broker is not published yet')
        return ctx.broker
      })
    }
    const transport: PortTransport = { createPortPair: realPortPair, registry: createPortRegistry() }
    // fs.open's own per-origin lookup (A184) -- the same generic
    // createPortRegistry `transport.registry` above uses, over
    // FailableFileHandle instead of RegisteredSocket. One instance for the
    // subsystem's whole lifetime, exactly like `transport`. `dirRegistry`
    // (A195) is its DirectoryHandle counterpart, over FailableDirectoryHandle.
    const fsTransport: FsTransport = { registry: createPortRegistry(), dirRegistry: createPortRegistry() }
    const limiter = createControlLimiter(realNow)
    const broker = createBroker(deps)
    // publishBroker (src/main/registry.ts) is the one sanctioned way to set
    // ctx.broker -- it throws instead of silently overwriting if this ever
    // runs twice, so a later subsystem is guaranteed to read this same
    // instance rather than a second, disagreeing one.
    publishBroker(ctx, broker)
    // `ctx` itself, not a captured `ctx.requestGrant` -- see RequestGrantCtx's own doc (ipc-validation.ts) for why.
    registerBrokerIpc(ipcMain, broker, transport, limiter, ctx, fsTransport)

    // ./sync-fs-policy.ts's createSyncFsPolicy calls straight through to
    // broker.fs.confineSync -- ADR-0016's synchronous grant-check/
    // confinement entry point on the SAME broker instance registerBrokerIpc
    // just wired, so a grant issued through any route (the app loader's
    // permission prompt later, src/main/dev-grant.ts's hook today) is live
    // for this channel the instant it lands on that one instance.
    registerSyncFsIpc(ipcMain, createSyncFsPolicy(broker), limiter)
  }
}
