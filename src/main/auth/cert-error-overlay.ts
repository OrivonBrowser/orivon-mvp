// The sheet over a tab whose page failed on its certificate: what is wrong, in a sentence, and the way back.
// There is no way on: the person is never offered to trust a certificate nobody vouches for. The page sends one
// fixed word; the tab is the one main named when it showed the sheet.
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { slotClosed } from '../overlays/tab-slots.js'
import { goHome } from '../shell/home.js'
import { CERT_ERROR_OVERLAY } from './auth-names.js'
import { certErrorText, isCertError, MAX_HOST } from './cert-error-text.js'

export interface CertErrorView {
  readonly host: string
  readonly text: string
}

function asPayload (payload: unknown): { host: string, code: number } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { host, code } = payload as { host?: unknown, code?: unknown }
  if (typeof host !== 'string' || host === '' || host.length > MAX_HOST || typeof code !== 'number' || !isCertError(code)) return undefined
  return { host, code }
}

export const certErrorOverlay: OverlayDef = {
  name: CERT_ERROR_OVERLAY,
  placement: { kind: 'area', at: 'center', width: 420 },
  surface: 'panel',
  focus: 'take',
  layer: 'bar',
  // The failed page is what the tab's address now says, so the address changing is not the person leaving it: the
  // watcher takes the sheet away when the tab starts a navigation of its own. A click elsewhere does not dismiss it.
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { min: 200, max: 360 },
  attach: ({ window, services, close }: OverlayWindow): OverlayHandler => {
    let tabId: string | null = null
    return {
      show: (payload): CertErrorView | undefined => {
        const asked = asPayload(payload)
        tabId = asked === undefined ? null : window.tabs.getState().activeTabId
        return asked === undefined ? undefined : { host: asked.host, text: certErrorText(asked.code) }
      },
      request: (command) => {
        if (typeof command !== 'object' || command === null || (command as { type?: unknown }).type !== 'back' || Object.keys(command).length !== 1) return undefined
        const id = tabId
        if (id === null || window.tabs.getState().activeTabId !== id) return undefined
        close()
        const tab = window.tabs.getState().tabs.find((candidate) => candidate.id === id)
        if (tab?.canGoBack === true) window.tabs.back(id)
        else goHome(window.tabs, services.settings, { newTab: false })
        return undefined
      },
      closed: (reason) => {
        tabId = null
        slotClosed(window, CERT_ERROR_OVERLAY, reason)
      }
    }
  }
}
