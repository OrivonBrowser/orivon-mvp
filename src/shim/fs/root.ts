// The app's own files-directory ROOT -- Node's cwd equivalent, reached as
// '.' or as the virtual root (fs/paths.ts maps the second onto the
// first) -- is a path the broker's confinement policy always refuses
// (src/broker/policy/paths.ts's `deny('is-root')`, deliberately: every call
// orivon.fs accepts is confined to a path STRICTLY INSIDE the root).
//
// THE ANSWER LIVES HERE, NOT IN A BROKER POLICY CHANGE. The root always
// exists -- the broker creates it -- exactly the way a process's cwd always
// exists in real Node, so the calls a ported dependency makes on it are
// answered locally: stat/access succeed, `mkdir -p` is a no-op, open('r')
// gives a directory fd whose fsync succeeds (@seald-io/nedb fsyncs its
// parent directory, '.', after every crash-safe rename), and a read or write
// of it as a file is EISDIR. readdir is the one it cannot answer: listing
// the root needs the broker, which refuses it. README.md's Design notes has
// the detail.

import { normalize } from 'path'
import type { FileHandle, FileStat } from '../../contracts/handles.js'
import { fsError } from './paths.js'

/** `.`, `./`, `a/..`, `./a/..`, ... -- any relative path whose POSIX-normalised form names the current directory itself. Never true for an absolute path or a real traversal outside it (`../x` normalises to `../x`, not `.`). */
export function isRootPath (path: string): boolean {
  const normalized = normalize(path)
  return normalized === '.' || normalized === './'
}

/** Synthetic, not a lie about the KIND: the root is a directory. The broker refuses the root itself, so there is no real size or mtime to report. */
const ROOT_STAT: FileStat = { size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }

export function rootStat (): FileStat { return ROOT_STAT }

/** readFile/writeFile/appendFile/readFileSync on the root: a directory is not a file, as in Node. */
export function rootIsDirectoryError (syscall: string): never { throw fsError('EISDIR', 'illegal operation on a directory', syscall) }

/** The one root call with no local answer: listing it needs the broker, which refuses the root. */
export function rootReaddirError (): never {
  throw fsError('EACCES', "permission denied (orivon.fs cannot list the app's root directory itself; list a folder inside it)", 'scandir')
}

/** rm/unlink/rename of the root: it is where the app's files live, and nothing may remove or move it. */
export function rootNotRemovableError (syscall: string): never {
  throw fsError('EACCES', "permission denied (the app's root directory cannot be removed or moved)", syscall)
}

/**
 * The three outcomes checked against real Node on Linux (ext4), not
 * assumed -- a directory fd's behaviour is easy to get wrong by analogy
 * with a regular file's. `read` fails EISDIR (the kernel refuses to read
 * directory bytes as a stream); `write` fails EBADF instead (the fd itself
 * is O_RDONLY, so the write never gets far enough to notice it targets a
 * directory); `truncate` fails EINVAL. `fs/handle.ts`'s
 * `NodeFileHandle` calls these directly for its own root-flagged instance,
 * so its fabricated `.code` reaches the caller unmangled -- routing a
 * directory fd's read/write/truncate through `guarded()`'s toNodeError
 * (which only recognises a real OrivonError) would overwrite it with
 * 'internal'. `rootDirectoryHandle()`'s own read/write/truncate below reuse
 * the exact same three functions, so the two never drift.
 */
export function rootReadError (): never { throw fsError('EISDIR', 'illegal operation on a directory', 'read') }
export function rootWriteError (): never { throw fsError('EBADF', 'bad file descriptor', 'write') }
export function rootTruncateError (): never { throw fsError('EINVAL', 'invalid argument', 'ftruncate') }

/**
 * A directory fd opened read-only over the root. `stat`/`sync`/`close` all
 * SUCCEED -- checked against real Node, not assumed; `stat` in particular
 * is NOT EISDIR, which a naive "directories refuse everything" assumption
 * would get wrong. `fs/handle.ts`'s `NodeFileHandle` intercepts
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
    stat: async (): Promise<FileStat> => ROOT_STAT,
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
  if (flags !== 'r') throw fsError('EISDIR', 'illegal operation on a directory', 'open')
}

/**
 * `fs.mkdir(root, opts)` -- the root always exists (the broker creates it),
 * so this is Node's own "mkdir an existing directory" outcome: recursive
 * succeeds as a no-op, and its absence fails EEXIST, exactly as Node's real
 * `fs.mkdir` does for any other already-existing directory.
 */
export function assertRootMkdirAllowed (opts: { recursive?: boolean } | undefined): void {
  if (opts?.recursive === true) return
  throw fsError('EEXIST', 'file already exists', 'mkdir')
}
