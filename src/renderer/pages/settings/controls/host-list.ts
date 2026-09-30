// A list of sites kept as the newline-separated text of a setting: each one removable, a field that adds one.
// It writes the whole list on every change and draws from what it was given.
import { h } from '../../shared/dom.js'
import { closeIcon, webIcon } from '../../shared/icons.js'
import type { SettingKey } from '../../../../main/settings/schema.js'
import { addHost, joinHosts, MAX_HOSTS, PLACEHOLDER_FULL, PROBLEM_FULL, PROBLEM_HOST, PROBLEM_SAVE, removeHost, splitHosts } from './host-list-model.js'
import { focusAfterRemove } from './page-list-model.js'
import type { Control } from '../model.js'
import type { SettingsState } from '../state.js'

export interface HostListOptions {
  /** What the empty field suggests, such as "Add a site, like example.com". */
  readonly placeholder: string
  /** What the list says while it holds nothing. */
  readonly empty: string
  /** The field's accessible name. */
  readonly label?: string
}

/** What to focus once the control is drawn again after a change: a remove button's position, or the field. */
let focusNext: { readonly kind: 'remove', readonly index: number } | { readonly kind: 'field' } | null = null

interface HostListView {
  readonly root: HTMLElement
  readonly field: HTMLInputElement
  update: (hosts: readonly string[]) => void
}

/** One view per setting, kept across redraws: the page draws itself again on every change, and a draft in the field, its message and the focus have to survive that. */
const views = new Map<string, HostListView>()

function createView (key: SettingKey, options: HostListOptions, state: SettingsState): HostListView {
  let hosts: readonly string[] = []
  const save = async (next: string[]): Promise<string | null> => {
    try {
      return await state.set(key, joinHosts(next)) === null ? null : PROBLEM_SAVE
    } catch {
      return PROBLEM_SAVE
    }
  }

  const list = h('div', { className: 'host-list-rows' })
  const field = h('input', { className: 'text host-list-field', type: 'text', placeholder: options.placeholder, maxLength: 253, autocomplete: 'off', spellcheck: false })
  field.setAttribute('aria-label', options.label ?? 'Add a site')
  // The draft lives in this node, so a redraw may happen at any time; the page hands the keyboard back to it.
  field.dataset['settled'] = 'true'
  const problem = h('p', { className: 'problem', role: 'alert' })
  const say = (message: string, invalid = message !== ''): void => {
    problem.textContent = message
    field.setAttribute('aria-invalid', invalid ? 'true' : 'false')
  }

  const add = async (): Promise<void> => {
    const text = field.value.trim()
    if (text === '') return
    const outcome = addHost(hosts, text)
    if (outcome.kind === 'invalid') { say(PROBLEM_HOST); return }
    if (outcome.kind === 'full') { say(PROBLEM_FULL); return }
    if (outcome.kind === 'duplicate') { say(''); field.value = ''; return }
    focusNext = { kind: 'field' }
    const refused = await save(outcome.hosts)
    if (refused !== null) {
      // The typed text stays, and what to do with it is said.
      focusNext = null
      say(refused, false)
      return
    }
    say('')
    field.value = ''
  }
  field.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void add() } })
  field.addEventListener('input', () => { if (problem.textContent !== '') say('') })
  const addButton = h('button', { type: 'button', className: 'btn small', textContent: 'Add', onclick: () => { void add() } })

  const root = h('div', { className: 'host-list' }, h('div', { className: 'host-list-add' }, field, addButton), problem, list)

  const rowsFor = (): HTMLElement => {
    if (hosts.length === 0) {
      return h('div', { className: 'empty-state compact' }, webIcon(), h('p', { textContent: options.empty }))
    }
    return h('ul', { className: 'listbox host-list-items' }, ...hosts.map((host, index) => h('li', { className: 'listbox-item host-list-item' },
      h('span', { className: 'item-title', title: host, textContent: host }),
      h('span', { className: 'item-meta' }, h('button', {
        type: 'button',
        className: 'btn icon host-list-remove',
        ariaLabel: `Remove ${host}`,
        title: 'Remove',
        onclick: () => {
          focusNext = focusAfterRemove(hosts.length - 1, index)
          void save(removeHost(hosts, index))
        }
      }, closeIcon())))))
  }

  root.dataset['keepFocus'] = 'true'
  return {
    root,
    field,
    update: (next) => {
      // A change arrives twice (the answer to the write, then main's announcement of it): the second must not replace the row holding focus.
      if (list.childElementCount > 0 && joinHosts(next) === joinHosts(hosts)) return
      hosts = next
      list.replaceChildren(rowsFor())
      const full = hosts.length >= MAX_HOSTS
      field.disabled = full
      addButton.disabled = full
      field.placeholder = full ? PLACEHOLDER_FULL : options.placeholder
      if (full) { field.value = ''; say('') }
    }
  }
}

function renderHostList (key: SettingKey, options: HostListOptions, state: SettingsState): HTMLElement {
  let view = views.get(key)
  if (view === undefined) {
    view = createView(key, options, state)
    views.set(key, view)
  }
  view.update(splitHosts(state.value(key)))

  const wanted = focusNext
  focusNext = null
  // After the row is in the page: the control is built before it is attached.
  if (wanted !== null) {
    const { root, field } = view
    queueMicrotask(() => {
      const target = wanted.kind === 'field' ? field : root.querySelector<HTMLElement>(`.host-list-item:nth-child(${String(wanted.index + 1)}) .host-list-remove`) ?? field
      target.focus()
    })
  }
  return view.root
}

/** A row's control for a setting that holds sites, one a line. Both the memory saver and the dark-mode exceptions use it. */
export function hostListControl (key: SettingKey, options: HostListOptions): Extract<Control, { type: 'custom' }> {
  return { type: 'custom', wide: true, render: (state) => renderHostList(key, options, state) }
}
