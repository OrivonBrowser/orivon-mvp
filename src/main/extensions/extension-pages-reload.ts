// Brings back the pages of an extension that a remove-then-load left behind.
// A page opened while the extension was removed fails to load, and one opened
// before keeps a dead extension context; neither gets its `chrome` APIs back
// unless it is navigated again. A store install's welcome tab, opened by the
// first service worker, is the page a person actually sees in that state.

/** The part of a WebContents this needs. */
export interface ReloadablePage {
  readonly isDestroyed: () => boolean
  readonly getURL: () => string
  readonly loadURL: (url: string) => Promise<void>
}

/** Navigates each live page of `extensionId` to its own URL again; returns
 * how many. A failed navigation is logged, never thrown: one stuck page must
 * not stop the others. */
export function reloadExtensionPages (extensionId: string, pages: readonly ReloadablePage[]): number {
  const prefix = `chrome-extension://${extensionId}/`
  let count = 0
  for (const page of pages) {
    if (page.isDestroyed()) continue
    const url = page.getURL()
    if (!url.startsWith(prefix)) continue
    count += 1
    page.loadURL(url).catch((error: unknown) => {
      console.error(`[extensions] could not reload ${url} after ${extensionId} was reloaded:`, error)
    })
  }
  return count
}
