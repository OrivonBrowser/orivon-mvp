// A first visit's way into the tab it began in (ADR-0076): the page is already on screen as an ordinary website, so
// staying a website asks nothing of the tab, and an app is entered by loading the address again through the address
// bar's own path, which puts it in the app's own partition before anything loads. No Electron.
import type { SetupHost } from '../install/first-visit.js'
import type { TabScreens } from './tab-screens.js'

/** `address` is read when the app is entered: the page may have moved within its document since the visit began. */
export function tabHost (screens: TabScreens, address: () => string): SetupHost {
  return {
    sheet: async (sheet) => await screens.sheet(sheet),
    enter: () => { screens.navigate(address()) },
    plain: () => { screens.end() },
    end: () => { screens.end() },
    tab: () => screens.tab()
  }
}
