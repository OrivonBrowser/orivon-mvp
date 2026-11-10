// The pages a website left open when its origin became an app that runs where websites run. A website page of the
// origin shares the app's storage and any worker it started, and nothing the shell checked ever ran in it, so when
// the shell starts to serve the origin every such page is loaded again: the shell answers it now, and a page that
// is the app's takes the app tab's place (`../shell/tab-view.ts`).
import type { WebContents } from 'electron'

const entering = new WeakSet<object>()

/** `page` is being sent into the app by the visit that serves it: a load of its own follows, so the pages that load again leave it out. Returns the end of that. */
export function enteringPage (page: object): () => void {
  entering.add(page)
  return () => { entering.delete(page) }
}

/** Whether `page` is being sent into the app (`enteringPage`). */
export function isEnteringPage (page: object): boolean {
  return entering.has(page)
}

export interface StalePagesDeps<Page> {
  /** The origins that run where websites run and are served now, whole each time. */
  readonly served: () => readonly string[]
  /** Every page that shows `origin`, in any session. */
  readonly pagesOf: (origin: string) => readonly Page[]
  /** Whether the page is the app's own, built as its tab: the shell's check answered it, and a reload would only repeat that. */
  readonly isAppPage: (page: Page) => boolean
  readonly reload: (page: Page) => void
  /** Calls `listener` when what the shell serves changes; returns the way to stop. */
  readonly onServingChange: (listener: () => void) => () => void
}

/** Reloads the website pages of each origin the shell starts to serve; an origin served already when this is called is not one. Returns the way to stop. */
export function reloadStalePagesOfNewlyServed<Page> (deps: StalePagesDeps<Page>): () => void {
  let known = new Set(deps.served())
  return deps.onServingChange(() => {
    const now = new Set(deps.served())
    const started = [...now].filter((origin) => !known.has(origin))
    known = now
    for (const origin of started) {
      for (const page of deps.pagesOf(origin)) {
        if (deps.isAppPage(page)) continue
        try {
          deps.reload(page)
        } catch (error) {
          // A page that went away between the list and the reload has nothing left to reload.
          console.warn(`[sessions] a page of ${origin} could not be reloaded as the app:`, error)
        }
      }
    }
  })
}

/** Loads `page` again past the HTTP cache. A page that asks "leave this page?" is overruled until the load ends: it must not keep itself as it was. */
export function reloadStalePage (page: WebContents): void {
  if (page.isDestroyed()) return
  const overrule = (event: { preventDefault: () => void }): void => { event.preventDefault() }
  page.on('will-prevent-unload', overrule)
  page.once('did-stop-loading', () => { if (!page.isDestroyed()) page.off('will-prevent-unload', overrule) })
  page.reloadIgnoringCache()
}
