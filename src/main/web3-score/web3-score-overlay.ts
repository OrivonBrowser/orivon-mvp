// The card the Web3 Score shield opens on a new tab, where there is no site to score: what the shield will show and
// what each level means. The page asks for one of two things, the provider setting or the page that explains scores.
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'

/** Also the press button the shield stamps on a new tab (../shell/press-stamps.ts). */
export const WEB3_SCORE_OVERLAY = 'web3-score'

export const WEB3_SCORES_PAGE = 'https://docs.orivonstack.com/docs/implementations/web3-score'

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
    show: () => ({}),
    request: (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type === 'provider') {
        close()
        window.tabs.openInternal('settings', '/web3')
      } else if (type === 'learn') {
        close()
        window.tabs.createTab(WEB3_SCORES_PAGE)
      }
      return undefined
    }
  })
}
