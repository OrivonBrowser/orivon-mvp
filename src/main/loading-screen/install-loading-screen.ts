// Watches every tab for a navigation to an address whose protocol has a loading screen (loading-screen-watch.ts).
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { requestSlot } from '../overlays/tab-slots.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { isCoverClaimed } from './claim.js'
import { LOADING_SCREEN_OVERLAY, watchLoadingScreen, type LoadingScreenDeps } from './loading-screen-watch.js'

export const installLoadingScreen: ShellInstaller = {
  name: 'loading-screen',
  install: (_app, services) => {
    const deps: LoadingScreenDeps = {
      findTab: (contents) => services.windows.findTab(contents),
      ask: requestSlot,
      screenFor: (url) => BUILTIN_ADDRESSES.loadingScreenFor(url),
      prewarm: (window) => { window.overlays.prewarm(LOADING_SCREEN_OVERLAY) },
      claimed: isCoverClaimed
    }
    services.tabLifecycle.subscribe({
      tabCreated: (contents) => { watchLoadingScreen(contents, deps) },
      viewReplaced: (_old, contents) => { watchLoadingScreen(contents, deps) }
    })
  }
}
