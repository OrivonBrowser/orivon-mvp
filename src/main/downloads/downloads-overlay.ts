// The downloads bubble under the toolbar button, and its peek: the same list, opened by a new download, that
// never takes focus. The page asks for actions by id; what a download is called and where it is stays here.
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { throttleChanges } from './change-throttle.js'
import { asBubbleRequest, bubbleRows } from './bubble-rows.js'
import type { BubbleById } from './bubble-rows.js'
import type { DownloadService } from './download-service.js'
import { PEEK_CONTROLLERS } from './peek-controller.js'
import { attentionFor } from './window-attention.js'

export const DOWNLOADS_OVERLAY = 'downloads'
export const DOWNLOADS_PEEK_OVERLAY = 'downloads-peek'
/** Live rows follow the list at this pace. */
const ROWS_INTERVAL_MS = 200

const BY_ID: Readonly<Record<Exclude<BubbleById, 'open' | 'showInFolder'>, (service: DownloadService, id: string) => boolean>> = {
  pause: (service, id) => service.pause(id),
  resume: (service, id) => service.resume(id),
  cancel: (service, id) => service.cancel(id),
  retry: (service, id) => service.retry(id),
  remove: (service, id) => service.remove(id),
  keep: (service, id) => service.keep(id),
  discard: (service, id) => service.discard(id)
}

export function createDownloadsBubble (win: OverlayWindow, peek: boolean): OverlayHandler {
  const { window, services } = win
  const { downloads } = services
  const controller = PEEK_CONTROLLERS.get(services)
  let unsubscribe: (() => void) | undefined

  /** Looking at the bubble is what clears the button's dot. */
  const markSeen = (): void => {
    attentionFor(window, downloads).seen()
    window.tabs.changed()
  }
  const sendRows = throttleChanges(() => {
    win.send({ type: 'rows', rows: bubbleRows(downloads.list()) })
    if (!peek) markSeen()
  }, ROWS_INTERVAL_MS)
  const stop = (): void => { unsubscribe?.(); unsubscribe = undefined; sendRows.cancel() }

  return {
    show: () => {
      stop()
      unsubscribe = downloads.onChange(sendRows)
      if (peek) controller?.opened(window)
      else markSeen()
      return { rows: bubbleRows(downloads.list()), peek }
    },
    request: async (command) => {
      const asked = asBubbleRequest(command)
      if (asked === undefined) return undefined
      if (!('id' in asked)) {
        if (asked.type === 'openPage') { win.close(); window.tabs.openInternal('downloads') } else controller?.pointer(window, asked.type === 'hold')
        return { ok: true }
      }
      const { id, type } = asked
      if (type !== 'open' && type !== 'showInFolder') return { ok: BY_ID[type](downloads, id) }
      const ok = type === 'open' ? await downloads.open(id) : downloads.showInFolder(id)
      if (ok) win.close()
      return { ok }
    },
    closed: () => {
      stop()
      controller?.closed(window)
    }
  }
}

const SHARED = {
  placement: { kind: 'anchor', width: 360, align: 'right' },
  surface: 'panel',
  layer: 'popup',
  keep: 'fresh',
  height: { initial: 160, min: 120, max: 460 }
} as const

export const downloadsOverlay: OverlayDef = {
  ...SHARED,
  name: DOWNLOADS_OVERLAY,
  focus: 'take',
  closeOn: CLOSE_LIKE_POPUP,
  attach: (win) => createDownloadsBubble(win, false)
}

/** It never holds focus, so a click inside it does not close it; it goes with a tab switch or a navigation, and its own timer. */
export const downloadsPeekOverlay: OverlayDef = {
  ...SHARED,
  name: DOWNLOADS_PEEK_OVERLAY,
  focus: 'never',
  closeOn: { blur: false, tabSwitch: true, navigation: true, layout: true },
  attach: (win) => createDownloadsBubble(win, true)
}
