// Electron's `app` is synchronous everywhere (`getVersion()`, `getPath()`
// read package.json at process start); ours sits on top of an async
// `orivon.app.manifest()` broker round-trip. `whenReady()` is the mechanism
// that makes that honest -- real Electron code already gates its own startup
// on it, so requiring it here asks nothing new of a ported app.
//
// handle-contracts.md's binding requirement 5: a synchronous accessor is
// served from a value captured at acquisition, never a cache an event fills
// in later. Acquisition here is `whenReady()`'s own manifest fetch -- once it
// resolves, `manifest` is a plain captured value, never re-read from a
// pending promise.

import { refuse } from './errors.js'
import type { Manifest } from '../contracts/manifest.js'
import type { Orivon } from '../contracts/capability-api.js'

export interface ElectronApp {
  whenReady(): Promise<void>
  isReady(): boolean
  getVersion(): string
  /**
   * Only `'userData'` has an Orivon equivalent -- the app's own confined `fs`
   * root. Every other Electron path name (`'home'`, `'exe'`, `'temp'`, ...)
   * names a real host directory, which is the ambient-filesystem row Table 3
   * excludes by design, so it throws rather than fabricating a path nothing
   * backs.
   */
  getPath(name: string): string
}

/**
 * The value `getPath('userData')` returns. Deliberately NOT an absolute
 * path: `orivon.fs.readFile`/`writeFile` reject an absolute path outright
 * (src/broker/policy/paths.ts, 'absolute'), so a value a porting app's own
 * `path.join(app.getPath('userData'), 'x')` could turn into a rejected
 * request would be a trap, not a convenience. `'.'` joins to a plain relative
 * path under every `path.join` implementation, including a future Node `path`
 * shim (Table 2's other adapter family, not this one).
 */
const USER_DATA_PATH = '.'

export function createApp (orivon: Pick<Orivon, 'app'>): ElectronApp {
  let manifest: Manifest | undefined
  let pending: Promise<void> | undefined

  function whenReady (): Promise<void> {
    if (pending === undefined) {
      pending = orivon.app.manifest().then((result) => { manifest = result })
    }
    return pending
  }

  function acquired (api: string): Manifest {
    if (manifest === undefined) {
      throw refuse(api, 'not-ready',
        `${api} was called before app.whenReady() resolved. Orivon fetches app metadata over ` +
        'the broker asynchronously, unlike real Electron\'s synchronous package.json read -- ' +
        'await app.whenReady() first.')
    }
    return manifest
  }

  return {
    whenReady,
    isReady: () => manifest !== undefined,
    getVersion: () => acquired('app.getVersion').version,
    getPath: (name) => {
      acquired('app.getPath')
      if (name === 'userData') return USER_DATA_PATH
      throw refuse('app.getPath', 'ambient-fs',
        `app.getPath('${name}') has no Orivon equivalent -- only 'userData' does (the app's own ` +
        'confined fs root). Every other name points at a real host directory, which is the ' +
        'ambient-filesystem row compatibility-matrix.md Table 3 excludes by design.')
    }
  }
}
