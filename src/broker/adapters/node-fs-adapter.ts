// The `BrokerFs` adapter -- the real filesystem half of ./node-adapters.ts,
// split out under code-guidelines.md Rule 2 once queue item 2.1's five new
// operations (mkdir, readdir, stat, rm, rename) pushed that file past 500
// lines. Concern-based, not line-count-based: ./node-adapters.ts's own
// header has always drawn this exact line ("dialTcp/dialOne/resolveHost
// need only node:net/node:dns; nodeFs needs only node:fs") -- this file is
// that other half, made real. A pure move for readFile/writeFile: every
// test that exercised them keeps exercising the same code, imported from
// here instead.

import { createReadStream, createWriteStream, mkdirSync, realpathSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import {
  mkdir,
  open as fsOpen,
  readdir as fsReaddir,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile
} from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { dirname, join } from 'node:path'
import type { BrokerFs, OpenedFile } from '../broker-contracts.js'
import type { CloseReason } from '../handles/handle-contracts.js'
import { originHash } from '../grants/origin-hash.js'

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
  return fsOpen(path, flags).then((handle) => {
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
        return Writable.toWeb(nodeStream) as WritableStream<Uint8Array>
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
        await handle.close()
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
    // NEITHER readFile NOR writeFile CATCHES. fs-capability.ts's `mapIoError`
    // is the one place an errno becomes an OrivonError; a catch here that
    // produced one instead would BYPASS that mapping, forwarding the
    // confined absolute path -- and through it the OS account name and the
    // sha256 confinement root (T13b) -- to the app verbatim as an 'internal'
    // error rather than 'denied': the exact permission-probe oracle
    // errors.ts's uniformity rule exists to close. One implementation of
    // this idea (code-guidelines.md Rule 3), and every method below follows
    // the same no-catch rule for the same reason.
    readFile: async (path) => {
      const buffer = await fsReadFile(path)
      // A COPY, not a zero-copy view over `buffer.buffer`. A Node Buffer is
      // a Uint8Array, but it can be a window into Node's shared allocation
      // pool (an 8KB slab holding unrelated data), and structured clone --
      // the path this value takes to the renderer -- serialises an
      // ArrayBufferView by serialising its WHOLE backing ArrayBuffer. See
      // README.md, Design notes, for why this is worth the memcpy even
      // though nothing observable leaks today.
      return new Uint8Array(buffer)
    },
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true })
      await fsWriteFile(path, data)
    },
    mkdir: async (path, opts) => { await mkdir(path, { recursive: opts?.recursive ?? false }) },
    // Names only, never full paths -- capability-api.ts's `readdir` returns
    // `readonly string[]`, and `withFileTypes` is not asked for because
    // nothing above this layer needs entry kinds yet (that is `stat`'s job,
    // called per entry by the shim if it needs one).
    readdir: async (path) => await fsReaddir(path),
    stat: async (path) => {
      const s = await fsStat(path)
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
    open: openFile
  }
}
