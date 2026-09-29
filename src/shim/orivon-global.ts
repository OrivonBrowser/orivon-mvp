// Reads the real `orivon` capability surface off the global object, the same
// pattern src/shim-electron/index.ts already uses (that file is a sibling
// stream's, not importable from here -- see README.md's import boundary --
// so this is a second, small copy rather than a shared one).
//
// Read once per caller, never cached at module-load time: http/http.ts and
// http/https.ts each call this inside their own factory setup, not at their
// own top level, so a test can stub `globalThis.orivon` per-case without
// import-order games.

import type { Orivon } from '../contracts/capability-api.js'

/**
 * The child host's own override (`worker/host.ts`'s `createChildHost`, alongside its sibling
 * `child-process/host-client.ts`'s `preferLocalWorkers`): the host's own `orivon` is kept off
 * `globalThis` on purpose (`preload/child-host.ts`'s own header -- the host runs no page code, so
 * there is nothing to expose it to), but `child-process/spawn.ts`'s `launchChild` still calls
 * `getOrivon()` to serve a local child's own Worker, whichever scope it runs in. Without this, a
 * spawnSync served on the host (a WASI program's own nested spawn, say) fails every time with
 * "window.orivon is not present": the grandchild's own Worker never starts, and spawnSync's own
 * caller sees a spawn failure with no orivon anywhere to blame it on. A page never calls this, so
 * `getOrivon()` there is unchanged: `globalThis.orivon`, as installed.
 */
let override: Orivon | undefined

/** Only the child host calls this, once, at its own construction (`worker/host.ts`). */
export function setOrivon (orivon: Orivon): void {
  override = orivon
}

export function getOrivon (): Orivon {
  const found = override ?? (globalThis as { orivon?: Orivon }).orivon
  if (found === undefined) {
    throw new Error(
      'orivon-node-shim: window.orivon is not present -- this module only works inside an ' +
      'Orivon app tab, after the preload has run.'
    )
  }
  return found
}
