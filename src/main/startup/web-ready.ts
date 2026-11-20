// When a page of the web may first load: every session must be routed and every enabled extension loaded before a
// website's first request. Every path from an address to a web page calls `deferUntilWebReady` first; Orivon's own
// pages (the new tab, `orivon://`) never wait. DESIGN.md says why the gate is on tabs and not on requests.
import { exposeWebReady, webReadyDelayMs } from './web-ready-test-seam.js'

let opening = false
let open = false
let release: () => void = () => {}
const ready = new Promise<void>((resolve) => { release = resolve })
exposeWebReady(ready)

/** Whether web pages may load now. */
export function isWebContentReady (): boolean {
  return open
}

/** Settles once web pages may load, and at once when they already may. */
export function webContentReady (): Promise<void> {
  return ready
}

/** Lets web pages load, and runs what waited for it, in the order it asked. The start calls it once, when the route and the extensions are in place; a second call does nothing. */
export function openWebContent (): void {
  if (opening) return
  opening = true
  const letIn = (): void => { open = true; release() }
  const delay = webReadyDelayMs()
  if (delay === 0) letIn()
  else setTimeout(letIn, delay).unref()
}

/**
 * When web pages may not load yet, calls `later` once they may and answers true, and the caller stops: what it was
 * asked to open is not lost, only late. Otherwise does nothing and answers false, and the caller goes on. A caller that
 * needs the opened tab's id (a restored tab gets its pin, title and history by it) must wait here before it opens.
 */
export function deferUntilWebReady (later: () => void): boolean {
  if (open) return false
  ready.then(later).catch((error: unknown) => { console.error('[startup] a request that waited for web content failed:', error) })
  return true
}
