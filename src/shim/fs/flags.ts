// `fs.open` flags: Node takes a string ('r', 'wx', ...) or a number built from
// fs.constants.O_*; orivon.fs takes the strings only. This maps a number onto
// the string that opens the file the same way, opens O_CREAT without
// O_TRUNC in two steps (CREATE_IN_PLACE), and refuses (EINVAL) any other
// combination no string flag expresses rather than opening it differently.
//
// O_NOFOLLOW and O_NONBLOCK are accepted and dropped: orivon.fs resolves a
// symlink that stays inside the root transparently and denies one that would
// leave it, and a file open never blocks.

import { FS_CONSTANTS as C } from './constants.js'
import { fsError } from './paths.js'

const KNOWN_BITS = C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_TRUNC | C.O_APPEND | C.O_NONBLOCK | C.O_NOFOLLOW

function refuse (why: string): never {
  throw fsError('EINVAL', `invalid argument (${why})`, 'open')
}

export function normalizeOpenFlags (flags: string | number | null | undefined): string {
  if (flags === null || flags === undefined) return 'r'
  if (typeof flags === 'string') return flags
  if (!Number.isInteger(flags) || flags < 0) refuse('flags must be a non-negative integer')
  if ((flags & ~KNOWN_BITS) !== 0) refuse(`flag bits ${flags & ~KNOWN_BITS} are not supported`)
  const access = flags & 3
  if (access === 3) refuse('O_WRONLY | O_RDWR')
  const create = (flags & C.O_CREAT) !== 0
  const exclusive = (flags & C.O_EXCL) !== 0
  const truncate = (flags & C.O_TRUNC) !== 0
  const append = (flags & C.O_APPEND) !== 0
  const plus = access === C.O_RDWR ? '+' : ''
  if (access === C.O_RDONLY) {
    if (create || exclusive || truncate || append) refuse('O_CREAT, O_EXCL, O_TRUNC and O_APPEND need a writable open')
    return 'r'
  }
  if (exclusive && !create) refuse('O_EXCL without O_CREAT')
  if (append) {
    if (!create) refuse('O_APPEND without O_CREAT')
    if (truncate) refuse('O_APPEND with O_TRUNC')
    return `${exclusive ? 'ax' : 'a'}${plus}`
  }
  if (truncate) {
    if (!create) refuse('O_TRUNC without O_CREAT')
    return `${exclusive ? 'wx' : 'w'}${plus}`
  }
  if (create) return exclusive ? `wx${plus}` : CREATE_IN_PLACE
  return 'r+'
}

/**
 * What O_CREAT asks for without O_TRUNC, O_APPEND or O_EXCL: create the file
 * if it is missing and keep what is there (random-access-file, webtorrent's
 * disk store, opens every file this way). No string flag says that, so
 * openFlagged opens it in two steps, and orivon.fs never sees this value. A
 * write-only request opens read-write, as O_WRONLY alone already does.
 */
export const CREATE_IN_PLACE = 'r+ (create)'

/** A second opener can create the file between the two steps; after this many rounds the last error stands. */
const CREATE_ATTEMPTS = 3

function codeIs (error: unknown, ...codes: readonly string[]): boolean {
  return typeof error === 'object' && error !== null && codes.includes(String((error as { code?: unknown }).code))
}

/** `open(path, flags)` for any flag normalizeOpenFlags returns: CREATE_IN_PLACE is 'r+', then 'wx+' when the file is missing, then 'r+' again if it appeared meanwhile. */
export async function openFlagged<H> (open: (path: string, flags: string) => Promise<H>, path: string, flags: string): Promise<H> {
  if (flags !== CREATE_IN_PLACE) return await open(path, flags)
  for (let attempt = 1; ; attempt++) {
    try {
      return await open(path, 'r+')
    } catch (error) {
      if (!codeIs(error, 'notFound', 'ENOENT')) throw error
    }
    try {
      return await open(path, 'wx+')
    } catch (error) {
      if (!codeIs(error, 'exists', 'EEXIST') || attempt === CREATE_ATTEMPTS) throw error
    }
  }
}

/** openFlagged's synchronous twin, for the *Sync family. */
export function openFlaggedSync<H> (open: (path: string, flags: string) => H, path: string, flags: string): H {
  if (flags !== CREATE_IN_PLACE) return open(path, flags)
  for (let attempt = 1; ; attempt++) {
    try {
      return open(path, 'r+')
    } catch (error) {
      if (!codeIs(error, 'notFound', 'ENOENT')) throw error
    }
    try {
      return open(path, 'wx+')
    } catch (error) {
      if (!codeIs(error, 'exists', 'EEXIST') || attempt === CREATE_ATTEMPTS) throw error
    }
  }
}
