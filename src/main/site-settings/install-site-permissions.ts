// Wires the per-site permission asker into the permission gate: a site asks
// for the camera, a location or another permission, and the person answers
// once per site in a prompt under the address bar. The installer runs after
// the settings are loaded and the broker exists, so the defaults and the
// registered apps are both known.
import { ipcMain } from 'electron'
import { configureSiteNotifications, setNotificationsBlockedCheck } from '../sessions/permission-gate.js'
import { registerPermissionQueryIpc } from '../sessions/permission-query-ipc.js'
import { siteAsks } from '../sessions/site-asks.js'
import { createWakeLockAsker } from '../sessions/wake-lock-asker.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { windowShowing } from '../shell/showing-window.js'
import { isAppOrigin } from './app-origin.js'
import { bindAskSite, createAskSite } from './ask-site.js'
import { siteKindById, type SiteKind } from './kinds.js'
import { pageAccess } from './page-access.js'
import { createSiteAsker } from './site-asker.js'
import { createSiteAsksEngine } from './site-asks-engine.js'

export const installSitePermissions: ShellInstaller = {
  name: 'site-permissions',
  install: (_app, services, ctx) => {
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
    siteAsks.add(createWakeLockAsker({ isTab: (contents) => services.windows.findTab(contents) !== null }))
    configureSiteNotifications({ isPrivate: services.isPrivate, isApp: (origin) => isAppOrigin(ctx, origin) })
    setNotificationsBlockedCheck(() => services.settings.get('sites.notifications') === 'block')
  }
}
