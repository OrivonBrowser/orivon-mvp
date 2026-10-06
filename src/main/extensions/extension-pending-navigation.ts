// Whether a page has a main-frame navigation that started and has not yet committed or failed. An
// extension's popup opened over such a page must outlive the commit, which takes the keyboard from it
// (the library's popup.ts, UPSTREAM.md patch 68). Tied to Electron only through the events it listens to.
import type { WebContents } from 'electron'

/** The part of a WebContents this needs. */
export interface NavigationSource {
  readonly on: {
    (event: 'did-start-navigation', listener: (details: { readonly isMainFrame: boolean, readonly isSameDocument: boolean }) => void): unknown
    (event: 'did-navigate', listener: () => void): unknown
    (event: 'did-stop-loading', listener: () => void): unknown
    (event: 'destroyed', listener: () => void): unknown
    (event: 'did-fail-load', listener: (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void): unknown
  }
}

export interface PendingNavigations<P extends NavigationSource> {
  /** Starts following `page`; a page already followed is not followed twice. */
  readonly watch: (page: P) => void
  /** True from the moment `page`'s main frame starts a navigation to another document until that
   * navigation commits, fails, or the page stops loading. */
  readonly isPending: (page: P) => boolean
}

export function createPendingNavigations<P extends NavigationSource> (): PendingNavigations<P> {
  const pending = new WeakSet<P & object>()
  const watched = new WeakSet<P & object>()

  return {
    watch (page) {
      if (watched.has(page)) return
      watched.add(page)
      const settle = (): void => { pending.delete(page) }
      page.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) pending.add(page)
      })
      page.on('did-navigate', settle)
      page.on('did-stop-loading', settle)
      page.on('destroyed', settle)
      page.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) settle() })
    },
    isPending: (page) => pending.has(page)
  }
}

const navigations = createPendingNavigations<WebContents>()

/** Follows `contents` for `hasPendingNavigation`; call it for every page that can be in front of a window. */
export function watchNavigations (contents: WebContents): void {
  navigations.watch(contents)
}

export function hasPendingNavigation (contents: WebContents): boolean {
  return navigations.isPending(contents)
}
