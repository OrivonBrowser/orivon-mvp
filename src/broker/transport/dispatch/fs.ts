// fs.readFile / writeFile / mkdir / readdir / stat / rm / rename, split out
// of ../ipc.ts's dispatch() switch under code-guidelines.md Rule 2 -- see
// ./app.ts's header for the seam this and its siblings share.
// fs.open and its handle-scoped siblings (read/write/fstat/truncate/sync/
// close, A184) joined this file rather than starting a new one, for the
// same reason net.connect's port wiring stayed inside transport/dispatch/net.ts:
// FailableFileHandle is FileHandle's own broker-internal counterpart, the
// same way FailableTcpSocket is TcpSocket's.

import { fail } from '../../errors.js'
import type { Broker } from '../../broker-contracts.js'
import type { FailableDirectoryHandle, FailableFileHandle } from '../../handles/handle-contracts.js'
import type { PortRegistry } from '../relay/port-registry.js'
import {
  isFsDirOpenParams, isFsDirPathOptionalParams, isFsDirPathRequiredParams, isFsDirPathWithRecursiveParams,
  isFsDirRenameParams, isFsDirWriteFileParams,
  isFsHandleIdParams, isFsHandleReadParams, isFsHandleTruncateParams, isFsHandleWriteParams,
  isFsOpenParams, isFsPathWithRecursiveParams, isFsReaddirParams, isFsReadFileParams,
  isFsRenameParams, isFsStatParams, isFsUserSelectedParams, isFsWriteFileParams
} from '../ipc-validation.js'
import type { ControlMethod } from '../ipc-validation.js'

/** The `fs.*` slice of `ControlMethod` -- see ./app.ts's own `AppControlMethod` for why this is derived rather than retyped. */
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
 *
 * `dirRegistry` (A195) is `DirectoryHandle`'s own counterpart, OPTIONAL so
 * every existing call site building an `FsTransport` for a test that never
 * touches the folder shape still type-checks unchanged. Production wiring
 * (../ipc.ts's `brokerIpcSubsystem`) always supplies both; a directory case
 * reached without one fails 'internal', the same wiring-bug-not-a-
 * capability-decision reasoning `transport === undefined` already gets
 * below.
 */
export interface FsTransport {
  readonly registry: PortRegistry<FailableFileHandle>
  readonly dirRegistry?: PortRegistry<FailableDirectoryHandle>
}

/**
 * The ownership check every handle-scoped case below shares: an id this
 * origin does not hold live is refused, never silently ignored (T11c), with
 * what happened to it -- closed, revoked, or never this origin's (see
 * `BrokerFsMethods.handleGone`). `close` is the one exception, matching
 * `Handle.close()`'s own idempotent contract; see its own case.
 */
function requireFile (broker: Broker, transport: FsTransport | undefined, origin: string, id: string): FailableFileHandle {
  const entry = transport?.registry.get(origin, id)
  if (entry === undefined) throw broker.fs.handleGone(origin, id)
  return entry
}

/** `requireFile`'s own DirectoryHandle counterpart (A195) -- identical reasoning, over `dirRegistry` instead. */
function requireDirectory (broker: Broker, transport: FsTransport | undefined, origin: string, id: string): FailableDirectoryHandle {
  const entry = transport?.dirRegistry?.get(origin, id)
  if (entry === undefined) throw broker.fs.handleGone(origin, id)
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
 *
 * A THIRD caller joined this lane (A195): `fs.dirOpen`'s own case below,
 * registering the `FileHandle` a `DirectoryHandle.open()` returns -- the
 * brief's own instruction to route a folder-opened file through the EXISTING
 * file mechanism rather than invent a second one. No change to this
 * function was needed to make that true.
 */
function registerFileHandle (transport: FsTransport, origin: string, file: FailableFileHandle): FsHandleDescriptor {
  transport.registry.register(origin, file.id, file)
  file.onUnlink(() => { transport.registry.remove(origin, file.id) })
  return { id: file.id }
}

/** `registerFileHandle`'s own DirectoryHandle counterpart (A195) -- same shape, over `dirRegistry` instead. */
function registerDirectoryHandle (transport: FsTransport, origin: string, dir: FailableDirectoryHandle): FsHandleDescriptor {
  const registry = transport.dirRegistry
  if (registry === undefined) throw fail('internal', 'no fs directory transport configured for this broker')
  registry.register(origin, dir.id, dir)
  dir.onUnlink(() => { registry.remove(origin, dir.id) })
  return { id: dir.id }
}

/** `fs.*`'s dispatch cases -- the app-rooted seven, `fs.open`'s handle-scoped six (A184), `fs.userSelected`'s two shapes and `DirectoryHandle`'s own eight (A195). */
export async function dispatchFs (
  broker: Broker,
  origin: string,
  method: FsControlMethod,
  payload: unknown,
  transport?: FsTransport,
  abandoned?: AbortSignal
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
      if (transport === undefined) throw fail('internal', 'no fs transport configured for this broker')
      if (payload.directory === true) {
        // The FOLDER shape (A195, closing A194). `broker.fs.userSelected`'s
        // own directory overload (fs-contracts.ts) already resolves
        // `FailableDirectoryHandle | null` -- registerDirectoryHandle is the
        // ONLY new registration mechanism this needed, mirroring
        // registerFileHandle exactly (Rule 3).
        const dir = await broker.fs.userSelected(origin, { directory: true })
        if (dir !== null && abandoned?.aborted === true) { await dir.close(); return null }
        return dir === null ? null : registerDirectoryHandle(transport, origin, dir)
      }
      const opts = payload.multiple === undefined ? undefined : { multiple: payload.multiple }
      const files = await broker.fs.userSelected(origin, opts)
      // A person can outlast the page's wait at the picker. Its request has
      // already timed out, so it will never learn these ids: close them
      // rather than leave them open and counted until the session ends.
      if (abandoned?.aborted === true) { await Promise.all(files.map(async (file) => { await file.close() })); return [] }
      return files.map((file) => registerFileHandle(transport, origin, file))
    }
    case 'fs.read': {
      if (!isFsHandleReadParams(payload)) throw fail('invalid', 'fs.read requires { id: string, position: number, length: number }')
      const file = requireFile(broker, transport, origin, payload.id)
      return await file.read({ position: payload.position, length: payload.length })
    }
    case 'fs.write': {
      if (!isFsHandleWriteParams(payload)) throw fail('invalid', 'fs.write requires { id: string, position: number, data: Uint8Array }')
      const file = requireFile(broker, transport, origin, payload.id)
      return await file.write({ position: payload.position, data: payload.data })
    }
    case 'fs.fstat': {
      if (!isFsHandleIdParams(payload)) throw fail('invalid', 'fs.fstat requires { id: string }')
      const file = requireFile(broker, transport, origin, payload.id)
      return await file.stat()
    }
    case 'fs.truncate': {
      if (!isFsHandleTruncateParams(payload)) throw fail('invalid', 'fs.truncate requires { id: string, length: number }')
      const file = requireFile(broker, transport, origin, payload.id)
      await file.truncate(payload.length)
      return undefined
    }
    case 'fs.sync': {
      if (!isFsHandleIdParams(payload)) throw fail('invalid', 'fs.sync requires { id: string }')
      const file = requireFile(broker, transport, origin, payload.id)
      await file.sync()
      return undefined
    }
    case 'fs.close': {
      if (!isFsHandleIdParams(payload)) throw fail('invalid', 'fs.close requires { id: string }')
      // Idempotent, silent no-op for an id this origin was never handed --
      // matching Handle.close()'s own contract (handle-contracts.md's
      // "Common shape" section), the one exception to requireFile's refusal
      // above -- exactly net.close's own precedent (transport/dispatch/net.ts).
      //
      // ONE method closes either kind (A195): a page never says whether the
      // id it is holding names a file or a folder, and ids are drawn from
      // handles.ts's own global, unguessable pool and never reused while
      // either registry still holds one (fs-handle-wrapper.ts's own doc on
      // that pool), so checking both registries in turn can never find the
      // wrong resource -- only ever the right one, or none.
      const file = transport?.registry.get(origin, payload.id)
      if (file !== undefined) { await file.close(); return undefined }
      const dir = transport?.dirRegistry?.get(origin, payload.id)
      if (dir !== undefined) await dir.close()
      return undefined
    }
    case 'fs.dirReaddir': {
      if (!isFsDirPathOptionalParams(payload)) throw fail('invalid', 'fs.dirReaddir requires { id: string, path?: string }')
      const dir = requireDirectory(broker, transport, origin, payload.id)
      return await dir.readdir(payload.path)
    }
    case 'fs.dirStat': {
      if (!isFsDirPathOptionalParams(payload)) throw fail('invalid', 'fs.dirStat requires { id: string, path?: string }')
      const dir = requireDirectory(broker, transport, origin, payload.id)
      return await dir.stat(payload.path)
    }
    case 'fs.dirMkdir': {
      if (!isFsDirPathWithRecursiveParams(payload)) throw fail('invalid', 'fs.dirMkdir requires { id: string, path: string, recursive?: boolean }')
      const dir = requireDirectory(broker, transport, origin, payload.id)
      await dir.mkdir(payload.path, payload.recursive === undefined ? undefined : { recursive: payload.recursive })
      return undefined
    }
    case 'fs.dirRm': {
      if (!isFsDirPathWithRecursiveParams(payload)) throw fail('invalid', 'fs.dirRm requires { id: string, path: string, recursive?: boolean }')
      const dir = requireDirectory(broker, transport, origin, payload.id)
      await dir.rm(payload.path, payload.recursive === undefined ? undefined : { recursive: payload.recursive })
      return undefined
    }
    case 'fs.dirRename': {
      if (!isFsDirRenameParams(payload)) throw fail('invalid', 'fs.dirRename requires { id: string, from: string, to: string }')
      const dir = requireDirectory(broker, transport, origin, payload.id)
      await dir.rename(payload.from, payload.to)
      return undefined
    }
    case 'fs.dirReadFile': {
      if (!isFsDirPathRequiredParams(payload)) throw fail('invalid', 'fs.dirReadFile requires { id: string, path: string }')
      const dir = requireDirectory(broker, transport, origin, payload.id)
      return await dir.readFile(payload.path)
    }
    case 'fs.dirWriteFile': {
      if (!isFsDirWriteFileParams(payload)) throw fail('invalid', 'fs.dirWriteFile requires { id: string, path: string, data: Uint8Array }')
      const dir = requireDirectory(broker, transport, origin, payload.id)
      await dir.writeFile(payload.path, payload.data)
      return undefined
    }
    case 'fs.dirOpen': {
      if (!isFsDirOpenParams(payload)) throw fail('invalid', 'fs.dirOpen requires { id: string, path: string, flags: string }')
      if (transport === undefined) throw fail('internal', 'no fs transport configured for this broker')
      const dir = requireDirectory(broker, transport, origin, payload.id)
      // The whole point of A195's brief: DirectoryHandle.open() resolves a
      // real FileHandle (confined inside the picked folder, sharing its
      // pickId -- ../../capabilities/user-selected.ts's own `open`), registered
      // through the EXACT SAME registerFileHandle fs.open/fs.userSelected
      // already use. No second file-handle mechanism.
      const file = await dir.open(payload.path, payload.flags)
      return registerFileHandle(transport, origin, file)
    }
    default: {
      // Exhaustiveness check, same reasoning and shape as ../ipc.ts's own
      // dispatch() and ./net.ts's dispatchNet (A185): if
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
