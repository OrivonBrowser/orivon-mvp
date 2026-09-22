// The site-info popup's own command channel -- one page of Orivon
// capability switches, a Web3 Score page, and a Cookies and site data
// page, all for the ONE origin this popup was opened for. Mirrors
// ./settings-ipc.ts's sender-identity check exactly, against the site-info
// popup's own webContents instead of the all-sites panel's.
//
// THE ORIGIN IS FIXED AT CONSTRUCTION, NEVER A COMMAND FIELD. Every
// command below acts on exactly the `origin` this function was called
// with -- the same origin `../permissions/site-info-panel.js` derived
// before creating the popup, itself from the active tab, never from
// anything the popup's own page could claim about itself.

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { SITE_INFO_COMMAND_CHANNEL } from '../channels.js'
import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import type { SiteInfo } from '../permissions/site-info.js'
import type { SiteInfoController } from '../permissions/site-info-controller.js'
import type { SiteTrust } from '../browsing/site-trust.js'
import { browserStorageEstimateFor, cookieCountFor, orivonStorageFor } from '../permissions/site-data-runner.js'
import type { BrowserStorageEstimate } from '../permissions/site-data-runner.js'

export interface SiteDataSnapshot {
  readonly cookieCount: number
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
  | { type: 'revokePickedPath'; pickId: string }
  | { type: 'clearBrowserData' }
  | { type: 'reload' }
  | { type: 'openAllSites' }
  /** Same contract as ./settings-ipc.ts's own `contentHeight`. */
  | { type: 'contentHeight'; height: number }

function isFromSiteInfoWindow (event: IpcMainInvokeEvent, siteInfoWebContents: WebContents): boolean {
  return event.senderFrame !== null && event.senderFrame === siteInfoWebContents.mainFrame
}

async function collectSiteData (
  controller: SiteInfoController,
  origin: string,
  userDataPath: string,
  activeWebContents: () => WebContents | undefined
): Promise<SiteDataSnapshot> {
  const declaration = await controller.storageDeclarationFor(origin)
  const tab = activeWebContents()
  const [orivon, cookieCount, browserStorage] = await Promise.all([
    orivonStorageFor(userDataPath, origin, declaration?.filesQuotaBytes, declaration?.codeVersion),
    tab === undefined ? 0 : cookieCountFor(tab.session, origin),
    tab === undefined ? null : browserStorageEstimateFor(tab, origin)
  ])
  return {
    cookieCount,
    browserStorage,
    orivonFilesBytes: orivon.filesBytes,
    orivonFilesQuotaBytes: orivon.filesQuotaBytes,
    orivonCodeBytes: orivon.codeBytes,
    orivonCodeVersion: orivon.codeVersion
  }
}

export function registerSiteInfoIpc (
  siteInfoWebContents: WebContents,
  controller: SiteInfoController,
  origin: string,
  userDataPath: string,
  activeWebContents: () => WebContents | undefined,
  reloadActiveTab: () => void,
  openAllSites: () => void,
  onContentHeight: (height: number) => void = () => {}
): void {
  ipcMain.handle(SITE_INFO_COMMAND_CHANNEL, async (
    event: IpcMainInvokeEvent,
    command: SiteInfoCommand
  ): Promise<void | SiteInfo | SiteTrust | null | SiteDataSnapshot | ApplyResult> => {
    if (!isFromSiteInfoWindow(event, siteInfoWebContents)) return

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
      case 'reload':
        reloadActiveTab()
        return
      case 'openAllSites':
        openAllSites()
        return
      case 'contentHeight':
        if (Number.isFinite(command.height)) onContentHeight(command.height)
        return
    }
  })
}
