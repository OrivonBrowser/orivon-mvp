// fs.constants -- the POSIX access-mode flags a ported dependency reads as
// DATA (`fs.constants.F_OK`), never calls -- so this is a plain object, never
// routed through refusingProxy/otherFsMember the way an unbuilt function-shaped
// member is (README.md's A169 design note already names `constants` as one of
// the two members that can never honestly be a throwing function). Values
// match Node's own (lib/internal/fs/utils.js), not invented here.
//
// The four access() modes, and the O_* open flags a dependency passes to
// `fs.open` as a number (flags.ts maps them onto the string flags orivon.fs
// takes). Real Node's fs.constants also carries S_I* stat-mode bits and the
// rest of the O_* set -- orivon.fs has no POSIX mode concept for them
// (fs/unsupported.ts's chmod/chown reasoning), so those would be numbers with
// nothing real behind them. Add a member here only when a caller reads it and
// the value would mean something on this fs. Values are Linux's, which is what
// Node reports on the platform the broker runs on.

export const FS_CONSTANTS = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  O_NONBLOCK: 2048,
  O_NOFOLLOW: 131072
} as const
