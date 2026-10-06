// What shows over a page while its protocol loads it: a title, the address, a slim moving bar and a line of detail.
// Main sends every string; the page has no button and asks for nothing.
import type { LoadingScreenView } from '../../../main/loading-screen/loading-screen-overlay.js'
import { h } from '../../pages/shared/dom.js'
import type { OverlayPage } from '../kit.js'
import { shortenMiddle } from '../sad-tab/address.js'
import './loading-screen.css'

/** What fits on one line of the column at its width. */
const ADDRESS_FIT = 44

export function isLoadingScreenView (value: unknown): value is LoadingScreenView {
  if (typeof value !== 'object' || value === null) return false
  const { title, detail, address } = value as Record<string, unknown>
  return typeof title === 'string' && typeof detail === 'string' && typeof address === 'string'
}

export const loadingScreenPage: OverlayPage = {
  mount (content, overlay) {
    const column = h('div', { className: 'loading-screen', role: 'status' })
    column.setAttribute('aria-live', 'polite')
    column.setAttribute('aria-busy', 'true')
    content.append(column)
    return {
      shown (payload) {
        if (!isLoadingScreenView(payload)) { overlay.close(); return }
        column.replaceChildren(
          h('p', { className: 'loading-screen-title' }, payload.title),
          h('p', { className: 'loading-screen-address', title: payload.address }, shortenMiddle(payload.address, ADDRESS_FIT)),
          h('div', { className: 'loading-screen-bar', ariaHidden: 'true' }, h('span', { className: 'loading-screen-slide' })),
          ...(payload.detail === '' ? [] : [h('p', { className: 'loading-screen-detail' }, payload.detail)]))
      }
    }
  }
}
