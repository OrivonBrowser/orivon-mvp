// "<App> wants to open <site>. Open the page through your tunnel, or directly?", asked each time a page of a routed app
// opens an address outside the sessions the app's route covers. Nothing is remembered. Drawn in the panel of the tab it is
// about, like the external-link question.
import { formatOriginForDisplay } from '../consent/grant-prompt-origin.js'
import type { Leave } from '../route/leave-decision.js'
import { askQuestion, type QuestionTarget } from './question/ask-question.js'

export type LeaveAnswer = 'proxy' | 'direct' | 'cancel'

/** The question as the panel is given it; split out so the words are tested without a window. */
export function leavingQuestion (leave: Leave): { message: string, detail: string, buttons: string[] } {
  const message = `${formatOriginForDisplay(leave.app)} wants to open ${formatOriginForDisplay(leave.origin)}.`
  const own = leave.site === true ? 'site' : 'app'
  if (leave.kind === 'served') return { message, detail: 'Orivon loads this page itself, so it cannot go through your tunnel yet.', buttons: ['Directly', 'Cancel'] }
  return {
    message,
    detail: leave.kind === 'website'
      ? `Your tunnel is on for this ${own}. Open the page through your tunnel, or directly?`
      : `Your tunnel is on for this ${own}, and not for the app it wants to open. Open it through your tunnel, or directly?`,
    buttons: [leave.kind === 'website' ? 'Through my tunnel' : `Use my tunnel for ${formatOriginForDisplay(leave.origin).replace(/^https:\/\//u, '')} too`, 'Directly', 'Cancel']
  }
}

/** What each button of `leavingQuestion` answers, in the order shown. */
function answersFor (leave: Leave): LeaveAnswer[] {
  return leave.kind === 'served' ? ['direct', 'cancel'] : ['proxy', 'direct', 'cancel']
}

/** Escape, a closed tab and a new page in the tab all answer `cancel`. */
export async function askToLeaveRoute (where: QuestionTarget, leave: Leave): Promise<LeaveAnswer> {
  const { message, detail, buttons } = leavingQuestion(leave)
  const answers = answersFor(leave)
  const { response } = await askQuestion(where, {
    kind: 'consent',
    buttons,
    cancelId: answers.indexOf('cancel'),
    guarded: answers.flatMap((answer, index) => answer === 'cancel' ? [] : [index]),
    focus: 'dialog',
    message,
    detail
  }, { endOnNavigation: true })
  return answers[response] ?? 'cancel'
}
