// The site-info popup's own command channel -- one page of Orivon
// capability switches, a Web3 Score page, and a Cookies and site data
// page, all for the ONE origin this popup was opened for. The same
// sender-identity check as ./permissions-ipc.ts, against the site-info
// popup's own webContents instead of the all-sites panel's.
//
// THE ORIGIN IS FIXED AT CONSTRUCTION, NEVER A COMMAND FIELD. Every
// command below acts on exactly the `origin` this function was called
// with -- the same origin `../permissions/site-info-panel.js` derived
// before creating the popup, itself from the active tab, never from
// anything the popup's own page could claim about itself.

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { SITE_INFO_COMMAND_CHANNEL } from '../channels.js'
import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import type { SiteInfo } from '../permissions/site-info.js'
import type { SiteInfoController } from '../permissions/site-info-controller.js'
import type { SiteTrust } from '../browsing/site-trust.js'
import { browserStorageEstimateFor, orivonStorageFor } from '../permissions/site-data-runner.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { CookieView } from '../privacy/cookie-list.js'
import { cookieViewsFor, removeSiteCookie, removeSiteCookies } from '../privacy/cookie-runner.js'
import type { BrowserStorageEstimate } from '../permissions/site-data-runner.js'
import type { SitePermissionsAccess, SitePermissionsView } from '../site-settings/site-permissions-view.js'

export interface SiteDataSnapshot {
  readonly cookieCount: number
  /** The site's cookies by name and flags, never by value. */
  readonly cookies: readonly CookieView[]
  readonly browserStorage: BrowserStorageEstimate | null
  readonly orivonFilesBytes: number
  readonly orivonFilesQuotaBytes: number | undefined
  readonly orivonCodeBytes: number
  readonly orivonCodeVersion: string | undefined
}

export interface ApplyResult {
  readonly info: SiteInfo
  /** Capabilities the person tried to turn on whose manifest had changed
   * since the row was shown -- see `site-switches.js`'s `turnOnCapability`
   * doc. The popup redraws from `info` regardless; this is what lets it
   * also say WHY one row did not move. */
  readonly staleCapabilities: readonly CapabilityKind[]
}

export type SiteInfoCommand =
  | { type: 'get' }
  | { type: 'trust' }
  | { type: 'data' }
  /** One Confirm click, one or more switches at once. Each `on: true`
   * change carries `shownPatterns` -- the popup's own copy of the row it
   * displayed -- so a manifest that changed underneath a long-open popup
   * fails that one capability closed rather than granting a surprise. */
  | { type: 'apply'; changes: ReadonlyArray<{ capability: CapabilityKind; on: boolean; shownPatterns: readonly Pattern[] }> }
  /** This site's per-site permissions, for the origin the popover was built for: null when it has none. */
  | { type: 'sitePermissions' }
  /** One answer for one kind: `value` is `default`, `allow` or `block`; main refuses a kind that is not offered. */
  | { type: 'setSitePermission'; kind: string; value: string }
  | { type: 'revokePickedPath'; pickId: string }
  | { type: 'clearBrowserData' }
  /** One cookie of this site, by the key the last `data` answer gave it. */
  | { type: 'removeCookie'; key: string }
  | { type: 'clearCookies' }
  | { type: 'reload' }
  | { type: 'openSiteSettings' }
  /** The extensions disclosure's own "Manage" link (docs/planning/extensions-
   * exploration.md): opens `orivon://extensions` the same way `openSiteSettings`
   * opens the Site settings page. */
  | { type: 'openExtensions' }
  /** The Certificate row: closes this popup and opens the certificate viewer for the active tab. */
  | { type: 'certificate' }
  /** Same contract as ./permissions-ipc.ts's own `contentHeight`. */
  | { type: 'contentHeight'; height: number }
  /** Escape in the popup's page: closes the popup. No argument. */
  | { type: 'close' }

/** Identity alone is not enough (open-questions.md A269), the same reason
 * ./permissions-ipc.ts's own `isFromPermissionsPanel` checks the URL too --
 * see that function's doc. `popupUrl` is the address this popup was created
 * with, which `lock-navigation.ts` refuses to ever change. */
function isFromSiteInfoWindow (event: IpcMainInvokeEvent, siteInfoWebContents: WebContents, popupUrl: string): boolean {
  return event.senderFrame !== null && event.senderFrame === siteInfoWebContents.mainFrame && event.senderFrame.url === popupUrl
}

async function collectSiteData (
  controller: SiteInfoController,
  origin: string,
  userDataPath: string,
  activeWebContents: () => WebContents | undefined
): Promise<SiteDataSnapshot> {
  const declaration = await controller.storageDeclarationFor(origin)
  const tab = activeWebContents()
  const [orivon, cookies, browserStorage] = await Promise.all([
    orivonStorageFor(userDataPath, origin, declaration?.filesQuotaBytes, declaration?.codeVersion),
    tab === undefined ? [] : cookieViewsFor(tab.session.cookies, new URL(origin).hostname),
    tab === undefined ? null : browserStorageEstimateFor(tab, origin)
  ])
  return {
    cookieCount: cookies.length,
    cookies,
    browserStorage,
    orivonFilesBytes: orivon.filesBytes,
    orivonFilesQuotaBytes: orivon.filesQuotaBytes,
    orivonCodeBytes: orivon.codeBytes,
    orivonCodeVersion: orivon.codeVersion
  }
}

export function registerSiteInfoIpc (
  siteInfoWebContents: WebContents,
  popupUrl: string,
  controller: SiteInfoController,
  origin: string,
  userDataPath: string,
  activeWebContents: () => WebContents | undefined,
  reloadActiveTab: () => void,
  openSiteSettings: () => void,
  openExtensions: () => void,
  onContentHeight: (height: number) => void = () => {},
  openCertificate: () => void = () => {},
  sitePermissions: SitePermissionsAccess = { view: () => null, set: () => null },
  closePopup: () => void = () => {}
): void {
  // On the popup's own webContents: the handler goes with it, and two windows
  // can each have one open.
  siteInfoWebContents.ipc.handle(SITE_INFO_COMMAND_CHANNEL, async (
    event: IpcMainInvokeEvent,
    command: SiteInfoCommand
  ): Promise<void | SiteInfo | SiteTrust | null | SiteDataSnapshot | ApplyResult | SitePermissionsView> => {
    if (!isFromSiteInfoWindow(event, siteInfoWebContents, popupUrl)) return

    switch (command.type) {
      case 'get':
        return await controller.siteInfoFor(origin)
      case 'trust':
        return await controller.siteTrustFor(origin)
      case 'data':
        return await collectSiteData(controller, origin, userDataPath, activeWebContents)
      case 'apply': {
        const staleCapabilities: CapabilityKind[] = []
        for (const change of command.changes) {
          if (change.on) {
            const result = await controller.turnOn(origin, change.capability, change.shownPatterns)
            if (result === 'stale') staleCapabilities.push(change.capability)
          } else {
            await controller.turnOff(origin, change.capability)
          }
        }
        return { info: await controller.siteInfoFor(origin), staleCapabilities }
      }
      case 'sitePermissions':
        return sitePermissions.view(origin)
      case 'setSitePermission':
        return typeof command.kind === 'string' && typeof command.value === 'string' ? sitePermissions.set(origin, command.kind, command.value) : null
      case 'revokePickedPath':
        await controller.revokePickedPath(origin, command.pickId)
        return await controller.siteInfoFor(origin)
      case 'clearBrowserData': {
        const tab = activeWebContents()
        if (tab === undefined) return
        try {
          await tab.session.clearData({ origins: [origin] })
        } catch (error) {
          console.error('[site-info] clearData failed', origin, error)
        }
        return
      }
      case 'removeCookie': {
        const tab = activeWebContents()
        if (tab === undefined || originFromUrl(tab.getURL()) !== origin || typeof command.key !== 'string') return
        await removeSiteCookie(tab.session.cookies, new URL(origin).hostname, command.key)
        return
      }
      case 'clearCookies': {
        const tab = activeWebContents()
        if (tab === undefined || originFromUrl(tab.getURL()) !== origin) return
        await removeSiteCookies(tab.session.cookies, new URL(origin).hostname)
        return
      }
      case 'reload':
        reloadActiveTab()
        return
      case 'openSiteSettings':
        openSiteSettings()
        return
      case 'openExtensions':
        openExtensions()
        return
      case 'close':
        // After the reply: this popup's close destroys the webContents, which would drop an invoke still waiting.
        setImmediate(closePopup)
        return
      case 'certificate':
        openCertificate()
        return
      case 'contentHeight':
        if (Number.isFinite(command.height)) onContentHeight(command.height)
        return
    }
  })
}
