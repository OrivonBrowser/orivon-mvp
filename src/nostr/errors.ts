// A local copy of src/broker/policy/errors.ts's fail() helper, not a shared
// import: src/nostr/ must never import src/broker/ internals (README.md,
// "What it must never import"), so a pure three-line constructor for the same
// OrivonError shape has nowhere legal to live except here too. This is the
// same case docs/development/code-guidelines.md Rule 3 already names as the
// reason src/shared/ exists -- two callers on opposite sides of a trust
// boundary -- but moving it there is a separate, change-controlled PR outside
// this lane's owned paths.

import type { OrivonError, OrivonErrorCode } from '../contracts/index.js'

/**
 * OrivonError is an interface, not a class -- src/contracts/ emits no
 * runtime code. Something has to construct the concrete object; every
 * consumer only switches on `code`.
 *
 * No `platformCode`: this module never talks to a real engine. Every error it
 * raises is either a caller mistake (bad event shape) or a broker/test-double
 * decision (declined connect prompt, malformed signed event) -- inventing a
 * platform errno for either would make an app's retry logic branch on
 * fiction, exactly as src/contracts/errors.ts's own doc comment warns against.
 */
export function fail (code: OrivonErrorCode, message: string): OrivonError {
  return Object.assign(new Error(message), { code })
}
