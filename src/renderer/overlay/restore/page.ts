// The crash bar: what happened, the one thing that can be done about it, and a way to say no thanks.
// It never takes focus (main keeps the keys), so it is driven by the mouse; it announces itself instead.
import { h } from '../../pages/shared/dom.js'
import { closeIcon, warningIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { formatKeys } from '../menu/keys.js'
import './restore.css'

export const restorePage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const restore = h('button', { type: 'button', className: 'btn small primary', textContent: 'Restore tabs', onclick: () => { void overlay.request({ type: 'restore' }) } })
    const dismiss = h('button', { type: 'button', className: 'btn icon', ariaLabel: 'Dismiss', title: 'Dismiss', onclick: () => { void overlay.request({ type: 'dismiss' }) } }, closeIcon())
    content.append(h('div', { className: 'restorebar', role: 'status' },
      h('span', { className: 'restore-mark' }, warningIcon()),
      h('span', { className: 'restore-text', textContent: 'Orivon didn\'t shut down correctly.' }),
      restore,
      dismiss))
    return {
      // The bar never takes focus, so the keyboard route to the same thing is named in the button's tooltip.
      shown (payload) {
        const keys = typeof payload === 'object' && payload !== null ? (payload as { keys?: unknown }).keys : undefined
        const bound = Array.isArray(keys) && keys.every((key) => typeof key === 'string') ? keys as string[] : null
        restore.title = bound === null ? 'Restore tabs' : `Restore tabs (${formatKeys(bound, overlay.platform)})`
      }
    }
  }
}
