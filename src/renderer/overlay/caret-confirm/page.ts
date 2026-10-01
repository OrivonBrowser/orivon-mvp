// The question F7 asks before caret browsing turns on. It names the key that turns it off again, as main reports it,
// and answers with one of two commands; nothing here changes a setting.
import { h } from '../../pages/shared/dom.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { turnOffText } from './text.js'
import './caret-confirm.css'

const EXPLAIN = 'Caret browsing puts a moving cursor in web pages, so you can move and select text with the keyboard.'

export const caretConfirmPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const detail = h('p', { className: 'caret-text' })
    const dontAsk = h('input', { type: 'checkbox' })
    const cancel = h('button', { type: 'button', className: 'btn', onclick: () => { void overlay.request({ type: 'cancel' }) } }, 'Cancel')
    const turnOn = h('button', { type: 'button', className: 'btn primary', onclick: () => { void overlay.request({ type: 'confirm', dontAsk: dontAsk.checked }) } }, 'Turn on')
    content.append(h('div', { className: 'caret', role: 'dialog', ariaLabel: 'Turn on caret browsing?' },
      h('h1', { className: 'sheet-title' }, 'Turn on caret browsing?'),
      h('div', { className: 'sheet-body' },
        h('p', { className: 'caret-text' }, EXPLAIN),
        detail,
        h('label', { className: 'check' }, dontAsk, h('span', {}, 'Don\'t ask again'))),
      h('div', { className: 'btn-row' }, cancel, turnOn)))
    return {
      shown (payload) {
        const keys = typeof payload === 'object' && payload !== null ? (payload as { keys?: unknown }).keys : undefined
        detail.textContent = turnOffText(keys, overlay.platform)
        dontAsk.checked = false
        turnOn.focus()
      }
    }
  }
}
