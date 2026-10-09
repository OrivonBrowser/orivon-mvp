// The tabs of an app that turned out to be bad after they were let in (ADR-0075): each is stopped and emptied, so
// nothing of the app runs on while its grants are taken away, covered with the security warning, and sent away
// when the person has read it. No Electron beyond the types: the tabs and their screens come in.
import type { WebContents } from 'electron'
import type { SetupSheet } from '../install/first-visit.js'
import type { TabSetup } from './tab-screens.js'

export interface BlockTabsDeps {
  /** Every live tab, in any window, whose page is on the origin. */
  readonly tabsOn: (origin: string) => readonly WebContents[]
  /** Read at the moment of use: the screens are published after the first visit is built. */
  readonly setup: () => TabSetup | undefined
}

export function blockOpenTabs (deps: BlockTabsDeps): (origin: string, sheet: SetupSheet) => Promise<void> {
  return async (origin, sheet) => {
    const shown: Array<Promise<void>> = []
    for (const contents of deps.tabsOn(origin)) {
      if (contents.isDestroyed()) continue
      contents.stop()
      const screens = deps.setup()?.(contents, contents.getURL())
      if (screens === undefined) continue
      shown.push((async () => {
        await screens.blank()
        await screens.sheet(sheet)
        screens.leavePage()
      })())
    }
    await Promise.all(shown)
  }
}
