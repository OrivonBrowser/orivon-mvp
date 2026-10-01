// The "Extra access you allowed" card: each item the person granted with a
// Turn off that takes it back at once, and, below, what the extension may still
// ask for. Main sends the words; the page never builds them.
import { h } from '../../shared/dom.js'
import type { DetailsPayload } from '../state.js'
import type { DetailSection, PageContext } from '../types.js'

interface GrantedItem { readonly kind: 'permission' | 'origin', readonly value: string, readonly words: string }
interface OptionalDetails { readonly granted: readonly GrantedItem[], readonly mayAsk: readonly string[] }

function optionalOf (details: DetailsPayload): OptionalDetails | null {
  const value = details.parts['optional']
  if (typeof value !== 'object' || value === null) return null
  const { granted, mayAsk } = value as Partial<OptionalDetails>
  return Array.isArray(granted) && Array.isArray(mayAsk) ? { granted, mayAsk } : null
}

function grantRow (item: GrantedItem, details: DetailsPayload, ctx: PageContext): HTMLElement {
  const command = item.kind === 'permission' ? 'revokePermission' : 'revokeOrigin'
  const remove = h('button', {
    type: 'button',
    className: 'btn small',
    textContent: 'Turn off',
    ariaLabel: `Turn off: ${item.words}`,
    onclick: () => {
      remove.disabled = true
      void ctx.request(command, { id: details.id, [item.kind]: item.value }).then(ctx.refresh)
    }
  })
  return h('li', { className: 'grant-row' }, h('span', { className: 'grant-words', textContent: item.words }), remove)
}

export const optionalSection: DetailSection = {
  id: 'optional',
  title: 'Extra access you allowed',
  order: 25,
  render: (details, ctx) => {
    const optional = optionalOf(details)
    if (optional === null) return null
    const granted = optional.granted.length === 0
      ? h('p', { className: 'grant-empty', textContent: 'Nothing extra yet. The extension will ask when it needs to.' })
      : h('ul', { className: 'grant-list' }, ...optional.granted.map((item) => grantRow(item, details, ctx)))
    const mayAsk = optional.mayAsk.length === 0 ? null : h('div', { className: 'detail-block' },
      h('span', { className: 'detail-label', textContent: 'It may also ask for:' }),
      h('ul', { className: 'stripped-list' }, ...optional.mayAsk.map((line) => h('li', { textContent: line }))))
    return h('div', { className: 'grants' }, granted, mayAsk)
  }
}
