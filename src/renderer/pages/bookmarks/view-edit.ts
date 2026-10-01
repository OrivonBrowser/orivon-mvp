// A row turned into a form: the name and, for a bookmark, the address. Enter saves, Escape leaves it as it was, and
// leaving the form saves too when what is typed is valid. The page decides what "valid" is; this only asks.
import { h } from '../shared/dom.js'
import { rowIcon } from './view-list.js'
import type { Row } from './state.js'

export interface EditCallbacks {
  /** Resolves to the problem to show, or null when it was saved (the row is then drawn again). */
  save: (title: string, url: string | null) => Promise<string | null>
  cancel: () => void
}

export function renderEdit (row: Row, callbacks: EditCallbacks): HTMLElement {
  const name = h('input', { className: 'text', type: 'text', value: row.title, autocomplete: 'off', spellcheck: false, maxLength: 512 })
  name.setAttribute('aria-label', row.kind === 'folder' ? 'Folder name' : 'Name')
  const address = row.kind === 'url' ? h('input', { className: 'text', type: 'text', value: row.url ?? '', autocomplete: 'off', spellcheck: false, maxLength: 16_384 }) : null
  address?.setAttribute('aria-label', 'Address')
  const problem = h('p', { className: 'problem', role: 'alert' })
  const fields = h('div', { className: 'bm-fields' }, name, address)
  const hint = h('p', { className: 'edit-hint', textContent: 'Enter to save, Esc to cancel' })
  const form = h('form', { className: 'bm-edit' }, fields, problem, hint)
  const el = h('div', { className: 'bm-row editing' }, rowIcon(row), form)
  el.dataset['id'] = row.id
  /** Set once the form has done its work: taking it off the page can itself fire a blur, which must not save it again. */
  let saving = false

  const submit = async (): Promise<void> => {
    if (saving) return
    saving = true
    const text = await callbacks.save(name.value, address === null ? null : address.value.trim())
    saving = text === null
    if (text !== null) {
      problem.textContent = text
      address?.setAttribute('aria-invalid', 'true')
    }
  }
  // Two text fields and no submit button: the browser would not submit on Enter by itself.
  form.addEventListener('submit', (event) => { event.preventDefault(); void submit() })
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void submit(); return }
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    saving = true
    callbacks.cancel()
  })
  form.addEventListener('input', () => { problem.textContent = ''; address?.removeAttribute('aria-invalid') })
  form.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    if (next instanceof Node && form.contains(next)) return
    if (next === null && !document.hasFocus()) return
    void submit()
  })
  queueMicrotask(() => { name.focus(); name.select() })
  return el
}
