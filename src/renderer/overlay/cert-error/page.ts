// The certificate-error sheet: which site, why it was not trusted, and the way back. Main sends both strings;
// the page offers nothing but Go back, because there is no way on.
import type { CertErrorView } from '../../../main/auth/cert-error-overlay.js'
import { h } from '../../pages/shared/dom.js'
import { warningIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import './cert-error.css'

export function isCertErrorView (value: unknown): value is CertErrorView {
  if (typeof value !== 'object' || value === null) return false
  const { host, text } = value as Record<string, unknown>
  return typeof host === 'string' && typeof text === 'string'
}

export const certErrorPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const card = h('div', { className: 'cert-error', role: 'alertdialog' })
    content.append(card)
    return {
      shown (payload) {
        if (!isCertErrorView(payload)) { overlay.close(); return }
        const back = h('button', { type: 'button', className: 'btn primary' }, 'Go back')
        back.addEventListener('click', () => { void overlay.request({ type: 'back' }) })
        card.setAttribute('aria-labelledby', 'cert-error-title')
        card.setAttribute('aria-describedby', 'cert-error-text')
        card.replaceChildren(
          h('span', { className: 'cert-error-icon' }, warningIcon()),
          h('h1', { className: 'sheet-title', id: 'cert-error-title' }, 'This site\'s certificate is not trusted'),
          h('p', { className: 'origin', title: payload.host }, payload.host),
          h('p', { className: 'cert-error-text', id: 'cert-error-text' }, payload.text),
          h('p', { className: 'cert-error-note' }, 'Orivon did not send your request to this site.'),
          h('div', { className: 'btn-row' }, back))
        back.focus()
      }
    }
  }
}
