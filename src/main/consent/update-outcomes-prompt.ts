// The real ReconsentPrompt/CapabilityPromptPrompt/RollbackChoicePrompt
// (./update-outcomes.ts) for S4-5's three pending outcomes -- three plain
// dialog.showMessageBox calls, no new dependency (Rule 8), matching
// install-consent-prompt.ts's own split: this file only shows the words
// ./grant-prompt-render.ts composes, never composes them itself.

import { dialog } from 'electron'
import type { MessageBoxOptions } from 'electron'
import { describeCapabilityPrompt, describeReconsent, describeRollbackChoice } from './grant-prompt-render.js'
import type { CapabilityPromptPrompt, ReconsentPrompt, RollbackChoicePrompt } from './update-outcomes.js'

/** `defaultId`/`cancelId` both point at "keep the current version" -- an
 * update is never the safer default to fall into on a dismissed or
 * Escape-closed dialog; the previously pinned bundle is what stays running
 * either way (this file's own three functions never call anything on a
 * `false` return). */
const KEEP_CURRENT_BUTTON_INDEX = 1

/** Builds the real ReconsentPrompt ./app-install-subsystem.ts wires in. */
export function createReconsentPrompt (): ReconsentPrompt {
  return async (origin, manifest) => {
    const content = describeReconsent(origin, manifest)
    const options: MessageBoxOptions = {
      type: 'question',
      buttons: ['Use the update', 'Keep the current version'],
      defaultId: KEEP_CURRENT_BUTTON_INDEX,
      cancelId: KEEP_CURRENT_BUTTON_INDEX,
      title: content.title,
      message: content.message,
      detail: content.detail
    }
    const { response } = await dialog.showMessageBox(options)
    return response === 0
  }
}

/** Builds the real CapabilityPromptPrompt ./app-install-subsystem.ts wires in. */
export function createCapabilityPrompt (): CapabilityPromptPrompt {
  return async (origin, manifest, requestedPatterns) => {
    const content = describeCapabilityPrompt(origin, manifest, requestedPatterns)
    const options: MessageBoxOptions = {
      type: content.warning ? 'warning' : 'question',
      buttons: ['Allow', 'Keep the current version'],
      defaultId: KEEP_CURRENT_BUTTON_INDEX,
      cancelId: KEEP_CURRENT_BUTTON_INDEX,
      title: content.title,
      message: content.message,
      detail: content.detail
    }
    const { response } = await dialog.showMessageBox(options)
    return response === 0
  }
}

/** Builds the real RollbackChoicePrompt ./app-install-subsystem.ts wires in. */
export function createRollbackChoicePrompt (): RollbackChoicePrompt {
  return async (origin, manifest, versionFloor) => {
    const content = describeRollbackChoice(origin, manifest, versionFloor)
    const options: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Use this version', 'Keep the current version'],
      defaultId: KEEP_CURRENT_BUTTON_INDEX,
      cancelId: KEEP_CURRENT_BUTTON_INDEX,
      title: content.title,
      message: content.message,
      detail: content.detail
    }
    const { response } = await dialog.showMessageBox(options)
    return response === 0
  }
}
