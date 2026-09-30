// The "site search and keywords" control: every engine with its keyword, a way to make one the default, and
// for the person's own a form to add, edit and remove them. One view is kept across redraws: the page draws
// itself again on every change, and a draft in the form, its messages and the keyboard have to survive that.
import { armEnded } from '../shared/armed.js'
import { h } from '../shared/dom.js'
import { closeIcon, pencilIcon, plusIcon } from '../shared/icons.js'
import type { EngineView } from '../../../main/browsing/search-resolve.js'
import { draftOf, emptyDraft, markColor, markLetter, problemFor } from './engines-form.js'
import type { Draft, Field } from './engines-form.js'
import type { SettingsState } from './state.js'

type Mode = { readonly kind: 'add' } | { readonly kind: 'edit', readonly id: string } | null

/** The button to focus once the list is drawn again: the Edit of a row that was just saved. */
let focusEdit: string | null = null

const ARM_MS = 4000
const FIELD_LABELS: ReadonlyArray<{ field: Field, label: string, placeholder: string, maxLength: number }> = [
  { field: 'name', label: 'Name', placeholder: '', maxLength: 200 },
  { field: 'keyword', label: 'Keyword', placeholder: 'for example: w', maxLength: 200 },
  { field: 'template', label: 'Address with %s in place of the search', placeholder: 'https://example.org/search?q=%s', maxLength: 2048 }
]

interface EnginesView {
  readonly root: HTMLElement
  update: (state: SettingsState) => void
}

function createView (): EnginesView {
  let state: SettingsState | null = null
  let mode: Mode = null
  const list = h('ul', { className: 'engine-items', role: 'list' })
  const note = h('p', { className: 'muted engine-note', textContent: 'This window is private, so search engines cannot be added or changed here.' })
  note.hidden = true

  const inputs = {} as Record<Field, HTMLInputElement>
  const problems = {} as Record<Field, HTMLElement>
  const fields = FIELD_LABELS.map(({ field, label, placeholder, maxLength }) => {
    const input = h('input', { className: 'text', type: 'text', placeholder, maxLength, autocomplete: 'off', spellcheck: false })
    // The draft lives in this node, so a redraw may come at any time and hands the keyboard straight back to it.
    input.dataset['settled'] = 'true'
    const problem = h('p', { className: 'problem', role: 'alert' })
    input.addEventListener('input', () => { clearProblems() })
    inputs[field] = input
    problems[field] = problem
    return h('label', { className: 'field' }, h('span', { textContent: label }), input, problem)
  })
  const formProblem = h('p', { className: 'problem', role: 'alert' })
  const formTitle = h('h4', { className: 'engine-form-title' })
  const save = h('button', { className: 'btn primary', type: 'button', textContent: 'Save', onclick: () => { void submit() } })
  const cancel = h('button', { className: 'btn', type: 'button', textContent: 'Cancel', onclick: () => { close() } })
  const form = h('div', { className: 'engine-form', role: 'group' }, formTitle, ...fields, formProblem, h('div', { className: 'btn-row' }, cancel, save))
  form.hidden = true
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); void submit() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  })

  const addButton = h('button', { className: 'btn engine-add', type: 'button', onclick: () => { open({ kind: 'add' }, emptyDraft()) } }, plusIcon(), h('span', { textContent: 'Add search engine' }))
  const root = h('div', { className: 'engines' }, list, note, addButton, form)
  root.dataset['keepFocus'] = 'true'

  function clearProblems (): void {
    for (const field of Object.keys(inputs) as Field[]) {
      problems[field].textContent = ''
      inputs[field].setAttribute('aria-invalid', 'false')
    }
    formProblem.textContent = ''
  }

  function open (next: Mode, draft: Draft): void {
    mode = next
    clearProblems()
    for (const field of Object.keys(inputs) as Field[]) inputs[field].value = draft[field]
    formTitle.textContent = next?.kind === 'edit' ? 'Edit search engine' : 'Add search engine'
    form.hidden = false
    addButton.hidden = true
    inputs.name.focus()
  }

  function close (): void {
    const edited = mode?.kind === 'edit' ? mode.id : null
    mode = null
    form.hidden = true
    addButton.hidden = state?.engines.isPrivate === true
    focusEdit = edited
    if (edited === null) addButton.focus()
    else list.querySelector<HTMLElement>(`[data-id="${CSS.escape(edited)}"] .engine-edit`)?.focus()
  }

  async function submit (): Promise<void> {
    if (state === null || mode === null) return
    const draft: Draft = { name: inputs.name.value, keyword: inputs.keyword.value, template: inputs.template.value }
    clearProblems()
    const refusal = mode.kind === 'add' ? await state.engines.add(draft) : await state.engines.update(mode.id, draft)
    if (refusal === null) { close(); return }
    const { field, text } = problemFor(refusal)
    if (field === null) { formProblem.textContent = text; return }
    problems[field].textContent = text
    inputs[field].setAttribute('aria-invalid', 'true')
    inputs[field].focus()
  }

  function row (engine: EngineView, current: SettingsState): HTMLElement {
    const isDefault = current.engines.defaultId === engine.id
    const own = engine.kind !== 'builtin' && !current.engines.isPrivate
    const mark = h('span', { className: 'mark engine-mark', textContent: markLetter(engine.name), ariaHidden: 'true' })
    mark.dataset['color'] = markColor(engine.name)
    const actions = h('span', { className: 'engine-actions' },
      isDefault
        ? h('span', { className: 'badge ok', textContent: 'Default' })
        : h('button', { className: 'link-btn engine-default', type: 'button', textContent: 'Make default', ariaLabel: `Make ${engine.name} the default search engine`, onclick: () => { void current.engines.makeDefault(engine.id) } }))
    if (own) {
      actions.append(h('button', {
        className: 'btn icon engine-edit', type: 'button', title: 'Edit', ariaLabel: `Edit ${engine.name}`,
        onclick: () => { open({ kind: 'edit', id: engine.id }, draftOf(engine)) }
      }, pencilIcon()), removeButton(engine, current))
    }
    const item = h('li', { className: 'engine-item' },
      mark,
      h('span', { className: 'engine-name', textContent: engine.name, title: engine.name }),
      h('kbd', { textContent: engine.keyword, title: 'Keyword' }),
      h('span', { className: 'engine-template', textContent: engine.template, title: engine.template }),
      actions)
    item.dataset['id'] = engine.id
    return item
  }

  return {
    root,
    update: (current) => {
      state = current
      list.replaceChildren(...current.engines.engines.map((engine) => row(engine, current)))
      note.hidden = !current.engines.isPrivate
      if (current.engines.isPrivate) { form.hidden = true; mode = null }
      addButton.hidden = current.engines.isPrivate || mode !== null
    }
  }
}

/** Remove asks twice: the first press turns the button into the confirming one for a few seconds. */
function removeButton (engine: EngineView, state: SettingsState): HTMLElement {
  const button = h('button', { className: 'btn icon engine-remove', type: 'button', title: 'Remove', ariaLabel: `Remove ${engine.name}` }, closeIcon())
  button.addEventListener('click', () => {
    const confirm = h('button', { className: 'btn danger armed small', type: 'button', textContent: 'Click again to remove', ariaLabel: `Click again to remove ${engine.name}` })
    const timer = setTimeout(() => { confirm.replaceWith(button); armEnded() }, ARM_MS)
    confirm.addEventListener('click', () => {
      clearTimeout(timer)
      // No longer waiting for a second click: the page holds its redraws back while a button is armed.
      confirm.classList.remove('armed')
      confirm.disabled = true
      void state.engines.remove(engine.id).then(() => { armEnded() })
    })
    button.replaceWith(confirm)
    confirm.focus()
  })
  return button
}

let view: EnginesView | null = null

export function renderEngines (state: SettingsState): HTMLElement {
  view ??= createView()
  view.update(state)
  const target = focusEdit
  focusEdit = null
  if (target !== null) {
    const { root } = view
    queueMicrotask(() => { root.querySelector<HTMLElement>(`[data-id="${CSS.escape(target)}"] .engine-edit`)?.focus() })
  }
  return view.root
}

