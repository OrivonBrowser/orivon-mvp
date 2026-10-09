// A first visit that began from a page's own manifest hint (ADR-0074): the page is already running, up to its
// DOMContentLoaded. The first stage replaces it in place with an empty page, so the network copy stops running
// (a stopped load does not stop script), and the way into the app, or back to the site as a plain website, is a
// navigation to the address the hint came from. The path for an origin the verifier does not serve, and the
// fallback for one whose first page could not be held.
import type { TabScreens } from '../app-setup/tab-screens.js'
import type { SetupHost } from './first-visit.js'

/** The tab that reported the hint. */
export interface HintSender {
  getURL: () => string
}

export function hintHost (sender: HintSender, screens: TabScreens): SetupHost {
  // Read before the page is replaced: this is the address the tab goes back to.
  const url = sender.getURL()
  let blanked = false
  return {
    show: async (stage) => {
      if (!blanked) {
        blanked = true
        await screens.blank()
      }
      screens.show(stage)
    },
    sheet: async (sheet) => await screens.sheet(sheet),
    // Through the address bar's own path: the app's session is in place before any of its files loads.
    enter: () => { screens.navigate(url) },
    plain: () => { if (blanked) screens.navigate(url); else screens.end() },
    end: () => { if (blanked) screens.leavePage(); else screens.end() }
  }
}

/**
 * A hint from contents no window holds as a tab: nothing can be drawn over them, so a question is the only screen and
 * a failure is only logged. The page keeps running, as it would before a first visit; entering reloads it, and the
 * tab becomes the app on that reload. The order is the same: ask, download, check, then grant.
 */
export function headlessHost (sender: { reload: () => void, isDestroyed: () => boolean }): SetupHost {
  return {
    show: () => {},
    sheet: async () => 'leave',
    enter: () => { if (!sender.isDestroyed()) sender.reload() },
    plain: () => {},
    end: () => {}
  }
}
