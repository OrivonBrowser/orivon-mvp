// The real UpdatePrompts (../install/app-updates.ts): each question is asked in the panel of the
// tab it concerns, like every question of ./update-outcomes-prompt.ts, and shows the words
// ./update-available-render.ts composes. A question whose tab left the origin before or while it
// was open answers `null`: nobody was asked, so nothing is remembered and the next visit asks again.

import type { UpdateOffer, UpdatePrompts } from '../install/app-updates.js'
import type { QuestionSpec } from '../shell/question/question-spec.js'
import { askCaller, holdCaller } from './ask-caller.js'
import { formatOriginForDisplay } from './grant-prompt-origin.js'
import type { DialogCaller } from './request-grant.js'
import { describeFailedUpdate, describeForceUpdate, describeUnverifiedUpdate, describeVerifiedUpdate } from './update-available-render.js'
import type { UpdateContent } from './update-available-render.js'

const TICK = 'Don\'t ask again for this version'

/** Shows `content`; `null` when the tab is no longer on the offer's origin before or after the answer. */
async function ask (caller: DialogCaller | undefined, offer: UpdateOffer, content: UpdateContent, extra: Pick<QuestionSpec, 'kind' | 'buttons' | 'cancelId'> & Partial<QuestionSpec>, hold: boolean): Promise<{ response: number, checked: boolean } | null> {
  if (caller !== undefined && !caller.stillOn(offer.origin)) return null
  const release = hold ? holdCaller(caller) : () => {}
  try {
    const result = await askCaller(caller, {
      origin: formatOriginForDisplay(offer.origin),
      warning: content.warning,
      title: content.title,
      message: content.message,
      detail: content.detail,
      ...extra
    })
    if (caller !== undefined && !caller.stillOn(offer.origin)) return null
    return { response: result.response, checked: result.checkboxChecked }
  } finally {
    release()
  }
}

export function createUpdatePrompts (): UpdatePrompts {
  return {
    verified: async (offer, caller) => {
      const answer = await ask(caller, offer, describeVerifiedUpdate(offer), { kind: 'consent', buttons: ['Yes', 'Not now'], cancelId: 1, guarded: [0], focus: 'dialog', checkboxLabel: TICK }, true)
      return answer === null ? null : { yes: answer.response === 0, quiet: answer.checked }
    },
    notice: async (offer, caller) => {
      const answer = await ask(caller, offer, describeUnverifiedUpdate(offer), { kind: 'notice', buttons: ['OK'], cancelId: 0, checkboxLabel: TICK }, false)
      return answer === null ? null : { quiet: answer.checked }
    },
    confirmForce: async (offer, held, caller) => {
      const answer = await ask(caller, offer, describeForceUpdate(offer, held), { kind: 'consent', buttons: ['Switch anyway', 'Cancel'], cancelId: 1, guarded: [0], focus: 'dialog' }, true)
      return answer !== null && answer.response === 0
    },
    failed: async (offer, reason, caller) => {
      await ask(caller, offer, describeFailedUpdate(offer, reason), { kind: 'notice', buttons: ['OK'], cancelId: 0 }, false)
    }
  }
}
