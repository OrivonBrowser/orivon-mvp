// fs.constants -- the POSIX access-mode flags a ported dependency reads as
// DATA (`fs.constants.F_OK`), never calls -- so this is a plain object, never
// routed through refusingProxy/otherFsMember the way an unbuilt function-shaped
// member is (README.md's A169 design note already names `constants` as one of
// the two members that can never honestly be a throwing function). Values
// match Node's own (lib/internal/fs/utils.js), not invented here.
//
// ONLY THE FOUR access() MODES. Real Node's fs.constants also carries O_*
// open flags and S_I* stat-mode bits -- orivon.fs has no POSIX mode concept
// for either (fs/unsupported.ts's chmod/chown reasoning), so those would
// be numbers with nothing real behind them. Add a member here only when a
// caller reads it and the value would mean something on this fs.

export const FS_CONSTANTS = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1
} as const
