import { contextBridge, ipcRenderer } from 'electron'
import { SITE_INFO_COMMAND_CHANNEL } from '../main/channels.js'
import type { ApplyResult, ProxyAddressResult, SiteDataSnapshot, SiteInfoCommand, TunnelResult } from '../main/ipc/site-info-ipc.js'
import type { SiteInfo } from '../main/permissions/site-info.js'
import type { SitePermissionsView } from '../main/site-settings/site-permissions-view.js'
import type { SiteTrust } from '../main/browsing/site-trust.js'
import type { ApplyOutcome } from '../main/install/app-updates.js'
import type { CapabilityKind, Pattern } from '../contracts/index.js'

// Loaded ONLY by the site-info popup's own WebContentsView
// (src/main/permissions/site-info-panel.ts). Same defense-in-depth as
// src/preload/networks.ts: this page never navigates anywhere else, but the
// check below still runs before exposing anything privileged, and
// src/main/ipc/site-info-ipc.ts re-verifies the same thing from the
// authoritative main-process side on every call -- neither layer trusts
// the other.
const URL_PREFIX = '--orivon-site-info-url='
const PAGE_PREFIX = '--orivon-site-info-page='
const ORIGIN_PREFIX = '--orivon-site-info-origin='
const expectedUrl = process.argv.find((arg) => arg.startsWith(URL_PREFIX))?.slice(URL_PREFIX.length)
const page = process.argv.find((arg) => arg.startsWith(PAGE_PREFIX))?.slice(PAGE_PREFIX.length)
const origin = process.argv.find((arg) => arg.startsWith(ORIGIN_PREFIX))?.slice(ORIGIN_PREFIX.length)

if (expectedUrl !== undefined && location.href === expectedUrl) {
  contextBridge.exposeInMainWorld('orivonSiteInfo', {
    get: async (): Promise<SiteInfo | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'get' } satisfies SiteInfoCommand)
      return (result ?? null) as SiteInfo | null
    },
    trust: async (): Promise<SiteTrust | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'trust' } satisfies SiteInfoCommand)
      return (result ?? null) as SiteTrust | null
    },
    data: async (): Promise<SiteDataSnapshot | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'data' } satisfies SiteInfoCommand)
      return (result ?? null) as SiteDataSnapshot | null
    },
    apply: async (changes: ReadonlyArray<{ capability: CapabilityKind, on: boolean, shownPatterns: readonly Pattern[] }>): Promise<ApplyResult | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'apply', changes } satisfies SiteInfoCommand)
      return (result ?? null) as ApplyResult | null
    },
    sitePermissions: async (): Promise<SitePermissionsView | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'sitePermissions' } satisfies SiteInfoCommand)
      return (result ?? null) as SitePermissionsView | null
    },
    setSitePermission: async (kind: string, value: string): Promise<SitePermissionsView | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'setSitePermission', kind, value } satisfies SiteInfoCommand)
      return (result ?? null) as SitePermissionsView | null
    },
    revokePickedPath: async (pickId: string): Promise<SiteInfo | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'revokePickedPath', pickId } satisfies SiteInfoCommand)
      return (result ?? null) as SiteInfo | null
    },
    /** Takes the update offered to this origin; main refuses any `cid` but the pending offer's. */
    applyUpdate: async (cid: string): Promise<ApplyOutcome> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'applyUpdate', cid } satisfies SiteInfoCommand)
      return (result ?? { ok: false, reason: 'no answer' }) as ApplyOutcome
    },
    /** The tunnel of the website or app: Nym, the person's proxy, or none. Main decides what it can do and answers the info after. On a tab's popup `shownOrigin` is the website the rows were drawn for, which main compares with the one the tab shows before it changes that website's entry. */
    setTunnel: async (kind: 'nym' | 'socks5' | null, shownOrigin?: string): Promise<TunnelResult | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'setTunnel', kind, ...(shownOrigin === undefined ? {} : { shownOrigin }) } satisfies SiteInfoCommand)
      return (result ?? null) as TunnelResult | null
    },
    /** "Always use for this site", on a tab's popup: `shownOrigin` is the website the panel was drawn for; main acts on the one the tab shows and refuses when they differ. */
    setSiteAlways: async (on: boolean, shownOrigin: string): Promise<TunnelResult | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'setSiteAlways', on, shownOrigin } satisfies SiteInfoCommand)
      return (result ?? null) as TunnelResult | null
    },
    /** The tunnel of the whole browser: Nym, the person's proxy, or none. Main decides what it can do and answers the info after. */
    setBrowserTunnel: async (kind: 'nym' | 'socks5' | null): Promise<TunnelResult | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'setBrowserTunnel', kind } satisfies SiteInfoCommand)
      return (result ?? null) as TunnelResult | null
    },
    /** Whether the IPFS and Swarm nodes follow the tunnel too. Main decides what it can do and answers the info after. */
    setNodesTunnel: async (on: boolean): Promise<TunnelResult | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'setNodesTunnel', on } satisfies SiteInfoCommand)
      return (result ?? null) as TunnelResult | null
    },
    /** Saves the address of the person's proxy. Main checks it as Settings does and answers why not, with the info after. */
    setProxyAddress: async (text: string): Promise<ProxyAddressResult | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'setProxyAddress', text } satisfies SiteInfoCommand)
      return (result ?? null) as ProxyAddressResult | null
    },
    /** Whether a tunnel answers. The answer is main's, read by the page with `resultOf`. */
    testTunnel: async (kind: 'nym' | 'socks5'): Promise<unknown> => await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'testTunnel', kind } satisfies SiteInfoCommand),
    openHome: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'openHome' } satisfies SiteInfoCommand)
    },
    openSupport: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'openSupport' } satisfies SiteInfoCommand)
    },
    clearBrowserData: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'clearBrowserData' } satisfies SiteInfoCommand)
    },
    removeCookie: async (key: string): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'removeCookie', key } satisfies SiteInfoCommand)
    },
    clearCookies: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'clearCookies' } satisfies SiteInfoCommand)
    },
    /** "Delete data" of the local file this popup was opened for; main reads which file. */
    deleteLocalFile: async (): Promise<boolean> => {
      return (await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'deleteLocalFile' } satisfies SiteInfoCommand)) === true
    },
    reload: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'reload' } satisfies SiteInfoCommand)
    },
    reviewPermissions: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'reviewPermissions' } satisfies SiteInfoCommand)
    },
    openSiteSettings: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'openSiteSettings' } satisfies SiteInfoCommand)
    },
    openTunnelSettings: async (everywhere: boolean): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'openTunnelSettings', everywhere } satisfies SiteInfoCommand)
    },
    openExtensions: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'openExtensions' } satisfies SiteInfoCommand)
    },
    openScoreHelp: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'openScoreHelp' } satisfies SiteInfoCommand)
    },
    openCertificate: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'certificate' } satisfies SiteInfoCommand)
    },
    /** Escape in the page: asks main to close the popup and hand the keyboard back to the tab. */
    close: (): void => {
      void ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'close' } satisfies SiteInfoCommand)
    },
    /** Fire-and-forget, same as settings.ts's own reportHeight -- a popup
     * that failed to resize is cosmetic, and must never break rendering. */
    reportHeight: (height: number): void => {
      void ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'contentHeight', height } satisfies SiteInfoCommand)
    },
    /** Read-only -- which page to render first, and the origin to show
     * before the first `get()` round trip resolves. Both come from the
     * SAME argv main already fixed the popup's origin from; nothing here
     * is a claim the page itself gets to make. */
    initialPage: page === 'web3' || page === 'tunnels' ? page : 'main',
    origin: origin ?? null
  })
}
