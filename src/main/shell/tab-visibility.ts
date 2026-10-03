// Tells each tab's page whether the person can see it. A tab that is not in front is taken off its window
// (pane-host.ts), and Electron never tells a view taken off its window that it is hidden: left alone its
// page reads `document.visibilityState === 'visible'` forever and never slows down. The page's preload
// (src/preload/page-visibility.ts) turns this message into the page's own answer. No `electron` import,
// so the rules are tested with fakes.
import type { BaseWindow, WebContents } from 'electron'
import { TAB_VISIBILITY_CHANNEL } from '../channels.js'
import type { TabLifecycle, TabShown } from './tab-lifecycle.js'

/** Why a window's tabs are all out of sight, tracked from its events: the OS does not say. */
interface Cover {
  minimized: boolean
  hidden: boolean
}

const WINDOW_EVENTS = ['minimize', 'restore', 'show', 'hide'] as const

/** Starts reporting; the return stops it and detaches every listener it added. */
export function startTabVisibility (lifecycle: TabLifecycle): () => void {
  const shownBy = new WeakMap<WebContents, { window: BaseWindow | undefined, shown: boolean }>()
  const tabsOf = new WeakMap<BaseWindow, readonly WebContents[]>()
  const covers = new WeakMap<BaseWindow, Cover>()
  /** What each page was last told; a page nobody has told is visible. */
  const told = new WeakMap<WebContents, boolean>()
  const detach: Array<() => void> = []
  const watchedPages = new WeakSet<WebContents>()

  /** `force` repeats the answer to a document that has just loaded, which starts out visible whatever it was told before. */
  const report = (contents: WebContents, force: boolean): void => {
    const state = shownBy.get(contents)
    // A crashed page has no frame to hear it, and the send would only log; its reload commits a new document that is told.
    if (state === undefined || contents.isDestroyed() || contents.isCrashed()) return
    const cover = state.window === undefined ? undefined : covers.get(state.window)
    const hidden = !state.shown || cover?.minimized === true || cover?.hidden === true
    if (!force && (told.get(contents) ?? false) === hidden) return
    told.set(contents, hidden)
    try {
      contents.send(TAB_VISIBILITY_CHANNEL, hidden)
    } catch {
      // The page went away between the check and the send.
    }
  }

  const watchPage = (contents: WebContents): void => {
    if (watchedPages.has(contents)) return
    watchedPages.add(contents)
    const onCommit = (): void => { report(contents, true) }
    contents.on('did-navigate', onCommit)
    detach.push(() => { if (!contents.isDestroyed()) contents.off('did-navigate', onCommit) })
  }

  const watchWindow = (window: BaseWindow): void => {
    if (covers.has(window)) return
    const cover: Cover = { minimized: window.isMinimized(), hidden: false }
    covers.set(window, cover)
    const onChange = (event: (typeof WINDOW_EVENTS)[number]): void => {
      cover.minimized = event === 'minimize' ? true : event === 'restore' ? false : window.isMinimized()
      if (event === 'hide') cover.hidden = true
      if (event === 'show' || event === 'restore') cover.hidden = false
      for (const contents of tabsOf.get(window) ?? []) report(contents, false)
    }
    for (const event of WINDOW_EVENTS) {
      const listener = (): void => { onChange(event) }
      window.on(event as 'show', listener)
      detach.push(() => { if (!window.isDestroyed()) window.off(event as 'show', listener) })
    }
  }

  const unsubscribe = lifecycle.subscribe({
    // A tab opened in the background is never announced as shown or hidden (nothing on screen changes), yet
    // its page has to learn it is hidden when its first document commits. It starts out not in front; the
    // announcement that brings it forward follows at once for a tab that is to be.
    tabCreated: (contents, window) => {
      if (window !== undefined) watchWindow(window)
      if (!shownBy.has(contents)) shownBy.set(contents, { window, shown: false })
      watchPage(contents)
    },
    viewReplaced: (oldContents, newContents, window) => {
      shownBy.set(newContents, { window, shown: shownBy.get(oldContents)?.shown ?? false })
      watchPage(newContents)
    },
    shownChanged: (window: BaseWindow | undefined, tabs: readonly TabShown[]) => {
      if (window !== undefined) {
        watchWindow(window)
        tabsOf.set(window, tabs.map((tab) => tab.contents))
      }
      for (const { contents, shown } of tabs) {
        shownBy.set(contents, { window, shown })
        watchPage(contents)
        report(contents, false)
      }
    }
  })
  return () => {
    unsubscribe()
    for (const undo of detach.splice(0)) undo()
  }
}
