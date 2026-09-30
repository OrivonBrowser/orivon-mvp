// The "pages to open" control: the addresses, each removable, a field that adds one, and a shortcut that takes
// the pages open now. It writes the whole list to the setting on every change and draws from what it was given.
import { h } from '../../shared/dom.js'
import { internalBridge } from '../../shared/bridge.js'
import { closeIcon, fileIcon } from '../../shared/icons.js'
import { addPage, focusAfterRemove, joinPages, MAX_PAGES, NOTE_NONE_OPEN, PLACEHOLDER_ADD, PLACEHOLDER_FULL, PROBLEM_ADDRESS, PROBLEM_FULL, PROBLEM_SAVE, PROBLEM_UNAVAILABLE, removePage, shorten, splitPages } from './page-list-model.js'
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
  /** Why the list was not kept, or null once it is. A refused write and a failed request read alike to the person. */
  const save = async (next: string[]): Promise<string | null> => {
    try {
      return await state.set(control.key, joinPages(next)) === null ? null : PROBLEM_SAVE
    } catch {
      return PROBLEM_SAVE
    }
  }

  const list = h('div', { className: 'page-list-rows' })
  const field = h('input', { className: 'text page-list-field', type: 'text', placeholder: PLACEHOLDER_ADD, maxLength: 2048, autocomplete: 'off', spellcheck: false })
  field.setAttribute('aria-label', 'Add a page')
  // The draft lives in this node, so a redraw may happen at any time; the page hands the keyboard back to it.
  field.dataset['settled'] = 'true'
  const problem = h('p', { className: 'problem', role: 'alert' })
  /** A message under the field; `invalid` marks the field as the cause. */
  const say = (message: string, invalid = message !== ''): void => {
    problem.textContent = message
    field.setAttribute('aria-invalid', invalid ? 'true' : 'false')
  }

  const add = async (): Promise<void> => {
    const text = field.value.trim()
    if (text === '') return
    let address: string | null
    try {
      address = await validate(text)
    } catch {
      say(PROBLEM_UNAVAILABLE, false)
      return
    }
    if (address === null) { say(PROBLEM_ADDRESS); return }
    const outcome = addPage(pages, address)
    if (outcome.kind === 'full') { say(PROBLEM_FULL); return }
    if (outcome.kind === 'duplicate') { say(''); field.value = ''; return }
    // A full list has no field to come back to: focus its last row instead.
    focusNext = outcome.pages.length >= MAX_PAGES ? { kind: 'remove', index: MAX_PAGES - 1 } : { kind: 'field' }
    const refused = await save(outcome.pages)
    if (refused !== null) {
      // The typed address stays, and what to do with it is said.
      focusNext = null
      say(refused, false)
      return
    }
    say('')
    field.value = ''
  }
  field.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void add() } })
  field.addEventListener('input', () => { if (problem.textContent !== '') say('') })
  const addButton = h('button', { type: 'button', className: 'btn', textContent: 'Add', onclick: () => { void add() } })

  // The pages are read when the button is pressed, not when Settings opened: tabs come and go in between. A
  // Settings tab alone has nothing to take, which is said instead of the button being switched off for good.
  const useOpen = h('button', {
    type: 'button',
    className: 'link-btn',
    textContent: 'Use the pages open now',
    onclick: () => {
      void (async () => {
        try {
          const open = await pagesOpenNow()
          if (open.length === 0) { say(NOTE_NONE_OPEN, false); return }
          focusNext = { kind: 'field' }
          const refused = await save(open)
          if (refused !== null) { focusNext = null; say(refused, false) } else say('')
        } catch {
          say(PROBLEM_UNAVAILABLE, false)
        }
      })()
    }
  })

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
      // A full list takes no more: say so before anything is typed, rather than after it is submitted.
      const full = pages.length >= MAX_PAGES
      field.disabled = full
      addButton.disabled = full
      field.placeholder = full ? PLACEHOLDER_FULL : PLACEHOLDER_ADD
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
