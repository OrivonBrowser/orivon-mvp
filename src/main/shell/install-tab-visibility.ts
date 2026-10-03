// Registered in `./shell-installers.ts`: starts telling pages whether they are in sight (./tab-visibility.ts).
import type { ShellInstaller } from './shell-installers.js'
import { startTabVisibility } from './tab-visibility.js'

export const installTabVisibility: ShellInstaller = {
  name: 'tab-visibility',
  install: (_app, services) => {
    startTabVisibility(services.tabLifecycle)
  }
}
