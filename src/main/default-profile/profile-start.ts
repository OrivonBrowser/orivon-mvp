// Whether this start begins from the default profile. Decided once, before any store or subsystem opens a file of the
// profile, because from then on every start would see files its own predecessor wrote.
import { defaultProfileOn, isNewProfile } from './default-profile.js'

let fromDefaultProfile = false

export function decideDefaultProfile (dir: string, env: NodeJS.ProcessEnv): void {
  fromDefaultProfile = defaultProfileOn(env) && isNewProfile(dir)
}

/** False until `decideDefaultProfile` has run. */
export function startsFromDefaultProfile (): boolean {
  return fromDefaultProfile
}
