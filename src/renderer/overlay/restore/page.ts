// The crash bar: what happened, what can be done about it (restore the tabs, report the problem), and a way to say no thanks.
// It never takes focus (main keeps the keys), so it is driven by the mouse; it announces itself instead.
import { h } from '../../pages/shared/dom.js'
import { closeIcon, warningIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { formatKeys } from '../menu/keys.js'
import './restore.css'

interface RestoreView {
  readonly keys: readonly string[] | null
  readonly restore: boolean
  readonly report: boolean
}

function viewOf (payload: unknown): RestoreView {
  const value = (typeof payload === 'object' && payload !== null ? payload : {}) as { keys?: unknown, restore?: unknown, report?: unknown }
  const keys = Array.isArray(value.keys) && value.keys.every((key) => typeof key === 'string') ? value.keys as string[] : null
  return { keys, restore: value.restore !== false, report: value.report === true }
}

export const restorePage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const restore = h('button', { type: 'button', className: 'btn small primary', textContent: 'Restore tabs', onclick: () => { void overlay.request({ type: 'restore' }) } })
    const report = h('button', { type: 'button', className: 'btn small', textContent: 'Report the problem', onclick: () => { void overlay.request({ type: 'report' }) } })
    const dismiss = h('button', { type: 'button', className: 'btn icon', ariaLabel: 'Dismiss', title: 'Dismiss', onclick: () => { void overlay.request({ type: 'dismiss' }) } }, closeIcon())
    content.append(h('div', { className: 'restorebar', role: 'status' },
      h('span', { className: 'restore-mark' }, warningIcon()),
      h('span', { className: 'restore-text', textContent: 'Orivon didn\'t shut down correctly.' }),
      restore,
      report,
      dismiss))
    return {
      // The bar never takes focus, so the keyboard route to the same thing is named in the button's tooltip.
      shown (payload) {
        const view = viewOf(payload)
        restore.hidden = !view.restore
        report.hidden = !view.report
        restore.title = view.keys === null ? 'Restore tabs' : `Restore tabs (${formatKeys(view.keys, overlay.platform)})`
      }
    }
  }
}
