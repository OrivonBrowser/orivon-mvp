// Manifest.capabilities -> update.ts's PatternSet, the shape decideUpdate()
// needs for its `newPatterns` argument. Small enough to earn its own file
// rather than crowd index.ts (docs/development/code-guidelines.md Rule 2),
// and it is the one place this lane translates the manifest's DECLARED
// authority into the same shape the GRANTED pattern set already has --
// worth keeping separate from where decideUpdate is actually called, so the
// two are never accidentally swapped at the call site (A18/A27's failure
// class: this file produces `newPatterns`, never `grantedPatterns`).

import type { Capabilities, CapabilityKind, Pattern } from '../contracts/index.js'
import type { PatternSet } from '../broker/policy/update.js'

/**
 * update.ts's own convention (its PatternSet doc comment): a capability KIND
 * present in the result, with an EMPTY array, means "requested, and this
 * capability carries no patterns of its own" -- `fs` and `id` are declared
 * that way. A kind ABSENT means "not requested at all". Getting the two
 * confused is exactly what would make `widensAuthority` (update.ts) treat a
 * brand-new `fs` request as nothing new.
 */
export function patternSetFromCapabilities (capabilities: Capabilities): PatternSet {
  const set: Partial<Record<CapabilityKind, readonly Pattern[]>> = {}

  const connect = capabilities.net?.tcp?.connect
  if (connect !== undefined) set['tcp.connect'] = connect
  const listen = capabilities.net?.tcp?.listen
  if (listen !== undefined) set['tcp.listen'] = listen
  const bind = capabilities.net?.udp?.bind
  if (bind !== undefined) set['udp.bind'] = bind
  const send = capabilities.net?.udp?.send
  if (send !== undefined) set['udp.send'] = send

  // Presence alone is the signal for fs/id -- neither carries a pattern of
  // its own (manifest.ts's FsCapability/IdCapability), so an empty array is
  // the correct "requested" value, not a placeholder for a missing field.
  if (capabilities.fs !== undefined) set.fs = []
  if (capabilities.id !== undefined) set.id = []

  // capabilities.protocols is deliberately not mapped: it is not a
  // CapabilityKind (contracts/manifest.ts's Capabilities.protocols is
  // routing, not a grant) and update.ts's PatternSet has no slot for it.

  return set
}
