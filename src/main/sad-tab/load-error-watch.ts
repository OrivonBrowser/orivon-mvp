// Watches one tab's web contents for a page that failed to load, and puts the sheet over the tab. Chromium shows a
// failed load as an empty page under the address that failed, so without the sheet nothing says it failed. The sheet
// belongs to that failure only: the tab's next navigation takes it, or its place in the queue, away.
import type { WebContents } from 'electron'
import { isCertError } from '../auth/cert-error-text.js'
import type { requestSlot } from '../overlays/tab-slots.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { isErrorName } from './load-error-text.js'

export const LOAD_ERROR_OVERLAY = 'load-error'

/** A navigation cancelled by a newer one, by the person, or because it became a download: the page did not fail. */
const ERR_ABORTED = -3

export interface LoadErrorDeps {
  readonly findTab: (contents: WebContents) => { window: ShellWindow, tabId: string } | null
  readonly ask: typeof requestSlot
  /** Another sheet explains this failure (HTTPS-only upgraded the address and the upgrade failed), so this one stays out. */
  readonly claimed?: (contentsId: number, url: string, code: number) => boolean
}

const watched = new WeakSet<WebContents>()

export function watchLoadErrors (contents: WebContents, deps: LoadErrorDeps): void {
  if (watched.has(contents)) return
  watched.add(contents)
  let pending: { cancel: () => void } | undefined
  const withdraw = (): void => {
    pending?.cancel()
    pending = undefined
  }
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) withdraw()
  })
  contents.on('did-fail-load', (_event, code, name, url, isMainFrame) => {
    // A failure that committed no error page (the page before it is still showing) reads another address.
    if (!isMainFrame || code === ERR_ABORTED || isCertError(code) || contents.getURL() !== url) return
    const found = deps.findTab(contents)
    if (found === null || deps.claimed?.(contents.id, url, code) === true) return
    withdraw()
    pending = deps.ask({
      window: found.window,
      tabId: found.tabId,
      slot: 'center',
      overlay: LOAD_ERROR_OVERLAY,
      payload: { code, name: isErrorName(name) ? name : '' },
      closed: () => { pending = undefined }
    })
  })
}
