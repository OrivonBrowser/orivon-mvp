// The on/off switch of one extension, as the list and the details view draw it.
import { h } from '../../shared/dom.js'
import type { ExtensionRow } from '../state.js'
import type { PageContext } from '../types.js'

export function enabledSwitch (ext: ExtensionRow, ctx: PageContext): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    checked: ext.enabled,
    onchange: () => { void ctx.request('setEnabled', { id: ext.id, enabled: input.checked }).then(ctx.refresh) }
  })
  input.setAttribute('aria-label', `${ext.name} is ${ext.enabled ? 'on' : 'off'}`)
  return h('label', { className: 'switch' }, input, h('span', { className: 'track' }))
}
