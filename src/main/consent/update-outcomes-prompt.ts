// The real ReconsentPrompt/CapabilityPromptPrompt/RollbackChoicePrompt
// (./update-outcomes.ts) for the three pending outcomes of an update: each
// asks in the panel of the tab that triggered it (the tab in front when
// none did), matching install-consent-prompt.ts's split: this file only
// shows the words ./grant-prompt-render.ts composes, never composes them.

import { describeCapabilityPrompt, describeReconsent, describeRollbackChoice } from './grant-prompt-render.js'
import type { CapabilityPromptPrompt, ReconsentPrompt, RollbackChoicePrompt } from './update-outcomes.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import { askCaller, holdCaller } from './ask-caller.js'
import { formatOriginForDisplay } from './grant-prompt-origin.js'
import type { QuestionSpec } from '../shell/question/question-spec.js'
import type { DialogCaller } from './request-grant.js'

/** Cancelling points at "keep the current version" -- an update is never the
 * safer outcome of a dismissed or Escape-closed question; the previously
 * pinned bundle is what stays running either way (this file's own three
 * functions never call anything on a `false` return). */
const KEEP_CURRENT_BUTTON_INDEX = 1

/** True only when the person pressed the first button, "use the update". */
async function accepted (caller: DialogCaller | undefined, origin: string, content: { title: string, message: string, detail: string }, buttons: readonly [string, string], warning: boolean): Promise<boolean> {
  const spec: QuestionSpec = {
    kind: 'consent',
    origin: formatOriginForDisplay(origin),
    warning,
    title: content.title,
    message: content.message,
    detail: content.detail,
    buttons,
    cancelId: KEEP_CURRENT_BUTTON_INDEX,
    guarded: [0],
    focus: 'dialog'
  }
  const release = holdCaller(caller)
  try {
    return (await askCaller(caller, spec)).response === 0
  } finally {
    release()
  }
}

/** Builds the real ReconsentPrompt ./app-install-subsystem.ts wires in. */
export function createReconsentPrompt (): ReconsentPrompt {
  return async (origin, manifest, caller) => {
    if (caller !== undefined && !caller.stillOn(origin)) return false

    const content = describeReconsent(origin, manifest)
    return await accepted(caller, origin, content, ['Use the update', 'Keep the current version'], false)
  }
}

/** Builds the real CapabilityPromptPrompt ./app-install-subsystem.ts wires
 * in. `levelOverrideFor` defaults to never overriding (ADR-0037); this is
 * the update-widening prompt, where breadth matters most, and the override
 * still applies to it -- silencing the warning here is exactly what an L4
 * site earns, not an exception carved out of it. */
export function createCapabilityPrompt (levelOverrideFor: (origin: string) => ScoreLevel | undefined = () => undefined): CapabilityPromptPrompt {
  return async (origin, manifest, requestedPatterns, caller) => {
    if (caller !== undefined && !caller.stillOn(origin)) return false

    const content = describeCapabilityPrompt(origin, manifest, requestedPatterns, levelOverrideFor(origin))
    return await accepted(caller, origin, content, ['Allow', 'Keep the current version'], content.warning)
  }
}

/** Builds the real RollbackChoicePrompt ./app-install-subsystem.ts wires in. */
export function createRollbackChoicePrompt (): RollbackChoicePrompt {
  return async (origin, manifest, versionFloor, caller) => {
    if (caller !== undefined && !caller.stillOn(origin)) return false

    const content = describeRollbackChoice(origin, manifest, versionFloor)
    return await accepted(caller, origin, content, ['Use this version', 'Keep the current version'], true)
  }
}
