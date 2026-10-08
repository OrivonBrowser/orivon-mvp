// A first visit that began from a page's own manifest hint (ADR-0074): the page is already running, up to its
// DOMContentLoaded, so the tab is stopped the moment a stage is shown, and the way into the app or out of the
// page is a navigation rather than the release of a held request. The path for an origin the verifier does not
// serve, and the fallback for one whose first page could not be held.
import type { TabScreens } from '../app-setup/tab-screens.js'
import type { SetupHost } from './first-visit.js'

/** The tab that reported the hint. */
export interface HintSender {
  stop: () => void
  reload: () => void
  getURL: () => string
}

export function hintHost (sender: HintSender, screens: TabScreens): SetupHost {
  let stopped = false
  return {
    show: (stage) => {
      if (!stopped) {
        stopped = true
        sender.stop()
      }
      screens.show(stage)
    },
    sheet: async (sheet) => await screens.sheet(sheet),
    // Through the address bar's own path: a reload would commit the network copy in the session the page ran in first.
    enter: () => {
      screens.end()
      screens.navigate(sender.getURL())
    },
    plain: () => {
      screens.end()
      if (stopped) sender.reload()
    },
    end: () => {
      const movedOn = screens.moved()
      screens.end()
      if (stopped && !movedOn) screens.leavePage()
    }
  }
}
