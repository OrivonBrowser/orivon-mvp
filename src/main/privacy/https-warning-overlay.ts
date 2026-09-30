// The sheet over a tab whose upgraded HTTPS load failed: the host, what the
// person risks, and two ways out. The page names one of two fixed words; the
// address "continue" opens is the one main kept when it showed the sheet, so
// a page cannot steer the tab somewhere else.
import { slotClosed } from '../overlays/tab-slots.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { httpsState } from './https-state.js'
import type { HttpsState } from './https-state.js'

export const HTTPS_WARNING_OVERLAY = 'https-warning'

/** What the sheet is told on each show. */
export interface HttpsWarningView {
  readonly host: string
  /** False when "go back" would have nowhere to go, so the button closes the tab and says so. */
  readonly canGoBack: boolean
}

export type HttpsWarningCommand = 'proceed' | 'back'

function asCommand (command: unknown): HttpsWarningCommand | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, ...rest } = command as Record<string, unknown>
  if (Object.keys(rest).length > 0) return undefined
  return type === 'proceed' || type === 'back' ? type : undefined
}

function asTabId (payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { tabId } = payload as { tabId?: unknown }
  return typeof tabId === 'string' ? tabId : undefined
}

export function createHttpsWarning ({ window, close }: OverlayWindow, state: HttpsState = httpsState): OverlayHandler {
  /** The tab the sheet is about. */
  let tabId: string | null = null

  return {
    show: (payload): HttpsWarningView | undefined => {
      const id = asTabId(payload)
      const failed = id === undefined ? undefined : state.failed.get(id)
      if (id === undefined || failed === undefined) { tabId = null; return undefined }
      tabId = id
      return { host: failed.host, canGoBack: window.tabs.liveWebContents(id)?.navigationHistory.canGoBack() === true }
    },
    request: (command) => {
      const asked = asCommand(command)
      const id = tabId
      if (asked === undefined || id === null) return undefined
      const failed = state.failed.get(id)
      if (failed === undefined) { close(); return undefined }
      if (asked === 'proceed') {
        state.exemptions.add(failed.host)
        close()
        window.tabs.navigate(id, failed.from)
        return undefined
      }
      const canGoBack = window.tabs.liveWebContents(id)?.navigationHistory.canGoBack() === true
      close()
      if (canGoBack) window.tabs.back(id)
      else window.tabs.closeTab(id)
      return undefined
    },
    closed: (reason) => {
      tabId = null
      slotClosed(window, HTTPS_WARNING_OVERLAY, reason)
    }
  }
}

export const httpsWarningOverlay: OverlayDef = {
  name: HTTPS_WARNING_OVERLAY,
  placement: { kind: 'area', at: 'center', width: 440 },
  surface: 'panel',
  focus: 'take',
  layer: 'bar',
  // A sheet belongs to one tab, so only a tab switch hides it. A new page in the tab ends it, but the
  // host's navigation close also fires for the failed page's own address change, so the fallback ends it.
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { min: 160, max: 340 },
  attach: (win) => createHttpsWarning(win)
}
