// "<App> wants to open <site>. Open the page through your proxy, or directly?", asked each time a page of a routed app
// opens an address outside the sessions the app's route covers. Nothing is remembered. Drawn in the panel of the tab it is
// about, like the external-link question.
import { formatOriginForDisplay } from '../consent/grant-prompt-origin.js'
import type { Leave } from '../route/leave-decision.js'
import { askQuestion, type QuestionTarget } from './question/ask-question.js'

export type LeaveAnswer = 'proxy' | 'direct' | 'cancel'

const PROXY = 0
const DIRECT = 1
const CANCEL = 2

/** The question as the panel is given it; split out so the words are tested without a window. */
export function leavingQuestion (app: string, leave: Leave): { message: string, detail: string, buttons: [string, string, string] } {
  return {
    message: `${formatOriginForDisplay(app)} wants to open ${formatOriginForDisplay(leave.origin)}.`,
    detail: leave.kind === 'website'
      ? 'Your proxy is on for this app. Open the page through your proxy, or directly?'
      : 'Your proxy is on for this app, and not for the app it wants to open. Open it through your proxy, or directly?',
    buttons: [leave.kind === 'website' ? 'Through my proxy' : `Use my proxy for ${formatOriginForDisplay(leave.origin).replace(/^https:\/\//u, '')} too`, 'Directly', 'Cancel']
  }
}

/** Escape, a closed tab and a new page in the tab all answer `cancel`. */
export async function askToLeaveRoute (where: QuestionTarget, app: string, leave: Leave): Promise<LeaveAnswer> {
  const { message, detail, buttons } = leavingQuestion(app, leave)
  const { response } = await askQuestion(where, {
    kind: 'consent',
    buttons,
    cancelId: CANCEL,
    guarded: [PROXY, DIRECT],
    focus: 'dialog',
    message,
    detail
  }, { endOnNavigation: true })
  return response === PROXY ? 'proxy' : response === DIRECT ? 'direct' : 'cancel'
}
