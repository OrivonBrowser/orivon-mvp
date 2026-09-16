// The real InstallConsentPrompt (./install-consent.ts) for d-0025 -- one
// native dialog for a manifest's whole declared capability set, never
// request-grant-prompt.ts's per-capability dialog shown once per capability.
// Same "no new dependency, no custom window" stance that file's header
// gives (Rule 8): a plain `dialog.showMessageBox`, its `type` swapped to
// 'warning' the moment any declared capability is unlimited (A100), with
// the actual words built by ./grant-prompt-render.ts's
// `describeInstallConsent` -- this file only shows them, never composes
// them, matching request-grant-prompt.ts's own split.
//
// createPerCapabilityConsentPrompt (A138, docs/open-questions.md) is the
// real PerCapabilityConsentPrompt: also no new dependency and no custom
// window, since a native message box cannot show a checkbox list -- see its
// own doc below for the staged sequence this builds instead.

import { dialog } from 'electron'
import type { MessageBoxOptions } from 'electron'
import { describeInstallConsent } from './grant-prompt-render.js'
import { describeCapabilityChoice } from './grant-prompt-choice.js'
import { patternSetFromCapabilities } from '../broker/policy/manifest-patterns.js'
import type { InstallConsentPrompt, PerCapabilityConsentPrompt } from './install-consent.js'
import type { CapabilityKind } from '../contracts/index.js'

/** Builds the real InstallConsentPrompt ./app-install-subsystem.ts wires in. */
export function createInstallConsentPrompt (): InstallConsentPrompt {
  return async (origin, manifest, capabilities, held = []) => {
    const content = describeInstallConsent(origin, manifest, capabilities, held)
    const options: MessageBoxOptions = {
      type: content.warning ? 'warning' : 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      title: content.title,
      message: content.message,
      detail: content.detail
    }
    const { response } = await dialog.showMessageBox(options)
    return response === 0
  }
}

const OVERVIEW_BUTTONS = ['Allow all', 'Choose individually', 'Deny all']
const ALLOW_ALL = 0
const DENY_ALL = 2

/**
 * Builds the real PerCapabilityConsentPrompt ./app-install-subsystem.ts
 * wires in for a manifest declaring `consentGranularity: 'per-capability'`.
 *
 * STAGED, PER THIS LANE'S OWN BRIEF: one overview dialog first, offering
 * "Allow all" / "Choose individually" / "Deny all" -- the common cases cost
 * one click, same as the all-or-nothing dialog above, and only a person who
 * actually wants finer control pays for the longer path. Defaults and
 * cancels on "Deny all" (index 2), the same safe-default convention every
 * other native dialog in this family already uses (dismissing a dialog must
 * never grant more than doing nothing would).
 *
 * "Choose individually" runs ONE Allow/Deny dialog per capability, in the
 * order `capabilities` was given. A native message box supports no
 * checkbox list, so this is the only way a SEQUENCE of single-capability
 * dialogs can still keep the whole request visible: each screen
 * (describeCapabilityChoice, ./grant-prompt-choice.ts) prints every
 * capability being decided this round, marks the one on screen, and marks
 * whatever this SAME sequence already decided for the others.
 */
export function createPerCapabilityConsentPrompt (): PerCapabilityConsentPrompt {
  return async (origin, manifest, capabilities) => {
    const overviewContent = describeInstallConsent(origin, manifest, capabilities)
    const overview = await dialog.showMessageBox({
      type: overviewContent.warning ? 'warning' : 'question',
      buttons: OVERVIEW_BUTTONS,
      defaultId: DENY_ALL,
      cancelId: DENY_ALL,
      title: overviewContent.title,
      message: overviewContent.message,
      detail: overviewContent.detail
    })
    if (overview.response === ALLOW_ALL) return capabilities
    if (overview.response === DENY_ALL) return []

    const declared = patternSetFromCapabilities(manifest.capabilities)
    const decided = new Map<CapabilityKind, boolean>()
    for (let index = 0; index < capabilities.length; index += 1) {
      const capability = capabilities[index]
      if (capability === undefined) continue // unreachable: index stays within capabilities.length
      const screen = describeCapabilityChoice(origin, manifest, declared, capabilities, index, decided)
      const choice = await dialog.showMessageBox({
        type: screen.warning ? 'warning' : 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        title: screen.title,
        message: screen.message,
        detail: screen.detail
      })
      decided.set(capability, choice.response === 0)
    }
    return capabilities.filter((capability) => decided.get(capability) === true)
  }
}
