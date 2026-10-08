// Wires an app's first visit to the shell (ADR-0074): the screens a tab shows while it runs, published for the
// manifest-hint path, and the hold on a verifier-served origin's first page.
import { randomUUID } from 'node:crypto'
import { session, webContents } from 'electron'
import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'
import { LOADING_SCREEN_OVERLAY } from '../loading-screen/loading-screen-watch.js'
import { requestSlot } from '../overlays/tab-slots.js'
import { publishTabSetup } from '../registry.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { goHome } from '../shell/home.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { verifiedHostFilter } from '../verifier/verifier-subsystem.js'
import { firstVisitBeforeRequest } from './first-visit-hook.js'
import { createTabSetup } from './tab-screens.js'

/** After the verifier's listening gate (order 0), which starts the host and waits for it: this reads the app's manifest through it. */
const AFTER_THE_LISTENING_GATE = 10

export const installAppSetup: ShellInstaller = {
  name: 'app-setup',
  install: (_app, services, ctx) => {
    const setup = createTabSetup({
      findTab: (contents) => services.windows.findTab(contents),
      ask: requestSlot,
      prewarm: (window) => { window.overlays.prewarm(LOADING_SCREEN_OVERLAY) },
      newToken: randomUUID,
      navigate: (window, tabId, url) => { window.tabs.navigate(tabId, url) },
      leavePage: (window, tabId) => {
        const tab = window.tabs.getState().tabs.find((candidate) => candidate.id === tabId)
        if (tab?.canGoBack === true) window.tabs.back(tabId)
        else goHome(window.tabs, services.settings, { newTab: false })
      }
    })
    publishTabSetup(ctx, setup)
    webRequestOwnerFor(session.defaultSession).onBeforeRequest(
      AFTER_THE_LISTENING_GATE,
      verifiedHostFilter(),
      servedByVerifier,
      firstVisitBeforeRequest({
        firstVisit: () => ctx.firstVisit,
        tabSetup: () => ctx.tabSetup,
        contentsById: (id) => webContents.fromId(id),
        windowForSender: (contents) => ctx.windowForSender?.(contents)
      })
    )
  }
}
