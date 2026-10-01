// The toast: an icon for what happened, one line, and, for one message, a link that does the next
// sensible thing. Main sends the whole view on every show, so a second message replaces the first.
import type { ToastView } from '../../../main/page-tools/toast.js'
import { h } from '../../pages/shared/dom.js'
import { checkIcon, closeIcon, infoIcon, warningIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import './toast.css'

const isView = (value: unknown): value is ToastView => {
  if (typeof value !== 'object' || value === null) return false
  const { text, tone, name, action } = value as Record<string, unknown>
  return typeof text === 'string' && (tone === 'info' || tone === 'ok' || tone === 'error') &&
    (name === undefined || typeof name === 'string') && (action === undefined || typeof action === 'string')
}

function mark (view: ToastView): Node {
  if (view.sticky) return h('span', { className: 'spinner' })
  return view.tone === 'ok' ? checkIcon() : view.tone === 'error' ? warningIcon() : infoIcon()
}

export const toastPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const toast = h('div', { className: 'toast', role: 'status' })
    toast.setAttribute('aria-live', 'polite')
    content.append(toast)
    // A toast that offers something waits while the pointer is on it, so a slow hand can reach the link.
    toast.addEventListener('mouseenter', () => { void overlay.request({ type: 'hold' }) })
    toast.addEventListener('mouseleave', () => { void overlay.request({ type: 'release' }) })
    return {
      shown (payload) {
        if (!isView(payload)) return
        toast.dataset['tone'] = payload.tone
        const name = payload.name
        toast.replaceChildren(
          h('span', { className: 'toast-mark' }, mark(payload)),
          h('span', { className: 'toast-text' }, payload.text),
          ...(name === undefined ? [] : [h('span', { className: 'toast-name', title: name }, name)]),
          ...(payload.action === undefined
            ? []
            : [
                h('button', { type: 'button', className: 'link-btn', onclick: () => { void overlay.request({ type: 'action' }) } }, payload.action),
                h('button', { type: 'button', className: 'btn icon toast-dismiss', ariaLabel: 'Dismiss', title: 'Dismiss', onclick: () => { void overlay.request({ type: 'dismiss' }) } }, closeIcon())
              ])
        )
      }
    }
  }
}
