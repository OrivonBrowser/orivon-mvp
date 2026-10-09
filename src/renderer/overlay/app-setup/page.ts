// The sheet over a tab whose app was not opened: a security warning for files that differ from what the site
// declared, or "Couldn't download" with Try again. Main sends every string and a token; the page sends the
// token back with one fixed word.
import type { SetupSheetView } from '../../../main/app-setup/setup-text.js'
import { h } from '../../pages/shared/dom.js'
import { warningIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { shortenMiddle } from '../sad-tab/address.js'
import './app-setup.css'

/** What fits on one line of the sheet at its width. */
const ADDRESS_FIT = 56

export function isSetupSheetView (value: unknown): value is SetupSheetView {
  if (typeof value !== 'object' || value === null) return false
  const view = value as Record<string, unknown>
  return typeof view['token'] === 'string' && (view['kind'] === 'blocked' || view['kind'] === 'download-failed' || view['kind'] === 'too-large') &&
    typeof view['title'] === 'string' && typeof view['body'] === 'string' && Array.isArray(view['files']) &&
    view['files'].every((file) => typeof file === 'string') && typeof view['more'] === 'string' &&
    typeof view['address'] === 'string' && typeof view['note'] === 'string' && typeof view['canRetry'] === 'boolean'
}

export const appSetupPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const card = h('div', { className: 'app-setup', role: 'alertdialog' })
    content.append(card)
    return {
      shown (payload) {
        if (!isSetupSheetView(payload)) { overlay.close(); return }
        const answer = (type: 'retry' | 'leave') => () => { void overlay.request({ type, token: payload.token }) }
        const leave = h('button', { type: 'button', className: payload.canRetry ? 'btn' : 'btn primary' }, 'Go back')
        leave.addEventListener('click', answer('leave'))
        const retry = payload.canRetry ? h('button', { type: 'button', className: 'btn primary' }, 'Try again') : null
        retry?.addEventListener('click', answer('retry'))
        card.setAttribute('aria-labelledby', 'app-setup-title')
        card.setAttribute('aria-describedby', 'app-setup-text')
        card.replaceChildren(
          h('span', { className: 'app-setup-icon' }, warningIcon()),
          h('h1', { className: 'sheet-title', id: 'app-setup-title' }, payload.title),
          ...(payload.address === '' ? [] : [h('p', { className: 'origin app-setup-address', title: payload.address }, shortenMiddle(payload.address, ADDRESS_FIT))]),
          h('p', { className: 'app-setup-text', id: 'app-setup-text' }, payload.body),
          ...(payload.files.length === 0 ? [] : [h('ul', { className: 'app-setup-files' }, ...payload.files.map((file) => h('li', { title: file }, file)))]),
          ...(payload.more === '' ? [] : [h('p', { className: 'app-setup-more' }, payload.more)]),
          ...(payload.note === '' ? [] : [h('p', { className: 'app-setup-note' }, payload.note)]),
          h('div', { className: 'btn-row' }, ...(retry === null ? [leave] : [leave, retry])))
        ;(retry ?? leave).focus()
      }
    }
  }
}
