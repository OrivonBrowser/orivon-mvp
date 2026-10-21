// The "Camera and microphone" card: one row for each device the extension has
// been answered for, with the answer in a menu that changes it or sets it back
// to Ask. Appears once an answer exists; main sends the rows and the page only
// draws them.
import { h } from '../../shared/dom.js'
import type { DetailsPayload } from '../state.js'
import type { DetailSection, PageContext } from '../types.js'

interface MediaRow { readonly kind: 'camera' | 'microphone', readonly label: string, readonly value: 'allow' | 'block' }

const CHOICES: ReadonlyArray<readonly [string, string]> = [['allow', 'Allowed'], ['block', 'Blocked'], ['ask', 'Ask']]

function rowsOf (details: DetailsPayload): readonly MediaRow[] | null {
  const value = details.parts['media']
  if (typeof value !== 'object' || value === null) return null
  const { rows } = value as { rows?: unknown }
  return Array.isArray(rows) && rows.length > 0 ? rows as MediaRow[] : null
}

function mediaRow (row: MediaRow, details: DetailsPayload, ctx: PageContext): HTMLElement {
  const select = h('select', { className: 'select', id: `media-${row.kind}` },
    ...CHOICES.map(([value, label]) => h('option', { value, textContent: label })))
  select.value = row.value
  select.setAttribute('aria-label', row.label)
  select.addEventListener('change', () => {
    select.disabled = true
    void ctx.request('setMedia', { id: details.id, kind: row.kind, value: select.value }).then(ctx.refresh)
  })
  return h('li', { className: 'grant-row' }, h('label', { className: 'grant-words', htmlFor: select.id, textContent: row.label }), select)
}

export const mediaSection: DetailSection = {
  id: 'media',
  title: 'Camera and microphone',
  order: 22,
  render: (details, ctx) => {
    const rows = rowsOf(details)
    if (rows === null) return null
    return h('div', { className: 'grants' },
      h('ul', { className: 'grant-list' }, ...rows.map((row) => mediaRow(row, details, ctx))),
      h('p', { className: 'grant-empty', textContent: 'A change applies the next time the extension asks. It does not stop a camera or microphone the extension is already using.' }))
  }
}
