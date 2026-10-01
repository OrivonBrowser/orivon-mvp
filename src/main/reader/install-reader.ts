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
      // A reader tab handed to another window keeps its article: it is keyed by the record that moves with it.
      tabClosing: ({ record, reason }) => {
        if (record.internalPage === 'reader' && reason !== 'moved') readerArticles.delete(record)
      }
    })
  }
}
