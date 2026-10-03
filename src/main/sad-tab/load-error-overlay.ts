// The sheet over a tab whose page failed to load: what went wrong, the address, and Try again. The page sends one
// fixed word; the tab is the one main named when it showed the sheet.
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { slotClosed } from '../overlays/tab-slots.js'
import { ADDRESS_LIMIT } from './sad-tab-text.js'
import { isErrorName, loadErrorText } from './load-error-text.js'
import { LOAD_ERROR_OVERLAY } from './load-error-watch.js'

export interface LoadErrorView {
  readonly title: string
  readonly body: string
  readonly address: string
  /** Chromium's short name for the error, or empty. */
  readonly name: string
}

function asPayload (payload: unknown): { code: number, name: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { code, name } = payload as { code?: unknown, name?: unknown }
  if (typeof code !== 'number' || !Number.isInteger(code) || code >= 0 || (name !== '' && !isErrorName(name))) return undefined
  return { code, name }
}

export const loadErrorOverlay: OverlayDef = {
  name: LOAD_ERROR_OVERLAY,
  placement: { kind: 'area', at: 'center', width: 420 },
  surface: 'panel',
  focus: 'take',
  layer: 'bar',
  // The failed page is what the tab's address now says, so the address changing is not the person leaving it: the
  // watcher takes the sheet away when the tab starts a navigation of its own.
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { min: 160, max: 320 },
  attach: ({ window, close }: OverlayWindow): OverlayHandler => {
    let tabId: string | null = null
    return {
      show: (payload): LoadErrorView | undefined => {
        const asked = asPayload(payload)
        const state = window.tabs.getState()
        tabId = asked === undefined ? null : state.activeTabId
        if (asked === undefined) return undefined
        const address = state.tabs.find((tab) => tab.id === tabId)?.displayUrl ?? ''
        return { ...loadErrorText(asked.code), address: address.slice(0, ADDRESS_LIMIT), name: asked.name }
      },
      request: (command) => {
        if (typeof command !== 'object' || command === null || (command as { type?: unknown }).type !== 'retry' || Object.keys(command).length !== 1) return undefined
        const id = tabId
        if (id === null || window.tabs.getState().activeTabId !== id) return undefined
        close()
        window.tabs.reload(id)
        return undefined
      },
      closed: (reason) => {
        tabId = null
        slotClosed(window, LOAD_ERROR_OVERLAY, reason)
      }
    }
  }
}
