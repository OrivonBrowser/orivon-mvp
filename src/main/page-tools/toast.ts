// The short messages the page tools show over the page, and the call that shows one. A message is
// a code here so a caller cannot invent wording, and a file name travels beside its text, never inside it.
import type { CommandId } from '../shortcuts/commands.js'
import type { ShellWindow } from '../shell/window-registry.js'

export type ToastTone = 'info' | 'ok' | 'error'

/** What the toast page draws. `name` is drawn after `text`, truncated on its own. `action` is the label of a link that runs `run`. */
export interface ToastView {
  readonly text: string
  readonly name?: string
  readonly tone: ToastTone
  /** Stays until replaced or closed: for work still going on. */
  readonly sticky: boolean
  readonly action?: string
}

interface ToastText {
  readonly text: string
  readonly tone: ToastTone
  readonly sticky?: true
  readonly action?: { readonly label: string, readonly run: CommandId }
}

export const TOAST_TEXT = {
  savingPdf: { text: 'Saving PDF…', tone: 'info', sticky: true },
  saved: { text: 'Saved', tone: 'ok' },
  pdfFailed: { text: 'Could not save the PDF', tone: 'error' },
  saveFailed: { text: 'Could not save this page', tone: 'error' },
  cannotSave: { text: 'This page cannot be saved', tone: 'error' },
  printFailed: { text: 'Could not print this page', tone: 'error' },
  noPrinter: { text: 'No printer found', tone: 'info', action: { label: 'Save as PDF', run: 'page.pdf' } },
  copied: { text: 'Screenshot copied', tone: 'ok' },
  copyFailed: { text: 'Could not copy the screenshot', tone: 'error' },
  shotFailed: { text: 'Could not take the screenshot', tone: 'error' },
  longPage: { text: 'Saved the first part of a very long page', tone: 'ok' },
  noVideo: { text: 'No video to pop out on this page', tone: 'info' },
  noSource: { text: 'The source of this page cannot be shown', tone: 'info' },
  sleepSound: { text: 'This tab is playing sound, so it stays awake.', tone: 'info' },
  sleepUnsaved: { text: 'This tab has unsaved changes, so it stays awake.', tone: 'info' },
  sleepPinned: { text: 'Pinned tabs stay awake.', tone: 'info' },
  sleepAsk: { text: 'This tab is waiting for your answer, so it stays awake.', tone: 'info' },
  sleepMedia: { text: 'This tab is using your camera, microphone or screen, so it stays awake.', tone: 'info' },
  sleepKept: { text: 'This site is set to stay awake.', tone: 'info' },
  sleepOther: { text: 'This tab cannot be put to sleep.', tone: 'info' },
  caretOn: { text: 'Caret browsing is on', tone: 'info' },
  caretOff: { text: 'Caret browsing is off', tone: 'info' },
  sidePanelNarrow: { text: 'Make the window wider to open the side panel', tone: 'info' },
  notReadable: { text: 'Reader view is not available for this page.', tone: 'info' },
  linkCopied: { text: 'Link copied', tone: 'ok' },
  linkCopyFailed: { text: 'Could not copy the link', tone: 'error' },
  noAddress: { text: 'This page has no address to share', tone: 'info' }
} as const satisfies Record<string, ToastText>

export type ToastCode = keyof typeof TOAST_TEXT

export const isToastCode = (value: unknown): value is ToastCode => typeof value === 'string' && Object.hasOwn(TOAST_TEXT, value)

/** How long a toast that is not sticky stays. */
export const TOAST_MS = 3000

/** How long a toast that offers something to do stays: long enough to reach it by keyboard or a slow pointer. */
export const TOAST_ACTION_MS = 8000

/** The label of the link a saved file's toast carries, which shows the file in its folder. */
export const REVEAL_LABEL = 'Show in folder'

/** The command a code's link runs, if it has one. */
export function toastAction (code: ToastCode): CommandId | undefined {
  const entry: ToastText = TOAST_TEXT[code]
  return entry.action?.run
}

export function toastView (code: ToastCode, name?: string, reveals = false): ToastView {
  const entry: ToastText = TOAST_TEXT[code]
  const action = entry.action?.label ?? (reveals ? REVEAL_LABEL : undefined)
  return {
    text: entry.text,
    tone: entry.tone,
    sticky: entry.sticky === true,
    ...(name === undefined ? {} : { name }),
    ...(action === undefined ? {} : { action })
  }
}

/** Shows `code` over the page, replacing whatever toast is up. `revealPath` is the file a saved toast offers to show
 * in its folder. Never throws: a message is not worth failing the work it reports. */
export function showToast (window: ShellWindow, code: ToastCode, name?: string, revealPath?: string): void {
  try {
    window.overlays.show('toast', undefined, {
      code,
      ...(name === undefined ? {} : { name }),
      ...(revealPath === undefined ? {} : { revealPath })
    })
  } catch (error) {
    console.error('[page-tools] could not show a toast', error)
  }
}
