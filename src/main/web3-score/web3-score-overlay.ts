// The card the Web3 Score shield opens on a new tab and every Web mark of the address bar opens on a site: what the
// shield shows and what each level means. A mark says which level its site is at, and the card marks that row. The
// page asks for one of two things, the provider setting or the page that explains scores.
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { openWeb3ScoreHelp } from './web3-score-help.js'

/** Also the press button the shield stamps on a new tab (../shell/press-stamps.ts). */
export const WEB3_SCORE_OVERLAY = 'web3-score'

/** The level of the site a mark was clicked on: `unscored` is a Level 2 no provider has judged, the gray Web?. */
export interface ThisSite { level: 1 | 2 | 3 | 4, unscored: boolean }

/** The chrome's payload is unvalidated: only a level from 1 to 4 counts, and `unscored` only on Level 2. */
export function thisSiteOf (payload: unknown): ThisSite | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { level, unscored } = payload as { level?: unknown, unscored?: unknown }
  if (level !== 1 && level !== 2 && level !== 3 && level !== 4) return undefined
  return { level, unscored: level === 2 && unscored === true }
}

const WIDTH = 360

export const web3ScoreOverlay: OverlayDef = {
  name: WEB3_SCORE_OVERLAY,
  placement: { kind: 'anchor', width: WIDTH, align: 'left' },
  surface: 'panel',
  focus: 'take',
  layer: 'popup',
  closeOn: CLOSE_LIKE_POPUP,
  keep: 'fresh',
  height: { initial: 420, max: 560 },
  attach: ({ window, close }) => ({
    show: (payload) => ({ site: thisSiteOf(payload) }),
    request: (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type === 'provider') {
        close()
        window.tabs.openInternal('settings', '/web3')
      } else if (type === 'learn') {
        close()
        openWeb3ScoreHelp(window.tabs)
      }
      return undefined
    }
  })
}
