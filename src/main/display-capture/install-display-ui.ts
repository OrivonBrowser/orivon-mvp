// Registered in `../shell/shell-installers.ts`: binds the picker the gate asks, and starts what draws a running share
// (tab badges, the sharing bar). The gate's own installer (./install-display-capture.ts) binds the share registry;
// everything here reads it after every installer has run, so the order of installers does not matter.
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
    // After the last installer has run, so the registry another installer binds is the one followed.
    queueMicrotask(() => {
      onShareChange(() => { sharingBars.sync() })
      watchShares()
    })
  }
}
