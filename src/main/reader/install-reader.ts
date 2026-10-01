// Wires reader view at start: a change to one of its reading settings reaches an open reader page, and a
// closed reader tab lets go of its article.
import type { ShellInstaller } from '../shell/shell-installers.js'
import { readerArticles } from './reader-store.js'

export const installReader: ShellInstaller = {
  name: 'reader',
  install: (_app, services) => {
    services.settings.onChange((change) => {
      if (change.key.startsWith('reader.')) services.internalPages.publish('reader.settings', change, ['reader'])
    })
    services.tabLifecycle.subscribe({
      tabClosing: ({ record }) => {
        if (record.internalPage !== 'reader') return
        const found = services.windows.findTab(record.view.webContents)
        if (found !== null) readerArticles.delete(found.window.tabs)
      }
    })
  }
}
