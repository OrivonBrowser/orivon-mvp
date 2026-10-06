import type { WebContents } from 'electron'
import type { TabClosingInfo } from '../shell/tab-lifecycle.js'

/** The lifecycle events that tell the driver which tab closed: the page ids it keeps, and the closing itself. */
interface SidePanelTabClosing {
  tabCreated: (contents: WebContents) => void
  viewReplaced: (oldContents: WebContents, newContents: WebContents) => void
  tabClosing: (info: TabClosingInfo) => void
}

/** A tab whose page was destroyed (it closed itself, crashed, was a popup) reaches `tabClosing` with no page left to ask
 * for an id, so the ids of live pages are kept from creation and a destroyed one is looked up among them. */
export function sidePanelTabClosing (driver: { tabClosed: (tabId: number) => void }): SidePanelTabClosing {
  const pages = new Map<number, WebContents>()
  return {
    tabCreated: (contents) => { pages.set(contents.id, contents) },
    viewReplaced: (oldContents, newContents) => {
      pages.delete(oldContents.id)
      pages.set(newContents.id, newContents)
    },
    tabClosing: ({ reason, record }) => {
      if (reason === 'moved') return
      const page = record.view.webContents as WebContents | undefined
      if (page !== undefined && !page.isDestroyed()) {
        pages.delete(page.id)
        driver.tabClosed(page.id)
        return
      }
      for (const [id, known] of [...pages]) {
        if (!known.isDestroyed()) continue
        pages.delete(id)
        driver.tabClosed(id)
      }
    }
  }
}
