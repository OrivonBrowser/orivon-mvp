// Maps a thrown value to the failure branch of a ResponseEnvelope. Shared by
// ./ipc.ts (the async CONTROL_CHANNEL path) and ./sync-fs.ts (the
// synchronous one, ADR-0016) -- its own file rather than one importing it
// from the other, so neither transport module depends on the other's load
// order.
//
// DoD rule 4: a 'denied' crosses with no `platformCode`, whatever threw it.
// `../errors.ts`'s `fail()` already enforces that at construction, but this
// is the boundary the app actually crosses, so it is re-checked here rather
// than trusted from upstream -- the same defence-in-depth reasoning as
// ./ipc.ts's own payload validation.
//
// Anything that is not a recognised OrivonError is a BUG, not a capability
// decision, and its message is never forwarded: it may name a file path, a
// stack frame, or another internal detail an app has no business seeing.
//
// An 'internal' failure -- such a value, or an OrivonError coded 'internal' --
// is also written to the console once as it crosses, with the error itself so
// its stack reaches the diagnostics log: errors.ts's 'internal' contract is
// "always logged". Every other code is an answer the app asked for (a missing
// file is routine) and is not logged here.

import { isOrivonErrorLike } from '../errors.js'
import type { ResponseEnvelope } from '../../contracts/ipc.js'

const BROKER_FAULT = '[broker] an internal error crossed to an app:'

export function toFailureResponse (id: string, error: unknown): ResponseEnvelope<never> {
  if (isOrivonErrorLike(error)) {
    if (error.code === 'internal') console.error(BROKER_FAULT, error)
    const base = { id, ok: false as const, code: error.code, message: error.message }
    if (error.code !== 'denied' && error.platformCode !== undefined) {
      return { ...base, platformCode: error.platformCode }
    }
    return base
  }
  console.error(BROKER_FAULT, error)
  return { id, ok: false, code: 'internal', message: 'an internal error occurred' }
}
