// The one id the opt-in usage report may carry about how the profile was started: the app a tagged installer opened on its first
// run. It is read from the profile's `flavour.json` and kept only if it is an entry of the shipped list, so an edited or damaged
// file, free text, or an id the browser does not ship all read as "none". The installer's file name never reaches the report.
import { storedFlavour } from './first-run-flavour.js'
import { findFlavour, type Flavour } from './flavours.js'

export function reportedFlavour (dir: string, flavours: readonly Flavour[]): string | null {
  const id = storedFlavour(dir)
  return id !== null && findFlavour(flavours, id) !== undefined ? id : null
}
