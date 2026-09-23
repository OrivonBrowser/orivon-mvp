import { contextBridge, ipcRenderer } from 'electron'
import { SITE_INFO_COMMAND_CHANNEL } from '../main/channels.js'
import type { ApplyResult, SiteDataSnapshot, SiteInfoCommand } from '../main/ipc/site-info-ipc.js'
import type { SiteInfo } from '../main/permissions/site-info.js'
import type { SiteTrust } from '../main/browsing/site-trust.js'
import type { CapabilityKind, Pattern } from '../contracts/index.js'

// Loaded ONLY by the site-info popup's own WebContentsView
// (src/main/permissions/site-info-panel.ts). Same defense-in-depth as
// src/preload/settings.ts: this page never navigates anywhere else, but the
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
    revokePickedPath: async (pickId: string): Promise<SiteInfo | null> => {
      const result: unknown = await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'revokePickedPath', pickId } satisfies SiteInfoCommand)
      return (result ?? null) as SiteInfo | null
    },
    clearBrowserData: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'clearBrowserData' } satisfies SiteInfoCommand)
    },
    reload: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'reload' } satisfies SiteInfoCommand)
    },
    openAllSites: async (): Promise<void> => {
      await ipcRenderer.invoke(SITE_INFO_COMMAND_CHANNEL, { type: 'openAllSites' } satisfies SiteInfoCommand)
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
    initialPage: page === 'web3' ? 'web3' : 'main',
    origin: origin ?? null
  })
}
