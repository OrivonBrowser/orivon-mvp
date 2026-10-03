// The one way the browser asks the person a question: `askQuestion(target,
// spec)` resolves with the button they pressed, in the shape of Electron's
// message box so a call site swaps one call for the other. The question is
// drawn in the tab's own window, under the address pill, and belongs to that
// tab: a question for a background tab waits for its tab, a tab switch hides
// it, and a closed tab, an abort or a new page answers it as a cancel.
// This is the one file outside the file pickers that may open a native box,
// and only when no shell window exists to draw in, and never for a page's own
// dialog: that is answered as a cancel.
import { dialog, type MessageBoxOptions } from 'electron'
import { crossingAnchor, promptAnchor } from '../actions/prompt-anchor.js'
import { requestSlot } from '../../overlays/tab-slots.js'
import type { ShellWindow, WindowRegistry } from '../window-registry.js'
import { QUESTION_OVERLAY, QUESTION_SHEET_OVERLAY, holdQuestion, releaseQuestion } from './question-overlay.js'
import { isPageKind, needsToolbar, normaliseSpec, type QuestionResult, type QuestionSpec } from './question-spec.js'

/** Where a question goes. A tab's contents resolves to its tab; a tab's own window and id say so directly; neither means the tab in front in the window the person is using. */
export interface QuestionTarget {
  readonly contents?: object | undefined
  readonly window?: ShellWindow | undefined
  readonly tabId?: string | undefined
}

export interface AskOptions {
  /** Aborting answers the question as a cancel, shown or not. */
  readonly signal?: AbortSignal | undefined
  /** A new page in the tab ends the question: it was about the page that asked. */
  readonly endOnNavigation?: boolean | undefined
}

export type AskQuestion = (target: QuestionTarget, spec: QuestionSpec, options?: AskOptions) => Promise<QuestionResult>

/** How long a consent question waits for the toolbar to be in view before it gives up as a cancel. */
const TOOLBAR_WAIT_MS = 5000
const TOOLBAR_POLL_MS = 50

export interface AskQuestionDeps {
  windows: Pick<WindowRegistry, 'findTab' | 'focused'>
  /** A kiosk has no toolbar for a question to hang from: it is drawn in the centre instead. */
  kiosk: boolean
  /** Answers when no shell window exists. */
  native?: (spec: QuestionSpec) => Promise<QuestionResult>
}

/** A message box for a question asked before any window exists. */
async function nativeBox (spec: QuestionSpec): Promise<QuestionResult> {
  // A box has no way to say whose dialog it is and no text box for a prompt, so a page is never answered through one.
  if (isPageKind(spec.kind)) return { response: spec.cancelId, checkboxChecked: false }
  const options: MessageBoxOptions = {
    type: spec.warning === true ? 'warning' : 'question',
    buttons: [...spec.buttons],
    defaultId: spec.cancelId,
    cancelId: spec.cancelId,
    noLink: true,
    message: spec.message,
    ...(spec.title === undefined ? {} : { title: spec.title }),
    ...(spec.detail === undefined ? {} : { detail: spec.detail }),
    ...(spec.checkboxLabel === undefined ? {} : { checkboxLabel: spec.checkboxLabel })
  }
  const { response, checkboxChecked } = await dialog.showMessageBox(options)
  return { response, checkboxChecked }
}

const isDestroyed = (contents: object): boolean => typeof (contents as { isDestroyed?: unknown }).isDestroyed === 'function' && (contents as { isDestroyed: () => boolean }).isDestroyed()

type EndEvent = 'did-navigate' | 'destroyed'
type NavigableContents = { once: (event: EndEvent, listener: () => void) => unknown, removeListener: (event: EndEvent, listener: () => void) => unknown }

export function createAskQuestion (deps: AskQuestionDeps): AskQuestion {
  const nativeAnswer = deps.native ?? nativeBox
  const native = async (spec: QuestionSpec): Promise<QuestionResult> =>
    isPageKind(spec.kind) ? { response: spec.cancelId, checkboxChecked: false } : await nativeAnswer(spec)

  function resolveTab (target: QuestionTarget): { window: ShellWindow, tabId: string } | undefined | 'gone' {
    if (target.window !== undefined && target.tabId !== undefined) return { window: target.window, tabId: target.tabId }
    if (target.contents !== undefined) {
      if (isDestroyed(target.contents)) return 'gone'
      const found = deps.windows.findTab(target.contents as never)
      if (found !== null) return found
    }
    const focused = deps.windows.focused()
    const tabId = focused?.tabs.getState().activeTabId
    return focused === undefined || tabId === null || tabId === undefined ? undefined : { window: focused, tabId }
  }

  /** The tab's window was closed, or the tab was: nothing is left to draw the question in, and a tab slot would hold it for a tab that never comes back. */
  function placeGone (place: { window: ShellWindow, tabId: string }): boolean {
    if (place.window.window.isDestroyed()) return true
    return !place.window.tabs.getState().tabs.some((tab) => tab.id === place.tabId)
  }

  /** The chrome has reported where the address pill is and shows it; a page holding the whole screen is asked to let go first. Resolves false at the timeout, or when the question was ended meanwhile. */
  async function toolbarInView (window: ShellWindow, tabId: string, ended: () => boolean): Promise<boolean> {
    const inView = (): boolean => promptAnchor(window) !== undefined && window.chrome.getVisible()
    if (inView()) return true
    if (!window.chrome.getVisible()) window.tabs.exitHtmlFullscreen(tabId)
    for (let waited = 0; waited < TOOLBAR_WAIT_MS; waited += TOOLBAR_POLL_MS) {
      await new Promise<void>((resolve) => { setTimeout(resolve, TOOLBAR_POLL_MS) })
      if (ended()) return false
      if (inView()) return true
    }
    return false
  }

  return async (target, rawSpec, options = {}) => {
    const spec = normaliseSpec(rawSpec)
    const cancel: QuestionResult = { response: spec.cancelId, checkboxChecked: false }
    const place = resolveTab(target)
    if (place === 'gone' || options.signal?.aborted === true) return cancel
    if (place === undefined) return await native(spec)

    return await new Promise<QuestionResult>((resolve) => {
      let settled = false
      let handle: { cancel: () => void } | undefined
      let id: string | undefined
      const contents = target.contents as NavigableContents | undefined
      const watching = options.endOnNavigation === true && contents !== undefined && typeof contents.once === 'function'
      function settle (result: QuestionResult): void {
        if (settled) return
        settled = true
        if (id !== undefined) releaseQuestion(id)
        options.signal?.removeEventListener('abort', onEnd)
        if (watching) {
          contents.removeListener('did-navigate', onEnd)
          contents.removeListener('destroyed', onEnd)
        }
        resolve(result)
      }
      function onEnd (): void {
        handle?.cancel()
        settle(cancel)
      }
      options.signal?.addEventListener('abort', onEnd, { once: true })
      // A new page ends it, and so does the contents going away: a typed address that needs another session replaces the view without a navigation.
      if (watching) {
        contents.once('did-navigate', onEnd)
        contents.once('destroyed', onEnd)
      }

      const kiosk = deps.kiosk
      const show = (): void => {
        if (settled) return
        if (placeGone(place)) { settle(cancel); return }
        id = holdQuestion(place.window, spec, settle)
        handle = requestSlot({
          window: place.window,
          tabId: place.tabId,
          slot: kiosk ? 'center' : 'address',
          overlay: kiosk ? QUESTION_SHEET_OVERLAY : QUESTION_OVERLAY,
          payload: { id },
          anchor: () => crossingAnchor(place.window),
          closed: () => { settle(cancel) }
        })
      }
      // A tab that is not in front waits in its slot until it is, and the toolbar is checked for it then: waiting for the
      // toolbar here would refuse its question while another tab holds the screen.
      const inFront = place.window.tabs.getState().activeTabId === place.tabId
      if (kiosk || !needsToolbar(spec) || !inFront) { show(); return }
      void toolbarInView(place.window, place.tabId, () => settled || placeGone(place)).then((ready) => {
        if (ready) show()
        else settle(cancel)
      })
    })
  }
}

let bound: AskQuestion | undefined

/** What every call site uses. Until the shell binds the real one it is the native box, which is only ever reached before a window exists. */
export const askQuestion: AskQuestion = async (target, spec, options) =>
  bound === undefined ? await nativeBox(normaliseSpec(spec)) : await bound(target, spec, options)

export function bindAskQuestion (ask: AskQuestion | undefined): void {
  bound = ask
}
