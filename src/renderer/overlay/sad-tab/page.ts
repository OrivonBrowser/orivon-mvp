// The sad-tab card: what happened to the page, the page's address, and the way back. Main sends the whole card on
// every show and decides what each button does; the page only names a button.
import type { SadTabView } from '../../../main/sad-tab/sad-tab-overlay.js'
import { h } from '../../pages/shared/dom.js'
import { warningIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { shortenMiddle } from './address.js'
import './sad-tab.css'

/** What fits on one line of the card at its width. */
const ADDRESS_FIT = 52

const isView = (value: unknown): value is SadTabView => {
  if (typeof value !== 'object' || value === null) return false
  const { kind, title, body, address } = value as Record<string, unknown>
  return (kind === 'crashed' || kind === 'unresponsive') && typeof title === 'string' && typeof body === 'string' && typeof address === 'string'
}

export const sadTabPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    // There is no page to return to: Escape must not close the card and leave a blank view.
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') event.preventDefault() }, true)

    const card = h('div', { className: 'sad', role: 'dialog' })
    content.append(card)
    const ask = (type: 'reload' | 'close-tab' | 'wait'): void => { void overlay.request({ type }) }

    return {
      shown (payload) {
        if (!isView(payload)) { overlay.close(); return }
        const title = h('h1', { className: 'sheet-title', id: 'sad-title' }, payload.title)
        const body = h('p', { className: 'sad-body', id: 'sad-body' }, payload.body)
        card.setAttribute('aria-labelledby', 'sad-title')
        card.setAttribute('aria-describedby', 'sad-body')
        const reload = h('button', { type: 'button', className: 'btn primary', onclick: () => { ask('reload') } }, 'Reload')
        const other = payload.kind === 'crashed'
          ? h('button', { type: 'button', className: 'btn', onclick: () => { ask('close-tab') } }, 'Close tab')
          : h('button', { type: 'button', className: 'btn', onclick: () => { ask('wait') } }, 'Wait')
        card.replaceChildren(
          h('span', { className: 'sad-icon' }, warningIcon()),
          title,
          body,
          ...(payload.address === '' ? [] : [h('p', { className: 'origin sad-address', title: payload.address }, shortenMiddle(payload.address, ADDRESS_FIT))]),
          h('div', { className: 'btn-row' }, other, reload)
        )
        reload.focus()
      }
    }
  }
}
