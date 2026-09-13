// Shared by ./update-outcomes.ts and ./install-consent.ts (A156, docs/
// open-questions.md): the one place that turns "capabilities the person has
// now agreed to hold" into actual broker.grant() calls. broker.grant()
// (src/broker/index.ts) always mints a fresh GrantId and tears down every
// live handle under the grant it replaces -- correct for a REAL authority
// change, wrong for a capability whose declared patterns did not change at
// all. Extracted once both call sites needed the exact same "skip if
// unchanged" idea (code-guidelines.md Rule 3), rather than each re-deciding
// what "unchanged" means.

import { decideGrantRequest } from '../broker/policy/request-grant.js'
import { patternSetFromGrants } from '../broker/policy/update.js'
import type { Broker } from '../broker/broker-contracts.js'
import type { CapabilityKind, Manifest, Pattern } from '../contracts/index.js'

/** Order-independent set equality -- two patterns are the same authority
 * however a manifest happens to list them, so re-declaring them in a
 * different order is never mistaken for a change. */
function sameOwnPatterns (a: readonly Pattern[], b: readonly Pattern[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((pattern, index) => pattern === right[index])
}

/**
 * Grants exactly `capabilities`, each bounded to the manifest's own declared
 * patterns (`decideGrantRequest`, never a raw pass-through -- capability-
 * api.md design rule 4) -- EXCEPT one already held with the exact same
 * pattern set, which is skipped: calling `broker.grant()` again for
 * unchanged authority would still trigger its revoke-the-superseded-grant
 * cascade and tear down a live, unrelated handle for no authority change at
 * all. A capability that is new, narrowed or widened is still granted.
 *
 * Errors are logged and swallowed per capability: the caller's own bundle
 * or install has already succeeded by the time this runs, and one
 * capability failing to grant must not be read as that having failed.
 */
export async function grantChangedCapabilities (
  broker: Broker,
  origin: string,
  manifest: Manifest,
  capabilities: readonly CapabilityKind[]
): Promise<void> {
  const held = patternSetFromGrants(await broker.app.grants(origin))
  for (const capability of capabilities) {
    const decision = decideGrantRequest(manifest, capability, undefined)
    if (!decision.allowed) continue

    const heldPatterns = held[capability]
    if (heldPatterns !== undefined && sameOwnPatterns(heldPatterns, decision.patterns)) continue

    try {
      await broker.grant(origin, capability, decision.patterns)
    } catch (error) {
      console.error('[app-install] a capability could not be granted after the person accepted', origin, capability, error)
    }
  }
}
