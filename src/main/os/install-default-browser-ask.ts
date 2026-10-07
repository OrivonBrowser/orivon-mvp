// Asks whether Orivon may be the default browser, half a minute into its first use and then about once a week: in the
// window the person is using, as the browser's one kind of question, and only when nothing else has the window's
// attention. The default profile alone asks. It looks at the clock when the next ask falls due, at least hourly, and
// every few seconds while an ask waits for a window to ask in; at the operating system only when an ask is due.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { introCovers } from '../shell/intro-view.js'
import { askQuestion } from '../shell/question/ask-question.js'
import type { QuestionResult, QuestionSpec } from '../shell/question/question-spec.js'
import type { ShellWindow, WindowRegistry } from '../shell/window-registry.js'
import { RESTORE_OVERLAY } from '../startup/restore-overlay.js'
import { askDueAt, askedNow, canStop, FIRST_ASK_AFTER_MS, firstSight, readAskState, stoppedAsking } from './default-browser-ask.js'
import type { AskState } from './default-browser-ask.js'
import { canOfferDefault, makeDefaultBrowser, readDefaultBrowser } from './default-browser.js'
import type { DefaultBrowserHost } from './default-browser.js'
import { defaultBrowserHost } from './default-browser-runner.js'
import { exposeAskNow } from './default-browser-test-seam.js'

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 60 * 60 * 1000
/** An ask due with no window to ask in looks again this soon, so it comes when the person is back, not an hour later. */
export const RETRY_MS = 10_000
const MAKE_DEFAULT = 0
const NOT_NOW = 1
const DONT_ASK_AGAIN = 2

export interface AskPlace {
  readonly window: ShellWindow
  readonly tabId: string
}

/** The window and tab to ask in, or undefined to wait: one the person is looking at and using, with no welcome screen over it and no restore bar in it. */
export function askPlace (windows: Pick<WindowRegistry, 'focused'>, introShowing: (window: ShellWindow['window']) => boolean = introCovers): AskPlace | undefined {
  const shown = windows.focused()
  if (shown === undefined || shown.window.isDestroyed() || !shown.window.isVisible() || shown.window.isMinimized()) return undefined
  const tabId = shown.tabs.getState().activeTabId
  if (tabId === null || tabId === undefined) return undefined
  // A window shown without being activated still has the focus in the page the person clicked in.
  const inUse = shown.window.isFocused() || shown.tabs.activeWebContents()?.isFocused() === true || shown.chrome.webContents.isFocused()
  if (!inUse || introShowing(shown.window) || shown.overlays.isOpen(RESTORE_OVERLAY)) return undefined
  return { window: shown, tabId }
}

function questionFor (stoppable: boolean): QuestionSpec {
  return {
    kind: 'notice',
    title: 'Make Orivon your default browser?',
    message: 'Links you click in other programs will open in Orivon.',
    buttons: stoppable ? ['Make default', 'Not now', 'Don\'t ask again'] : ['Make default', 'Not now'],
    cancelId: NOT_NOW,
    guarded: [MAKE_DEFAULT],
    // The question appears while the person may be typing: a key meant for the page must land on no button.
    focus: 'dialog'
  }
}

export interface AskDeps {
  readonly now: () => number
  readonly read: () => string | undefined
  readonly write: (text: string) => void
  readonly host: DefaultBrowserHost
  readonly place: () => AskPlace | undefined
  readonly ask: (place: AskPlace, spec: QuestionSpec) => Promise<QuestionResult>
  readonly wait: (ms: number) => Promise<void>
}

/** One look at the clock: asks if an ask is due and there is a place for it, and records what the person answered. Resolves to how long until the next look. */
export function createDefaultBrowserCheck (deps: AskDeps): () => Promise<number> {
  let inFlight = false
  const save = (state: AskState): void => {
    try {
      deps.write(JSON.stringify(state))
    } catch (error) {
      console.error('[os] could not remember the default-browser ask:', error)
    }
  }
  return async () => {
    if (inFlight) return CHECK_EVERY_MS
    inFlight = true
    try {
      const now = deps.now()
      const { state, repaired } = readAskState(deps.read(), now)
      if (state === undefined) {
        // The clock starts in a window the person is using: time spent on the welcome screen and its popup is not use.
        if (deps.place() === undefined) return RETRY_MS
        save(firstSight(now))
        return FIRST_ASK_AFTER_MS
      }
      if (repaired) save(state)
      const dueAt = askDueAt(state)
      if (dueAt === undefined) return CHECK_EVERY_MS
      if (now < dueAt) return Math.min(CHECK_EVERY_MS, dueAt - now)
      const place = deps.place()
      if (place === undefined) return RETRY_MS
      const answer = await readDefaultBrowser(deps.host)
      if (answer.state === 'unavailable') return CHECK_EVERY_MS
      if (answer.state === 'default') {
        save(askedNow(state, deps.now()))
        return CHECK_EVERY_MS
      }
      const stoppable = canStop(state, deps.now())
      const { response } = await deps.ask(place, questionFor(stoppable))
      if (response === DONT_ASK_AGAIN && stoppable) save(stoppedAsking(state))
      else save(askedNow(state, deps.now()))
      if (response === MAKE_DEFAULT) await makeDefaultBrowser(deps.host, deps.wait)
    } catch (error) {
      console.error('[os] the default-browser check failed:', error)
    } finally {
      inFlight = false
    }
    return CHECK_EVERY_MS
  }
}

export const installDefaultBrowserAsk: ShellInstaller = {
  name: 'default-browser-ask',
  install: (_app, services, _ctx, runtime) => {
    if (runtime.profileId !== 'default' || runtime.isPrivate || services.kiosk || !canOfferDefault(defaultBrowserHost)) return
    const file = join(runtime.dir, 'default-browser-ask.json')
    const check = createDefaultBrowserCheck({
      now: Date.now,
      read: () => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
      write: (text) => { writeFileAtomic(file, text) },
      host: defaultBrowserHost,
      place: () => askPlace(services.windows),
      ask: async (place, spec) => await askQuestion({ window: place.window, tabId: place.tabId }, spec),
      wait: async (ms) => { await new Promise<void>((resolve) => { setTimeout(resolve, ms) }) }
    })
    exposeAskNow(check)
    const look = (): void => { void check().then((next) => { setTimeout(look, next).unref() }) }
    setTimeout(look, FIRST_CHECK_MS).unref()
  }
}
