// The window side of the update notice: where the question may be asked, and what the answer does. Tied to Electron
// through the question panel and the windows it draws in; the words are ./update-ask.ts, the rules ./update-notice.ts.
import { askPlace } from '../os/install-default-browser-ask.js'
import type { AskPlace } from '../os/install-default-browser-ask.js'
import { askQuestion } from '../shell/question/ask-question.js'
import type { AskQuestion } from '../shell/question/ask-question.js'
import type { WindowRegistry } from '../shell/window-registry.js'
import { readUpdateChoice, updateQuestion } from './update-ask.js'
import type { Installable, UpdateChoice } from './update-ask.js'
import type { ReleaseInfo } from './update-check.js'
import { LATEST_RELEASE_NAME, LATEST_RELEASE_URL } from './release-url.js'
import type { AskOutcome, PlaceResult } from './update-notice.js'

/** Not yet: the signed install is not built, so the question offers the two download pages alone. */
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

/** The page an answer opens and what the log calls it, or none for a way out. The newest-release address is fixed, never taken from `release`. */
function downloadOf (choice: UpdateChoice, release: ReleaseInfo): { url: string, name: string } | undefined {
  if (choice === 'github') return { url: release.url, name: 'the release page' }
  if (choice === 'ens') return { url: LATEST_RELEASE_URL, name: LATEST_RELEASE_NAME }
  return undefined
}

/**
 * Asks about `release` in `place` and acts on the answer: the release page, or the start page of the newest-release
 * name, opens in a tab of that window. Resolves once answered or closed, and says whether the panel was ever up: an
 * Escape after reading it and a cancel because the toolbar never came into view look the same in the result, and only
 * the first is the person having been told.
 */
export async function askInWindow (
  place: AskPlace, release: ReleaseInfo, running: string, log: (line: string) => void, ask: AskQuestion = askQuestion
): Promise<AskOutcome> {
  let up = false
  const spec = updateQuestion(release.version.replace(/^v/i, ''), running.replace(/^v/i, ''), INSTALLABLE)
  const { response, clicked } = await ask({ window: place.window, tabId: place.tabId }, spec, { onShown: () => { up = true } })
  const seen = up || clicked === true
  const choice = readUpdateChoice(response, INSTALLABLE)
  const download = downloadOf(choice, release)
  log(download !== undefined ? `answer: ${download.name}` : clicked === true ? 'answer: not now' : seen ? 'answer: closed without a choice' : 'answer: closed before it was shown')
  if (download !== undefined && !place.window.window.isDestroyed()) {
    place.window.tabs.createTab(download.url)
    log(`opened ${download.name} in a tab`)
  }
  return { seen }
}
