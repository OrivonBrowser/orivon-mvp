// The bubble under the pop-up chip: what the page in front tried to open and
// was refused, a way to open one of those on purpose, and the choice to keep
// blocking or always allow this site. The page names a row by position; the
// address, the site and the tab are always read here, in main.
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { commandById } from '../shortcuts/commands.js'
import { asPopupsCommand, popupsView } from './popups-view.js'
import type { PopupsView } from './popups-view.js'
import { popupBlocks } from './site-popups.js'
import type { PopupBlocks } from './popup-blocks.js'

export const POPUPS_BLOCKED_OVERLAY = 'popups-blocked'
const WIDTH = 340

export function createPopupsBubble ({ window, services, close }: OverlayWindow, blocks: PopupBlocks<WebContents> = popupBlocks): OverlayHandler {
  /** The tab the bubble is about, and the addresses it listed, as they were when it opened. */
  let shown: { tabId: string, origin: string, urls: readonly string[] } | undefined

  /** The tab in front, while it is still the one the bubble was opened for and on the site it listed. */
  function current (): { wc: WebContents, origin: string, urls: readonly string[] } | undefined {
    if (shown === undefined || window.tabs.getState().activeTabId !== shown.tabId) return undefined
    const wc = window.tabs.liveWebContents(shown.tabId)
    if (wc === undefined || originFromUrl(wc.getURL()) !== shown.origin) return undefined
    return { wc, origin: shown.origin, urls: shown.urls }
  }

  return {
    show: (): PopupsView | undefined => {
      shown = undefined
      const tabId = window.tabs.getState().activeTabId
      const wc = tabId === null ? undefined : window.tabs.liveWebContents(tabId)
      if (tabId === null || wc === undefined) return undefined
      const origin = originFromUrl(wc.getURL())
      const urls = blocks.list(wc)
      if (origin === null || urls.length === 0) return undefined
      shown = { tabId, origin, urls }
      return popupsView(origin, urls, services.siteSettings.get(origin, 'popups') === 'allow', commandById('siteSettings.open')?.pending !== true)
    },

    request: (command) => {
      const asked = asPopupsCommand(command)
      const open = asked === undefined ? undefined : current()
      if (asked === undefined || open === undefined) return undefined
      if (asked.type === 'open') {
        const url = open.urls[asked.index]
        if (url === undefined) return undefined
        // A deliberate act: the address goes through the ordinary tab pipeline, which refuses what no tab may open.
        close()
        window.tabs.createTab(url)
      } else if (asked.type === 'apply') {
        if (asked.allow) services.siteSettings.set(open.origin, 'popups', 'allow')
        else services.siteSettings.forget(open.origin, 'popups')
        close()
      } else {
        if (commandById('siteSettings.open')?.pending === true) return undefined
        close()
        services.commands.run('siteSettings.open', window)
      }
      return undefined
    },

    closed: () => { shown = undefined }
  }
}

export const popupsBlockedOverlay: OverlayDef = {
  name: POPUPS_BLOCKED_OVERLAY,
  placement: { kind: 'anchor', width: WIDTH, align: 'left' },
  surface: 'panel',
  layer: 'popup',
  focus: 'take',
  closeOn: CLOSE_LIKE_POPUP,
  keep: 'fresh',
  height: { initial: 280, min: 180, max: 460 },
  attach: (win) => createPopupsBubble(win)
}
