// Wires the per-site permission asker into the permission gate: a site asks
// for the camera, a location or another permission, and the person answers
// once per site in a prompt under the address bar. The installer runs after
// the settings are loaded and the broker exists, so the defaults and the
// registered apps are both known.
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { setNotificationsBlockedCheck } from '../sessions/permission-gate.js'
import { siteAsks } from '../sessions/site-asks.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { windowShowing } from '../shell/showing-window.js'
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
      // The same test the developer-tools gate makes: an app holding grants, or one served from the cache.
      isApp: (origin) => ctx.broker?.app.hasGrantsSync(origin) === true || isOriginServedFromCacheSync(origin),
      showing: (tab) => windowShowing(tab) !== undefined,
      ask,
      access: pageAccess
    })
    siteAsks.add(createSiteAsker(engine))
    setNotificationsBlockedCheck(() => services.settings.get('sites.notifications') === 'block')
  }
}
