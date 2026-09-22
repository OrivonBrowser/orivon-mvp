// Every fs path a caller passes, turned into the confined relative path
// orivon.fs takes: an absolute path under the virtual root (virtual-root.ts)
// is stripped to what follows it, a relative one passes through exactly as
// written, and one outside the root fails EACCES here. README.md's Design
// notes, "One virtual root", says why. Also the Node-shaped error every fs
// module in this package throws.

import { isAbsolute, normalize } from 'path'
import { getOrivon } from './orivon-global.js'
import { toNodeError } from './node-http-errors.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from './virtual-root.js'

export type PathLike = string | Uint8Array | URL

export interface NodeFsError extends Error {
  code: string
  errno: number | undefined
  syscall: string
  path?: string
}

/** Linux values, as Node reports them on the platform the broker runs on. */
const ERRNO: Readonly<Record<string, number>> = { ENOENT: -2, EBADF: -9, EACCES: -13, EEXIST: -17, EISDIR: -21, EINVAL: -22 }

/** A Node-shaped fs error: `EISDIR: illegal operation on a directory, read`, with `code`, `errno`, `syscall` and, when there is one, `path`. */
export function fsError (code: string, description: string, syscall: string, path?: string): NodeFsError {
  const where = path === undefined ? syscall : `${syscall} '${path}'`
  const error = Object.assign(new Error(`${code}: ${description}, ${where}`), { code, errno: ERRNO[code], syscall })
  return path === undefined ? error : Object.assign(error, { path })
}

/**
 * Runs one orivon.fs call, rethrowing its OrivonError as a Node-shaped one.
 * Wrap the orivon.fs call only: an error already Node-shaped (from this
 * file, or node-fs-root.ts) would come out of toNodeError as 'internal'.
 */
export async function guarded<T> (run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toNodeError(error)
  }
}

function invalidPath (path: unknown): TypeError & { code: string } {
  return Object.assign(
    new TypeError(`The "path" argument must be of type string or an instance of Buffer or URL. Received ${typeof path}`),
    { code: 'ERR_INVALID_ARG_TYPE' }
  )
}

function pathText (path: PathLike): string {
  if (typeof path === 'string') return path
  if (path instanceof Uint8Array) return new TextDecoder().decode(path)
  if (path instanceof URL) {
    if (path.protocol !== 'file:') throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' })
    return decodeURIComponent(path.pathname)
  }
  throw invalidPath(path)
}

/** POSIX-normalised, with any trailing slash dropped so `/orivon/app/` is the root. */
function normalized (text: string): string {
  return normalize(text).replace(/(.)\/+$/, '$1')
}

/** The path orivon.fs takes for `path`: `.` for the root itself. Throws EACCES, naming `syscall`, for one outside the root. */
export function toConfinedPath (path: PathLike, syscall: string): string {
  const text = pathText(path)
  const resolved = normalized(text)
  if (isAbsolute(resolved)) {
    if (resolved === VIRTUAL_ROOT) return '.'
    if (resolved.startsWith(`${VIRTUAL_ROOT}/`)) return resolved.slice(VIRTUAL_ROOT.length + 1)
  } else if (resolved !== '..' && !resolved.startsWith('../')) {
    return text
  }
  throw fsError('EACCES', `permission denied (outside this app's files, which live under ${VIRTUAL_ROOT})`, syscall, text)
}

const TMPDIR_CONFINED = VIRTUAL_TMPDIR.slice(VIRTUAL_ROOT.length + 1)
let tmpdirReady: Promise<void> | undefined

function isInTmpdir (path: PathLike): boolean {
  const resolved = normalized(pathText(path))
  return resolved === VIRTUAL_TMPDIR || resolved.startsWith(`${VIRTUAL_TMPDIR}/`)
}

/**
 * toConfinedPath, plus making os.tmpdir() exist the first time a path inside
 * it is used: Node's tmpdir always exists, the app's files root starts empty.
 * A failed mkdir is not reported here; the call that needed it reports its
 * own failure instead, and the next one tries again.
 */
export async function confine (path: PathLike, syscall: string): Promise<string> {
  const confined = toConfinedPath(path, syscall)
  if (isInTmpdir(path)) {
    tmpdirReady ??= getOrivon().fs.mkdir(TMPDIR_CONFINED, { recursive: true }).catch(() => { tmpdirReady = undefined })
    await tmpdirReady
  }
  return confined
}
