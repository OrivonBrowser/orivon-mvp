// Puts the history recorder on every page the process makes, tabs included
// however they came to exist, without wiring each one.
import type { App } from 'electron'
import type { InternalPageRegistry } from '../pages/internal-registry.js'
import type { WindowRegistry } from '../shell/window-registry.js'
import { attachHistory } from './attach-history.js'
import type { HistoryService } from './history-service.js'

export function installHistory (app: Pick<App, 'on'>, windows: WindowRegistry, internalPages: InternalPageRegistry, history: HistoryService): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return
    attachHistory(contents, history, {
      recordable: (candidate) => {
        if (internalPages.pageOf(candidate) !== undefined) return false
        const found = windows.findTab(candidate)
        // The new-tab page is a tab too, but a fresh tab's page is not somewhere the person went.
        return found !== null && found.window.tabs.getState().tabs.find((tab) => tab.id === found.tabId)?.isNewTab !== true
      }
    })
  })
}
