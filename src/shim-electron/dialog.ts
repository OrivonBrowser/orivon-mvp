// dialog.showOpenDialog is the one Table 2 API this package cannot back yet.
// It maps to orivon.fs.userSelected, spec'd in capability-api.ts but not
// implemented by the broker (compatibility-matrix.md Table 1: Broker [ ]) and
// not exposed on window.orivon by the preload either. The signature below is
// the real Electron shape, so a ported app's call site type-checks and fails
// at the one line that actually needs the broker, rather than failing to
// import at all.

import { refuse } from './errors.js'
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
 */
export function createDialog (orivon: Pick<Orivon, 'fs'>): ElectronDialog {
  void orivon
  return {
    async showOpenDialog () {
      throw refuse('dialog.showOpenDialog', 'not-built',
        "dialog.showOpenDialog is backed by orivon.fs.userSelected, which the broker does not " +
        'implement yet (compatibility-matrix.md Table 1). Even once it does, userSelected ' +
        "resolves to a FileHandle, not a host OS path, so this method's return shape needs " +
        'revisiting rather than simply wiring the call through.')
    }
  }
}
