// Wires an app's camera, microphone and screen grants into the permission gate and the display gate: the app media
// asker joins the per-site asker registry, and the grants are bound where the display gate finds them. The ledger
// and the run-time question are read from the context when they are used, because the broker and the request-grant
// subsystem are published after the installers run.
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { DialogCaller } from '../consent/request-grant.js'
import { bindAppMediaGrants } from '../display-capture/bindings.js'
import type { AppMediaKind } from '../display-capture/types.js'
import { siteAsks } from '../sessions/site-asks.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { isAppOrigin, isRegisteredAppOrigin } from '../site-settings/app-origin.js'
import { createAppMediaAsker } from './app-media-asker.js'
import { createAppMediaGrants } from './app-media-grants.js'

/** The site setting each app media kind shares its name with: the person's block is stored under it. */
const SITE_KIND = { 'media.camera': 'camera', 'media.microphone': 'microphone', 'media.screen': 'screenShare' } as const satisfies Record<AppMediaKind, string>
const DEFAULT_KEY = { 'media.camera': 'sites.camera', 'media.microphone': 'sites.microphone', 'media.screen': 'sites.screenShare' } as const satisfies Record<AppMediaKind, string>

/** The tab that asked, as the question and its guards need it: read live, so a page that moved on or a closed tab is seen. */
function callerFor (tab: WebContents, windowFor: ((sender: WebContents) => unknown) | undefined): DialogCaller {
  return {
    window: () => windowFor?.(tab),
    stillOn: (origin) => !tab.isDestroyed() && originFromUrl(tab.getURL()) === origin,
    id: tab,
    contents: () => tab
  }
}

export const installMediaGrants: ShellInstaller = {
  name: 'media-grants',
  install: (_app, services, ctx) => {
    const grants = createAppMediaGrants({
      held: (origin, kind) => ctx.broker?.app.heldSync(origin, kind) === true,
      ask: async (tab, origin, kind) => {
        const requestGrant = ctx.requestGrant
        return requestGrant !== undefined && await requestGrant(origin, { capability: kind }, callerFor(tab, ctx.windowForSender))
      }
    })
    bindAppMediaGrants(grants)
    // Registered ahead of the per-site asker (shell-installers.ts keeps the order): the first answer wins, and that
    // one refuses every app origin.
    siteAsks.add(createAppMediaAsker({
      isTab: (contents) => services.windows.findTab(contents) !== null,
      urlOf: (tab) => tab.getURL(),
      isApp: (origin) => isRegisteredAppOrigin(ctx, origin),
      // Site settings show a registered origin with no grant as a website and let the person store a block for it.
      blocked: (origin, kind) => !isAppOrigin(ctx, origin) && (services.siteSettings.get(origin, SITE_KIND[kind]) === 'block' || services.settings.get(DEFAULT_KEY[kind]) === 'block'),
      grants
    }))
  }
}
