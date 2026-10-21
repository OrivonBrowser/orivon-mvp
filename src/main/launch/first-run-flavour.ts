// Where an `orivon:` link's `flavour=` id leaves the link layer. Nothing acts on it yet.
import { FLAVOUR_ID, openableOrivonLink } from './orivon-link.js'
import { operandsOf } from './launch-request.js'

/**
 * The one place first-run presets will hook in. It is handed an id of the shape `FLAVOUR_ID` and nothing else, only on
 * the start of a browser that a link started; whether the profile is new, and whether the id names an entry of any list,
 * are for the code behind it to decide. Does nothing yet.
 */
export function firstRunFlavourHint (_id: string): void {}

/** The flavour of the first `orivon:` link on a command line that carries one. */
export function flavourOfCommandLine (argv: readonly string[], packaged: boolean): string | undefined {
  for (const operand of operandsOf(argv, packaged)) {
    const flavour = openableOrivonLink(operand)?.flavour
    if (flavour !== undefined) return flavour
  }
  return undefined
}

/** Passes `id` to `hint` when it has the shape of an id; any other value goes nowhere. `hint` is replaceable for a test. */
export function offerFirstRunFlavour (id: string | undefined, hint: (id: string) => void = firstRunFlavourHint): void {
  if (typeof id === 'string' && FLAVOUR_ID.test(id)) hint(id)
}
