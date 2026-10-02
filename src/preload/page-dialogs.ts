// A page's `prompt`, asked in the browser's own panel instead of failing.
// Electron's renderer throws for `prompt`, and the event it raises for
// `alert` and `confirm` is never raised for it, so this is the one dialog
// that has to be caught in the page (the other two reach main through
// Electron's own dialog event: src/main/shell/page-dialogs.ts). The page's
// call stays synchronous: the wrapper blocks on a send main answers once the
// person has, and a Proxy over the page's function keeps `toString`, `name`
// and the property's descriptor as the page expects them. Runs where a tab's
// preload runs, which is the top frame.
import { contextBridge, ipcRenderer } from 'electron'
import { PAGE_DIALOG_CHANNEL } from '../main/channels.js'

/**
 * Chromium refuses a dialog to a document sandboxed without `allow-modals` before it tells the browser; a
 * wrapper in front of that check repeats the part it can see. A top-level http(s) document with an opaque
 * origin is one sandboxed without `allow-same-origin` (the sandbox flags themselves are not readable), and
 * it loses its prompt even where `allow-modals` was given: the cautious side.
 */
function sandboxed (): boolean {
  return window.origin === 'null' && /^https?:$/.test(location.protocol)
}

/** Asks main and returns what the page's own `prompt` returns: the typed text, or null. A reply that is not a string is a refusal. */
function ask (message: string, defaultText: string): string | null {
  let reply: unknown
  try {
    reply = sandboxed() ? null : ipcRenderer.sendSync(PAGE_DIALOG_CHANNEL, { type: 'prompt', message, defaultText })
  } catch {
    reply = null
  }
  return typeof reply === 'string' ? reply : null
}

/** Runs in the page's main world through contextBridge.executeInMainWorld, so it closes over nothing from this module. */
function wrapPrompt (askMain: (message: string, defaultText: string) => string | null): void {
  const text = (value: unknown): string => {
    try { return String(value) } catch { return '' }
  }
  // Chromium ignores a dialog raised while the page is being left, so that a page cannot put its own words in
  // front of someone who is leaving; the event being handled says so. No listener of ours is registered for it:
  // one would make every page one that has a handler, and every navigation of it wait for its renderer.
  // `window.event` is replaceable by the page (`window.event = 0`), so the browser's own getter is taken now,
  // before any page script has run, and read through instead.
  let descriptor: PropertyDescriptor | undefined
  for (let owner: object | null = window; owner !== null && descriptor === undefined; owner = Object.getPrototypeOf(owner) as object | null) {
    descriptor = Object.getOwnPropertyDescriptor(owner, 'event')
  }
  const getEvent = descriptor?.get
  const call = Reflect.apply
  const currentEvent = (): { type?: unknown } | undefined =>
    (getEvent === undefined ? (window as unknown as { event?: { type?: unknown } }).event : call(getEvent, window, []) as { type?: unknown } | undefined)
  const leaving = (): boolean => {
    try {
      const type = currentEvent()?.type
      // A page hidden by a navigation raises visibilitychange as part of being left.
      return type === 'beforeunload' || type === 'pagehide' || type === 'unload' || (type === 'visibilitychange' && document.visibilityState === 'hidden')
    } catch {
      return false
    }
  }
  const page = window as unknown as Record<string, unknown>
  const native = page.prompt
  if (typeof native !== 'function') return
  page.prompt = new Proxy(native, {
    apply: (_target, _self, args: unknown[]) => leaving() ? null : askMain(args.length > 0 ? text(args[0]) : '', args.length > 1 ? text(args[1]) : '')
  })
}

/** Fail-open like the other main-world installers: `executeInMainWorld` is `@experimental`, and without the wrapper the page's `prompt` throws as Electron's does. */
export function installPageDialogs (): void {
  try {
    contextBridge.executeInMainWorld({
      func: wrapPrompt,
      args: [(message: string, defaultText: string) => ask(message, defaultText)]
    })
  } catch (error) {
    console.error('[orivon] page prompt not wrapped', error)
  }
}
