// The window side of the update notice: where the question may be asked, and what the answer does. Tied to Electron
// through the question panel and the windows it draws in; the words are ./update-ask.ts, the rules ./update-notice.ts.
import { askPlace } from '../os/install-default-browser-ask.js'
import type { AskPlace } from '../os/install-default-browser-ask.js'
import { askQuestion } from '../shell/question/ask-question.js'
import type { AskQuestion } from '../shell/question/ask-question.js'
import type { WindowRegistry } from '../shell/window-registry.js'
import { readUpdateChoice, updateQuestion } from './update-ask.js'
import type { Installable } from './update-ask.js'
import type { ReleaseInfo } from './update-check.js'
import type { PlaceResult } from './update-notice.js'

/** Not yet: the signed install is not built, so the question offers the release page alone. */
const INSTALLABLE: Installable = { ok: false }

const WITHOUT_WINDOW = 'no window is in use (minimised, hidden, behind the welcome screen, or another question is open)'

/**
 * The window to ask in, or why not yet. Never an operating-system box: with no window in use the question waits. A
 * full-screen window waits too, since a video or a presentation is not to be interrupted, and a kiosk is only told
 * through Settings.
 */
export function updatePlace (windows: Pick<WindowRegistry, 'focused'>, kiosk: boolean, place: typeof askPlace = askPlace): PlaceResult<AskPlace> {
  if (kiosk) return { waiting: 'this is a kiosk' }
  const found = place(windows)
  if (found === undefined) return { waiting: WITHOUT_WINDOW }
  if (found.window.window.isFullScreen() || found.window.shortcutsSuspended()) return { waiting: 'the window is full screen' }
  return { place: found }
}

/** Asks about `release` in `place` and acts on the answer: the release page opens in a tab of that window. Resolves once answered or closed. */
export async function askInWindow (
  place: AskPlace, release: ReleaseInfo, running: string, log: (line: string) => void, ask: AskQuestion = askQuestion
): Promise<void> {
  const { response, clicked } = await ask({ window: place.window, tabId: place.tabId }, updateQuestion(release.version.replace(/^v/i, ''), running.replace(/^v/i, ''), INSTALLABLE))
  const choice = readUpdateChoice(response, INSTALLABLE)
  log(choice === 'github' ? 'answer: the release page' : clicked === true ? 'answer: not now' : 'answer: closed without a choice')
  if (choice === 'github' && !place.window.window.isDestroyed()) {
    place.window.tabs.createTab(release.url)
    log('opened the release page in a tab')
  }
}
