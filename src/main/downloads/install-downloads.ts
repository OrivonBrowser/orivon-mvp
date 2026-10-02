// Puts the downloads service on every session a tab can use. A session's `will-download` decides nothing
// until a handler sets the file's path, so this has to reach a session before its first download: the
// default session at once, and each other one the first time a tab is created in it.
import type { App, DownloadItem, Event, Session, WebContents } from 'electron'
import type { WindowRegistry } from '../shell/window-registry.js'
import type { DownloadService } from './download-service.js'

export interface InstallHost {
  readonly windows: Pick<WindowRegistry, 'findTab'>
  readonly downloads: Pick<DownloadService, 'track' | 'discardHeldFiles'>
  readonly defaultSession: Session
  /** A private session keeps no list, so the files a hold left are deleted as it ends. */
  readonly discardHeldAtQuit?: boolean
}

export function installDownloads (app: Pick<App, 'on'>, host: InstallHost): void {
  const attached = new WeakSet<Session>()
  const attach = (target: Session): void => {
    if (attached.has(target)) return
    attached.add(target)
    target.on('will-download', (event: Event, item: DownloadItem, contents: WebContents | undefined) => {
      try {
        host.downloads.track(item, contents, event)
      } catch (error) {
        // A download with no path set would wait for ever, so one the service could not take is refused.
        console.error('[orivon] a download could not be started:', error)
        event.preventDefault()
      }
    })
  }
  attach(host.defaultSession)
  if (host.discardHeldAtQuit === true) app.on('before-quit', () => { host.downloads.discardHeldFiles() })
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return
    // A tab is registered just after its contents exist, so whether it is one is asked a moment later.
    // The embed, child and web-context sessions hold no tab and keep their own refusal of downloads.
    setImmediate(() => {
      if (!contents.isDestroyed() && host.windows.findTab(contents) !== null) attach(contents.session)
    })
  })
}
