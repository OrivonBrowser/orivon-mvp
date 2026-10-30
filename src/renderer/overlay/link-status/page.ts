// The link bubble: the address a link goes to, in one line. Main sends the text, the corner, the most the bubble may
// be wide and how far the view reaches past what shows; the page fits the text to that room (the end of the host is
// never what is cut), draws it, measures how wide it is and says so, and main sizes the view to that and only then
// lets it be seen. A pointer that enters it is told to main, which moves it out of the way.
import type { BubbleSide, LinkStatusView } from '../../../main/link-status/link-status-view.js'
import { h } from '../../pages/shared/dom.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { fitAddress } from './fit-address.js'
import './link-status.css'

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

function isView (value: unknown): value is LinkStatusView {
  if (typeof value !== 'object' || value === null) return false
  const { seq, text, side, room, inset } = value as Record<string, unknown>
  if (typeof seq !== 'number' || typeof text !== 'string' || (side !== 'left' && side !== 'right') || !isNumber(room)) return false
  if (typeof inset !== 'object' || inset === null) return false
  const { left, right } = inset as Record<string, unknown>
  return isNumber(left) && isNumber(right)
}

export const linkStatusPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    // `dir` keeps an address that reads right to left (a path of Hebrew letters) from pulling the scheme to the far end.
    const bubble = h('div', { className: 'link-status', dir: 'ltr' })
    // The same text, as wide as it wants to be and never seen: the bubble itself is held to the view's width.
    const probe = h('div', { className: 'link-status link-status-probe', dir: 'ltr' })
    probe.setAttribute('aria-hidden', 'true')
    content.append(bubble, probe)
    const body = document.body
    body.addEventListener('pointerenter', () => { void overlay.request({ type: 'pointer' }) })

    // What was drawn for which text and room: the same again is only measured and answered, not fitted once more.
    let drawn = ''
    const draw = (view: LinkStatusView): void => {
      const side: BubbleSide = view.side
      body.dataset['side'] = side
      body.style.setProperty('--inset-left', `${String(view.inset.left)}px`)
      body.style.setProperty('--inset-right', `${String(view.inset.right)}px`)
      const key = `${String(view.room)}|${view.text}`
      if (key !== drawn) {
        drawn = key
        const fits = (candidate: string): boolean => {
          probe.textContent = candidate
          return probe.getBoundingClientRect().width <= view.room
        }
        const fitted = fitAddress(view.text, fits)
        bubble.textContent = fitted
        probe.textContent = fitted
      }
      void overlay.request({ type: 'width', seq: view.seq, width: Math.ceil(probe.getBoundingClientRect().width) })
    }
    overlay.onEvent((event) => { if (isView(event)) draw(event) })
    return { shown: (payload) => { if (isView(payload)) draw(payload) } }
  }
}
