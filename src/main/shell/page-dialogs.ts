// A page's own `alert`, `confirm` and `prompt`, asked in the question panel of
// its tab. `alert` and `confirm` come from Electron's own dialog event, which
// Chromium raises per frame after its own checks (a document sandboxed without
// `allow-modals`, a call made while the page is being left) have passed; the
// handler Electron installed for it, which draws a native box, is replaced here.
// `prompt` never reaches that event, so the tab's preload sends it
// (src/preload/page-dialogs.ts). Either way the page's script stays blocked
// until the person answers, so an answer, a navigation and a refused or
// malformed call reply. A closed tab is answered as a cancel while its frame
// is alive. A dead renderer, Electron's own cancel event and a removed frame
// close the panel and send nothing to Electron's callback, which takes the
// browser process down when its frame is gone.
import type { IpcMainEvent, WebContents, WebFrameMain } from 'electron'
import { PAGE_DIALOG_CHANNEL } from '../channels.js'
import { formatOriginForDisplay } from '../consent/grant-prompt-origin.js'
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

/** Who is speaking: the frame's own origin, which main reads from the committed document and the page cannot set, written as the rest of the shell writes an origin. A frame inside the page says so, as Chromium's own dialog does. */
export function speaker (frameOrigin: string, topFrame: boolean): string | undefined {
  const known = frameOrigin !== '' && frameOrigin !== 'null'
  const shown = known ? formatOriginForDisplay(frameOrigin) : ''
  if (topFrame) return known ? shown : undefined
  return known ? `An embedded page on ${shown}` : 'An embedded page'
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

/** The internal events Electron raises for a page's dialogs; they are not in its typings. */
const RUN_DIALOG = '-run-dialog'
const CANCEL_DIALOGS = '-cancel-dialogs'

/** What Electron's `-run-dialog` carries (measured on Electron 44): the frame that asked, and the call. */
interface DialogInfo {
  readonly frame?: WebFrameMain | null
  readonly dialogType?: unknown
  readonly messageText?: unknown
  readonly defaultPromptText?: unknown
}

type DialogCallback = (success: boolean, input: string) => void

interface DialogEmitter {
  listeners: (event: string) => Array<(...args: unknown[]) => void>
  removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
}

let warned = false

/** Said once: the handler this replaces is one Electron owns, and a change in how it is wired means the native box is back. */
function warnOnce (found: number): void {
  if (warned) return
  warned = true
  console.error(`[orivon] page dialogs: expected exactly one internal ${RUN_DIALOG} listener, found ${String(found)}; Electron's own dialog handling stays`)
}

/** What the page's `-run-dialog` callback takes for each reply: whether the person accepted, and the typed text. */
function callbackArguments (type: PageDialogType, value: PageDialogReply): [boolean, string] {
  if (type === 'alert') return [true, '']
  if (type === 'confirm') return [value === true, '']
  return typeof value === 'string' ? [true, value] : [false, '']
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

  // A dialog whose frame or renderer is gone has nothing waiting on it: its panel is closed and no answer is
  // sent, because Electron's callback for a frame that no longer exists takes the browser process down (measured).
  // Only a dialog answered through that callback is abandoned; a prompt, answered over IPC, is replied the default.
  const abandoned = new WeakSet<AbortController>()
  const viaCallback = new WeakSet<AbortController>()
  const endAll = (): void => { for (const controller of [...open]) controller.abort() }
  const abandonAll = (): void => { for (const controller of [...open]) { if (viaCallback.has(controller)) abandoned.add(controller); controller.abort() } }
  // A cross-origin frame lives in a process of its own: its parent can remove it while its dialog is open, and
  // nothing else says so.
  let poll: ReturnType<typeof setInterval> | undefined
  const stopPolling = (): void => { if (poll !== undefined && frames.size === 0) { clearInterval(poll); poll = undefined } }
  const startPolling = (): void => {
    poll ??= setInterval(() => {
      for (const [controller, frame] of [...frames]) if (frameEnded(frame)) { abandoned.add(controller); controller.abort() }
    }, FRAME_POLL_MS)
  }
  // A page that is leaving, or gone, asks nothing more: Chromium cancels its open dialogs on a navigation the same way.
  contents.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) endAll() })
  contents.on('did-navigate', () => { document.count = 0; document.stopped = false })
  contents.on('render-process-gone', abandonAll)
  contents.on('destroyed', () => { abandonAll(); watched.delete(contents) })

  /** Asks one dialog and calls `reply` exactly once with what the page's own function returns. */
  const handle = (request: PageDialogRequest, frame: WebFrameMain | null | undefined, reply: (value: PageDialogReply) => void, throughCallback = false): void => {
    // Electron raised a dialog it could not name a frame for: the frame is most likely gone, so no callback.
    if (frame === null || frame === undefined) { if (!throughCallback) reply(defaultReply(request.type)); return }
    if (!shown() || document.stopped || contents.isDestroyed()) { reply(defaultReply(request.type)); return }

    const spec = pageDialogSpec(request, speaker(frame.origin, frame === contents.mainFrame), document.count >= FREE_DIALOGS)
    document.count += 1
    const controller = new AbortController()
    open.add(controller)
    if (throughCallback) viaCallback.add(controller)
    if (frame !== contents.mainFrame) { frames.set(controller, frame); startPolling() }
    const done = (answer: PageDialogReply): void => {
      open.delete(controller)
      frames.delete(controller)
      stopPolling()
      if (!abandoned.has(controller)) reply(answer)
    }
    ask({ contents: panelOf() }, spec, { signal: controller.signal }).then((result) => {
      if (result.checkboxChecked) document.stopped = true
      done(replyFor(request, spec, result))
    }, () => { done(defaultReply(request.type)) })
  }

  // `prompt`, from the tab's preload: only from the top frame, and only a prompt.
  contents.ipc.on(PAGE_DIALOG_CHANNEL, (event: IpcMainEvent, raw: unknown) => {
    let replied = false
    const reply = (value: PageDialogReply): void => {
      if (replied) return
      replied = true
      try { event.returnValue = value } catch { /* the page is gone: nobody waits */ }
    }
    const request = readRequest(raw)
    if (request === undefined || request.type !== 'prompt' || event.senderFrame !== contents.mainFrame) { reply(request === undefined ? undefined : defaultReply(request.type)); return }
    handle(request, event.senderFrame, reply)
  })

  // `alert` and `confirm`, from Electron: exactly the one handler Electron installed is replaced.
  const emitter = contents as unknown as DialogEmitter
  const internal = emitter.listeners(RUN_DIALOG)
  if (internal.length !== 1) { warnOnce(internal.length); return }
  emitter.removeListener(RUN_DIALOG, internal[0] as (...args: unknown[]) => void)
  emitter.on(RUN_DIALOG, (rawInfo: unknown, rawCallback: unknown) => {
    const info = (typeof rawInfo === 'object' && rawInfo !== null ? rawInfo : {}) as DialogInfo
    const callback: DialogCallback = typeof rawCallback === 'function' ? rawCallback as DialogCallback : () => {}
    const type = info.dialogType
    const request = typeof type === 'string' && TYPES.includes(type) && typeof info.messageText === 'string'
      ? readRequest({ type, message: info.messageText, defaultText: typeof info.defaultPromptText === 'string' ? info.defaultPromptText : '' })
      : undefined
    if (request === undefined) {
      if (!contents.isDestroyed() && info.frame != null && !frameEnded(info.frame)) { try { callback(false, '') } catch { /* the page is gone */ } }
      return
    }
    let called = false
    handle(request, info.frame, (value) => {
      if (called) return
      called = true
      // The poll notices a removed frame only every FRAME_POLL_MS: an answer given before that must not reach it.
      if (contents.isDestroyed() || (info.frame != null && frameEnded(info.frame))) return
      try { callback(...callbackArguments(request.type, value)) } catch { /* the page is gone: nobody waits */ }
    }, true)
  })
  emitter.on(CANCEL_DIALOGS, abandonAll)
}
