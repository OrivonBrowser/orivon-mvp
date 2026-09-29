// WASI preview1's errno numbering, which is not Linux's: the guest reads
// these values, never a host errno. `errnoFor` turns whatever an orivon.fs
// call threw into one of them.

import type { OrivonErrorCode } from '../../contracts/errors.js'

/**
 * wasi_snapshot_preview1.witx's `errno` enum in declaration order, so a
 * name's index IS its value. The order is the ABI: never sort or insert.
 */
const ERRNO_NAMES = [
  'SUCCESS', '2BIG', 'ACCES', 'ADDRINUSE', 'ADDRNOTAVAIL', 'AFNOSUPPORT', 'AGAIN', 'ALREADY', 'BADF',
  'BADMSG', 'BUSY', 'CANCELED', 'CHILD', 'CONNABORTED', 'CONNREFUSED', 'CONNRESET', 'DEADLK',
  'DESTADDRREQ', 'DOM', 'DQUOT', 'EXIST', 'FAULT', 'FBIG', 'HOSTUNREACH', 'IDRM', 'ILSEQ', 'INPROGRESS',
  'INTR', 'INVAL', 'IO', 'ISCONN', 'ISDIR', 'LOOP', 'MFILE', 'MLINK', 'MSGSIZE', 'MULTIHOP',
  'NAMETOOLONG', 'NETDOWN', 'NETRESET', 'NETUNREACH', 'NFILE', 'NOBUFS', 'NODEV', 'NOENT', 'NOEXEC',
  'NOLCK', 'NOLINK', 'NOMEM', 'NOMSG', 'NOPROTOOPT', 'NOSPC', 'NOSYS', 'NOTCONN', 'NOTDIR', 'NOTEMPTY',
  'NOTRECOVERABLE', 'NOTSOCK', 'NOTSUP', 'NOTTY', 'NXIO', 'OVERFLOW', 'OWNERDEAD', 'PERM', 'PIPE',
  'PROTO', 'PROTONOSUPPORT', 'PROTOTYPE', 'RANGE', 'ROFS', 'SPIPE', 'SRCH', 'STALE', 'TIMEDOUT',
  'TXTBSY', 'XDEV', 'NOTCAPABLE'
] as const

type ErrnoName = typeof ERRNO_NAMES[number]

const ERRNO_BY_NAME: ReadonlyMap<string, number> = new Map(ERRNO_NAMES.map((name, value) => [name, value]))

function errno (name: ErrnoName): number {
  return ERRNO_BY_NAME.get(name) as number
}

export const Errno = {
  SUCCESS: errno('SUCCESS'),
  ACCES: errno('ACCES'),
  BADF: errno('BADF'),
  BUSY: errno('BUSY'),
  EXIST: errno('EXIST'),
  FAULT: errno('FAULT'),
  FBIG: errno('FBIG'),
  ILSEQ: errno('ILSEQ'),
  INVAL: errno('INVAL'),
  IO: errno('IO'),
  ISDIR: errno('ISDIR'),
  NAMETOOLONG: errno('NAMETOOLONG'),
  NOENT: errno('NOENT'),
  NOSPC: errno('NOSPC'),
  NOSYS: errno('NOSYS'),
  NOTDIR: errno('NOTDIR'),
  NOTEMPTY: errno('NOTEMPTY'),
  NOTSOCK: errno('NOTSOCK'),
  NOTSUP: errno('NOTSUP'),
  PERM: errno('PERM'),
  SPIPE: errno('SPIPE'),
  NOTCAPABLE: errno('NOTCAPABLE')
} as const

/**
 * Used only when an error carries no errno name of its own. `denied` is
 * ACCES for every reason a denial has, as the broker keeps it uniform.
 */
const BY_ORIVON_CODE: Readonly<Record<OrivonErrorCode, ErrnoName>> = {
  denied: 'ACCES',
  revoked: 'IO',
  unreachable: 'HOSTUNREACH',
  timeout: 'TIMEDOUT',
  reset: 'CONNRESET',
  closed: 'BADF',
  limit: 'NOSPC',
  invalid: 'INVAL',
  notFound: 'NOENT',
  exists: 'EXIST',
  internal: 'IO',
  unavailable: 'IO'
}

/** 55 -> `NOTEMPTY`: the name WASI 0.2's error codes are mapped from. */
export function errnoName (value: number): string | undefined {
  return ERRNO_NAMES[value]
}

/** `ENOTEMPTY` -> 55. Undefined for a name WASI does not have. */
function fromPosixName (name: unknown): number | undefined {
  if (typeof name !== 'string' || !name.startsWith('E')) return undefined
  return ERRNO_BY_NAME.get(name.slice(1))
}

/**
 * An orivon.fs rejection, or a Node-shaped error from fs/root.ts, as a WASI
 * errno. The broker's `platformCode` wins when present: it is the one place
 * ENOTEMPTY, EISDIR and ENOTDIR survive the trip, and the contract keeps it
 * for exactly this reconstruction.
 */
export function errnoFor (error: unknown): number {
  if (typeof error !== 'object' || error === null) return Errno.IO
  const { platformCode, code } = error as { platformCode?: unknown, code?: unknown }
  const named = fromPosixName(platformCode) ?? fromPosixName(code)
  if (named !== undefined) return named
  if (typeof code !== 'string' || !Object.hasOwn(BY_ORIVON_CODE, code)) return Errno.IO
  return errno(BY_ORIVON_CODE[code as OrivonErrorCode])
}
