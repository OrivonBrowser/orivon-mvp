// The "pages to open" control: the addresses, each removable, a field that adds one, and a shortcut that takes
// the pages open now. It writes the whole list to the setting on every change and draws from what it was given.
import { h } from '../../shared/dom.js'
import { internalBridge } from '../../shared/bridge.js'
import { closeIcon, fileIcon } from '../../shared/icons.js'
import { addPage, focusAfterRemove, joinPages, PROBLEM_ADDRESS, PROBLEM_FULL, removePage, shorten, splitPages } from './page-list-model.js'
import type { Control } from '../model.js'
import type { SettingsState } from '../state.js'

type PageListControl = Extract<Control, { type: 'pageList' }>

/** What to focus once the control is drawn again after a change: a remove button's position, or the field. */
let focusNext: { readonly kind: 'remove', readonly index: number } | { readonly kind: 'field' } | null = null

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

async function validate (text: string): Promise<string | null> {
  const reply = await internalBridge().request('startup', { type: 'validate', text })
  return isRecord(reply) && reply['ok'] === true && typeof reply['normalised'] === 'string' ? reply['normalised'] : null
}

async function pagesOpenNow (): Promise<string[]> {
  const reply = await internalBridge().request('startup', { type: 'currentPages' })
  return Array.isArray(reply) ? reply.filter((address): address is string => typeof address === 'string') : []
}

interface PageListView {
  readonly root: HTMLElement
  readonly field: HTMLInputElement
  /** Draws the rows for `pages` into the list that is already on the page. */
  update: (pages: readonly string[], fieldId: string) => void
}

/** One view per setting, kept across redraws: the page draws itself again on every change, and a draft in the field, its message and the focus have to survive that. */
const views = new Map<string, PageListView>()

function createView (control: PageListControl, state: SettingsState): PageListView {
  let pages: readonly string[] = []
  const save = (next: string[]): Promise<string | null> => state.set(control.key, joinPages(next))

  const list = h('div', { className: 'page-list-rows' })
  const field = h('input', { className: 'text page-list-field', type: 'text', placeholder: 'Add a page, like example.com', maxLength: 2048, autocomplete: 'off', spellcheck: false })
  field.setAttribute('aria-label', 'Add a page')
  // The draft lives in this node, so a redraw may happen at any time; the page hands the keyboard back to it.
  field.dataset['settled'] = 'true'
  const problem = h('p', { className: 'problem', role: 'alert' })
  const say = (message: string): void => {
    problem.textContent = message
    field.setAttribute('aria-invalid', message === '' ? 'false' : 'true')
  }

  const add = async (): Promise<void> => {
    const text = field.value.trim()
    if (text === '') return
    const address = await validate(text)
    if (address === null) { say(PROBLEM_ADDRESS); return }
    const outcome = addPage(pages, address)
    if (outcome.kind === 'full') { say(PROBLEM_FULL); return }
    say('')
    field.value = ''
    if (outcome.kind === 'duplicate') return
    focusNext = { kind: 'field' }
    await save(outcome.pages)
  }
  field.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void add() } })
  field.addEventListener('input', () => { if (problem.textContent !== '') say('') })
  const addButton = h('button', { type: 'button', className: 'btn small', textContent: 'Add', onclick: () => { void add() } })

  const useOpen = h('button', { type: 'button', className: 'link-btn', textContent: 'Use the pages open now', disabled: true })
  // Enabled once main says there is something to take: a Settings tab alone has nothing.
  void pagesOpenNow().then((open) => {
    useOpen.disabled = open.length === 0
    useOpen.onclick = () => { focusNext = { kind: 'field' }; void save(open) }
  }).catch(() => {})

  const root = h('div', { className: 'page-list' }, list, h('div', { className: 'page-list-add' }, field, addButton), problem, useOpen)

  const rowsFor = (): HTMLElement => {
    if (pages.length === 0) {
      return h('div', { className: 'empty-state compact' }, fileIcon(), h('p', { textContent: 'No pages yet. Orivon opens the new tab page until you add one.' }))
    }
    return h('ul', { className: 'page-list-items' }, ...pages.map((address, index) => h('li', { className: 'page-list-item' },
      h('span', { className: 'page-list-mark' }, fileIcon()),
      h('span', { className: 'page-list-address', title: address, textContent: shorten(address) }),
      h('button', {
        type: 'button',
        className: 'btn icon page-list-remove',
        ariaLabel: `Remove ${address}`,
        title: 'Remove',
        onclick: () => {
          focusNext = focusAfterRemove(pages.length - 1, index)
          void save(removePage(pages, index))
        }
      }, closeIcon()))))
  }

  root.dataset['keepFocus'] = 'true'
  return {
    root,
    field,
    update: (next, fieldId) => {
      field.id = fieldId
      // A change arrives twice (the answer to the write, then main's announcement of it): the second must not replace the row holding focus.
      if (list.childElementCount > 0 && joinPages(next) === joinPages(pages)) return
      pages = next
      list.replaceChildren(rowsFor())
    }
  }
}

export function renderPageList (control: PageListControl, state: SettingsState, id: string): HTMLElement {
  let view = views.get(control.key)
  if (view === undefined) {
    view = createView(control, state)
    views.set(control.key, view)
  }
  view.update(splitPages(state.value(control.key)), id)

  const wanted = focusNext
  focusNext = null
  // After the row is in the page: the control is built before it is attached.
  if (wanted !== null) {
    const { root, field } = view
    queueMicrotask(() => {
      const target = wanted.kind === 'field' ? field : root.querySelector<HTMLElement>(`.page-list-item:nth-child(${String(wanted.index + 1)}) .page-list-remove`) ?? field
      target.focus()
    })
  }
  return view.root
}
