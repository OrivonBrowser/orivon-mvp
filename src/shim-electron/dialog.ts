// dialog.showOpenDialog is the one Table 2 API this package cannot back yet.
// It maps to orivon.fs.userSelected, which the broker NOW implements
// (L5-userselected, A187) -- the remaining gap is a genuine shape mismatch,
// not a missing broker method: Electron's real showOpenDialog returns raw
// host OS paths (`filePaths: string[]`), while `orivon.fs.userSelected`
// resolves opaque `FileHandle`/`DirectoryHandle` objects with NO raw path an
// app can read (handle-contracts.md's own confinement design -- an app never
// sees where on the host disk its pick actually lives). Presenting Node's
// path-string idiom over that opaque handle is a real shim-layer design
// question -- how a ported app's later `fs.readFile(theReturnedPath)` call
// would even address the same file through OrivonFs's own confined,
// relative-path model -- filed as A187 rather than guessed at here, and out
// of L5's own owned paths (src/broker/) regardless. The signature below is
// still the real Electron shape, so a ported app's call site type-checks and
// fails at the one line that actually needs this resolved, rather than
// failing to import at all.

import { refuse } from './errors.js'
import { notConsidered, refusingProxy } from './unimplemented.js'
import type { Orivon } from '../contracts/capability-api.js'

export interface OpenDialogOptions {
  readonly properties?: readonly string[]
  readonly filters?: ReadonlyArray<{ readonly name: string, readonly extensions: readonly string[] }>
}

export interface OpenDialogReturnValue {
  readonly canceled: boolean
  readonly filePaths: readonly string[]
}

export interface ElectronDialog {
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
}

/**
 * `orivon` is accepted, not read, until the broker implements
 * `fs.userSelected` -- taking it now keeps this factory's signature stable
 * across that future change rather than adding a parameter later.
 *
 * `showOpenDialog` is the only real Electron dialog method under
 * consideration at all -- it refuses with its own specific, decided reason
 * (`'not-built'`, below). Every other real Electron dialog method
 * (`showMessageBox`, `showSaveDialog`, `showErrorBox`, ...) has never been
 * considered here one way or the other, so it gets the generic
 * `'unimplemented'` refusal via the same Proxy this package uses for a
 * whole missing module -- keeping `dialog` a single mechanism rather than
 * growing a second, dialog-specific one.
 */
export function createDialog (orivon: Pick<Orivon, 'fs'>): ElectronDialog {
  void orivon
  const known: ElectronDialog = {
    async showOpenDialog () {
      throw refuse('dialog.showOpenDialog', 'not-built',
        'dialog.showOpenDialog is backed by orivon.fs.userSelected, which the broker now ' +
        'implements (L5-userselected) -- but userSelected resolves an opaque FileHandle/' +
        'DirectoryHandle, never a host OS path, so this method still cannot return the real ' +
        "Electron shape (filePaths: string[]) without a shim-layer design this package's own " +
        'lane has not built (filed as A187, docs/open-questions.md).')
    }
  }
  return refusingProxy(known, (prop) => notConsidered(`dialog.${prop}`))
}
