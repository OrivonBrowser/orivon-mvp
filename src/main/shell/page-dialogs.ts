// A page's own `alert`, `confirm` and `prompt`, asked in the question panel of
// its tab. The tab's preloads wrap the three functions in every frame
// (src/preload/page-dialogs.ts) and block on a synchronous send; this is the
// other end. The page's script stays blocked until the person answers, so
// every path out of here replies: an answer, a navigation, a closed tab, a
// refused or malformed call. Electron's own native box is never reached: the
// tab's `disableDialogs` answers a frame the wrapper missed.
import type { IpcMainEvent, WebContents, WebFrameMain } from 'electron'
import { PAGE_DIALOG_CHANNEL } from '../channels.js'
import { askQuestion, type AskQuestion } from './question/ask-question.js'
import type { QuestionResult, QuestionSpec } from './question/question-spec.js'

export type PageDialogType = 'alert' | 'confirm' | 'prompt'

export interface PageDialogRequest {
  readonly type: PageDialogType
  readonly message: string
  readonly defaultText: string
}

/** What the page's own function returns when nobody answered it. */
export type PageDialogReply = undefined | boolean | string | null

/** Larger text than this is cut before it is cleaned, so a page cannot make main work on a megabyte. */
const MAX_RAW = 100_000

/** How many dialogs a document may show before the next one offers to stop them. */
const FREE_DIALOGS = 2

const TYPES: readonly string[] = ['alert', 'confirm', 'prompt']

/** `{ type, message, defaultText }` and nothing else, or undefined. */
export function readRequest (raw: unknown): PageDialogRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const { type, message, defaultText } = record
  if (Object.keys(record).length !== 3 || typeof type !== 'string' || !TYPES.includes(type)) return undefined
  if (typeof message !== 'string' || typeof defaultText !== 'string') return undefined
  return { type: type as PageDialogType, message: message.slice(0, MAX_RAW), defaultText: defaultText.slice(0, MAX_RAW) }
}

export function defaultReply (type: PageDialogType): PageDialogReply {
  return type === 'confirm' ? false : type === 'prompt' ? null : undefined
}

/** Who is speaking: the frame's own origin, which main reads from the committed document and the page cannot set. A frame inside the page says so, as Chromium's own dialog does. */
export function speaker (frameOrigin: string, topFrame: boolean): string | undefined {
  const known = frameOrigin !== '' && frameOrigin !== 'null'
  if (topFrame) return known ? frameOrigin : undefined
  return known ? `An embedded page on ${frameOrigin}` : 'An embedded page'
}

/** The question for one dialog. A text on a dialog the person has now seen twice offers to stop the rest. */
export function pageDialogSpec (request: PageDialogRequest, origin: string | undefined, offerStop: boolean): QuestionSpec {
  const answered = request.type !== 'alert'
  return {
    kind: `page-${request.type}`,
    message: request.message,
    ...(origin === undefined ? {} : { origin }),
    buttons: answered ? ['OK', 'Cancel'] : ['OK'],
    cancelId: answered ? 1 : 0,
    // The OK of a question is where a key meant for the page would land.
    ...(answered ? { guarded: [0] } : {}),
    focus: 0,
    ...(request.type === 'prompt' ? { input: { initial: request.defaultText } } : {}),
    ...(offerStop ? { checkboxLabel: 'Do not let this page show more dialogs' } : {})
  }
}

/** What the page's function returns for the person's answer. */
export function replyFor (request: PageDialogRequest, spec: QuestionSpec, result: QuestionResult): PageDialogReply {
  if (request.type === 'alert') return undefined
  if (result.response === spec.cancelId) return defaultReply(request.type)
  return request.type === 'confirm' ? true : result.text ?? request.defaultText
}

/** How often a dialog's frame is looked at while its panel is open: a frame its parent removes takes no more part in the page. */
const FRAME_POLL_MS = 250

const pending = new WeakMap<WebContents, Set<AbortController>>()
const watched = new Set<WebContents>()

/**
 * True while a page of this tab, or of another tab in the same renderer process (an opened popup shares its
 * opener's), is blocked on a dialog: a process that answers no input is waiting for the person, not hung.
 */
export function hasPendingPageDialog (contents: WebContents): boolean {
  if ((pending.get(contents)?.size ?? 0) > 0) return true
  let processId: number
  try { processId = contents.getOSProcessId() } catch { return false }
  for (const other of watched) {
    if (other === contents || (pending.get(other)?.size ?? 0) === 0) continue
    try { if (other.getOSProcessId() === processId) return true } catch { /* a tab torn down is not blocking anything */ }
  }
  return false
}

/** A frame that is gone (removed by its parent) or unreadable no longer has a script waiting on it. */
function frameEnded (frame: WebFrameMain): boolean {
  try { return frame.detached } catch { return true }
}

/**
 * Answers the page dialogs of one tab. `shown` is false for a view that is parked or being replaced: its page
 * is not the person's, so nothing is asked. A page an app shows inside itself has no panel of its own: its
 * question is asked in `panelOf`, the app's tab.
 */
export function watchPageDialogs (contents: WebContents, shown: () => boolean, ask: AskQuestion = askQuestion, panelOf: () => WebContents = () => contents): void {
  const open = new Set<AbortController>()
  const frames = new Map<AbortController, WebFrameMain>()
  pending.set(contents, open)
  watched.add(contents)
  const document = { count: 0, stopped: false }

  const endAll = (): void => { for (const controller of [...open]) controller.abort() }
  // A cross-origin frame lives in a process of its own: its parent can remove it while its dialog is open, and
  // nothing else says so.
  let poll: ReturnType<typeof setInterval> | undefined
  const stopPolling = (): void => { if (poll !== undefined && frames.size === 0) { clearInterval(poll); poll = undefined } }
  const startPolling = (): void => {
    poll ??= setInterval(() => {
      for (const [controller, frame] of [...frames]) if (frameEnded(frame)) controller.abort()
    }, FRAME_POLL_MS)
  }
  // A page that is leaving, or gone, asks nothing more: Chromium cancels its open dialogs on a navigation the same way.
  contents.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) endAll() })
  contents.on('did-navigate', () => { document.count = 0; document.stopped = false })
  contents.on('render-process-gone', endAll)
  contents.on('destroyed', () => { endAll(); watched.delete(contents) })

  contents.ipc.on(PAGE_DIALOG_CHANNEL, (event: IpcMainEvent, raw: unknown) => {
    let replied = false
    const reply = (value: PageDialogReply): void => {
      if (replied) return
      replied = true
      try { event.returnValue = value } catch { /* the page is gone: nobody waits */ }
    }
    const request = readRequest(raw)
    const frame = event.senderFrame
    if (request === undefined || frame === null || frame === undefined) { reply(undefined); return }
    if (!shown() || document.stopped || contents.isDestroyed()) { reply(defaultReply(request.type)); return }

    const spec = pageDialogSpec(request, speaker(frame.origin, frame === contents.mainFrame), document.count >= FREE_DIALOGS)
    document.count += 1
    const controller = new AbortController()
    open.add(controller)
    if (frame !== contents.mainFrame) { frames.set(controller, frame); startPolling() }
    const done = (answer: PageDialogReply): void => {
      open.delete(controller)
      frames.delete(controller)
      stopPolling()
      reply(answer)
    }
    ask({ contents: panelOf() }, spec, { signal: controller.signal }).then((result) => {
      if (result.checkboxChecked) document.stopped = true
      done(replyFor(request, spec, result))
    }, () => { done(defaultReply(request.type)) })
  })
}
