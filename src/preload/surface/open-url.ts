// `orivon.app.onOpenUrl` (d-0596): the links the person sent to this app, heard by the page's listeners. There is no
// push channel to a page, so a listener's existence starts a long poll of `app.nextOpenUrl`, the way ./web.ts
// waits for a context to close. The shell holds links routed before any page listens, so an app opened by a link
// hears it once it registers; a link that arrives while no listener is registered waits here for the next one.
// This runs in the isolated world, so a page script cannot reach the loop or the held links.

import { toOrivonError } from '../orivon-error.js'
import { call, TIMEOUT_MS } from './control-call.js'

type Listener = (url: string) => void

/** Longer than this and a page that never listens would hold links for ever. */
const MAX_HELD = 16
/** After a refusal for calling too often, the wait before the poll asks again. */
const RETRY_AFTER_LIMIT_MS = 1_000

const listeners = new Set<Listener>()
const held: string[] = []
let polling = false

function deliver (url: string): void {
  if (listeners.size === 0) {
    held.push(url)
    while (held.length > MAX_HELD) held.shift()
    return
  }
  for (const listener of [...listeners]) {
    try { listener(url) } catch (error) { console.error('[orivon] an onOpenUrl listener threw', error) }
  }
}

async function poll (): Promise<void> {
  polling = true
  try {
    while (listeners.size > 0) {
      let url: string | null
      try {
        url = await call<string | null>('app.nextOpenUrl', undefined, TIMEOUT_MS.openUrl)
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (code === 'timeout') continue
        if (code === 'limit') {
          await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_LIMIT_MS))
          continue
        }
        // 'denied' (no grant) or anything else final: this app is not being sent links, so stop asking.
        return
      }
      if (url !== null) deliver(url)
    }
  } finally {
    polling = false
  }
}

/** Registers `listener`; the returned function removes it. A link held for want of a listener goes to this one first. */
export function appOnOpenUrl (listener: Listener): () => void {
  if (typeof listener !== 'function') throw toOrivonError('invalid', { message: 'orivon.app.onOpenUrl needs a function' })
  listeners.add(listener)
  for (const url of held.splice(0)) deliver(url)
  if (!polling) void poll()
  return () => { listeners.delete(listener) }
}

/** `orivon.app.requestSchemeHandler`: asks the person; needs a click or key press in the page, like the file picker. */
export async function appRequestSchemeHandler (scheme: string): Promise<boolean> {
  if (navigator.userActivation?.isActive !== true) return false
  return await call<boolean>('app.requestSchemeHandler', { scheme }, TIMEOUT_MS.grant)
}

export async function appIsSchemeHandler (scheme: string): Promise<boolean> {
  return await call<boolean>('app.isSchemeHandler', { scheme }, TIMEOUT_MS.metadata)
}
