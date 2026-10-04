// The sheet over a page that failed to load: what went wrong, the address, the error's short name and Try again.
// Main sends every string; the page only names its one button.
import type { LoadErrorView } from '../../../main/sad-tab/load-error-overlay.js'
import { h } from '../../pages/shared/dom.js'
import { warningIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { shortenMiddle } from '../sad-tab/address.js'
import './load-error.css'

/** What fits on one line of the sheet at its width. */
const ADDRESS_FIT = 52

export function isLoadErrorView (value: unknown): value is LoadErrorView {
  if (typeof value !== 'object' || value === null) return false
  const { title, body, address, name } = value as Record<string, unknown>
  return typeof title === 'string' && typeof body === 'string' && typeof address === 'string' && typeof name === 'string'
}

export const loadErrorPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const card = h('div', { className: 'load-error', role: 'alertdialog' })
    content.append(card)
    return {
      shown (payload) {
        if (!isLoadErrorView(payload)) { overlay.close(); return }
        const retry = h('button', { type: 'button', className: 'btn primary' }, 'Try again')
        retry.addEventListener('click', () => { void overlay.request({ type: 'retry' }) })
        card.setAttribute('aria-labelledby', 'load-error-title')
        card.setAttribute('aria-describedby', 'load-error-text')
        card.replaceChildren(
          h('span', { className: 'load-error-icon' }, warningIcon()),
          h('h1', { className: 'sheet-title', id: 'load-error-title' }, payload.title),
          ...(payload.address === '' ? [] : [h('p', { className: 'origin load-error-address', title: payload.address }, shortenMiddle(payload.address, ADDRESS_FIT))]),
          h('p', { className: 'load-error-text', id: 'load-error-text' }, payload.body),
          ...(payload.name === '' ? [] : [h('p', { className: 'load-error-name' }, payload.name)]),
          h('div', { className: 'btn-row' }, retry))
        retry.focus()
      }
    }
  }
}
