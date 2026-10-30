// The tunnel popup's command channel when it was opened for a TAB (`../permissions/site-info-tab.ts`): every website the tab
// opens goes through the tunnel the person picks. The same sender-identity check as `./site-info-ipc.ts`, and the same
// rule: THE TAB IS FIXED AT CONSTRUCTION, NEVER A COMMAND FIELD. Only the commands the tunnels page sends are answered;
// everything else a site's popup answers (capability switches, cookies, the Web3 Score, the update offer) is not
// registered here at all, so a command naming one gets nothing. The website a tab shows is read from the tab when a command
// arrives, never from the popup: `shownOrigin` only says which website the popup drew, so that a change of a website's own
// entry fails closed when the tab has moved on since (a tab popup stays open across a navigation).

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { SITE_INFO_COMMAND_CHANNEL } from '../channels.js'
import type { SiteInfo } from '../permissions/site-info.js'
import type { SiteInfoController } from '../permissions/site-info-controller.js'
import type { ProxyTestReply } from '../route/route-domain.js'
import { isFromSiteInfoWindow } from './site-info-ipc.js'
import type { ProxyAddressResult, SiteInfoCommand, TunnelResult } from './site-info-ipc.js'

/** The commands whose answer is the popup's info as it is now, and which change nothing about the tab: the others (closing, sizing, a test of the proxy) never wait for it. */
const ANSWERS_WITH_INFO: ReadonlySet<string> = new Set(['get', 'setBrowserTunnel', 'setNodesTunnel', 'setProxyAddress'])

export function registerSiteInfoTabIpc (
  siteInfoWebContents: WebContents,
  popupUrl: string,
  controller: SiteInfoController,
  tabId: string,
  openSettings: (path?: string) => void,
  onContentHeight: (height: number) => void = () => {},
  closePopup: () => void = () => {}
): void {
  let last: Promise<unknown> = Promise.resolve()
  const inOrder = async <T>(job: () => Promise<T>): Promise<T> => {
    const run = last.then(job, job)
    last = run.catch(() => undefined)
    return await run
  }
  siteInfoWebContents.ipc.handle(SITE_INFO_COMMAND_CHANNEL, async (
    event: IpcMainInvokeEvent,
    command: SiteInfoCommand
  ): Promise<void | SiteInfo | TunnelResult | ProxyAddressResult | ProxyTestReply | null> => {
    if (!isFromSiteInfoWindow(event, siteInfoWebContents, popupUrl)) return
    // The tab may be gone when a command arrives: nothing then has an answer to draw. The tunnel of the whole browser is part of what is drawn.
    const infoNow = async (): Promise<SiteInfo | undefined> => {
      const now = await controller.tabInfoFor(tabId)
      return now === undefined ? undefined : controller.withBrowserTunnel(now)
    }
    // The commands that change the tab or the website's entry go one at a time in the order they arrived: each reads what the one before left, and the answer to it is what the popup draws next.
    if (command.type === 'setTunnel' || command.type === 'setSiteAlways') {
      const change = command
      return await inOrder(async (): Promise<TunnelResult | undefined> => {
        const info = await infoNow()
        if (info === undefined) return undefined
        // Read again whether it was done or not: a move that could not be made gave the tab its choice back, and the rows show what is true.
        const answer = async (ok: boolean): Promise<TunnelResult> => ({ ok, info: await infoNow() ?? info })
        if (change.type === 'setTunnel') {
          if (change.kind !== null && change.kind !== 'nym' && change.kind !== 'socks5') return { ok: false, info }
          return await answer(await controller.setTabTunnel(tabId, change.kind, typeof change.shownOrigin === 'string' ? change.shownOrigin : ''))
        }
        return await answer(typeof change.on === 'boolean' && typeof change.shownOrigin === 'string' && await controller.setSiteAlways(tabId, change.on, change.shownOrigin))
      })
    }
    const info = ANSWERS_WITH_INFO.has(command.type) ? await infoNow() : undefined

    switch (command.type) {
      case 'get':
        return info
      case 'setBrowserTunnel': {
        if (info === undefined) return
        if (command.kind !== null && command.kind !== 'nym' && command.kind !== 'socks5') return { ok: false, info } satisfies TunnelResult
        const ok = controller.setBrowserTunnel(command.kind)
        return { ok, info: await infoNow() ?? info } satisfies TunnelResult
      }
      case 'setNodesTunnel': {
        if (info === undefined) return
        const ok = typeof command.on === 'boolean' && controller.setNodesTunnel(command.on)
        return { ok, info: await infoNow() ?? info } satisfies TunnelResult
      }
      case 'setProxyAddress': {
        if (info === undefined) return
        if (typeof command.text !== 'string') return { ok: false, reason: 'invalid', info } satisfies ProxyAddressResult
        const saved = controller.setProxyAddress(command.text)
        return { ok: saved === 'ok', ...(saved === 'ok' ? {} : { reason: saved }), info: await infoNow() ?? info } satisfies ProxyAddressResult
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
