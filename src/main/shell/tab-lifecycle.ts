// The seam a tab or window's creation, activation, closing and view
// replacement reach code outside the tab collection through. Built for the
// extension host (src/main/extensions/extension-host.ts), which must mirror
// every tab Orivon shows into the electron-chrome-extensions library's own
// tab store, but any future subscriber may use it the same way -- one list
// of listeners, not a bespoke callback threaded through tabs.ts by hand.
//
// `window` on tabCreated/viewReplaced is `BaseWindow | undefined`, matching
// TabViewHost.window (tab-types.ts): undefined in a test with no TabShell.
// A listener that needs a real window (extension-host.ts's does -- the
// library's own addTab() requires one) checks it there, not here: every
// event fires unconditionally, so one place decides what "no window yet"
// means rather than every call site guessing.
import type { BaseWindow, WebContents } from 'electron'

export interface TabLifecycleListener {
  tabCreated?: (contents: WebContents, window: BaseWindow | undefined) => void
  tabActivated?: (contents: WebContents) => void
  tabClosed?: (contents: WebContents) => void
  /** A navigation swapped this tab's WebContentsView for a fresh one
   * (tab-view.ts's repartitionView) -- same tab, new WebContents; the old
   * one is retired right after. */
  viewReplaced?: (oldContents: WebContents, newContents: WebContents, window: BaseWindow | undefined) => void
}

export class TabLifecycle {
  private readonly listeners = new Set<TabLifecycleListener>()

  /** Returns the unsubscribe function. */
  subscribe (listener: TabLifecycleListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  tabCreated (contents: WebContents, window: BaseWindow | undefined): void {
    for (const listener of this.listeners) listener.tabCreated?.(contents, window)
  }

  tabActivated (contents: WebContents): void {
    for (const listener of this.listeners) listener.tabActivated?.(contents)
  }

  tabClosed (contents: WebContents): void {
    for (const listener of this.listeners) listener.tabClosed?.(contents)
  }

  viewReplaced (oldContents: WebContents, newContents: WebContents, window: BaseWindow | undefined): void {
    for (const listener of this.listeners) listener.viewReplaced?.(oldContents, newContents, window)
  }
}
