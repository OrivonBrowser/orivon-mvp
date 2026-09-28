// Bit and enum values from wasi_snapshot_preview1.witx that more than one
// function family reads.

/** A right is bit `n` of preview1's `rights` flags; the argument is its bit number. */
function rights (...bits: number[]): bigint {
  return bits.reduce((set, bit) => set | (1n << BigInt(bit)), 0n)
}

export const Rights = {
  FD_READ: rights(1),
  FD_WRITE: rights(6)
} as const

// What each kind of descriptor reports it can do: the sets the standard
// runtimes report, links and file times included, since a right says which
// calls apply to a descriptor, not that each will succeed. Reported, never
// enforced: the broker is the boundary, so fd_fdstat_set_rights answers
// NOTSUP, as current runtimes do.
const FILE_COMMON = rights(0, 2, 3, 4, 5, 7, 21, 23, 27)
const FILE_READ = rights(1)
const FILE_WRITE = rights(6, 8, 22)
export const DIRECTORY_RIGHTS = rights(9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 23, 24, 25, 26)
export const DIRECTORY_INHERITING = DIRECTORY_RIGHTS | FILE_COMMON | FILE_READ | FILE_WRITE
/** No seek or tell, which is how wasi-libc's isatty() recognises a character device. */
export const STDIO_RIGHTS = rights(0, 1, 3, 4, 6, 21, 27)

export function fileRights (readable: boolean, writable: boolean): bigint {
  return FILE_COMMON | (readable ? FILE_READ : 0n) | (writable ? FILE_WRITE : 0n)
}

export const Oflags = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const

export const Fdflags = { APPEND: 1, DSYNC: 2, NONBLOCK: 4, RSYNC: 8, SYNC: 16 } as const

/** Synchronous-write modes: refused, since orivon.fs offers no per-write durability to honour them with. */
export const SYNC_FDFLAGS = Fdflags.DSYNC | Fdflags.RSYNC | Fdflags.SYNC

export const Fstflags = { ATIM: 1, ATIM_NOW: 2, MTIM: 4, MTIM_NOW: 8 } as const

export const Whence = { SET: 0, CUR: 1, END: 2 } as const

export const Clock = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME: 2, THREAD_CPUTIME: 3 } as const

export const EventType = { CLOCK: 0, FD_READ: 1, FD_WRITE: 2 } as const

export const SUBSCRIPTION_CLOCK_ABSTIME = 1
