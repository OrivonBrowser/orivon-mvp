// The site-info popup's own command channel -- one page of Orivon
// capability switches, a Web3 Score page, and a Cookies and site data
// page, all for the ONE origin this popup was opened for. The same
// sender-identity check as ./networks-ipc.ts, against the site-info
// popup's own webContents instead of the Available networks popup's.
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
import type { ProxyTestReply } from '../route/route-domain.js'
import type { SiteInfoController } from '../permissions/site-info-controller.js'
import type { SiteTrust } from '../browsing/site-trust.js'
import type { ApplyOutcome } from '../install/app-updates.js'
import { dialogCallerFor } from '../install/dialog-caller.js'
import { browserStorageEstimateFor, orivonStorageFor } from '../permissions/site-data-runner.js'
import { isLocalFileKey, originFromUrl } from '../../broker/policy/origin.js'
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

/** The answer to the tunnel switch: whether it was done, and the info the popup then draws. */
export interface TunnelResult {
  readonly ok: boolean
  readonly info: SiteInfo
}

/** The answer to saving the proxy's address from the menu: whether it was saved and, if not, why, with the info the popup then draws. */
export interface ProxyAddressResult {
  readonly ok: boolean
  readonly reason?: 'invalid' | 'refused'
  readonly info: SiteInfo
}

export interface ApplyResult {
  readonly info: SiteInfo
  /** Capabilities the person tried to turn on whose manifest had changed
   * since the row was shown -- see `site-switches.js`'s `turnOnCapability`
   * doc. The popup redraws from `info` regardless; this is what lets it
   * also say WHY one row did not move. */
  readonly staleCapabilities: readonly CapabilityKind[]
  /** Capabilities the person tried to turn on that nothing could grant: no manifest is loaded for the site, or it no longer declares them. Nothing changed for these, so a reload would not apply anything. */
  readonly refusedCapabilities: readonly CapabilityKind[]
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
  /** Takes the update offered for this popup's origin: `cid` must name exactly the pending offer, and main refuses any other. */
  | { type: 'applyUpdate'; cid: string }
  /** "Open <home>": a new tab at the `domain` this origin's manifest names. No argument: main reads the name, the popup never supplies one. */
  | { type: 'openHome' }
  /** "Report a problem with this site": a new tab at the address this origin's manifest gives as `support.issues`. No argument: main reads it, the popup never supplies one. */
  | { type: 'openSupport' }
  | { type: 'clearBrowserData' }
  /** One cookie of this site, by the key the last `data` answer gave it. */
  | { type: 'removeCookie'; key: string }
  | { type: 'clearCookies' }
  | { type: 'reload' }
  /** The tunnel of a website or an installed app: Nym, the person's proxy, or none (null). Answers whether it was done, with the popup's info as it is after. */
  | { type: 'setTunnel'; kind: 'nym' | 'socks5' | null }
  /** The tunnel of the whole browser: Nym, the person's proxy, or none (null). Answers whether it was done, with the popup's info as it is after. */
  | { type: 'setBrowserTunnel'; kind: 'nym' | 'socks5' | null }
  /** Whether the IPFS and Swarm nodes follow the tunnel too. Answers whether it was done, with the popup's info as it is after. */
  | { type: 'setNodesTunnel'; on: boolean }
  /** The address of the person's proxy, typed in the menu: main checks it as Settings does and saves it. Refused in a window held to Nym. */
  | { type: 'setProxyAddress'; text: string }
  /** Whether a tunnel answers, as Settings' Test asks it: it names no address, main tests the one saved. Answers nothing in a window held to Nym. */
  | { type: 'testTunnel'; kind: 'nym' | 'socks5' }
  /** "Delete data" of the local file this popup was opened for: no argument, main reads the key. Answers whether every step succeeded. */
  | { type: 'deleteLocalFile' }
  /** "Review permissions" of an app that was never let in: the question is given back and the tab in front reloads, so the first visit asks again. No argument: main reads the origin. */
  | { type: 'reviewPermissions' }
  | { type: 'openSiteSettings' }
  /** The tunnel list's links to Settings > Tunnels: `everywhere` lands on the browser-wide switch. */
  | { type: 'openTunnelSettings'; everywhere: boolean }
  /** The extensions disclosure's own "Manage" link (docs/planning/extensions-
   * exploration.md): opens `orivon://extensions` the same way `openSiteSettings`
   * opens the Site settings page. */
  | { type: 'openExtensions' }
  /** The Certificate row: closes this popup and opens the certificate viewer for the active tab. */
  | { type: 'certificate' }
  /** Same contract as ./networks-ipc.ts's own `contentHeight`. */
  | { type: 'contentHeight'; height: number }
  /** A "?" on the Web3 Score page: closes this popup and opens the page that says what the levels mean. No argument: main knows the page. */
  | { type: 'openScoreHelp' }
  /** Escape in the popup's page: closes the popup. No argument. */
  | { type: 'close' }

/** Identity alone is not enough (open-questions.md A269), the same reason
 * ./networks-ipc.ts's own `isFromNetworksPanel` checks the URL too --
 * see that function's doc. `popupUrl` is the address this popup was created
 * with, which `lock-navigation.ts` refuses to ever change. */
export function isFromSiteInfoWindow (event: IpcMainInvokeEvent, siteInfoWebContents: WebContents, popupUrl: string): boolean {
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
    // A local file has no cookies of its own: its session keeps them apart from the web, and a host-less address names none.
    tab === undefined || isLocalFileKey(origin) ? [] : cookieViewsFor(tab.session.cookies, new URL(origin).hostname),
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
  openSettings: (path?: string) => void,
  openExtensions: () => void,
  onContentHeight: (height: number) => void = () => {},
  openCertificate: () => void = () => {},
  sitePermissions: SitePermissionsAccess = { view: () => null, set: () => null },
  closePopup: () => void = () => {},
  openHome: (domain: string) => void = () => {},
  openScoreHelp: () => void = () => {},
  openSupport: (url: string) => void = () => {}
): void {
  // A website the person opened through their proxy from a routed app says so, in the tab the popover is about; and the tunnel of the whole browser is there for the Browser-wide panel.
  const withRoute = (info: SiteInfo): SiteInfo => controller.withBrowserTunnel(controller.inSession(info, activeWebContents()?.session))
  // On the popup's own webContents: the handler goes with it, and two windows
  // can each have one open.
  siteInfoWebContents.ipc.handle(SITE_INFO_COMMAND_CHANNEL, async (
    event: IpcMainInvokeEvent,
    command: SiteInfoCommand
  ): Promise<void | boolean | SiteInfo | SiteTrust | null | SiteDataSnapshot | ApplyResult | TunnelResult | ProxyAddressResult | ProxyTestReply | SitePermissionsView | ApplyOutcome> => {
    if (!isFromSiteInfoWindow(event, siteInfoWebContents, popupUrl)) return

    switch (command.type) {
      case 'get':
        return withRoute(await controller.siteInfoFor(origin))
      case 'trust':
        return await controller.siteTrustFor(origin)
      case 'data':
        return await collectSiteData(controller, origin, userDataPath, activeWebContents)
      case 'apply': {
        const staleCapabilities: CapabilityKind[] = []
        const refusedCapabilities: CapabilityKind[] = []
        for (const change of command.changes) {
          if (change.on) {
            const result = await controller.turnOn(origin, change.capability, change.shownPatterns)
            if (result === 'stale') staleCapabilities.push(change.capability)
            else if (result !== 'ok') refusedCapabilities.push(change.capability)
          } else {
            await controller.turnOff(origin, change.capability)
          }
        }
        return { info: withRoute(await controller.siteInfoFor(origin)), staleCapabilities, refusedCapabilities }
      }
      case 'sitePermissions':
        return sitePermissions.view(origin)
      case 'setSitePermission':
        return typeof command.kind === 'string' && typeof command.value === 'string' ? sitePermissions.set(origin, command.kind, command.value) : null
      case 'applyUpdate': {
        if (typeof command.cid !== 'string') return { ok: false, reason: 'no such offer' }
        const tab = activeWebContents()
        return await controller.applyUpdate(origin, command.cid, tab === undefined ? undefined : dialogCallerFor(tab))
      }
      case 'openHome': {
        const home = (await controller.siteInfoFor(origin)).homeDomain
        if (home !== undefined) openHome(home)
        return
      }
      case 'openSupport': {
        const issues = (await controller.siteInfoFor(origin)).supportIssues
        if (issues !== undefined && issues.startsWith('https://')) openSupport(issues)
        return
      }
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
      case 'setTunnel': {
        if (command.kind !== null && command.kind !== 'nym' && command.kind !== 'socks5') return { ok: false, info: withRoute(await controller.siteInfoFor(origin)) } satisfies TunnelResult
        // A page whose tunnel is its session's (opened through an app's tunnel, or adopted into its session) does not choose here, whatever a popup asks.
        const before = withRoute(await controller.siteInfoFor(origin))
        const ok = before.tunnel?.fixed === undefined && await controller.setTunnel(origin, command.kind)
        return { ok, info: ok ? withRoute(await controller.siteInfoFor(origin)) : before } satisfies TunnelResult
      }
      case 'setBrowserTunnel': {
        if (command.kind !== null && command.kind !== 'nym' && command.kind !== 'socks5') return { ok: false, info: withRoute(await controller.siteInfoFor(origin)) } satisfies TunnelResult
        const ok = controller.setBrowserTunnel(command.kind)
        return { ok, info: withRoute(await controller.siteInfoFor(origin)) } satisfies TunnelResult
      }
      case 'setNodesTunnel': {
        const ok = typeof command.on === 'boolean' && controller.setNodesTunnel(command.on)
        return { ok, info: withRoute(await controller.siteInfoFor(origin)) } satisfies TunnelResult
      }
      case 'setProxyAddress': {
        if (typeof command.text !== 'string') return { ok: false, reason: 'invalid', info: withRoute(await controller.siteInfoFor(origin)) } satisfies ProxyAddressResult
        const saved = controller.setProxyAddress(command.text)
        return { ok: saved === 'ok', ...(saved === 'ok' ? {} : { reason: saved }), info: withRoute(await controller.siteInfoFor(origin)) } satisfies ProxyAddressResult
      }
      case 'testTunnel':
        return command.kind === 'nym' || command.kind === 'socks5' ? await controller.testTunnel(command.kind) : null
      case 'reload':
        reloadActiveTab()
        return
      case 'reviewPermissions':
        if (await controller.reviewPermissions(origin)) reloadActiveTab()
        return
      case 'deleteLocalFile':
        return await controller.deleteLocalFileData(origin)
      case 'openSiteSettings':
        openSettings()
        return
      case 'openTunnelSettings':
        openSettings(command.everywhere === true ? '/tunnels#route-everywhere' : '/tunnels')
        return
      case 'openExtensions':
        openExtensions()
        return
      case 'openScoreHelp':
        openScoreHelp()
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
