// "Open mailto link with your system's default app?", asked each time a
// page opens a link another app on the computer handles. Attached to the
// window showing the page, and asynchronous: the main process keeps serving
// every other tab while it is open.
import { dialog, type BaseWindow } from 'electron'
import { formatOriginForDisplay } from '../consent/grant-prompt-origin.js'
import type { ExternalLinkQuestion } from '../sessions/external-links.js'

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

/** True only when the person chose Allow. Enter and Escape both cancel. */
export async function confirmExternalLink (window: BaseWindow, question: ExternalLinkQuestion): Promise<boolean> {
  if (window.isDestroyed()) return false
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['Allow', 'Cancel'],
    defaultId: CANCEL,
    cancelId: CANCEL,
    noLink: true,
    message: `Open ${question.scheme} link with your system's default app?`,
    detail: `${formatOriginForDisplay(question.origin)} wants to open:\n${displayableUrl(question.url)}`
  })
  return response === ALLOW
}
