// The `BrokerFs` adapter -- the real filesystem half of ./node-adapters.ts,
// split out under code-guidelines.md Rule 2 once queue item 2.1's five new
// operations (mkdir, readdir, stat, rm, rename) pushed that file past 500
// lines. Concern-based, not line-count-based: ./node-adapters.ts's own
// header has always drawn this exact line ("dialTcp/dialOne/resolveHost
// need only node:net/node:dns; nodeFs needs only node:fs") -- this file is
// that other half, made real. A pure move for readFile/writeFile: every
// test that exercised them keeps exercising the same code, imported from
// here instead.

import { constants as fsConstants, createReadStream, createWriteStream, mkdirSync, realpathSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open as fsOpen,
  readdir as fsReaddir,
  rename as fsRename,
  rm as fsRm
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { dirname, join } from 'node:path'
import type { BrokerFs, OpenedFile } from '../broker-contracts.js'
import type { CloseReason } from '../handles/handle-contracts.js'
import { originHash } from '../grants/origin-hash.js'

/**
 * `node:fs`'s own numeric equivalent of every flags string
 * `fs-handle-wrapper.ts`'s `VALID_OPEN_FLAGS` accepts -- Node's docs list
 * these; there is no exported function that does the string-to-number
 * conversion, so it is reproduced here (verified against the real `open`
 * for every string in that set: same accept/refuse outcome, same resulting
 * bytes, for both a missing and an already-existing leaf). Needed so
 * `O_NOFOLLOW` (below) can be OR'd in -- `fs.open`'s string form has no way
 * to add a flag to it.
 */
const OPEN_FLAG_BITS: Readonly<Record<string, number>> = {
  r: fsConstants.O_RDONLY,
  rs: fsConstants.O_RDONLY | fsConstants.O_SYNC,
  'r+': fsConstants.O_RDWR,
  'rs+': fsConstants.O_RDWR | fsConstants.O_SYNC,
  w: fsConstants.O_TRUNC | fsConstants.O_CREAT | fsConstants.O_WRONLY,
  wx: fsConstants.O_TRUNC | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_EXCL,
  'w+': fsConstants.O_TRUNC | fsConstants.O_CREAT | fsConstants.O_RDWR,
  'wx+': fsConstants.O_TRUNC | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_EXCL,
  a: fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
  ax: fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_EXCL,
  'a+': fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR,
  'ax+': fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_EXCL
}

/** Undefined on Windows -- node:fs's own docs list it as POSIX-only. */
const NOFOLLOW: number | undefined = fsConstants.O_NOFOLLOW

/**
 * `OPEN_FLAG_BITS[flags]`, asserted defined. Every external caller of
 * `open` validates `flags` against `VALID_OPEN_FLAGS` first (this file's
 * own `openFile` doc), and `readFile`/`writeFile` below only ever pass
 * their own fixed `'r'`/`'w'` -- both always present in the table above, so
 * this throw is unreachable in practice, matching `openFile`'s own
 * fail-closed shape for the same case.
 */
function flagBits (flags: string): number {
  const bits = OPEN_FLAG_BITS[flags]
  if (bits === undefined) throw new Error(`node-fs-adapter: unrecognised open flags '${flags}'`)
  return bits
}

/**
 * The error a leaf symlink refusal raises, shaped exactly like the real
 * `ELOOP` `O_NOFOLLOW` itself produces (verified directly: opening a leaf
 * symlink with `O_NOFOLLOW` set throws `Error: ELOOP: too many symbolic
 * links encountered, code: 'ELOOP'`) -- so the Windows lstat-first fallback
 * below and the POSIX kernel refusal reach ../io-errors.ts's `mapIoError`
 * as the same errno and map to the same `'denied'` this broker already
 * uses for `policy/paths.ts`'s own `symlink-escape` (paths.ts's own doc
 * comment, and this function's own doc, explain why: closing the confinement
 * TOCTOU window this way, not by re-running `confinePath`, since the path
 * string alone cannot see what changed underneath it since the check).
 */
export function leafSymlinkError (path: string): NodeJS.ErrnoException {
  const error = new Error(`ELOOP: too many symbolic links encountered, open '${path}'`) as NodeJS.ErrnoException
  error.code = 'ELOOP'
  return error
}

/**
 * `fs.open`, refusing a leaf that is a symlink rather than following it --
 * closes `policy/paths.ts`'s own documented TOCTOU (confinePath proves the
 * leaf is safe at THAT instant; only the open, not a second path check, can
 * prove it still is). `O_NOFOLLOW` where the platform defines it (every
 * platform this repository ships to except Windows): the kernel itself
 * refuses atomically, so there is no window at all between the check and
 * the refusal. On Windows: `O_NOFOLLOW` does not exist, so this lstats the
 * leaf immediately before the open and refuses a symlink there -- a real
 * but narrower window than the POSIX path, and the residual this function
 * does NOT close (a parent directory swapped mid-walk, not the leaf) is
 * `docs/open-questions.md` A283 on both platforms.
 */
async function openNoFollow (path: string, flags: string, bits: number): Promise<FileHandle> {
  if (NOFOLLOW !== undefined) return await fsOpen(path, bits | NOFOLLOW)
  let leaf
  try {
    leaf = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Does not exist yet -- nothing to follow. The real open below still
    // runs, and creates it (or fails ENOENT itself for a read-only flag).
    return await fsOpen(path, flags)
  }
  if (leaf.isSymbolicLink()) throw leafSymlinkError(path)
  return await fsOpen(path, flags)
}

/**
 * `OpenedFile` over a real `fs.promises.FileHandle`. `readable`/`writable`
 * ALWAYS pass an explicit `start` (never `undefined`) to `createReadStream`/
 * `createWriteStream` -- Node falls back to the shared, kernel-tracked fd
 * position once `start` is left out, and that is exactly the implicit-cursor
 * hazard `FileHandle`'s own contract (src/contracts/handles.ts) exists to
 * rule out even for these bulk-stream paths. See node-fs-adapter-open.test.ts's
 * "writable() with no opts starts at 0" for the regression this guards.
 *
 * `destroy`'s teardown is CONDITIONAL ON THE CLOSE REASON, mirroring
 * node-adapters.ts's `destroySocket` (A84): 'closed'/'sessionEnded' let any
 * still-queued `writable()` stream drain before the fd is released;
 * 'revoked'/'aborted'/'failed' discard it. Unlike a TCP socket there is no
 * remote peer that can stall a drain forever -- a local Node WriteStream
 * drains to the OS's own write() syscall, bounded by disk I/O, never by
 * another party's willingness to read -- so this deliberately does NOT
 * reuse `destroySocket`'s CLOSE_DRAIN_TIMEOUT_MS; see README.md's design
 * notes for the full reasoning.
 */
function openFile (path: string, flags: string): Promise<OpenedFile> {
  // `flagBits` inside the chain, not before it: a caller relies on THIS
  // function never throwing synchronously (matching `fsOpen`'s own
  // contract, which openFile wrapped before this fix), only ever rejecting.
  return Promise.resolve().then(() => flagBits(flags))
    .then((bits) => openNoFollow(path, flags, bits))
    .then((handle) => {
    const fd = handle.fd
    const liveWriteStreams = new Set<WriteStream>()

    return {
      read: async ({ position, length }) => {
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read({ buffer, position, length })
        // Same copy discipline as readFile above -- see that method's own
        // comment. `subarray` is a view; wrapping it in `new Uint8Array(...)`
        // is what actually copies it into its own backing buffer.
        return new Uint8Array(buffer.subarray(0, bytesRead))
      },
      write: async ({ position, data }) => {
        const { bytesWritten } = await handle.write(data, 0, data.length, position)
        return bytesWritten
      },
      readable: (opts) => {
        const start = opts?.start ?? 0
        // contracts/handles.ts's own doc: "[start, end)" -- EXCLUSIVE of end.
        // Node's own `end` option on createReadStream is INCLUSIVE, so it is
        // translated here rather than passed through; an empty range (end
        // at or before start) is answered directly, since Node has no clean
        // way to ask a ReadStream for zero bytes.
        if (opts?.end !== undefined && opts.end <= start) {
          return new ReadableStream<Uint8Array>({ start (controller) { controller.close() } })
        }
        const nodeStream = createReadStream(path, { fd, start, end: opts?.end === undefined ? undefined : opts.end - 1, autoClose: false })
        // Same reasoning as writable()'s own 'error' listener just below --
        // a reader.cancel() (or this handle's own destroy()) can destroy the
        // raw stream abruptly, and a zero-listener 'error' event is fatal to
        // the whole process, not merely to this read.
        nodeStream.on('error', () => {})
        return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
      },
      writable: (opts) => {
        const nodeStream = createWriteStream(path, { fd, start: opts?.start ?? 0, autoClose: false })
        // REQUIRED, not decoration: `destroy()` below calls `stream.destroy()`
        // directly on the RAW stream for an abrupt reason, bypassing
        // `Writable.toWeb`'s own graceful-close bookkeeping -- its internal
        // `end-of-stream` listener then raises ERR_STREAM_PREMATURE_CLOSE as
        // a real 'error' event on THIS stream. An EventEmitter with zero
        // 'error' listeners throws, which on this path crashes the whole
        // Electron main process. The WHATWG side still reports the failure
        // correctly through its own writer promise regardless -- this
        // listener only stops the raw duplicate from being fatal.
        nodeStream.on('error', () => {})
        liveWriteStreams.add(nodeStream)
        nodeStream.once('close', () => { liveWriteStreams.delete(nodeStream) })
        const web = Writable.toWeb(nodeStream) as WritableStream<Uint8Array>
        // TWO SEPARATE escapes from the same premature close, both found
        // running the full suite, neither covered by the raw stream's own
        // 'error' listener above because both live on DIFFERENT promises
        // that Writable.toWeb creates internally:
        //   1. `writer.closed`/`writer.ready` settle when the wrapped
        //      stream errors -- unhandled if the caller never observes them.
        //   2. Each individual `writer.write(chunk)` call has its OWN
        //      promise, tied to that one queued write, which is what
        //      abrupt teardown actually needs to interrupt (a graceful
        //      `writer.abort()` waits for an in-flight write instead of
        //      cutting it off -- confirmed directly: it lets the whole
        //      chunk land, which is wrong for 'revoked'/'aborted'). So the
        //      write MUST be interrupted via the raw stream's `destroy()`
        //      below, which leaves this exact promise to reject on its own.
        // getWriter() is wrapped, not called here, because acquiring the
        // writer eagerly and holding it would lock the stream before the
        // caller ever gets a chance to -- this only observes whichever
        // writer the caller ends up creating, attaching a silent handler
        // alongside (never instead of) whatever the caller itself attaches,
        // so a caller that DOES check write()'s result still sees it.
        const getWriter = web.getWriter.bind(web)
        web.getWriter = () => {
          const writer = getWriter()
          writer.closed.catch(() => {})
          writer.ready.catch(() => {})
          const write = writer.write.bind(writer)
          writer.write = (chunk) => {
            const result = write(chunk)
            result.catch(() => {})
            return result
          }
          return writer
        }
        return web
      },
      stat: async () => {
        const s = await handle.stat()
        return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs }
      },
      truncate: async (length) => { await handle.truncate(length) },
      sync: async () => { await handle.sync() },
      destroy: async (reason: CloseReason) => {
        const flush = reason === 'closed' || reason === 'sessionEnded'
        const pending = Array.from(liveWriteStreams)
        liveWriteStreams.clear()
        await Promise.all(pending.map(async (stream) => {
          await new Promise<void>((resolve) => {
            if (flush) stream.end(() => { resolve() })
            else { stream.destroy(); resolve() }
          })
        }))
        try {
          await handle.close()
        } catch (error) {
          // Expected, not exceptional, whenever a stream was just torn down
          // above: destroying/ending it closes this SAME shared fd even
          // though it was opened with `autoClose: false` (confirmed
          // directly, not assumed -- that option only suppresses the
          // auto-close-on-finish convenience, not the close a stream's own
          // teardown forces regardless), so this handle.close() is closing
          // an fd that is already gone. Any OTHER close failure still
          // propagates.
          if (!(error != null && typeof error === 'object' && 'code' in error && error.code === 'EBADF')) throw error
        }
      }
    }
  })
}

/**
 * `BrokerFs` over the real filesystem. `rootFor` is `../grants/origin-hash.js`'s
 * `originHash(origin)` under `<userData>/apps/`, per ADR-0003 and
 * security-model.md T13b -- directory names must never be the literal
 * origin string, or `https://Example.com` and `https://example.com`
 * collide on a case-insensitive filesystem. `../grants/origin-hash.js`'s own
 * header explains why this construction is shared with `partitionFor`
 * rather than inlined here.
 *
 * Takes `userDataPath` as a plain string rather than reaching for Electron's
 * `app` itself, so this adapter -- like `../node-adapters.js`'s
 * `dialTcp`/`resolveHost`, which need no Electron at all -- stays testable
 * against a real temp directory without needing Electron either.
 */
export function nodeFs (userDataPath: string): BrokerFs {
  return {
    // CREATES the root, it does not merely name it. confinePath's very first
    // act is realpath(root), and its own doc calls a root that will not
    // resolve "a broker bug, not an app's" -- so a root that has never been
    // created denies every path the app ever asks for, silently and always
    // (it fails closed, the same as a real traversal attempt, which is why
    // nothing catches it by symptom). Nothing else in the tree creates it:
    // writeFile's own mkdir runs on the confined path, only reached after
    // confinement has already refused.
    //
    // recursive: true makes this a no-op once the directory exists. It is a
    // blocking syscall on the broker's thread, in a function that already
    // hands confinePath a synchronous realpath (A28) -- whoever makes
    // realpath async should take this with it.
    rootFor: (origin) => {
      const root = join(userDataPath, 'apps', originHash(origin), 'files')
      mkdirSync(root, { recursive: true })
      return root
    },
    realpathSync,
    // NEITHER readFile NOR writeFile CATCHES. capabilities/fs.ts's `mapIoError`
    // is the one place an errno becomes an OrivonError; a catch here that
    // produced one instead would BYPASS that mapping, forwarding the
    // confined absolute path -- and through it the OS account name and the
    // sha256 confinement root (T13b) -- to the app verbatim as an 'internal'
    // error rather than 'denied': the exact permission-probe oracle
    // errors.ts's uniformity rule exists to close. One implementation of
    // this idea (code-guidelines.md Rule 3), and every method below follows
    // the same no-catch rule for the same reason.
    //
    // BOTH open the leaf via `openNoFollow` and read/write through the
    // returned handle, never a second path-taking call -- paths.ts's own
    // doc comment for why (the TOCTOU `confinePath` cannot close itself).
    readFile: async (path) => {
      const handle = await openNoFollow(path, 'r', flagBits('r'))
      try {
        const buffer = await handle.readFile()
        // A COPY, not a zero-copy view over `buffer.buffer`. A Node Buffer is
        // a Uint8Array, but it can be a window into Node's shared allocation
        // pool (an 8KB slab holding unrelated data), and structured clone --
        // the path this value takes to the renderer -- serialises an
        // ArrayBufferView by serialising its WHOLE backing ArrayBuffer. See
        // README.md, Design notes, for why this is worth the memcpy even
        // though nothing observable leaks today.
        return new Uint8Array(buffer)
      } finally {
        await handle.close()
      }
    },
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true })
      const handle = await openNoFollow(path, 'w', flagBits('w'))
      try {
        await handle.writeFile(data)
      } finally {
        await handle.close()
      }
    },
    mkdir: async (path, opts) => { await mkdir(path, { recursive: opts?.recursive ?? false }) },
    // Names only, never full paths -- capability-api.ts's `readdir` returns
    // `readonly string[]`, and `withFileTypes` is not asked for because
    // nothing above this layer needs entry kinds yet (that is `stat`'s job,
    // called per entry by the shim if it needs one).
    readdir: async (path) => await fsReaddir(path),
    // `lstat`, never `stat`: reports the leaf itself, so a symlink planted
    // there since confinement reads as neither a file nor a directory
    // rather than silently handing back a target outside the root's own
    // size/mtime -- paths.ts's own doc comment. Free of the TOCTOU the
    // other methods close with `O_NOFOLLOW`: `lstat` is already one syscall
    // that never follows the leaf, on every platform, with no open to add
    // a flag to.
    stat: async (path) => {
      const s = await lstat(path)
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs }
    },
    // NO `force`: ../broker-contracts.js's `BrokerFs` doc records that a
    // missing path surfaces ENOENT like every other fs call, rather than
    // silently succeeding -- `force` would swallow that distinction here,
    // underneath the mapping that turns ENOENT into 'notFound'.
    rm: async (path, opts) => { await fsRm(path, { recursive: opts?.recursive ?? false }) },
    // Does NOT create the destination's parent directory, unlike writeFile
    // above -- `mkdir` is now its own capability method, and a caller that
    // wants that convenience can call it explicitly rather than have rename
    // silently create directory structure on its behalf.
    rename: async (from, to) => { await fsRename(from, to) },
    open: openFile,
    diskUsage
  }
}

/**
 * The bytes the regular files at or under `path` hold, 0 if it does not
 * exist. lstat, never stat: a symlink is counted as itself and never
 * followed, so nothing outside the tree is measured.
 */
async function diskUsage (path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  let total = 0
  for (const name of await fsReaddir(path)) total += await diskUsage(join(path, name))
  return total
}
