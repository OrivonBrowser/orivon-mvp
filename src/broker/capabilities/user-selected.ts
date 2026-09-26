// `orivon.fs.userSelected` -- the OS picker (files or, per d-0029, a single
// folder), the shape L5-userselected's brief calls out as "the picker,
// remembered and revocable." Lifted out to its own file the same way
// net/id/fs already are (README.md's design notes): a fourth capability
// concern, not a branch inside capabilities/fs.ts, because it is authorised
// by the user's dialog choice rather than a standing `fs` grant --
// `handles.ts`'s own "FileHandle" exception, structural, not a special
// case bolted onto the grant-checked methods around it.
//
// ONE CONFINEMENT IMPLEMENTATION, ROOTED DIFFERENTLY (this lane's own
// brief). Every path under a picked folder goes through the SAME
// `confinePath` (../policy/paths.js) capabilities/fs.ts's `confineForOrigin`
// uses -- only the root passed to it differs: the picked path, realpath'd
// once at acquisition, never the app's own files directory. A second
// confinement implementation is the bug capabilities/fs.ts's own header says
// it exists to make impossible; this file does not repeat that mistake for
// a different root.

import { fail } from '../errors.js'
import { mapIoError } from '../io-errors.js'
import { CONFINEMENT_ERROR_CODE, confinePath } from '../policy/paths.js'
import { createFileHandleWrapper, VALID_OPEN_FLAGS } from './fs-handle-wrapper.js'
import type { HandleTable } from '../handles/handles.js'
import type { Authorisation, FailableDirectoryHandle, FailableFileHandle, HandleEntry } from '../handles/handle-contracts.js'
import type { GrantLedger } from '../grants/grant-ledger.js'
import type { PickedPathLedger } from '../grants/picked-path-ledger.js'
import type { BrokerFsMethods, OpenedFile } from '../fs-contracts.js'
import type { CreateBrokerOptions } from '../broker-contracts.js'

export interface UserSelectedCapabilityOptions {
  readonly deps: CreateBrokerOptions
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
  readonly pickedPaths: PickedPathLedger
  readonly canonical: (origin: string) => string
}

/** Builds the `userSelected` member of `Broker['fs']` -- see this file's header for why it is its own capability rather than a branch inside capabilities/fs.ts. */
export function createUserSelectedCapability (
  { deps, handleTable, ledger, pickedPaths, canonical }: UserSelectedCapabilityOptions
): Pick<BrokerFsMethods, 'userSelected'> {
  const { toFailableFileHandle } = createFileHandleWrapper({ handleTable, ledger })

  /** `confineForOrigin`'s own root-parametrised twin -- same `confinePath` call, a picked folder in place of `deps.fs.rootFor(origin)`. */
  function confineToRoot (root: string, path: string): string {
    const confined = confinePath(root, path, deps.fs.realpathSync)
    if (!confined.ok) throw fail(CONFINEMENT_ERROR_CODE, 'the path is outside the picked folder')
    return confined.resolved
  }

  /** Every operation against a picked handle re-checks ownership via `{on:'handle'}` (T11c) -- `fs-handle-wrapper.ts`'s `runFileIo`, applied here for DirectoryHandle's own RPC-shaped methods rather than a positional file. */
  async function runDirIo<T> (key: string, handleId: string, io: () => Promise<T>): Promise<T> {
    return await handleTable.run(key, { on: 'handle', handleId }, async (signal) => {
      if (signal.aborted) throw fail('revoked', 'the pick authorising this operation was revoked')
      let result: T
      try {
        result = await io()
      } catch (error) {
        throw mapIoError(error, 'fs')
      }
      if (signal.aborted) throw fail('revoked', 'the pick authorising this operation was revoked')
      return result
    })
  }

  /**
   * `root` is ALREADY the realpath'd, canonical form of the picked folder
   * (computed once, at acquisition, the same "confine once at open time is
   * sufficient" reasoning `capabilities/fs.ts`'s own `open` doc gives for a
   * file descriptor -- here the resource is a directory root rather than an
   * fd, but the argument is the same: nothing below re-resolves the root
   * itself, only paths relative to it).
   */
  function toFailableDirectoryHandle (key: string, entry: HandleEntry, root: string): FailableDirectoryHandle {
    /** `readdir`/`stat` alone may omit `path` to mean the root itself -- `handles.ts`'s own doc on `DirectoryHandle`. `confinePath` itself would refuse that (`'is-root'`, by design, for an APP-supplied path): the broker's own `root` bypasses it here rather than being asked to accept a value it exists to reject. */
    function resolveOptional (path: string | undefined): string {
      return path === undefined ? root : confineToRoot(root, path)
    }

    return {
      id: entry.id,
      closed: entry.closed,
      close: async (): Promise<void> => { await handleTable.release(key, entry.id) },
      fail: (code, platformCode) => { handleTable.fail(key, entry.id, code, platformCode) },
      onUnlink: (listener) => { handleTable.onUnlink(key, entry.id, listener) },
      readdir: async (path) => await runDirIo(key, entry.id, async () => await deps.fs.readdir(resolveOptional(path))),
      stat: async (path) => await runDirIo(key, entry.id, async () => await deps.fs.stat(resolveOptional(path))),
      mkdir: async (path, opts) => await runDirIo(key, entry.id, async () => { await deps.fs.mkdir(confineToRoot(root, path), opts) }),
      rm: async (path, opts) => await runDirIo(key, entry.id, async () => { await deps.fs.rm(confineToRoot(root, path), opts) }),
      // BOTH sides confined independently -- capabilities/fs.ts's own `rename`
      // doc explains why a check on `from` alone would turn this into an
      // arbitrary-write primitive; the same argument applies to a picked
      // root exactly as it does to the app's own files directory.
      rename: async (from, to) => await runDirIo(key, entry.id, async () => { await deps.fs.rename(confineToRoot(root, from), confineToRoot(root, to)) }),
      readFile: async (path) => await runDirIo(key, entry.id, async () => await deps.fs.readFile(confineToRoot(root, path))),
      writeFile: async (path, data) => {
        const resolved = confineToRoot(root, path)
        // Same reserve-then-write-then-refund-on-failure shape as
        // capabilities/fs.ts's own `writeFile` -- a picked folder's bytes
        // count against the SAME per-origin quota an app's own files
        // directory does; writing through a user-granted folder is not a
        // way around a declared storage limit.
        if (!ledger.reserveFsBytes(key, data.length)) {
          throw fail('limit', "this write would exceed the app's declared storage quota")
        }
        let started = false
        try {
          await runDirIo(key, entry.id, async () => {
            started = true
            try {
              await deps.fs.writeFile(resolved, data)
            } catch (error) {
              ledger.releaseFsBytes(key, data.length)
              throw error
            }
          })
        } catch (error) {
          if (!started) ledger.releaseFsBytes(key, data.length)
          throw error
        }
      },
      open: async (path, flags) => {
        if (!VALID_OPEN_FLAGS.has(flags)) throw fail('invalid', `unrecognised fs.open flags: ${flags}`)
        const resolved = confineToRoot(root, path)
        return await handleTable.run(key, { on: 'handle', handleId: entry.id }, async (signal) => {
          if (signal.aborted) throw fail('revoked', 'the pick authorising this operation was revoked')
          let opened: OpenedFile
          try {
            opened = await deps.fs.open(resolved, flags)
          } catch (error) {
            throw mapIoError(error, 'fs')
          }
          if (signal.aborted) {
            await opened.destroy('revoked')
            throw fail('revoked', 'the pick authorising this operation was revoked')
          }
          const { destroy, ...fields } = opened
          // SAME `pickId` as the directory itself -- not a derived handle
          // (`acquireDerived` is a tcpSocket-only mechanism, handles.ts's
          // own guard), a second row under the identical Authorisation. This
          // is what makes revoking the FOLDER pick also close a file opened
          // from inside it: both live in the same `byPickedPath` bucket.
          const fileEntry = handleTable.acquire({ origin: key, kind: 'file', authorisedBy: entry.authorisedBy, destroy })
          return toFailableFileHandle(key, fileEntry, fields)
        })
      }
    }
  }

  async function pickDirectory (key: string, appName: string | undefined): Promise<FailableDirectoryHandle | null> {
    let result: Awaited<ReturnType<CreateBrokerOptions['pickPath']>>
    try {
      result = await deps.pickPath({ directory: true, multiple: false, appName })
    } catch (error) {
      throw fail('internal', 'the OS picker could not be shown', undefined, error instanceof Error ? error.message : undefined)
    }
    // Cancelling the dialog is never a rejected promise -- capability-api.ts
    // is explicit that declining a picker is not a failure. `null` matches
    // the folder shape's true cardinality (at most one, never a list).
    if (result.canceled || result.paths.length === 0) return null

    let root: string
    try {
      root = deps.fs.realpathSync(result.paths[0] as string)
    } catch (error) {
      throw mapIoError(error, 'fs')
    }

    const pick = pickedPaths.record(key, 'directory', root, deps.now(), appName)
    const authorisedBy: Authorisation = { by: 'userSelected', pickId: pick.id }
    const entry = handleTable.acquire({ origin: key, kind: 'file', authorisedBy, destroy: () => {} })
    return toFailableDirectoryHandle(key, entry, root)
  }

  async function pickFiles (key: string, multiple: boolean, appName: string | undefined): Promise<readonly FailableFileHandle[]> {
    let result: Awaited<ReturnType<CreateBrokerOptions['pickPath']>>
    try {
      result = await deps.pickPath({ directory: false, multiple, appName })
    } catch (error) {
      throw fail('internal', 'the OS picker could not be shown', undefined, error instanceof Error ? error.message : undefined)
    }
    // Cancelling the file picker resolves an empty array, never a rejection
    // -- the file shape's own cancel convention (capability-api.ts).
    if (result.canceled) return []

    const handles: FailableFileHandle[] = []
    try {
      for (const path of result.paths) {
        let realPath: string
        try {
          realPath = deps.fs.realpathSync(path)
        } catch (error) {
          throw mapIoError(error, 'fs')
        }
        const pick = pickedPaths.record(key, 'file', realPath, deps.now(), appName)
        let opened: OpenedFile
        try {
          // 'r+': the app may read and write a file it explicitly picked --
          // `showOpenDialog` only ever names an EXISTING file (a save
          // dialog is a different, unbuilt method -- see this lane's log),
          // so the file is always there to open read-write.
          opened = await deps.fs.open(realPath, 'r+')
        } catch (error) {
          throw mapIoError(error, 'fs')
        }
        const { destroy, ...fields } = opened
        const entry = handleTable.acquire({ origin: key, kind: 'file', authorisedBy: { by: 'userSelected', pickId: pick.id }, destroy })
        handles.push(toFailableFileHandle(key, entry, fields))
      }
    } catch (error) {
      // One failed pick tears down whatever this call already opened,
      // rather than handing back a partial array with no way for the app
      // to know which entries are missing -- the same all-or-nothing
      // acquisition discipline `open`'s own signal-checked cleanup follows.
      for (const handle of handles) await handle.close()
      throw error
    }
    return handles
  }

  // Overloaded the same way BrokerFsMethods/capability-api.ts declare it
  // (A167 item 2) -- two call signatures plus one implementation signature
  // that is never itself part of the public overload set, so a caller
  // passing `{ directory: true }` sees `DirectoryHandle | null` with no
  // union or cast at the call site.
  async function userSelected (origin: string, opts: { directory: true }): Promise<FailableDirectoryHandle | null>
  async function userSelected (origin: string, opts?: { directory?: false, multiple?: boolean }): Promise<readonly FailableFileHandle[]>
  async function userSelected (origin: string, opts?: { directory?: boolean, multiple?: boolean }): Promise<FailableDirectoryHandle | null | readonly FailableFileHandle[]> {
    const key = canonical(origin)
    const appName = ledger.manifestFor(key)?.name
    if (opts?.directory === true) return await pickDirectory(key, appName)
    return await pickFiles(key, opts?.multiple === true, appName)
  }

  return { userSelected }
}
