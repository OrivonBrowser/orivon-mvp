// What one declared capability reads as when it is offered for the person to switch on: the words and the patterns they
// were rendered from. The key popup's off rows (../permissions/site-info.ts) and the first-visit panel
// (./install-consent-panel.ts) both come through here, so the two surfaces never word a capability differently.
import type { CapabilityKind, Manifest, Pattern } from '../../contracts/index.js'
import { decideGrantRequest } from '../../broker/policy/request-grant.js'
import { summaryAtLevel } from './grant-level.js'
import { describeCapabilityGrant } from './grant-prompt-render.js'
import type { ScoreLevel } from '../../trust/website-level.js'

export interface OfferedCapability {
  readonly warning: boolean
  readonly message: string
  /** The sentence that says what the grant reaches beyond the headline, when there is one. */
  readonly explanation: string | undefined
  /** What switching the capability on would grant under the manifest as it is now. */
  readonly patterns: readonly Pattern[]
}

/** Undefined when the manifest no longer lets the capability be granted: there is nothing to switch. `level` is the Level 4 override of ADR-0037. */
export function offerCapability (manifest: Manifest, capability: CapabilityKind, level?: ScoreLevel): OfferedCapability | undefined {
  const decision = decideGrantRequest(manifest, capability, undefined)
  if (!decision.allowed) return undefined
  const { warning, message, explanation } = summaryAtLevel(describeCapabilityGrant(capability, decision.patterns), level)
  return { warning, message, explanation, patterns: decision.patterns }
}
