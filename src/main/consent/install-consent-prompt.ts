// The real InstallConsentPrompt (./install-consent.ts): one question in the panel of the tab that reported the manifest,
// a switch per capability being decided, for both consent granularities. The words come from ./install-consent-panel.ts;
// this file shows them and reads the answer. The panel is the warning style the moment any row is unlimited (A100).
import { describeInstallPanel } from './install-consent-panel.js'
import type { InstallConsentPrompt } from './install-consent.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import { askCaller, holdCaller } from './ask-caller.js'
import { formatOriginForDisplay } from './grant-prompt-origin.js'
import { takeFirstPromptNote, withFirstPromptLine } from './first-prompt-note.js'

/** `levelOverrideFor` defaults to never overriding, so an unwired caller (and every existing test) keeps warning exactly as before -- the real `../dev/score-levels.js` function is wired in at `../install/app-install-subsystem.ts` (ADR-0037). */
type LevelOverrideFor = (origin: string) => ScoreLevel | undefined
const NO_OVERRIDE: LevelOverrideFor = () => undefined

/** The extensions disclosure, wired to the real `../extensions/site-reach-runner.js` at the same place; it defaults to naming none. */
type ExtensionsOnSite = (origin: string) => Promise<readonly string[]>
const NO_EXTENSIONS: ExtensionsOnSite = async () => []

const GRANT_ALL = 0
const CLOSE = 1

/**
 * Builds the real InstallConsentPrompt ./app-install-subsystem.ts wires in. Grant all answers every row; Close answers
 * the rows switched on, which is none when the person switched nothing. Escape, a closed tab and a navigation answer
 * `null`, like a tab that moved on: the first visit reads that as "ask again next time" and records nothing.
 */
export function createInstallConsentPrompt (levelOverrideFor: LevelOverrideFor = NO_OVERRIDE, extensionsOnSite: ExtensionsOnSite = NO_EXTENSIONS, firstOfProfile: () => boolean = takeFirstPromptNote): InstallConsentPrompt {
  return async (origin, manifest, capabilities, caller) => {
    const names = await extensionsOnSite(origin)
    // The tab that reported this hint may already have navigated away, or closed, by the time this runs: never show a question for a page the person is no longer looking at (request-grant.ts's `DialogCaller`).
    if (caller !== undefined && !caller.stillOn(origin)) return null

    const content = describeInstallPanel(origin, manifest, capabilities, levelOverrideFor(origin), names)
    const detail = firstOfProfile() ? withFirstPromptLine(content.detail, formatOriginForDisplay(origin)) : content.detail
    const release = holdCaller(caller)
    try {
      const answer = await askCaller(caller, {
        kind: 'consent',
        origin: formatOriginForDisplay(origin),
        warning: content.warning,
        title: content.title,
        message: content.message,
        detail,
        choices: content.rows.map((row) => ({ id: row.capability, icon: row.capability, message: row.message, warning: row.warning, ...(row.explanation === undefined ? {} : { detail: row.explanation }) })),
        ...(content.note === undefined ? {} : { choicesNote: content.note }),
        buttons: ['Grant all', 'Close'],
        cancelId: CLOSE,
        guarded: [GRANT_ALL, CLOSE],
        focus: 'dialog'
      })
      // Only a pressed button answers; the ways out answer with Close's index too.
      if (answer.clicked !== true) return null
      if (answer.response === GRANT_ALL) return content.rows.map((row) => row.capability)
      const chosen = answer.chosen ?? []
      return content.rows.filter((row) => chosen.includes(row.capability)).map((row) => row.capability)
    } finally {
      release()
    }
  }
}
