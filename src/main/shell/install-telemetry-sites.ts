// Registered in `./shell-installers.ts`: tells telemetry which site the tab in front shows, from the
// tab events the shell already raises, when telemetry runs in this process at all. The deciding is in
// `../../telemetry/site-tracker.ts`; this file only listens.
import type { BaseWindow, WebContents } from 'electron'
import { noteSite, telemetryOff } from '../../telemetry/runner.js'
import { SiteTracker } from '../../telemetry/site-tracker.js'
import type { ShellInstaller } from './shell-installers.js'

export const installTelemetrySites: ShellInstaller = {
  name: 'telemetry-sites',
  install: (_app, services) => {
    if (telemetryOff() !== undefined) return
    const tracker = new SiteTracker({
      classify: async (url) => {
        const trust = await services.windows.focused()?.siteTrustFor?.(url)
        return trust === undefined || trust === null ? null : { level: trust.displayedLevel, judged: trust.judged.status === 'judged' }
      },
      emit: noteSite,
      now: () => Date.now()
    })
    /** The tab in front in the window the person is using; cheap, because an origin is asked about once. */
    const refresh = (): void => {
      const contents = services.windows.focused()?.tabs.activeWebContents()
      tracker.show(contents === undefined || contents.isDestroyed() ? '' : contents.getURL())
    }
    const watchedPages = new WeakSet<WebContents>()
    const watchedWindows = new WeakSet<BaseWindow>()
    const watch = (contents: WebContents, window: BaseWindow | undefined): void => {
      if (!watchedPages.has(contents)) {
        watchedPages.add(contents)
        contents.on('did-navigate', refresh)
        contents.on('did-navigate-in-page', refresh)
      }
      if (window !== undefined && !watchedWindows.has(window)) {
        watchedWindows.add(window)
        window.on('focus', refresh)
      }
    }
    services.tabLifecycle.subscribe({
      tabCreated: (contents, window) => { watch(contents, window) },
      tabActivated: refresh,
      tabClosed: refresh,
      viewReplaced: (_old, contents, window) => { watch(contents, window); refresh() }
    })
  }
}
