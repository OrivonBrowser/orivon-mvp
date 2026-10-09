// The pages of an app that turned out to be bad after they were let in (ADR-0075): every tab of the origin is stopped
// and emptied, so nothing of the app runs on while its grants are taken away and its storage is cleared, whatever its
// `beforeunload` handlers say; every other page of the app's partition (a popup, a context's host) is closed; then each
// tab is covered with the security warning and sent away when the person has read it. No Electron beyond the types:
// the tabs and their screens come in.
import type { WebContents } from 'electron'
import type { SetupSheet } from '../install/first-visit.js'
import type { TabRef, TabSetup } from './tab-screens.js'

export interface BlockTabsDeps {
  /** Every live tab, in any window, whose page is on the origin. */
  readonly tabsOn: (origin: string) => readonly WebContents[]
  /** Every web contents in the origin's own partition, tabs, popups and hosts alike. */
  readonly pagesOf: (origin: string) => readonly WebContents[]
  /** Read at the moment of use: the screens are published after the first visit is built. */
  readonly setup: () => TabSetup | undefined
}

/** What a block does to the pages: `emptied` once nothing of the app runs any more, `dismissed` once the person has read the warning. */
export interface Blocking {
  readonly emptied: Promise<void>
  readonly dismissed: Promise<void>
}

export function blockOpenTabs (deps: BlockTabsDeps): (origin: string, sheet: SetupSheet, entered: object | undefined) => Blocking {
  return (origin, sheet, entered) => {
    // The tab the visit let in shows no address of the origin when its first page failed to load, so it is named, not found; and it holds other contents than the visit began with.
    const ref = entered as TabRef | undefined
    const named = ref?.window.tabs.liveWebContents(ref.tabId)
    const tabs = new Set<WebContents>([...deps.tabsOn(origin), ...(named === undefined ? [] : [named])])
    const emptied: Array<Promise<void>> = []
    const dismissed: Array<Promise<void>> = []
    for (const contents of tabs) {
      if (contents.isDestroyed()) continue
      // A page that asks "leave this page?" must not keep itself alive: the veto is overruled.
      const overrule = (event: { preventDefault: () => void }): void => { event.preventDefault() }
      contents.on('will-prevent-unload', overrule)
      contents.stop()
      const current = contents.getURL()
      const screens = deps.setup()?.(contents, current.startsWith(origin) ? current : `${origin}/`)
      if (screens === undefined) {
        contents.off('will-prevent-unload', overrule)
        contents.close()
        continue
      }
      const gone = screens.blank()
      emptied.push(gone)
      dismissed.push((async () => {
        await gone
        await screens.sheet(sheet)
        screens.leavePage()
      })().finally(() => { if (!contents.isDestroyed()) contents.off('will-prevent-unload', overrule) }))
    }
    for (const page of deps.pagesOf(origin)) {
      if (tabs.has(page) || page.isDestroyed()) continue
      page.close()
    }
    return { emptied: Promise.all(emptied).then(() => {}), dismissed: Promise.all(dismissed).then(() => {}) }
  }
}
