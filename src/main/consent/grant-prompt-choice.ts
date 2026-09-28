// Part 2 of A138 (docs/open-questions.md): the content for ONE screen in a
// sequence that decides a 'per-capability' manifest's declared capabilities
// one at a time -- install-consent-prompt.ts's createPerCapabilityConsentPrompt
// is the only caller. Split into its own file rather than folded into
// grant-prompt-render.ts, which was already within a few dozen lines of its
// own 500-line ceiling (code-guidelines.md Rule 2).
//
// A native dialog offers no checkbox list -- install-consent-prompt.ts's own
// header says so, and it is why this sequence exists at all. The only way a
// SEQUENCE of single-capability dialogs can still show the whole request is
// to print the whole request as context on every screen: this function's
// `detail` lists every capability in `capabilities`, marks the one being
// decided now, and marks whatever this SAME sequence has already decided
// for the others -- never a second vocabulary for what a capability means
// (Rule 3): every row's own wording comes from describeCapabilityGrant
// (grant-prompt-render.ts), the identical function the whole-set dialog and
// the settings permissions list already use.

import type { CapabilityKind, Manifest, Pattern } from '../../contracts/index.js'
import type { PatternSet } from '../../broker/policy/update.js'
import type { GrantPromptContent } from './grant-prompt-render.js'
import { describeCapabilityGrant, formatOriginForDisplay } from './grant-prompt-render.js'
import { summaryAtLevel } from './grant-level.js'
import type { ScoreLevel } from '../../trust/website-level.js'

/**
 * `capabilities[index]` is the one this screen asks about; the rest are
 * shown as context only. `decided` carries what EARLIER screens in this
 * same sequence already chose (never capabilities beyond `index` -- the
 * caller has not asked about those yet), keyed by capability. `level`
 * (ADR-0037) goes through `summaryAtLevel` for EVERY row on this screen,
 * not only `currentRow` -- the context lines are built from the same
 * `describeCapabilityGrant` summaries and must read the same way.
 */
export function describeCapabilityChoice (
  origin: string,
  manifest: Manifest,
  declared: PatternSet,
  capabilities: readonly CapabilityKind[],
  index: number,
  decided: ReadonlyMap<CapabilityKind, boolean>,
  level?: ScoreLevel
): GrantPromptContent {
  const current = capabilities[index]
  if (current === undefined) throw new Error(`describeCapabilityChoice: index ${index} is out of range for ${capabilities.length} capabilities`)
  const patternsFor = (capability: CapabilityKind): readonly Pattern[] => declared[capability] ?? []
  const currentRow = summaryAtLevel(describeCapabilityGrant(current, patternsFor(current)), level)

  const lines = capabilities.map((capability, i) => {
    const { message } = summaryAtLevel(describeCapabilityGrant(capability, patternsFor(capability)), level)
    if (i === index) return `> ${message}`
    const decision = decided.get(capability)
    if (decision === true) return `  [Allowed] ${message}`
    if (decision === false) return `  [Denied] ${message}`
    return `  ${message}`
  })

  const displayOrigin = formatOriginForDisplay(origin)
  const claim = `Claims to be "${manifest.name}".`
  const intro = `Choosing what this app may do, one at a time (${index + 1} of ${capabilities.length}). Allow the item marked ">" below?`
  const detailLines = [claim, intro, ...lines]
  if (currentRow.explanation !== undefined) detailLines.push(currentRow.explanation)
  detailLines.push(displayOrigin)

  return {
    warning: currentRow.warning,
    title: displayOrigin,
    message: currentRow.message,
    detail: detailLines.join('\n')
  }
}
