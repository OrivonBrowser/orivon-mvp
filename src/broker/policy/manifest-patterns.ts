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

  // Presence alone is the signal for fs/id/secrets -- none carries a pattern
  // of its own (manifest.ts's FsCapability/IdCapability/SecretsCapability),
  // so an empty array is the correct "requested" value, not a placeholder
  // for a missing field. `secrets` (ADR-0031) follows `id`'s own precedent:
  // requireGrantedCurve (../id-capability.js) re-checks the live manifest
  // for what an empty-patterns `id` grant actually authorises, and
  // secrets-capability.ts needs nothing narrower than presence either.
  if (capabilities.fs !== undefined) set.fs = []
  if (capabilities.id !== undefined) set.id = []
  if (capabilities.secrets !== undefined) set.secrets = []

  // ADR-0019: web.contexts IS the pattern list for 'web.context' -- each
  // declared origin is compared exactly against a grant's own patterns
  // (manifest.ts's WebCapability.contexts doc), the same "presence carries
  // the patterns" shape tcp.connect/https.connect already have, unlike
  // fs/id's presence-only rows above.
  const contexts = capabilities.web?.contexts
  if (contexts !== undefined) set['web.context'] = contexts

  // capabilities.protocols is deliberately not mapped: it is not a
  // CapabilityKind (contracts/manifest.ts's Capabilities.protocols is
  // routing, not a grant) and update.ts's PatternSet has no slot for it.

  return set
}

/**
 * The site-info popover's "off" switch (../../main/permissions/site-
 * switches.js) must stick across the origin's next visit: `decideUpdate`'s
 * widening check (./update.ts) sees only what a manifest DECLARES, with no
 * notion of a capability the person has since turned back off, so a
 * still-declared kind reads as newly requested again on every load. Called
 * from loader/index.ts's decideAndRoute BEFORE decideUpdate, this drops
 * exactly the kinds that are both declined and not currently held from the
 * set decideUpdate compares against.
 *
 * NOT currently held is the load-bearing condition: a kind the origin
 * already holds a grant for is real authority already in force, and
 * dropping it here would make decideUpdate blind to that grant being
 * silently widened or narrowed by a manifest change it should still catch.
 * Declining once must suppress a re-ASK, never suppress the check on
 * authority already granted.
 */
export function withoutSwitchedOffCapabilities (declared: PatternSet, granted: PatternSet, declined: readonly CapabilityKind[] | undefined): PatternSet {
  if (declined === undefined || declined.length === 0) return declared
  const result: Partial<Record<CapabilityKind, readonly Pattern[]>> = { ...declared }
  for (const capability of declined) {
    if (!Object.hasOwn(granted, capability)) delete result[capability]
  }
  return result
}
