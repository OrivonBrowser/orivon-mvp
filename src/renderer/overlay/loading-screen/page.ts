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
  const { title, detail, address, busy } = value as Record<string, unknown>
  return typeof title === 'string' && typeof detail === 'string' && typeof address === 'string' && typeof busy === 'boolean'
}

/** Main sends this when a scheme it learned changes what the address reads. */
function viewOfEvent (event: unknown): LoadingScreenView | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const { type, view } = event as { type?: unknown, view?: unknown }
  return type === 'view' && isLoadingScreenView(view) ? view : undefined
}

export const loadingScreenPage: OverlayPage = {
  mount (content, overlay) {
    const column = h('div', { className: 'loading-screen', role: 'status' })
    column.setAttribute('aria-live', 'polite')
    column.setAttribute('aria-busy', 'true')
    content.append(column)
    const draw = (view: LoadingScreenView): void => {
      column.setAttribute('aria-busy', String(view.busy))
      column.replaceChildren(
        h('p', { className: 'loading-screen-title' }, view.title),
        h('p', { className: 'loading-screen-address', title: view.address }, shortenMiddle(view.address, ADDRESS_FIT)),
        ...(view.busy ? [h('div', { className: 'loading-screen-bar', ariaHidden: 'true' }, h('span', { className: 'loading-screen-slide' }))] : []),
        ...(view.detail === '' ? [] : [h('p', { className: 'loading-screen-detail' }, view.detail)]))
    }
    overlay.onEvent((event) => {
      const view = viewOfEvent(event)
      if (view !== undefined) draw(view)
    })
    return {
      shown (payload) {
        if (!isLoadingScreenView(payload)) { overlay.close(); return }
        draw(payload)
      }
    }
  }
}
