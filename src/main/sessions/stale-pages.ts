// The pages a website left open when its origin became an app that runs where websites run. A website page of the
// origin shares the app's storage and any worker it started, and nothing the shell checked ever ran in it, so once the
// shell serves the origin every such page is loaded again (`./worker-settle.ts` says in what order): the shell answers it
// now, and a page that is the app's takes the app tab's place (`../shell/tab-view.ts`).
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

export interface NewlyServedDeps {
  /** The origins that run where websites run and are served now, whole each time. */
  readonly served: () => readonly string[]
  /** Calls `listener` when what the shell serves changes; returns the way to stop. */
  readonly onServingChange: (listener: () => void) => () => void
}

/** Calls `run` for each origin the shell starts to serve; an origin served already when this is called is not one. Returns the way to stop. */
export function forNewlyServed (deps: NewlyServedDeps, run: (origin: string) => void): () => void {
  let known = new Set(deps.served())
  return deps.onServingChange(() => {
    const now = new Set(deps.served())
    const started = [...now].filter((origin) => !known.has(origin))
    known = now
    for (const origin of started) {
      try {
        run(origin)
      } catch (error) {
        console.warn(`[sessions] the pages of ${origin} could not be settled as it started to be served:`, error)
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
