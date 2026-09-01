// Wires createBroker (./index.ts) to a real renderer over Electron IPC.
//
// SCOPE: the CONTROL channel only -- app.manifest, app.grants, fs.readFile,
// fs.writeFile. net.connect is DELIBERATELY not wired here even though
// `dialTcp`/`resolveHost` below give createBroker a real dial/resolve: a
// TcpSocket's actual shape is readable/writable/close/closed
// (../contracts/capability-api.ts), and returning a serialisable descriptor
// instead would hand the app a socket with no way to ever close it, leaking
// one handle-table slot and one fd per call (LIMITS.concurrentSockets is
// finite). The per-socket bulk-byte pump (MessageChannelMain, the credit
// window, ../contracts/ipc.ts's DataMessage/CreditMessage) is its own task,
// and net.connect is wired once, for real, when that task lands. See the PR
// body's "Decisions and open questions".
//
// THE RULE THIS FILE EXISTS TO ENFORCE (src/preload/README.md, T3, T13b):
// every call is attributed to the ORIGIN OF THE SENDING FRAME, derived via
// policy/origin.ts's originFromSenderFrame, NEVER to anything the renderer
// put in the message payload. A compromised renderer can still reach this
// channel directly (contextBridge only gates what a PAGE's JS can construct,
// not what a compromised renderer PROCESS can send over the underlying
// Chromium IPC pipe), so the envelope's `method` and `payload` are validated
// here defensively rather than trusted because the preload is well-behaved.
//
// TWO RULES FROM SPIKE GATE 0 (../contracts/ipc.ts's header), both honoured
// below: every reply carries an explicit timeout (`withTimeout`, keyed off
// the envelope's required `timeoutMs`), and nothing on this path is a
// transferable -- every value here is plain data, structurally cloned.
//
// TESTABLE WITHOUT ELECTRON, the way src/main/registry.ts is: the two
// functions that matter for correctness -- `handleControlRequest` and
// `registerBrokerIpc` -- take a `Broker` and a structurally-typed event/
// ipcMain rather than reaching for `electron` themselves. Only
// `brokerIpcSubsystem`, which nothing in ipc.test.ts calls, touches the real
// `ipcMain` value import below -- confirmed safe to import at module scope
// under plain Node/vitest (electron resolves to a harmless string outside a
// real Electron process; destructuring `ipcMain` from it yields `undefined`,
// which only breaks if actually called).

import { ipcMain } from 'electron'
import { CONTROL_CHANNEL } from '../main/channels.js'
import type { Subsystem, SubsystemContext } from '../main/registry.js'
import { createBroker } from './index.js'
import type { Broker, CreateBrokerOptions } from './index.js'
import { dialTcp, nodeFs, resolveHost } from './node-adapters.js'
import { originFromSenderFrame } from './policy/origin.js'
import type { SenderFrameLike } from './policy/origin.js'
import { fail, isOrivonErrorLike } from './errors.js'
import type { OrivonError, OrivonErrorCode, RequestEnvelope, ResponseEnvelope } from '../contracts/index.js'

export { CONTROL_CHANNEL }

/** The four wired control operations. Anything else is 'invalid'. */
export type ControlMethod = 'app.manifest' | 'app.grants' | 'fs.readFile' | 'fs.writeFile'

function isControlMethod (method: string): method is ControlMethod {
  return method === 'app.manifest' || method === 'app.grants' ||
    method === 'fs.readFile' || method === 'fs.writeFile'
}

export interface FsReadFileParams { readonly path: string }
export interface FsWriteFileParams { readonly path: string, readonly data: Uint8Array }

function isFsReadFileParams (payload: unknown): payload is FsReadFileParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string'
}

function isFsWriteFileParams (payload: unknown): payload is FsWriteFileParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string' &&
    (payload as { data?: unknown }).data instanceof Uint8Array
}

/**
 * The shape of Electron's `IpcMainInvokeEvent` this module reads -- just
 * `senderFrame`, structurally, so a literal stands in for it in tests the
 * same way `SenderFrameLike` (policy/origin.ts) lets a literal stand in for
 * `WebFrameMain`. A real `IpcMainInvokeEvent` satisfies this with room to
 * spare.
 */
export interface ControlEvent {
  readonly senderFrame: SenderFrameLike | null
}

/** One request, dispatched to `broker` with the origin THIS FUNCTION derived -- never one from `payload`. */
async function dispatch (broker: Broker, origin: string, method: string, payload: unknown): Promise<unknown> {
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
 * everything that touches either is INJECTED (`broker`, `event`).
 *
 * Origin derivation happens here and ONLY here (DoD rule 1): `event.
 * senderFrame` is the sole source of the caller's identity. `envelope.
 * payload` is never inspected for anything resembling an origin.
 */
export async function handleControlRequest (
  broker: Broker,
  event: ControlEvent,
  envelope: RequestEnvelope<unknown>
): Promise<ResponseEnvelope<unknown>> {
  const origin = originFromSenderFrame(event.senderFrame)
  if (origin === null) {
    return { id: envelope.id, ok: false, code: 'denied', message: 'no authenticated origin for this frame' }
  }

  try {
    const result = await withTimeout(dispatch(broker, origin, envelope.method, envelope.payload), envelope.timeoutMs)
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

/** Thin wiring: one `ipcMain.handle` registration over `handleControlRequest`. */
export function registerBrokerIpc (ipc: IpcMainLike, broker: Broker): void {
  ipc.handle(CONTROL_CHANNEL, async (event, envelope) => await handleControlRequest(broker, event, envelope))
}

/** Builds the production `Broker` and registers it on `ipcMain`. The one place this module's `electron` value import is used. */
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
      // five wired control operations reach `orivon.id`.
      keychain: {
        getSeed: async () => { throw fail('internal', 'identity key derivation is not implemented yet (ADR-0010)') }
      }
    }
    registerBrokerIpc(ipcMain, createBroker(deps))
  }
}
