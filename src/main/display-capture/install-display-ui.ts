// Registered in `../shell/shell-installers.ts`: binds the picker the gate asks, and starts what draws a running share
// (tab badges, the sharing bar). The gate's own installer (./install-display-capture.ts) binds the share registry;
// what follows it moves to the registry when it is bound, so the order of installers does not matter.
import type { ShellInstaller } from '../shell/shell-installers.js'
import { watchShares } from '../shell/signals/sharing.js'
import { bindDisplayChooser } from './bindings.js'
import { onShareChange } from './indicators/share-events.js'
import { sharingBars } from './indicators/sharing-bar.js'
import { createDisplayChooser } from './picker/choose-display-source.js'
import { pickerStore } from './picker/picker-real.js'

export const installDisplayUi: ShellInstaller = {
  name: 'display-capture-ui',
  install: (_app, services) => {
    bindDisplayChooser(createDisplayChooser({ store: pickerStore, findTab: (contents) => services.windows.findTab(contents) }))
    sharingBars.use(() => services.windows.all())
    onShareChange(() => { sharingBars.sync() })
    watchShares()
  }
}
