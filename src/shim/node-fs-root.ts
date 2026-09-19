// The app's own files-directory ROOT -- Node's cwd equivalent here -- is a
// path the broker's own confinement policy always refuses
// (src/broker/policy/paths.ts's `deny('is-root')`, deliberately, whenever a
// requested path resolves to the root itself: `docs/open-questions.md`
// around confinePath's own design notes). @seald-io/nedb's storage.js asks
// for it directly, twice: `path.dirname('settings.db')` is `'.'` for
// `fs.promises.mkdir(dir, {recursive: true})`, and `flushToStorageAsync`
// opens that same `'.'` with flags 'r' to fsync the datafile's parent
// directory after every crash-safe rename.
//
// THE ANSWER LIVES HERE, NOT IN A BROKER POLICY CHANGE. The root always
// exists -- the broker creates it -- exactly the way a process's cwd always
// exists in real Node; `orivon.fs` simply has no operation that targets it
// (every call it accepts is confined to a path STRICTLY INSIDE the root).
// This module answers the handful of root-targeting calls a ported
// dependency's OWN Node semantics require, entirely locally, and lets every
// other call (stat, readdir, readFile, ...) keep reaching the broker and
// getting its ordinary, uniform 'denied' -- see node-fs-core.ts's `doMkdir`
// and node-fs-handle.ts's `NodeFileHandle.open` for the two call sites this
// intercepts, and README.md's Design notes for which calls were
// deliberately left alone and why.

import { normalize } from 'path'
import type { FileHandle, FileStat } from '../contracts/handles.js'

/** `.`, `./`, `a/..`, `./a/..`, ... -- any relative path whose POSIX-normalised form names the current directory itself. Never true for an absolute path or a real traversal outside it (`../x` normalises to `../x`, not `.`). */
export function isRootPath (path: string): boolean {
  const normalized = normalize(path)
  return normalized === '.' || normalized === './'
}

function nodeError (syscall: string, code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`orivon-node-shim: ${code}: ${message}, ${syscall}`), { code })
}

/**
 * The three outcomes checked against real Node on Linux (ext4), not
 * assumed -- a directory fd's behaviour is easy to get wrong by analogy
 * with a regular file's. `read` fails EISDIR (the kernel refuses to read
 * directory bytes as a stream); `write` fails EBADF instead (the fd itself
 * is O_RDONLY, so the write never gets far enough to notice it targets a
 * directory); `truncate` fails EINVAL. `node-fs-handle.ts`'s
 * `NodeFileHandle` calls these directly for its own root-flagged instance,
 * so its fabricated `.code` reaches the caller unmangled -- routing a
 * directory fd's read/write/truncate through `guarded()`'s toNodeError
 * (which only recognises a real OrivonError) would overwrite it with
 * 'internal'. `rootDirectoryHandle()`'s own read/write/truncate below reuse
 * the exact same three functions, so the two never drift.
 */
export function rootReadError (): never { throw nodeError('read', 'EISDIR', 'illegal operation on a directory') }
export function rootWriteError (): never { throw nodeError('write', 'EBADF', 'bad file descriptor') }
export function rootTruncateError (): never { throw nodeError('truncate', 'EINVAL', 'invalid argument') }

/**
 * A directory fd opened read-only over the root. `stat`/`sync`/`close` all
 * SUCCEED -- checked against real Node, not assumed; `stat` in particular
 * is NOT EISDIR, which a naive "directories refuse everything" assumption
 * would get wrong. `node-fs-handle.ts`'s `NodeFileHandle` intercepts
 * read/write/truncate before ever reaching this object's own versions of
 * them (so those three are unreachable in practice, kept only so this
 * still satisfies the `FileHandle` shape).
 */
export function rootDirectoryHandle (): FileHandle {
  return {
    id: 'root-directory-handle',
    closed: new Promise(() => {}),
    close: async () => {},
    read: async () => rootReadError(),
    write: async () => rootWriteError(),
    readable: () => rootReadError(),
    writable: () => rootWriteError(),
    // Synthetic, not a lie about the KIND: isDirectory is genuinely true.
    // orivon.fs.stat('.') is never called to fill this in -- the broker
    // refuses that path unconditionally (README.md's Design notes explains
    // why stat('.') is deliberately left refusing rather than answered
    // here), so there is no real size/mtimeMs this shim could ask for
    // without contradicting that choice.
    stat: async (): Promise<FileStat> => ({ size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }),
    truncate: async () => rootTruncateError(),
    sync: async () => {}
  }
}

/**
 * `fs.open(root, flags)`'s own gate, called before this module's fake
 * handle is ever constructed: only 'r' succeeds (real Node opens a
 * directory read-only fine); every other flag fails immediately, the same
 * "illegal operation on a directory" real Node's own `open()` gives for
 * `fs.open(aDirectory, 'w'|'a'|'r+'|...)` -- checked against real Node, not
 * assumed.
 */
export function assertRootOpenAllowed (flags: string): void {
  if (flags !== 'r') throw nodeError('open', 'EISDIR', 'illegal operation on a directory')
}

/**
 * `fs.mkdir(root, opts)` -- the root always exists (the broker creates it),
 * so this is Node's own "mkdir an existing directory" outcome: recursive
 * succeeds as a no-op, and its absence fails EEXIST, exactly as Node's real
 * `fs.mkdir` does for any other already-existing directory.
 */
export function assertRootMkdirAllowed (opts: { recursive?: boolean } | undefined): void {
  if (opts?.recursive === true) return
  throw nodeError('mkdir', 'EEXIST', 'file already exists')
}
