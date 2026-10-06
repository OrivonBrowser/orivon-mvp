// Brings back the pages of an extension that a remove-then-load left behind.
// A page opened while the extension was removed fails to load, and one opened
// before keeps a dead extension context; neither gets its `chrome` APIs back
// unless it is navigated again. A store install's welcome tab, opened by the
// first service worker, is the page a person actually sees in that state.
// The failure can be reported after the reload has finished, so a page whose
// load fails is watched for a short while after it, not only swept once.

/** The part of a WebContents this needs. */
export interface ReloadablePage {
  readonly isDestroyed: () => boolean
  readonly getURL: () => string
  readonly loadURL: (url: string) => Promise<void>
}

/** How long after a reload ends a failed load of the extension's own page is
 * still taken as a casualty of that reload. */
export const RELOAD_AFTER_GRACE_MS = 5000

/** Chromium's net::ERR_ABORTED: a navigation another navigation replaced. */
const ERR_ABORTED = -3

const EXTENSION_PAGE = /^chrome-extension:\/\/([a-p]{32})\//

/** Navigates `page` to `url` again; a failure is logged, never thrown: one
 * stuck page must not stop the others. */
function navigateAgain (extensionId: string, page: ReloadablePage, url: string): void {
  page.loadURL(url).catch((error: unknown) => {
    console.error(`[extensions] could not reload ${url} after ${extensionId} was reloaded:`, error)
  })
}

export interface ExtensionPageRecoveryDeps<P extends ReloadablePage> {
  readonly now: () => number
  readonly graceMs: number
  /** False for a page that is not worth navigating (one nobody sees) and for
   * one the extension did not put on its own URL itself: a web page's refused
   * attempt at that URL must not be delivered by a reload the browser starts. */
  readonly isEligible: (page: P, extensionId: string) => boolean
}

export interface ExtensionPageRecovery<P extends ReloadablePage> {
  /** The extension is about to be removed. */
  readonly begin: (extensionId: string) => void
  /** The extension has been loaded again, or the attempt is over. */
  readonly end: (extensionId: string) => void
  /** The extension is between `begin` and `end`: an unload now is the reload's own, not a removal. */
  readonly reloading: (extensionId: string) => boolean
  /** A main-frame load of `url` in `page` failed with `errorCode`. */
  readonly pageFailed: (page: P, url: string, errorCode: number) => void
  /** Pages that already hold a URL of the extension, once it is loaded again. */
  readonly sweep: (extensionId: string, pages: readonly P[]) => number
}

interface ReloadWindow<P extends ReloadablePage> {
  open: boolean
  until: number
  readonly pending: Map<P, string>
  readonly navigated: WeakSet<P & object>
}

/** Each page is navigated again at most once per reload: a page whose second
 * load fails too is left alone, so a genuinely broken page cannot loop. A
 * failure while the extension is still removed waits for `end`; one reported
 * after it is retried at once, for `graceMs`. */
export function createExtensionPageRecovery<P extends ReloadablePage> (deps: ExtensionPageRecoveryDeps<P>): ExtensionPageRecovery<P> {
  const windows = new Map<string, ReloadWindow<P>>()

  const retry = (extensionId: string, window: ReloadWindow<P>, page: P, url: string): void => {
    if (window.navigated.has(page) || page.isDestroyed() || !deps.isEligible(page, extensionId)) return
    window.navigated.add(page)
    navigateAgain(extensionId, page, url)
  }

  return {
    begin (extensionId) {
      windows.set(extensionId, { open: true, until: Infinity, pending: new Map(), navigated: new WeakSet() })
    },
    end (extensionId) {
      const window = windows.get(extensionId)
      if (window === undefined) return
      window.open = false
      window.until = deps.now() + deps.graceMs
      for (const [page, url] of window.pending) retry(extensionId, window, page, url)
      window.pending.clear()
    },
    reloading (extensionId) {
      return windows.get(extensionId)?.open === true
    },
    pageFailed (page, url, errorCode) {
      const extensionId = EXTENSION_PAGE.exec(url)?.[1]
      if (extensionId === undefined || errorCode === ERR_ABORTED) return
      const window = windows.get(extensionId)
      if (window === undefined) return
      if (window.open) {
        window.pending.set(page, url)
        return
      }
      if (deps.now() > window.until) {
        windows.delete(extensionId)
        return
      }
      retry(extensionId, window, page, url)
    },
    sweep (extensionId, pages) {
      const window = windows.get(extensionId)
      const prefix = `chrome-extension://${extensionId}/`
      let count = 0
      for (const page of pages) {
        if (page.isDestroyed() || !deps.isEligible(page, extensionId)) continue
        const url = page.getURL()
        if (!url.startsWith(prefix)) continue
        if (window?.navigated.has(page) === true) continue
        count += 1
        window?.navigated.add(page)
        navigateAgain(extensionId, page, url)
      }
      return count
    }
  }
}
