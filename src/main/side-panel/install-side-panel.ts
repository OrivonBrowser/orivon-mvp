// Starts what the side panel needs once per process: the file its width and last view are kept in.
import { join } from 'node:path'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { setGuestEntries, sidePanelFor } from './side-panel-host.js'
import { FileSidePanelStore, MemorySidePanelStore } from './side-panel-store.js'
import { registerStore } from './side-panel-stores.js'
import { exposeSidePanelForTests } from './side-panel-test-hook.js'

export const installSidePanel: ShellInstaller = {
  name: 'side-panel',
  install: (app, services) => {
    // A private session keeps nothing: the panel remembers its width in memory only.
    registerStore(services, services.isPrivate ? new MemorySidePanelStore() : new FileSidePanelStore(join(app.getPath('userData'), 'side-panel.json')))
    exposeSidePanelForTests({
      host: (index) => { const entry = services.windows.all()[index]; return entry === undefined ? undefined : sidePanelFor(entry) },
      setGuestEntries: (entries) => { setGuestEntries(entries as Parameters<typeof setGuestEntries>[0]) },
      setSetting: (key, value) => { services.settings.set(key as never, value as never) }
    })
  }
}
