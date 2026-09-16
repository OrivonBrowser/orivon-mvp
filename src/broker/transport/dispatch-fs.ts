// fs.readFile / writeFile / mkdir / readdir / stat / rm / rename, split out
// of ./ipc.ts's dispatch() switch under code-guidelines.md Rule 2 -- see
// ./dispatch-app.ts's header for the seam this and its siblings share.
// fs.open and its handle-scoped siblings (read/write/fstat/truncate/sync/
// close, A184) joined this file rather than starting a new one, for the
// same reason net.connect's port wiring stayed inside dispatch-net.ts:
// FailableFileHandle is FileHandle's own broker-internal counterpart, the
// same way FailableTcpSocket is TcpSocket's.

import { fail } from '../errors.js'
import type { Broker } from '../broker-contracts.js'
import type { FailableFileHandle } from '../handles/handle-contracts.js'
import type { PortRegistry } from './port-registry.js'
import {
  isFsHandleIdParams, isFsHandleReadParams, isFsHandleTruncateParams, isFsHandleWriteParams,
  isFsOpenParams, isFsPathWithRecursiveParams, isFsReaddirParams, isFsReadFileParams,
  isFsRenameParams, isFsStatParams, isFsWriteFileParams
} from './ipc-validation.js'
import type { ControlMethod } from './ipc-validation.js'

/** The `fs.*` slice of `ControlMethod` -- see ./dispatch-app.ts's own `AppControlMethod` for why this is derived rather than retyped. */
export type FsControlMethod = Extract<ControlMethod, `fs.${string}`>

/**
 * What `fs.open` resolves to over CONTROL_CHANNEL. Deliberately NOT a
 * `FailableFileHandle` or a `FileHandle` -- `read`/`write`/`readable`/
 * `writable`/`close`/`closed` do not survive structured clone, matching
 * `SocketDescriptor`'s own doc (port-transport.ts) for exactly the same
 * reason. Every subsequent call against this handle (fs.read, fs.write,
 * ...) is tagged with this same `id`.
 *
 * `readable`/`writable` have NO CONTROL_CHANNEL case in this lane's own
 * landing -- see this lane's PR body for what that means and what does not
 * yet reach a page.
 */
export interface FsHandleDescriptor {
  readonly id: string
}

/**
 * The per-origin lookup `fs.read`/`fs.write`/`fs.fstat`/`fs.truncate`/
 * `fs.sync`/`fs.close` need to turn an `id` back into the live
 * `FailableFileHandle` `fs.open` registered -- `PortTransport.registry`'s
 * fs counterpart, using the exact same generic `createPortRegistry` rather
 * than a second lookup mechanism (code-guidelines.md Rule 3). ONE instance
 * lives for the subsystem's whole lifetime, exactly like `PortTransport`.
 */
export interface FsTransport {
  readonly registry: PortRegistry<FailableFileHandle>
}

/**
 * The ownership check every handle-scoped case below shares: an id this
 * origin was never handed -- wrong origin, already closed, or never real --
 * is refused, never silently ignored (T11c). `close` is the one exception,
 * matching `Handle.close()`'s own idempotent contract; see its own case.
 */
function requireFile (transport: FsTransport | undefined, origin: string, id: string): FailableFileHandle {
  const entry = transport?.registry.get(origin, id)
  if (entry === undefined) throw fail('denied', 'no such file handle for this origin', id)
  return entry
}

/** `fs.*`'s dispatch cases, unchanged from ./ipc.ts's own switch for the seven pre-existing ones. */
export async function dispatchFs (
  broker: Broker,
  origin: string,
  method: FsControlMethod,
  payload: unknown,
  transport?: FsTransport
): Promise<unknown> {
  switch (method) {
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
    case 'fs.open': {
      if (!isFsOpenParams(payload)) throw fail('invalid', 'fs.open requires { path: string, flags: string }')
      if (transport === undefined) throw fail('internal', 'no fs transport configured for this broker')
      const file = await broker.fs.open(origin, payload.path, payload.flags)
      transport.registry.register(origin, file.id, file)
      // Released the instant the handle leaves the broker's tables for ANY
      // reason -- an explicit fs.close below, a revoked grant, or session
      // teardown -- so a stale entry never outlives the resource it names.
      // One mechanism, not a second cleanup path duplicating `fs.close`'s.
      file.onUnlink(() => { transport.registry.remove(origin, file.id) })
      const descriptor: FsHandleDescriptor = { id: file.id }
      return descriptor
    }
    case 'fs.read': {
      if (!isFsHandleReadParams(payload)) throw fail('invalid', 'fs.read requires { id: string, position: number, length: number }')
      const file = requireFile(transport, origin, payload.id)
      return await file.read({ position: payload.position, length: payload.length })
    }
    case 'fs.write': {
      if (!isFsHandleWriteParams(payload)) throw fail('invalid', 'fs.write requires { id: string, position: number, data: Uint8Array }')
      const file = requireFile(transport, origin, payload.id)
      return await file.write({ position: payload.position, data: payload.data })
    }
    case 'fs.fstat': {
      if (!isFsHandleIdParams(payload)) throw fail('invalid', 'fs.fstat requires { id: string }')
      const file = requireFile(transport, origin, payload.id)
      return await file.stat()
    }
    case 'fs.truncate': {
      if (!isFsHandleTruncateParams(payload)) throw fail('invalid', 'fs.truncate requires { id: string, length: number }')
      const file = requireFile(transport, origin, payload.id)
      await file.truncate(payload.length)
      return undefined
    }
    case 'fs.sync': {
      if (!isFsHandleIdParams(payload)) throw fail('invalid', 'fs.sync requires { id: string }')
      const file = requireFile(transport, origin, payload.id)
      await file.sync()
      return undefined
    }
    case 'fs.close': {
      if (!isFsHandleIdParams(payload)) throw fail('invalid', 'fs.close requires { id: string }')
      // Idempotent, silent no-op for an id this origin was never handed --
      // matching Handle.close()'s own contract (handle-contracts.md's
      // "Common shape" section), the one exception to requireFile's refusal
      // above -- exactly net.close's own precedent (dispatch-net.ts).
      const entry = transport?.registry.get(origin, payload.id)
      if (entry !== undefined) await entry.close()
      return undefined
    }
  }
}
