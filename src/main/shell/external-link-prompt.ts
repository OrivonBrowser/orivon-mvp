// "Open mailto link with your system's default app?", asked each time a
// page opens a link another app on the computer handles. Drawn in the panel
// of the tab it is about, and asynchronous: the main process keeps serving
// every other tab while it is open.
import { formatOriginForDisplay } from '../consent/grant-prompt-origin.js'
import type { ExternalLinkQuestion } from '../sessions/external-links.js'
import { askQuestion, type QuestionTarget } from './question/ask-question.js'

const ALLOW = 0
const CANCEL = 1

/** Long enough for any real mailto: or payment link to read whole; past
 * it, the dialog would grow taller than the window. */
const MAX_DISPLAYED_URL = 200
const ELISION_MARKER = '...'

/** The URL as the person reads it: anything but printable ASCII escaped, so
 * a line break or a bidi override cannot rewrite the lines around it, then
 * cut to a length the dialog can hold. */
export function displayableUrl (url: string): string {
  const escaped = url.replace(/[^\x20-\x7e]/gu, (char) => encodeURIComponent(char))
  if (escaped.length <= MAX_DISPLAYED_URL) return escaped
  return escaped.slice(0, MAX_DISPLAYED_URL - ELISION_MARKER.length) + ELISION_MARKER
}

/** True only when the person chose Allow. Escape, a closed tab and a new page in the tab all cancel. */
export async function confirmExternalLink (where: QuestionTarget, question: ExternalLinkQuestion): Promise<boolean> {
  const { response } = await askQuestion(where, {
    kind: 'consent',
    buttons: ['Allow', 'Cancel'],
    cancelId: CANCEL,
    guarded: [ALLOW],
    focus: 'dialog',
    message: question.initiator === 'person' ? 'Open your mail program with this page\'s link?' : `Open ${question.scheme} link with your system's default app?`,
    detail: question.initiator === 'person'
      ? displayableUrl(question.url)
      : `${formatOriginForDisplay(question.origin)} wants to open:\n${displayableUrl(question.url)}`
  }, { endOnNavigation: true })
  return response === ALLOW
}
