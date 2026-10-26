// What a page's `navigator.permissions.query` reads for a permission it would still be asked about. Electron answers
// the query from the session's permission check, which can only say granted or denied, so a camera nobody decided
// reads `denied`, and a page that checks before it asks (a wallet extension's webcam check is one) reports "no permission"
// without ever asking. The page's `Permissions.prototype.query` is wrapped in its own world: when the engine's
// answer is `denied` the wrapper asks main (src/main/sessions/permission-query-ipc.ts), and when main says the
// person would be asked it returns the engine's own PermissionStatus with `state` reading `prompt`. Only that
// change is possible: a `granted` is never made out of a `denied`, and any failure leaves the engine's answer. A page
// that tampers with the wrapper only fools itself. Runs in a website tab's top frame and an extension page's.
import { contextBridge, ipcRenderer } from 'electron'
import { PERMISSION_QUERY_CHANNEL } from '../main/channels.js'
import { inMainFrame } from './frame.js'

/** Asks main what a query for `name` reads, and returns its word for it; anything but a string is no answer. */
async function ask (name: string): Promise<string | null> {
  try {
    const reply: unknown = await ipcRenderer.invoke(PERMISSION_QUERY_CHANNEL, { name })
    return typeof reply === 'string' ? reply : null
  } catch {
    return null
  }
}

/**
 * Runs in the page's main world through contextBridge.executeInMainWorld, so it closes over nothing from this module.
 * Every native it uses is taken now, before a page script has run, and none is looked up when a query runs: a page
 * whose compartments scuttle their globals (LavaMoat) still gets its answer.
 */
function wrapQuery (askMain: (name: string) => Promise<unknown>): void {
  // The interfaces exist for a secure context only: an error page and a blank page have none, and nothing to wrap.
  if (typeof Permissions === 'undefined' || typeof PermissionStatus === 'undefined') return
  const owner = Permissions.prototype
  const native = Object.getOwnPropertyDescriptor(owner, 'query')
  const nativeQuery: unknown = native?.value
  const readState = Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state')?.get
  if (native === undefined || typeof nativeQuery !== 'function' || typeof readState !== 'function') return
  const call = Reflect.apply
  const define = Object.defineProperty
  const nativeThen = Promise.prototype.then

  /** The status the page was handed, whose `state` reads `prompt` for as long as the engine's own reading is `denied`. */
  const soften = (status: object): object => {
    define(status, 'state', {
      configurable: true,
      enumerable: false,
      get: () => {
        const state: unknown = call(readState, status, [])
        return state === 'denied' ? 'prompt' : state
      }
    })
    return status
  }

  /** The name the page gave, or undefined when it gave none that reads as text (the engine answers such a call alone). */
  const nameOf = (descriptor: unknown): string | undefined => {
    try {
      const name: unknown = typeof descriptor === 'object' && descriptor !== null ? (descriptor as { name?: unknown }).name : undefined
      return typeof name === 'string' ? name : undefined
    } catch {
      return undefined
    }
  }

  const settle = (status: unknown, name: string | undefined): unknown => {
    try {
      if (name === undefined || typeof status !== 'object' || status === null || call(readState, status, []) !== 'denied') return status
      return call(nativeThen, askMain(name), [(state: unknown) => state === 'prompt' ? soften(status) : status, () => status])
    } catch {
      return status
    }
  }

  const wrapped = new Proxy(nativeQuery, {
    apply: (target, self: unknown, args: unknown[]) => {
      const name = nameOf(args[0])
      const result: unknown = call(target, self, args)
      try {
        return call(nativeThen, result as Promise<unknown>, [(status: unknown) => settle(status, name)])
      } catch {
        return result
      }
    }
  })
  define(owner, 'query', { value: wrapped, writable: native.writable, enumerable: native.enumerable, configurable: native.configurable })
}

/** Fail-open like the other main-world installers: `executeInMainWorld` is `@experimental`, and without the wrapper the page reads the engine's answer. */
export function installPermissionQuery (): void {
  try {
    contextBridge.executeInMainWorld({
      func: wrapQuery,
      args: [(name: string) => ask(name)]
    })
  } catch (error) {
    console.error('[orivon] permission query not wrapped', error)
  }
}

/** An extension's own page, in its top frame: the tab preload exposes nothing on such a page, so its wrapper comes from the extension preload. */
export function installPermissionQueryInExtensionPage (): void {
  if (typeof location === 'undefined' || location.protocol !== 'chrome-extension:' || !inMainFrame()) return
  installPermissionQuery()
}
