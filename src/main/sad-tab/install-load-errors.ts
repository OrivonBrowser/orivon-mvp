// Watches every tab for a page that fails to load, so the load-error sheet can say so (load-error-watch.ts).
import { requestSlot } from '../overlays/tab-slots.js'
import { upgradeTracker } from '../privacy/https-fallback.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { watchLoadErrors, type LoadErrorDeps } from './load-error-watch.js'

export const installLoadErrors: ShellInstaller = {
  name: 'load-errors',
  install: (_app, services) => {
    const deps: LoadErrorDeps = {
      findTab: (contents) => services.windows.findTab(contents),
      ask: requestSlot,
      claimed: (id, url, code) => upgradeTracker.claims(id, url, code)
    }
    services.tabLifecycle.subscribe({
      tabCreated: (contents) => { watchLoadErrors(contents, deps) },
      viewReplaced: (_old, contents) => { watchLoadErrors(contents, deps) }
    })
  }
}
