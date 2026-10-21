// The "Private windows" card: one switch that lets the extension run in private windows with a copy of its own files,
// choices and data. Main sends whether it is on (and nothing inside a private window, where the card is left out).
import { h } from '../../shared/dom.js'
import type { DetailsPayload } from '../state.js'
import type { DetailSection } from '../types.js'

function enabledOf (details: DetailsPayload): boolean | null {
  const value = details.parts['privateWindows']
  if (typeof value !== 'object' || value === null) return null
  const { enabled } = value as { enabled?: unknown }
  return typeof enabled === 'boolean' ? enabled : null
}

export const privateWindowsSection: DetailSection = {
  id: 'private-windows',
  title: 'Private windows',
  order: 30,
  render: (details, ctx) => {
    const enabled = enabledOf(details)
    if (enabled === null) return null
    const input = h('input', {
      type: 'checkbox',
      checked: enabled,
      onchange: () => {
        input.disabled = true
        void ctx.request('setPrivateWindows', { id: details.id, enabled: input.checked }).then(ctx.refresh)
      }
    })
    input.setAttribute('aria-label', 'Run in private windows')
    input.setAttribute('aria-describedby', 'private-windows-note')
    input.dataset['focus'] = `${details.id}:private-windows`
    return h('div', { className: 'private-windows' },
      h('label', { className: 'private-windows-row' }, h('span', { textContent: 'Run in private windows' }), h('span', { className: 'switch' }, input, h('span', { className: 'track' }))),
      h('p', {
        className: 'private-windows-note',
        id: 'private-windows-note',
        textContent: 'It also runs in private windows, starting with a copy of its data from this profile. Nothing it does there is saved back. Orivon cannot stop an extension from recording what you visit in a private window.'
      }))
  }
}
