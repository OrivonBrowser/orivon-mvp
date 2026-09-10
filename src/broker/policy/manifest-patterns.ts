// Manifest.capabilities -> update.ts's PatternSet -- the declared-authority
// half of the conversion patternSetFromGrants (./update.ts) already performs
// for the GRANTED half. Moved here from src/loader/update-patterns.ts
// (2026-09-10, P4-1): ./request-grant.ts's subset check needs the exact same
// conversion decideUpdate() does, and src/broker/ may never import
// src/loader/ (../README.md) -- only the reverse. src/loader/update-patterns.ts
// now re-exports this so its existing import path needs no change.

import type { Capabilities, CapabilityKind, Pattern } from '../../contracts/index.js'
import type { PatternSet } from './update.js'

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
  // ADR-0017's TLS-terminated capability -- a SEPARATE grant from
  // tcp.connect (manifest.ts's own HttpsCapability doc), and until this fix
  // (2026-09-10, P4-1) it had no mapping here at all: a manifest update that
  // ADDED https.connect went undetected by decideUpdate()'s subset check
  // and installed silently, and request-grant.ts's "or not declared" check
  // would have refused every https.connect request as undeclared even when
  // the manifest named one. Found while wiring app.requestGrant, which is
  // the first caller that actually exercises this capability through this
  // function.
  const secureConnect = capabilities.net?.https?.connect
  if (secureConnect !== undefined) set['https.connect'] = secureConnect

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
