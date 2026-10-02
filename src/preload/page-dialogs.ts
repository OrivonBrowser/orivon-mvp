// A page's `alert`, `confirm` and `prompt`, asked in the browser's own panel
// instead of Electron's native box. Runs in every frame of a tab, which is why
// it is the only thing a subframe's preload does (./frame.ts). The page's call
// stays synchronous: the wrapper blocks on a send main answers once the
// person has, and a Proxy over the native function keeps `toString`, `name`
// and the property's descriptor as the page expects them.
import { contextBridge, ipcRenderer } from 'electron'
import { PAGE_DIALOG_CHANNEL } from '../main/channels.js'
import { sandboxedWithoutModals } from './dialog-gates.js'

type DialogType = 'alert' | 'confirm' | 'prompt'

/** Asks main and returns what the page's own function returns: nothing, a boolean, a string or null. A reply that is not the expected shape is a refusal. */
function ask (type: DialogType, message: string, defaultText: string): unknown {
  let reply: unknown
  try {
    // Chromium's own refusal (./dialog-gates.ts) comes first: a dialog it would have ignored is never asked.
    reply = sandboxedWithoutModals() ? undefined : ipcRenderer.sendSync(PAGE_DIALOG_CHANNEL, { type, message, defaultText })
  } catch {
    reply = undefined
  }
  if (type === 'confirm') return reply === true
  if (type === 'prompt') return typeof reply === 'string' ? reply : null
  return undefined
}

/** Runs in the page's main world through contextBridge.executeInMainWorld, so it closes over nothing from this module. */
function wrapDialogs (askMain: (type: string, message: string, defaultText: string) => unknown): void {
  const text = (value: unknown): string => {
    try { return String(value) } catch { return '' }
  }
  /** Chromium ignores a dialog raised while the page is being left; the event being handled says so (./dialog-gates.ts). */
  const leaving = (): boolean => {
    try {
      const type = (window as unknown as { event?: { type?: unknown } }).event?.type
      return type === 'beforeunload' || type === 'pagehide' || type === 'unload'
    } catch {
      return false
    }
  }
  const page = window as unknown as Record<string, unknown>
  for (const name of ['alert', 'confirm', 'prompt']) {
    const native = page[name]
    if (typeof native !== 'function') continue
    page[name] = new Proxy(native, {
      apply: (_target, _self, args: unknown[]) => leaving() ? (name === 'confirm' ? false : name === 'prompt' ? null : undefined) : askMain(name, args.length > 0 ? text(args[0]) : '', name === 'prompt' && args.length > 1 ? text(args[1]) : '')
    })
  }
}

/** Fail-open like the other main-world installers: `executeInMainWorld` is `@experimental`, and the tab's `disableDialogs` setting answers a page's dialog at once if the wrapper is missing. */
export function installPageDialogs (): void {
  try {
    contextBridge.executeInMainWorld({
      func: wrapDialogs,
      args: [(type: string, message: string, defaultText: string) => ask(type as DialogType, message, defaultText)]
    })
  } catch (error) {
    console.error('[orivon] page dialogs not wrapped', error)
  }
}
