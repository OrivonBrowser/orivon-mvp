// A tab's navigation is held while a question about its page is open: the
// page that asked must not be able to leave, or turn into another page,
// before the person has answered. Tied to Electron through the events of
// the `WebContents` it guards.
import type { WebContents } from 'electron'

const holds = new WeakMap<object, number>()

/** Holds the tab's page where it is until the returned release is called, which is safe to call twice. Holds nest. A contents that is not a tab's is held by no one. */
export function holdNavigation (contents: object | undefined): () => void {
  if (contents === undefined) return () => {}
  holds.set(contents, (holds.get(contents) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (holds.get(contents) ?? 1) - 1
    if (left <= 0) holds.delete(contents)
    else holds.set(contents, left)
  }
}

export function isNavigationHeld (contents: object): boolean {
  return holds.has(contents)
}

type Refusable = { preventDefault: () => void, url: string, isMainFrame?: boolean }

/** Drops what the page itself starts while held: a new address, a redirect, a script. A change of the address inside the same document fires none of these, so a single-page app keeps routing. */
export function refuseHeldNavigation (wc: WebContents): void {
  const refuse = (event: Refusable): void => {
    if (!isNavigationHeld(wc)) return
    console.log('[orivon] dropped a navigation while a question about the page is open:', event.url)
    event.preventDefault()
  }
  wc.on('will-navigate', refuse)
  wc.on('will-redirect', (event) => { if (event.isMainFrame) refuse(event) })
  wc.on('will-frame-navigate', (event) => { if (event.isMainFrame) refuse(event) })
}
