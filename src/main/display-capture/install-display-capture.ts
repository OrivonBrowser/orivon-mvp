// Wires the display-capture gate: the asker that owns the display `media` request (registered before every other
// asker), the handler that answers the display request, the messages of the tab preload, the share registry and the
// page's lifecycle. The picker and the app media grants bind themselves in their own installers (./bindings.ts).
import { ipcMain, desktopCapturer, webContents, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { originFromUrl } from '../../broker/policy/origin.js'
import { exposeDisplayChooserForTests } from '../dev/dev-display-chooser.js'
import { markMediaInUse, clearMediaInUse } from '../memory-saver/media-in-use.js'
import { bindDisplayMediaHandler } from '../sessions/display-media-handler.js'
import { siteAsks } from '../sessions/site-asks.js'
import { DISPLAY_CAPTURE_STOP_CHANNEL } from '../channels.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { windowShowing } from '../shell/showing-window.js'
import { isAppOrigin } from '../site-settings/app-origin.js'
import { pageAccess } from '../site-settings/page-access.js'
import { appMediaGrants, bindShareRegistry, chooseDisplaySource } from './bindings.js'
import { createDisplayAsker } from './display-asker.js'
import { createDisplayGate } from './display-gate.js'
import { createDisplayHandler } from './display-handler.js'
import { registerDisplayIpc } from './display-ipc.js'
import { createDisplayPolicy } from './display-policy.js'
import { createDisplayTickets } from './display-tickets.js'
import { endUnexpectedCapture } from './end-unexpected-capture.js'
import { mainFrameKey } from './frame-key.js'
import { createShareRegistry } from './share-registry.js'
import type { DisplayChoice } from './types.js'

/** The origin the tab's top frame committed, or null for a page that is not an http(s) site. */
function committedOrigin (contents: WebContents): string | null {
  if (contents.isDestroyed()) return null
  try {
    return originFromUrl(contents.mainFrame.url)
  } catch {
    return null
  }
}

/** Calls `ended` once when the page in `contents` is replaced, its renderer is lost or the tab is destroyed. */
function watchPage (contents: WebContents, ended: () => void): () => void {
  const events = ['did-navigate', 'render-process-gone', 'destroyed'] as const
  const listener = (): void => { ended() }
  for (const event of events) contents.on(event as 'destroyed', listener)
  return () => {
    for (const event of events) contents.removeListener(event as 'destroyed', listener)
  }
}

export const installDisplayCapture: ShellInstaller = {
  name: 'display-capture',
  install: (app, services, ctx) => {
    const isTab = (contents: WebContents): boolean => services.windows.findTab(contents) !== null
    const tickets = createDisplayTickets<DisplayChoice>()
    const policy = createDisplayPolicy({
      isApp: (origin) => isAppOrigin(ctx, origin),
      blockedByDefault: () => services.settings.get('sites.screenShare') === 'block',
      storedBlock: (origin) => services.siteSettings.get(origin, 'screenShare') === 'block',
      noteBlocked: (tab, origin) => { pageAccess.note(tab, origin, 'screenShare', 'blocked') },
      appGrants: appMediaGrants
    })
    const shares = createShareRegistry({
      now: () => Date.now(),
      newId: () => randomUUID(),
      watch: watchPage,
      isBeingCaptured: (contents) => !contents.isDestroyed() && contents.isBeingCaptured(),
      sendStop: (requester, nonce) => {
        if (!requester.isDestroyed()) requester.mainFrame.send(DISPLAY_CAPTURE_STOP_CHANNEL, { nonce })
      },
      markInUse: markMediaInUse,
      clearInUse: clearMediaInUse,
      every: (tick, ms) => {
        const timer = setInterval(tick, ms)
        return () => { clearInterval(timer) }
      }
    })
    bindShareRegistry(shares)

    const gate = createDisplayGate({
      tickets,
      policy,
      choose: chooseDisplaySource,
      shares,
      now: () => Date.now(),
      isTab,
      showing: (contents) => windowShowing(contents) !== undefined,
      mainFrameOrigin: committedOrigin,
      frameKey: mainFrameKey
    })
    registerDisplayIpc({ ipc: ipcMain, gate, isTab })

    bindDisplayMediaHandler(createDisplayHandler({
      tickets,
      contentsOf: (frame) => webContents.fromFrame(frame),
      shares,
      platform: process.platform
    }))

    // Before the site-permissions asker, whatever order the installers run in: it must see the request first.
    siteAsks.addFirst(createDisplayAsker({
      tickets,
      isTab,
      mainFrameOrigin: committedOrigin,
      mayAsk: (_contents, origin) => policy.mayAsk(origin),
      endUnexpectedCapture
    }))

    const endWhenPageEnds = (contents: WebContents): void => {
      const end = (): void => { gate.endForTab(contents) }
      contents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) end() })
      contents.on('render-process-gone', end)
    }
    for (const contents of webContents.getAllWebContents()) endWhenPageEnds(contents)
    app.on('web-contents-created', (_event, contents) => { endWhenPageEnds(contents) })

    exposeDisplayChooserForTests({
      firstScreen: async () => {
        const [screen] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        return screen === undefined ? undefined : { id: screen.id, name: screen.name }
      },
      findTab: (url) => webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.getURL().includes(url))
    })
  }
}
