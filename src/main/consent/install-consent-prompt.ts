// The real InstallConsentPrompt (./install-consent.ts): one question in the
// panel of the tab that reported the manifest, for the whole declared
// capability set, never request-grant-prompt.ts's one-capability question
// shown once per capability. The panel is the warning style the moment any
// declared capability is unlimited (A100). The words come from
// ./grant-prompt-render.ts's `describeInstallConsent`; this file only shows
// them, matching request-grant-prompt.ts's own split.
//
// createPerCapabilityConsentPrompt (A138, docs/open-questions.md) is the real
// PerCapabilityConsentPrompt: an overview question, then one Allow/Deny
// question per capability for a person who wants finer control.

import { describeInstallConsent } from './grant-prompt-render.js'
import { describeCapabilityChoice } from './grant-prompt-choice.js'
import { patternSetFromCapabilities } from '../../broker/policy/manifest-patterns.js'
import type { InstallConsentPrompt, PerCapabilityConsentPrompt } from './install-consent.js'
import type { CapabilityKind } from '../../contracts/index.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import { askCaller, holdCaller } from './ask-caller.js'
import { formatOriginForDisplay } from './grant-prompt-origin.js'

/** `levelOverrideFor` defaults to never overriding, so an unwired caller
 * (and every existing test) keeps warning exactly as before -- the real
 * `../dev/score-levels.js` function is wired in at
 * `../install/app-install-subsystem.ts` (ADR-0037). */
type LevelOverrideFor = (origin: string) => ScoreLevel | undefined
const NO_OVERRIDE: LevelOverrideFor = () => undefined

/** The extensions disclosure (docs/planning/extensions-exploration.md) -- the same
 * shape `./request-grant-prompt.ts`'s own `createGrantPrompt` takes, wired
 * to the real `../extensions/site-reach-runner.js` at the same place
 * (`../install/app-install-subsystem.ts`), and defaults to always naming
 * none. */
type ExtensionsOnSite = (origin: string) => Promise<readonly string[]>
const NO_EXTENSIONS: ExtensionsOnSite = async () => []

/** Builds the real InstallConsentPrompt ./app-install-subsystem.ts wires in. */
export function createInstallConsentPrompt (levelOverrideFor: LevelOverrideFor = NO_OVERRIDE, extensionsOnSite: ExtensionsOnSite = NO_EXTENSIONS): InstallConsentPrompt {
  return async (origin, manifest, capabilities, held = [], caller) => {
    const names = await extensionsOnSite(origin)
    // The tab that reported this hint may already have navigated away, or
    // closed, by the time this actually runs (the lookup above included) --
    // never show a dialog for a page the person is no longer looking at
    // (request-grant.ts's own `DialogCaller` doc).
    if (caller !== undefined && !caller.stillOn(origin)) return false

    const content = describeInstallConsent(origin, manifest, capabilities, held, levelOverrideFor(origin), names)
    const release = holdCaller(caller)
    try {
      const { response } = await askCaller(caller, {
        kind: 'consent',
        origin: formatOriginForDisplay(origin),
        warning: content.warning,
        title: content.title,
        message: content.message,
        detail: content.detail,
        buttons: ['Allow', 'Deny'],
        cancelId: 1,
        guarded: [0],
        focus: 'dialog'
      })
      return response === 0
    } finally {
      release()
    }
  }
}

const OVERVIEW_BUTTONS = ['Allow all', 'Choose individually', 'Deny all']
const ALLOW_ALL = 0
const DENY_ALL = 2

/**
 * Builds the real PerCapabilityConsentPrompt ./app-install-subsystem.ts
 * wires in for a manifest declaring `consentGranularity: 'per-capability'`.
 *
 * STAGED: one overview question first, offering
 * "Allow all" / "Choose individually" / "Deny all" -- the common cases cost
 * one click, same as the all-or-nothing question above, and only a person who
 * actually wants finer control pays for the longer path. It cancels on
 * "Deny all" (index 2), the safe-default convention every question in this
 * family follows (dismissing one must never grant more than doing nothing
 * would).
 *
 * "Choose individually" runs ONE Allow/Deny question per capability, in the
 * order `capabilities` was given. Each screen (describeCapabilityChoice,
 * ./grant-prompt-choice.ts) prints every capability being decided this
 * round, marks the one on screen, and marks whatever this SAME sequence
 * already decided for the others.
 *
 * The tab's page is held for the whole sequence, the gaps between screens
 * included.
 */
export function createPerCapabilityConsentPrompt (levelOverrideFor: LevelOverrideFor = NO_OVERRIDE, extensionsOnSite: ExtensionsOnSite = NO_EXTENSIONS): PerCapabilityConsentPrompt {
  return async (origin, manifest, capabilities, caller) => {
    const level = levelOverrideFor(origin)
    const names = await extensionsOnSite(origin)
    // Checked before the FIRST screen of this staged sequence, after the
    // lookup above -- the whole sequence never starts for a page the person
    // is no longer looking at.
    if (caller !== undefined && !caller.stillOn(origin)) return []

    const release = holdCaller(caller)
    try {
      const overviewContent = describeInstallConsent(origin, manifest, capabilities, [], level, names)
      const overview = await askCaller(caller, {
        kind: 'consent',
        origin: formatOriginForDisplay(origin),
        warning: overviewContent.warning,
        title: overviewContent.title,
        message: overviewContent.message,
        detail: overviewContent.detail,
        buttons: OVERVIEW_BUTTONS,
        cancelId: DENY_ALL,
        guarded: [ALLOW_ALL],
        focus: 'dialog'
      })
      if (overview.response === ALLOW_ALL) return capabilities
      if (overview.response === DENY_ALL) return []

      const declared = patternSetFromCapabilities(manifest.capabilities)
      const decided = new Map<CapabilityKind, boolean>()
      for (let index = 0; index < capabilities.length; index += 1) {
        const capability = capabilities[index]
        if (capability === undefined) continue // unreachable: index stays within capabilities.length
        // Re-checked before EACH screen: the person can close or navigate the
        // tab partway through this multi-screen sequence, not only before it
        // started.
        if (caller !== undefined && !caller.stillOn(origin)) return []
        const screen = describeCapabilityChoice(origin, manifest, declared, capabilities, index, decided, level)
        const choice = await askCaller(caller, {
          kind: 'consent',
          origin: formatOriginForDisplay(origin),
          warning: screen.warning,
          title: screen.title,
          message: screen.message,
          detail: screen.detail,
          buttons: ['Allow', 'Deny'],
          cancelId: 1,
          guarded: [0],
          focus: 'dialog'
        })
        decided.set(capability, choice.response === 0)
      }
      return capabilities.filter((capability) => decided.get(capability) === true)
    } finally {
      release()
    }
  }
}
