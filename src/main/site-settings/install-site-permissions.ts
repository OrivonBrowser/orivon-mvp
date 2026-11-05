// Wires the per-site permission asker into the permission gate: a site asks
// for the camera, a location or another permission, and the person answers
// once per site in a prompt under the address bar. The installer runs after
// the settings are loaded and the broker exists, so the defaults and the
// registered apps are both known. A page's WebGPU adapter is asked about here
// too (`webgpu-ask.ts`): Electron reports no WebGPU request, so its question
// comes from the page's own preload.
import { ipcMain, type WebContents } from 'electron'
import { X11_SETTING, x11VulkanOffer, x11VulkanReading } from '../graphics/x11-vulkan-runner.js'
import { restartOrivon } from '../launch/relaunch.js'
import { configureSiteNotifications, setNotificationsBlockedCheck } from '../sessions/permission-gate.js'
import { registerPermissionQueryIpc } from '../sessions/permission-query-ipc.js'
import { siteAsks } from '../sessions/site-asks.js'
import { createWakeLockAsker } from '../sessions/wake-lock-asker.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { windowShowing } from '../shell/showing-window.js'
import { startupRestoresSession } from '../startup/startup-plan.js'
import { isAppOrigin } from './app-origin.js'
import { bindAskSite, createAskSite, createOfferRestart } from './ask-site.js'
import { siteKindById, type SiteKind } from './kinds.js'
import { pageAccess } from './page-access.js'
import { createSiteAsker } from './site-asker.js'
import { createSiteAsksEngine } from './site-asks-engine.js'
import { addressAfterRestart, createWebGpuAsk } from './webgpu-ask.js'
import { registerWebGpuAskIpc } from './webgpu-ask-ipc.js'

/** The page a tab shows now, to open again after a restart; none when the tab is gone. */
function pageOf (tab: WebContents): string | undefined {
  try {
    return tab.isDestroyed() ? undefined : tab.getURL()
  } catch {
    return undefined
  }
}

export const installSitePermissions: ShellInstaller = {
  name: 'site-permissions',
  install: (app, services, ctx) => {
    const ask = createAskSite({ windows: services.windows })
    bindAskSite(ask)
    const engine = createSiteAsksEngine({
      store: services.siteSettings,
      defaultFor: (kind: SiteKind) => {
        const key = siteKindById(kind)?.settingKey
        return key !== undefined && services.settings.get(key) === 'block' ? 'block' : 'ask'
      },
      isTab: (contents) => services.windows.findTab(contents) !== null,
      urlOf: (tab) => tab.getURL(),
      isApp: (origin) => isAppOrigin(ctx, origin),
      showing: (tab) => windowShowing(tab) !== undefined,
      ask,
      access: pageAccess
    })
    siteAsks.add(createSiteAsker(engine))
    // What a page's own permission query reads: the engine's check says denied for everything undecided, and each
    // asker here (and the extension one, ahead of them) says which of those the person would in fact be asked about.
    registerPermissionQueryIpc({ ipc: ipcMain, asks: siteAsks })
    // Electron 44 tells the browser process nothing of a WebGPU request: the page's top frame asks, and main decides.
    const offerRestart = createOfferRestart({ windows: services.windows })
    registerWebGpuAskIpc({
      ipc: ipcMain,
      ask: createWebGpuAsk<WebContents>({
        request: (request, contents, details) => engine.request(request, contents, details),
        isApp: (origin) => isAppOrigin(ctx, origin),
        blockedByDefault: () => services.settings.get('sites.webgpu') === 'block',
        stored: (origin) => services.siteSettings.get(origin, 'webgpu'),
        isPrivate: services.isPrivate,
        x11: () => {
          const { offered, revert } = x11VulkanOffer()
          return { offered, onAtStart: x11VulkanReading().onAtStart, reverted: revert !== null }
        },
        turnOnX11: () => services.settings.set(X11_SETTING, true).ok,
        restoresSession: () => startupRestoresSession(services.settings.get('startup.mode'), services.isPrivate),
        tabHasTunnel: (tab) => {
          const found = services.windows.findTab(tab)
          return found?.window.tabs.record(found.tabId)?.tunnelChoice !== undefined
        },
        // `reopens` is decided once: the question the person reads and the command line the restart runs both follow it.
        offerRestart: (tab, reopens) => { offerRestart(tab, { reopens, run: () => { restartOrivon(app, process.argv, addressAfterRestart(reopens, pageOf(tab))) } }) }
      })
    })
    siteAsks.add(createWakeLockAsker({ isTab: (contents) => services.windows.findTab(contents) !== null }))
    configureSiteNotifications({ isPrivate: services.isPrivate, isApp: (origin) => isAppOrigin(ctx, origin) })
    setNotificationsBlockedCheck(() => services.settings.get('sites.notifications') === 'block')
  }
}
