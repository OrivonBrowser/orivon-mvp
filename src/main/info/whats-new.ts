// Whether this start opens the What's new page, and the version it records either way. Pure: no Electron,
// no disk. The caller reads the profile's last version and acts on the answer (../shell/intro-state.ts keeps it).
import { compareVersions, parseVersion } from '../self-update/github-release-version.js'

export interface WhatsNewInput {
  /** The version running now. */
  readonly current: string
  /** The version that last started on this profile, or undefined when none is remembered. */
  readonly lastRun: string | undefined
  /** Whether the profile has already been through the welcome screen. */
  readonly welcomeSeen: boolean
  /** Whether this build has notes for `current`. */
  readonly hasNotes: boolean
}

export interface WhatsNewDecision {
  /** Open the page in front, once. */
  readonly open: boolean
  /** The version to write down; undefined leaves what is written as it is (a downgrade, a build with no version). */
  readonly remember: string | undefined
}

const NOTHING: WhatsNewDecision = { open: false, remember: undefined }

export function decideWhatsNew ({ current, lastRun, welcomeSeen, hasNotes }: WhatsNewInput): WhatsNewDecision {
  const now = parseVersion(current)
  if (now === null) return NOTHING
  // A profile that has neither run a version nor been through the welcome screen is new: it gets the welcome screen.
  if (lastRun === undefined && !welcomeSeen) return { open: false, remember: current }
  // A profile that ran before versions were remembered, or whose note is unreadable, is treated as older than any version.
  const before = lastRun === undefined ? null : parseVersion(lastRun)
  if (before !== null && compareVersions(now, before) <= 0) return NOTHING
  return { open: hasNotes, remember: current }
}
