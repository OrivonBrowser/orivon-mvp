// The card over a tab whose page crashed or stopped answering: what happened, the page's address and the way
// back. The page sends one of three fixed words and no id; the tab is the one main named when it showed the card.
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { cardClosed, SAD_TAB_OVERLAY } from './sad-tab-controller.js'
import { waiveUnresponsive, troubleOf } from './sad-tab-state.js'
import { ADDRESS_LIMIT, textFor, UNRESPONSIVE_TEXT } from './sad-tab-text.js'

/** What the card is told on each show. */
export interface SadTabView {
  readonly kind: 'crashed' | 'unresponsive'
  readonly title: string
  readonly body: string
  readonly address: string
}

export type SadTabCommand = 'reload' | 'close-tab' | 'wait'

function asCommand (command: unknown): SadTabCommand | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, ...rest } = command as Record<string, unknown>
  if (Object.keys(rest).length > 0) return undefined
  return type === 'reload' || type === 'close-tab' || type === 'wait' ? type : undefined
}

function asTabId (payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { id } = payload as { id?: unknown }
  return typeof id === 'string' ? id : undefined
}

export function createSadTab ({ window, close }: OverlayWindow): OverlayHandler {
  /** The tab the card is about. */
  let tabId: string | null = null

  return {
    show: (payload): SadTabView | undefined => {
      const id = asTabId(payload)
      const record = id === undefined ? undefined : window.tabs.record(id)
      const trouble = record === undefined ? null : troubleOf(record)
      if (id === undefined || trouble === null) { tabId = null; return undefined }
      tabId = id
      const text = trouble.kind === 'crashed' ? textFor(trouble.reason) : UNRESPONSIVE_TEXT
      const address = window.tabs.getState().tabs.find((tab) => tab.id === id)?.displayUrl ?? ''
      return { kind: trouble.kind, ...text, address: address.slice(0, ADDRESS_LIMIT) }
    },
    request: (command) => {
      const asked = asCommand(command)
      const id = tabId
      if (asked === undefined || id === null) return undefined
      const record = window.tabs.record(id)
      const wc = window.tabs.liveWebContents(id)
      if (record === undefined || wc === undefined) { close(); return undefined }
      if (asked === 'reload') {
        wc.reload()
        close()
      } else if (asked === 'close-tab') {
        close()
        window.tabs.closeTab(id)
      } else {
        waiveUnresponsive(record)
        close()
      }
      return undefined
    },
    closed: () => {
      tabId = null
      cardClosed(window)
    }
  }
}

export const sadTabOverlay: OverlayDef = {
  name: SAD_TAB_OVERLAY,
  placement: { kind: 'area', at: 'center', width: 420 },
  surface: 'panel',
  focus: 'take',
  layer: 'bar',
  // There is no page to return to, so nothing closes it but a tab switch or the way back; a resize only re-centres it.
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { min: 160, max: 320 },
  attach: createSadTab
}
