// A details section for an extension that declares commands: how many, and a
// link to where their keys are set. Left out when it declares none.
import { h } from '../../shared/dom.js'
import { pathFor } from '../router.js'
import type { DetailSection } from '../types.js'

export const shortcutsLinkSection: DetailSection = {
  id: 'shortcuts',
  title: 'Shortcuts',
  order: 35,
  render: (details, ctx) => {
    const part = details.parts['shortcuts'] as { commands?: unknown } | undefined
    const count = typeof part?.commands === 'number' ? part.commands : 0
    if (count === 0) return null
    const href = `${pathFor('shortcuts')}#${details.id}`
    return h('div', { className: 'ext-details' }, h('div', { className: 'detail-row' },
      h('span', { className: 'detail-label', textContent: count === 1 ? '1 command' : `${String(count)} commands` }),
      h('span', { className: 'detail-value' }, h('a', {
        className: 'link-btn',
        href,
        textContent: 'Keyboard shortcuts',
        onclick: (event: MouseEvent) => { event.preventDefault(); ctx.navigate(href) }
      }))))
  }
}
