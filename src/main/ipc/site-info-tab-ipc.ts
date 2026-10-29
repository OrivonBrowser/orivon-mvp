// The tunnel popup's command channel when it was opened for a TAB (`../permissions/site-info-tab.ts`): every website the tab
// opens goes through the tunnel the person picks. The same sender-identity check as `./site-info-ipc.ts`, and the same
// rule: THE TAB IS FIXED AT CONSTRUCTION, NEVER A COMMAND FIELD. Only the commands the tunnels page sends are answered;
// everything else a site's popup answers (capability switches, cookies, the Web3 Score, the update offer) is not
// registered here at all, so a command naming one gets nothing.

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { SITE_INFO_COMMAND_CHANNEL } from '../channels.js'
import type { SiteInfo } from '../permissions/site-info.js'
import type { SiteInfoController } from '../permissions/site-info-controller.js'
import type { ProxyTestReply } from '../route/route-domain.js'
import { isFromSiteInfoWindow } from './site-info-ipc.js'
import type { ProxyAddressResult, SiteInfoCommand, TunnelResult } from './site-info-ipc.js'

export function registerSiteInfoTabIpc (
  siteInfoWebContents: WebContents,
  popupUrl: string,
  controller: SiteInfoController,
  tabId: string,
  openSettings: (path?: string) => void,
  onContentHeight: (height: number) => void = () => {},
  closePopup: () => void = () => {}
): void {
  siteInfoWebContents.ipc.handle(SITE_INFO_COMMAND_CHANNEL, async (
    event: IpcMainInvokeEvent,
    command: SiteInfoCommand
  ): Promise<void | SiteInfo | TunnelResult | ProxyAddressResult | ProxyTestReply | null> => {
    if (!isFromSiteInfoWindow(event, siteInfoWebContents, popupUrl)) return
    // The tab may be gone when a command arrives: nothing then has an answer to draw.
    const info = controller.tabInfoFor(tabId)

    switch (command.type) {
      case 'get':
        return info
      case 'setTunnel': {
        if (info === undefined) return
        if (command.kind !== null && command.kind !== 'nym' && command.kind !== 'socks5') return { ok: false, info } satisfies TunnelResult
        const ok = controller.setTabTunnel(tabId, command.kind)
        return { ok, info: ok ? controller.tabInfoFor(tabId) ?? info : info } satisfies TunnelResult
      }
      case 'setProxyAddress': {
        if (info === undefined) return
        if (typeof command.text !== 'string') return { ok: false, reason: 'invalid', info } satisfies ProxyAddressResult
        const saved = controller.setProxyAddress(command.text)
        return { ok: saved === 'ok', ...(saved === 'ok' ? {} : { reason: saved }), info: controller.tabInfoFor(tabId) ?? info } satisfies ProxyAddressResult
      }
      case 'testTunnel':
        return command.kind === 'nym' || command.kind === 'socks5' ? await controller.testTunnel(command.kind) : null
      case 'openTunnelSettings':
        openSettings(command.everywhere === true ? '/tunnels#route-everywhere' : '/tunnels')
        return
      case 'contentHeight':
        if (Number.isFinite(command.height)) onContentHeight(command.height)
        return
      case 'close':
        // After the reply: this popup's close destroys the webContents, which would drop an invoke still waiting.
        setImmediate(closePopup)
        return
      default:
        return
    }
  })
}
