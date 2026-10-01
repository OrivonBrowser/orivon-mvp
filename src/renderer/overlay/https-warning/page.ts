// The HTTPS warning sheet: the host, what is at risk, and two ways out. Main sends the whole sheet on every
// show and decides what each button does; the page only names a button. Escape is "go back".
import { h } from '../../pages/shared/dom.js'
import { warningIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { backLabel, BODY, CONTINUE_LABEL, isView, TITLE } from './model.js'
import './https-warning.css'

export const httpsWarningPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const ask = (type: 'proceed' | 'back'): void => { void overlay.request({ type }) }
    // The kit would close the sheet on Escape and leave the failed page showing: Escape means the safe answer.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      ask('back')
    }, true)

    const card = h('div', { className: 'https-card', role: 'alertdialog' })
    card.setAttribute('aria-labelledby', 'https-title')
    card.setAttribute('aria-describedby', 'https-body')
    content.append(card)

    return {
      shown (payload) {
        if (!isView(payload)) { overlay.close(); return }
        const back = h('button', { type: 'button', className: 'btn primary', onclick: () => { ask('back') } }, backLabel(payload.canGoBack))
        card.replaceChildren(
          h('span', { className: 'https-icon' }, warningIcon()),
          h('h1', { className: 'sheet-title', id: 'https-title' }, TITLE),
          h('p', { className: 'origin https-host', title: payload.host }, payload.host),
          h('p', { className: 'https-body', id: 'https-body' }, BODY),
          h('div', { className: 'btn-row' },
            h('button', { type: 'button', className: 'link-btn https-continue', onclick: () => { ask('proceed') } }, CONTINUE_LABEL),
            back))
        back.focus()
      }
    }
  }
}
