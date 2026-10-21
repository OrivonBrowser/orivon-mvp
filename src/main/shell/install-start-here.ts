// Registered in `./shell-installers.ts`: ticks the steps of the new tab's "Start here" card that the browser itself can see,
// from the tab events the shell already raises: an app opening, and a `.eth` name loading. The import step is ticked by
// `../import/import-host.ts` when an import ends. What the steps are and when the card shows is in `../newtab/`.
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isEthPageUrl } from '../newtab/start-here-state.js'
import { watchAppOpen } from '../os/app-open-watch.js'
import type { ShellInstaller } from './shell-installers.js'
import { appTabViews } from './tab-partition.js'

export const installStartHere: ShellInstaller = {
  name: 'start-here',
  install: (_app, services, ctx, runtime) => {
    if (runtime.isPrivate || services.kiosk) return
    const { featured } = services
    const appOpened = (): void => { featured.markStep('app') }
    const watched = new WeakSet<WebContents>()
    const watch = (contents: WebContents): void => {
      // An app is a tab of a registered app, or a page of an origin that holds a grant.
      watchAppOpen(contents, () => {
        const found = services.windows.findTab(contents)
        const view = found?.window.tabs.record(found.tabId)?.view
        if (view !== undefined && appTabViews.has(view)) return true
        const origin = originFromUrl(contents.getURL())
        return origin !== null && ctx.broker?.app.hasGrantsSync(origin) === true
      }, appOpened)
      if (watched.has(contents)) return
      watched.add(contents)
      contents.on('did-finish-load', () => {
        if (!contents.isDestroyed() && isEthPageUrl(contents.getURL())) featured.markStep('eth')
      })
    }
    services.tabLifecycle.subscribe({
      tabCreated: (contents) => { watch(contents) },
      viewReplaced: (_old, contents) => { watch(contents) }
    })
  }
}
