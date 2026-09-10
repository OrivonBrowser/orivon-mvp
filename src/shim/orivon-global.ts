// Reads the real `orivon` capability surface off the global object, the same
// pattern src/shim-electron/index.ts already uses (that file is a sibling
// stream's, not importable from here -- see README.md's import boundary --
// so this is a second, small copy rather than a shared one).
//
// Read once per caller, never cached at module-load time: node-http.ts and
// node-https.ts each call this inside their own factory setup, not at their
// own top level, so a test can stub `globalThis.orivon` per-case without
// import-order games.

import type { Orivon } from '../contracts/capability-api.js'

export function getOrivon (): Orivon {
  const found = (globalThis as { orivon?: Orivon }).orivon
  if (found === undefined) {
    throw new Error(
      'orivon-node-shim: window.orivon is not present -- this module only works inside an ' +
      'Orivon app tab, after the preload has run.'
    )
  }
  return found
}
