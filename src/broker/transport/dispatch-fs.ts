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
  isFsRenameParams, isFsStatParams, isFsUserSelectedParams, isFsWriteFileParams
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

/**
 * Registers an already-acquired file handle the SAME way for both callers
 * that produce one -- `fs.open`'s own case below, and `fs.userSelected`'s
 * (Rule 3: one registration mechanism, not two copies of the exact same
 * five lines). Released the instant the handle leaves the broker's tables
 * for ANY reason -- an explicit fs.close, a revoked grant/pick, or session
 * teardown -- so a stale registry entry never outlives the resource it
 * names; one mechanism, not a second cleanup path duplicating fs.close's.
 */
function registerFileHandle (transport: FsTransport, origin: string, file: FailableFileHandle): FsHandleDescriptor {
  transport.registry.register(origin, file.id, file)
  file.onUnlink(() => { transport.registry.remove(origin, file.id) })
  return { id: file.id }
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
      return registerFileHandle(transport, origin, file)
    }
    case 'fs.userSelected': {
      if (!isFsUserSelectedParams(payload)) {
        throw fail('invalid', 'fs.userSelected requires an optional { directory?: boolean, multiple?: boolean }')
      }
      if (payload.directory === true) {
        // The FOLDER shape (DirectoryHandle) has no CONTROL_CHANNEL delivery
        // yet -- a genuinely different problem from `fs.open`'s, not the
        // same one repeated. FileHandle's handle-scoped siblings
        // (fs.read/write/fstat/truncate/sync/close) already existed before
        // this case was written, so the FILE shape below is pure reuse; a
        // DirectoryHandle needs EIGHT new handle-scoped verbs
        // (readdir/stat/mkdir/rm/rename/readFile/writeFile/open) with no
        // existing precedent to reuse, over a method set A167 already flags
        // as an unconfirmed AI recommendation (docs/open-questions.md).
        // Building that surface now would mean inventing a delivery
        // mechanism for a shape nobody has signed off on -- filed as A194
        // rather than guessed at.
        throw fail('internal', "orivon.fs.userSelected's folder shape is not reachable from a page yet -- see A194, docs/open-questions.md")
      }
      if (transport === undefined) throw fail('internal', 'no fs transport configured for this broker')
      const opts = payload.multiple === undefined ? undefined : { multiple: payload.multiple }
      const files = await broker.fs.userSelected(origin, opts)
      return files.map((file) => registerFileHandle(transport, origin, file))
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
    default: {
      // Exhaustiveness check, same reasoning and shape as ./ipc.ts's own
      // dispatch() and ./dispatch-net.ts's dispatchNet (A185): if
      // FsControlMethod ever gains a member no case above names, `method` is
      // not assignable to `never` and this line fails to compile, instead of
      // the switch silently falling through and this function resolving
      // `undefined` for an operation that never ran -- exactly what A185
      // found for net.listen, and highest-risk here since seven of this
      // run's new fs methods route through this file.
      const unrouted: never = method
      throw fail('internal', `unrouted fs control method: ${unrouted as string}`)
    }
  }
}
