// Which pages the extension host itself put on an extension's own URL.
// A web page cannot reach chrome-extension: (the URL gate refuses it), but a
// refused attempt still leaves that URL in the tab; a browser-initiated
// reload of the tab would then deliver the page the gate refused.
// Navigating a page again after an extension reload is therefore limited to
// the pages recorded here (extension-pages-reload.ts).
import type { WebContents } from 'electron'

/** The part of a WebContents this needs. */
export interface TrackablePage {
  readonly on: (event: 'did-start-navigation', listener: (details: { readonly url: string, readonly isMainFrame: boolean, readonly isSameDocument: boolean }) => void) => unknown
}

const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})\//

export interface ExtensionOpenedPages<P extends TrackablePage> {
  /** The host has just sent `page` to `url`; ignored unless that is an extension page. */
  readonly mark: (page: P, url: string) => void
  /** True while `page` is on a page the host sent it to, of `extensionId`. */
  readonly isOpenedBy: (page: P, extensionId: string) => boolean
}

/** A page stops counting the moment its main frame starts a navigation to
 * anything but a page of the extension it was sent to, so a tab the extension
 * opened and a web page later steered at the extension's URL is not one. */
export function createExtensionOpenedPages<P extends TrackablePage> (): ExtensionOpenedPages<P> {
  const opened = new WeakMap<P & object, string>()
  const watched = new WeakSet<P & object>()

  return {
    mark (page, url) {
      const id = EXTENSION_URL.exec(url)?.[1]
      if (id === undefined) return
      opened.set(page, id)
      if (watched.has(page)) return
      watched.add(page)
      page.on('did-start-navigation', (details) => {
        if (!details.isMainFrame || details.isSameDocument) return
        if (EXTENSION_URL.exec(details.url)?.[1] !== opened.get(page)) opened.delete(page)
      })
    },
    isOpenedBy: (page, extensionId) => opened.get(page) === extensionId
  }
}

const hostOpened = createExtensionOpenedPages<WebContents>()

/** Records that the extension host sent `contents` to `url`. */
export function markExtensionOpened (contents: WebContents, url: string): void {
  hostOpened.mark(contents, url)
}

export function isExtensionOpened (contents: WebContents, extensionId: string): boolean {
  return hostOpened.isOpenedBy(contents, extensionId)
}

/** `tabs.openTrusted` for a caller that has checked `target`, remembering a tab it puts on an extension page. */
export function openExtensionTab (tabs: { readonly openTrusted: (target?: string) => [string, WebContents] | undefined }, target?: string): [string, WebContents] | undefined {
  const opened = tabs.openTrusted(target)
  if (opened !== undefined && target !== undefined) markExtensionOpened(opened[1], target)
  return opened
}
