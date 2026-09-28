// The one directory every Node-shaped path in an app tab agrees on:
// process.cwd(), os.homedir(), $HOME/$APPDATA/$USERPROFILE and electron's
// app.getPath('userData') all name it, and the fs shim maps it onto the app's
// confined orivon.fs root (fs/root.ts). No imports, on purpose: the
// preload reaches this through globals.ts and must not pull in a polyfill.
// src/shim-electron/app.ts keeps its own copy of VIRTUAL_ROOT, since it may
// not import this package; tests/virtual-root.test.ts holds the two equal.

export const VIRTUAL_ROOT = '/orivon/app'

/** os.tmpdir() and $TMPDIR. A folder inside the root, created on first use. */
export const VIRTUAL_TMPDIR = `${VIRTUAL_ROOT}/tmp`
