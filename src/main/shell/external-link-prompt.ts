// "Open mailto link with your system's default app?", asked each time a
// page opens a link another app on the computer handles. Drawn in the panel
// of the tab it is about, and asynchronous: the main process keeps serving
// every other tab while it is open.
import { formatOriginForDisplay } from '../consent/grant-prompt-origin.js'
import type { AppLinkOption, ExternalLinkQuestion, LinkAnswer } from '../sessions/external-links.js'
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

/** More would not fit in a row of the panel's buttons beside the system's app and Cancel. */
export const MAX_APPS_OFFERED = 2

/**
 * The question when apps that declare the scheme are among the choices (d-0596): one button per app, named by its
 * origin (the app's own name is only claimed, so it is a line of detail), the system's app, and Cancel. Ticking
 * Always makes the app picked the default for the scheme; it never applies to the system's app, which is asked
 * about every time.
 */
export async function chooseLinkApp (where: QuestionTarget, question: ExternalLinkQuestion, apps: readonly AppLinkOption[]): Promise<LinkAnswer> {
  const offered = apps.slice(0, MAX_APPS_OFFERED)
  const system = offered.length
  const cancel = system + 1
  const named = offered.map((app) => `${formatOriginForDisplay(app.origin)} calls itself "${app.name}".`)
  const { response, checkboxChecked } = await askQuestion(where, {
    kind: 'consent',
    buttons: [...offered.map((app) => `Open in ${formatOriginForDisplay(app.origin)}`), 'Open with your system\'s app', 'Cancel'],
    cancelId: cancel,
    guarded: [...offered.keys(), system],
    focus: 'dialog',
    message: `Open this ${question.scheme} link?`,
    detail: `${formatOriginForDisplay(question.origin)} wants to open:\n${displayableUrl(question.url)}\n\n${named.join('\n')}\nYour system's app is asked about every time.`,
    checkboxLabel: `Always use the app I pick for ${question.scheme} links`
  }, { endOnNavigation: true })
  if (response === system) return { kind: 'system' }
  const app = offered[response]
  return app === undefined ? { kind: 'cancel' } : { kind: 'app', origin: app.origin, remember: checkboxChecked }
}

export interface SchemeDefaultQuestion {
  readonly scheme: string
  readonly origin: string
  /** The app that is the default now, which this would replace. */
  readonly replaces?: string | undefined
}

/** "Make this app your default for magnet links?", asked in the app's own tab when its page asks for it. True only when the person agreed. */
export async function confirmSchemeDefault (where: QuestionTarget, question: SchemeDefaultQuestion): Promise<boolean> {
  const replaces = question.replaces === undefined ? '' : `\nIt replaces ${formatOriginForDisplay(question.replaces)}.`
  const { response } = await askQuestion(where, {
    kind: 'consent',
    buttons: ['Make default', 'Cancel'],
    cancelId: 1,
    guarded: [0],
    focus: 'dialog',
    origin: question.origin,
    message: `Open ${question.scheme} links in this app from now on?`,
    detail: `${question.scheme} links open here without asking each time.${replaces}\nYou can change this in Settings, under Apps.`
  }, { endOnNavigation: true })
  return response === 0
}
