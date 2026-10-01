// `fs.open` flags: Node takes a string ('r', 'wx', ...) or a number built from
// fs.constants.O_*; orivon.fs takes the strings only. This maps a number onto
// the string that opens the file the same way, and refuses (EINVAL) a
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
  if (create) {
    if (exclusive) return `wx${plus}`
    refuse('O_CREAT without O_TRUNC, O_APPEND or O_EXCL')
  }
  return 'r+'
}
