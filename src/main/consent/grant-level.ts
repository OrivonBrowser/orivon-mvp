// ADR-0037: an L4 site's grants are shown without warnings, on every
// consent surface a grant summary ever reaches -- the dialogs
// (grant-prompt-render.ts, grant-prompt-choice.ts), the site-info popup's
// switch rows (../permissions/site-info.ts) and the all-sites panel's rows
// (../permissions/permissions.ts). ONE rule, applied at row-building time,
// rather than each caller re-deriving its own "is this L4" branch --
// code-guidelines.md Rule 3.
//
// WHAT THIS DOES NOT TOUCH: the rollback warning (update-outcomes-prompt.ts,
// describeRollbackChoice) and the "this app asked for these together"
// staged note (site-info/main-view.ts) never go through
// `describeCapabilityGrant`/`describePickedPath` at all -- they are not
// about a grant's BREADTH, so L4 never silences them. `summaryAtLevel`
// exists only for the summaries that ARE about breadth.

import type { ScoreLevel } from '../../trust/website-level.js'
import type { CapabilityGrantSummary } from './grant-prompt-connect.js'
import { WARNING_MARK } from './grant-prompt-connect.js'

/**
 * `summary`, unchanged, unless `level` is 4 -- in which case the warning is
 * gone: `warning: false`, no `explanation`, and `WARNING_MARK` stripped from
 * the start of every line of `message` (a multi-line message, one origin per
 * line, is `describeWebContextGrant`'s own shape). The WORDS a person reads
 * otherwise never change -- "Unlimited network access" still says exactly
 * that, only the alarm markers around it are gone. Returns the SAME object
 * when nothing changes, so a caller comparing rows by reference (this file's
 * own `describeCapabilitySet`'s row-merge, for one) is never confused into
 * thinking a plain pass-through is a new row.
 */
export function summaryAtLevel (summary: CapabilityGrantSummary, level: ScoreLevel | undefined): CapabilityGrantSummary {
  if (level !== 4 || !summary.warning) return summary
  const message = summary.message
    .split('\n')
    .map((line) => line.startsWith(WARNING_MARK) ? line.slice(WARNING_MARK.length) : line)
    .join('\n')
  return { warning: false, message }
}
