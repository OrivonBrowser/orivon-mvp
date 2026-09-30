// Watches one tab's web contents for a page that failed on its certificate, and puts the sheet over the tab. The
// sheet belongs to that failure only: a new navigation of the tab takes it, or its place in the queue, away.
import type { WebContents } from 'electron'
import type { requestSlot } from '../overlays/tab-slots.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { CERT_ERROR_OVERLAY } from './auth-names.js'
import { isCertError } from './cert-error-text.js'

export interface CertErrorDeps {
  readonly findTab: (contents: WebContents) => { window: ShellWindow, tabId: string } | null
  readonly ask: typeof requestSlot
}

const watched = new WeakSet<WebContents>()

/** A host to name: the failing address's host, read here, or nothing when the address is not one. */
export function hostOfFailure (url: string): string | undefined {
  try {
    const { protocol, host } = new URL(url)
    return protocol === 'https:' && host !== '' ? host : undefined
  } catch {
    return undefined
  }
}

export function watchCertErrors (contents: WebContents, deps: CertErrorDeps): void {
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
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    const host = isMainFrame && isCertError(code) ? hostOfFailure(url) : undefined
    const found = host === undefined ? null : deps.findTab(contents)
    if (host === undefined || found === null) return
    withdraw()
    pending = deps.ask({
      window: found.window,
      tabId: found.tabId,
      slot: 'center',
      overlay: CERT_ERROR_OVERLAY,
      payload: { host, code },
      closed: () => { pending = undefined }
    })
  })
}
