// The one place a tab's form watcher is heard. A message counts only from the top frame of a tab this
// shell shows, at an http(s) address, and its origin is read from that frame here, never from the message.
// What a feature does with a message is its own `formWatch.on(type, handler)`; what reaches the page goes
// through `fillFrame`, which checks the page is still where the choice was made.
import type { IpcMainEvent, WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { FORM_FILL_CHANNEL, FORM_WATCH_CHANNEL } from '../channels.js'
import type { ShellWindow, WindowRegistry } from '../shell/window-registry.js'
import { createRateLimiter, parseFormMessage } from './form-message.js'
import type { FormCommand, FormMessage, FormMessageType } from './form-message.js'

/** Messages a tab may send per second; a page that floods its own watcher gets the rest dropped. A sign-in and the page after it send about ten: a hello, the fields, a focus per box and the submit, twice over. */
export const MESSAGES_PER_SECOND = 20

/** Who sent a message: a tab of a window of this shell, and the origin its top frame has right now. */
export interface FormSender {
  readonly window: ShellWindow
  readonly tabId: string
  readonly contents: WebContents
  readonly origin: string
}

export type FormHandler<T extends FormMessageType = FormMessageType> = (message: Extract<FormMessage, { type: T }>, sender: FormSender) => void

export interface FormWatch {
  /** Runs `handler` for each message of `type`; returns the removal. A handler that throws is logged and the others still run. */
  on: <T extends FormMessageType>(type: T, handler: FormHandler<T>) => () => void
  dispatch: (message: FormMessage, sender: FormSender) => void
}

export function createFormWatch (): FormWatch {
  const handlers = new Map<FormMessageType, Set<FormHandler>>()
  return {
    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set()
      handlers.set(type, set)
      // The type key above is what keeps a handler on its own messages.
      const any = handler as unknown as FormHandler
      set.add(any)
      return () => { set.delete(any) }
    },
    dispatch: (message, sender) => {
      for (const handler of [...handlers.get(message.type) ?? []]) {
        try {
          handler(message, sender)
        } catch (error) {
          console.error(`[forms] a ${message.type} handler failed:`, error)
        }
      }
    }
  }
}

/** The dispatcher the password features and later form features subscribe to. */
export const formWatch: FormWatch = createFormWatch()

export interface FormIpc {
  on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => unknown
  removeListener: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => unknown
}

/** Listens on FORM_WATCH_CHANNEL; returns the removal. */
export function installFormWatchIpc (
  ipc: FormIpc, windows: Pick<WindowRegistry, 'findTab'>, watch: FormWatch = formWatch,
  allow: (key: number) => boolean = createRateLimiter(MESSAGES_PER_SECOND, 1000)
): () => void {
  const listener = (event: IpcMainEvent, payload: unknown): void => {
    const frame = event.senderFrame
    // A subframe has no watcher; a message from one is not from this shell's preload.
    if (frame === null || frame !== event.sender.mainFrame) return
    const origin = originFromUrl(frame.url)
    if (origin === null) return
    const tab = windows.findTab(event.sender)
    if (tab === null) return
    const message = parseFormMessage(payload)
    if (message === null) return
    // A hello is sent once per document and turns the watcher on: a lost one leaves the page unwatched, so a flood of
    // focus messages must not be able to use up its place.
    if (message.type !== 'hello' && !allow(event.sender.id)) return
    watch.dispatch(message, { window: tab.window, tabId: tab.tabId, contents: event.sender, origin })
  }
  ipc.on(FORM_WATCH_CHANNEL, listener)
  return () => { ipc.removeListener(FORM_WATCH_CHANNEL, listener) }
}

/**
 * Sends `command` to the top frame of `contents`, only while that frame is still at `origin`. A page that
 * navigated between the choice and this call gets nothing. True when it was sent.
 */
export function fillFrame (contents: WebContents, origin: string, command: FormCommand): boolean {
  try {
    if (contents.isDestroyed()) return false
    const frame = contents.mainFrame
    if (originFromUrl(frame.url) !== origin) return false
    frame.send(FORM_FILL_CHANNEL, command)
    return true
  } catch {
    // A frame torn down mid-call has nobody to fill.
    return false
  }
}
