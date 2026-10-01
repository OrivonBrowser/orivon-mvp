// Draws the Passwords section from `PasswordsPart` and sends what the person does back to it; it never asks main
// itself. The saved-passwords list is one element kept across page redraws, so what is typed in its search box
// and where the keyboard is survive a change made elsewhere.
import { h, replaceChildren } from '../../shared/dom.js'
import { copyIcon, eyeIcon, eyeOffIcon, keyIcon, moreIcon, trashIcon } from '../../shared/icons.js'
import type { SettingsState } from '../state.js'
import { BANNER_TEXT, markColor, markLetter } from './passwords-model.js'
import type { ListEntry, Mark } from './passwords-model.js'
import type { PasswordsPart } from './passwords-part.js'

const NO_USERNAME = 'No username'

/** The text with its marks in `<mark>`, for a row that matched a search. */
function marked (text: string, marks: readonly Mark[]): Array<Node | string> {
  const out: Array<Node | string> = []
  let at = 0
  for (const mark of marks) {
    if (mark.start > at) out.push(text.slice(at, mark.start))
    out.push(h('mark', { textContent: text.slice(mark.start, mark.end) }))
    at = mark.end
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

function action (name: string, key: string, label: string, child: Node | string, onclick: () => void, extra: Partial<HTMLButtonElement> = {}): HTMLButtonElement {
  const button = h('button', { className: 'btn icon', type: 'button', title: label, onclick, ...extra }, child)
  button.setAttribute('aria-label', label)
  button.dataset['action'] = name
  button.dataset['focusKey'] = `${key}:${name}`
  return button
}

function revealButton (entry: ListEntry, part: PasswordsPart, who: string): HTMLButtonElement {
  const { id } = entry.login
  const shown = part.revealed?.id === id
  const armed = part.armedReveal === id
  const label = shown ? `Hide password for ${who}` : `Show password for ${who}`
  const button = action('reveal', id, label, shown ? eyeOffIcon() : eyeIcon(), () => { part.pressReveal(id) })
  button.setAttribute('aria-pressed', shown ? 'true' : armed ? 'mixed' : 'false')
  if (armed) button.title = 'Click again to show'
  return button
}

function deleteButton (entry: ListEntry, part: PasswordsPart, who: string): HTMLButtonElement {
  const { id } = entry.login
  if (part.armedDelete !== id) return action('delete', id, `Delete password for ${who}`, trashIcon(), () => { void part.pressDelete(id) })
  const button = h('button', { className: 'btn small danger armed', type: 'button', textContent: 'Click again to delete', onclick: () => { void part.pressDelete(id) } })
  button.setAttribute('aria-label', `Click again to delete the password for ${who}`)
  button.dataset['action'] = 'delete'
  button.dataset['focusKey'] = `${id}:delete`
  return button
}

function renderEntry (entry: ListEntry, part: PasswordsPart): HTMLElement {
  const { login, host } = entry
  const who = login.username === '' ? host : `${login.username} on ${host}`
  const mark = h('span', { className: 'item-icon mark pw-mark', textContent: markLetter(host) })
  mark.dataset['color'] = markColor(host)
  mark.setAttribute('aria-hidden', 'true')
  const item = h('li', { className: 'listbox-item pw-item' },
    mark,
    h('span', { className: 'item-title', title: login.origin }, ...marked(host, entry.hostMarks)),
    login.username === ''
      ? h('span', { className: 'item-sub dim', textContent: NO_USERNAME })
      : h('span', { className: 'item-sub' }, ...marked(login.username, entry.userMarks)),
    h('span', { className: 'item-meta btn-row' },
      revealButton(entry, part, who),
      action('copy', login.id, `Copy password for ${who}`, copyIcon(), () => { void part.copy(login.id) }),
      deleteButton(entry, part, who)),
    part.revealed?.id === login.id ? h('code', { className: 'pw-code', textContent: part.revealed.password }) : null)
  item.dataset['id'] = login.id
  return item
}

const skeletonRow = (): HTMLElement => h('li', { className: 'pw-skeleton' }, h('span', { className: 'skeleton pw-skeleton-mark' }), h('span', { className: 'skeleton pw-skeleton-line' }))

function emptyState (text: string, action?: HTMLElement): HTMLElement {
  return h('div', { className: 'empty-state compact' }, keyIcon(), h('p', { textContent: text }), action ?? null)
}

function build (part: PasswordsPart): HTMLElement {
  const search = h('input', { className: 'text search', type: 'search', placeholder: 'Search sites and usernames', autocomplete: 'off', spellcheck: false })
  search.setAttribute('aria-label', 'Search passwords')
  // The draft lives in this node, so a redraw of the page may happen at any time.
  search.dataset['settled'] = 'true'
  search.addEventListener('input', () => { part.setQuery(search.value) })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || search.value === '') return
    event.stopPropagation()
    search.value = ''
    part.setQuery('')
  })
  const more = h('button', { className: 'btn icon', type: 'button', title: 'Import or export', onclick: () => { part.toggleTools() } }, moreIcon())
  more.setAttribute('aria-label', 'Import or export passwords')
  const importButton = h('button', { className: 'btn', type: 'button', textContent: 'Import…', onclick: () => { void part.importFile() } })
  const exportButton = h('button', { className: 'btn', type: 'button', onclick: () => { void part.pressExport() } })
  const tools = h('div', { className: 'btn-row pw-tools' }, importButton, exportButton)
  const notice = h('div', { className: 'banner', role: 'status' })
  const list = h('ul', { className: 'listbox pw-list' })
  list.setAttribute('role', 'list')
  const showAll = h('button', { className: 'link-btn pw-show-all', type: 'button', onclick: () => { part.showEverything() } })
  const toast = h('div', { className: 'pw-toast', role: 'status' })
  const root = h('div', { className: 'pw-saved' }, h('div', { className: 'pw-head' }, search, more), tools, notice, list, showAll, toast)
  // The page hands the keyboard back to a control inside this element after it redraws.
  root.dataset['keepFocus'] = 'true'

  const update = (): void => {
    const ready = part.vault === 'ready'
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.dataset['focusKey'] : undefined
    search.disabled = !ready
    // Nothing to search until something is saved.
    search.hidden = !ready || part.logins.length === 0
    more.disabled = !ready
    more.setAttribute('aria-expanded', String(part.toolsOpen && ready))
    tools.hidden = !(part.toolsOpen && ready)
    importButton.disabled = !ready
    exportButton.className = part.armedExport ? 'btn danger armed' : 'btn'
    exportButton.textContent = part.armedExport ? 'Click again: the file is not encrypted' : 'Export…'

    notice.hidden = part.notice === null
    notice.className = `banner ${part.notice?.tone ?? 'ok'}`
    notice.setAttribute('role', part.notice?.tone === 'error' ? 'alert' : 'status')
    replaceChildren(notice, part.notice?.text, part.notice === null ? null : ' ', part.notice === null ? null : h('button', { className: 'link-btn', type: 'button', textContent: 'Dismiss', onclick: () => { part.dismissNotice() } }))

    const { shown, hidden, matching } = part.page()
    if (part.vault === null) {
      list.setAttribute('aria-busy', 'true')
      replaceChildren(list, skeletonRow(), skeletonRow())
    } else {
      list.removeAttribute('aria-busy')
      if (!ready || part.logins.length === 0) {
        const importFromFile = h('button', { className: 'btn', type: 'button', textContent: 'Import passwords…', onclick: () => { void part.importFile() } })
        replaceChildren(list, emptyState(ready ? 'No saved passwords yet. Orivon offers to save one after you sign in to a site.' : 'No saved passwords.', ready ? importFromFile : undefined))
      } else if (matching === 0) {
        replaceChildren(list, emptyState(`No passwords match "${part.query.trim()}".`))
      } else {
        replaceChildren(list, ...shown.map((entry) => renderEntry(entry, part)))
      }
    }
    showAll.hidden = hidden === 0
    showAll.textContent = `Show all ${String(matching)}`
    toast.replaceChildren(...(part.toast?.where === 'list' ? [h('span', { className: 'toast', textContent: part.toast.text })] : []))

    if (focused !== undefined) (list.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`) ?? search).focus()
  }
  part.subscribe(update)
  // Hidden again when the person leaves: a shown password never outlives the window being looked at.
  window.addEventListener('blur', () => { part.hide() })
  document.addEventListener('visibilitychange', () => { if (document.hidden) part.hide() })
  update()
  return root
}

const views = new WeakMap<PasswordsPart, HTMLElement>()

/** The "Saved passwords" control: the same element on every redraw of the page. */
export function renderSavedPasswords (state: SettingsState): HTMLElement {
  const part = state.part<PasswordsPart>('passwords')
  let root = views.get(part)
  if (root === undefined) {
    root = build(part)
    views.set(part, root)
  }
  return root
}

/** The banner a state that keeps nothing shows at the top of the section. */
export function renderPasswordsBanner (state: SettingsState): HTMLElement {
  const vault = state.part<PasswordsPart>('passwords').vault
  if (vault !== 'unavailable' && vault !== 'private') return h('span')
  const banner = h('div', { className: vault === 'private' ? 'banner info' : 'banner warn', textContent: BANNER_TEXT[vault] })
  banner.setAttribute('role', 'status')
  return banner
}

/** Sites Orivon does not offer to save for, each with a way to take it back. */
export function renderNeverSaved (state: SettingsState): HTMLElement {
  const part = state.part<PasswordsPart>('passwords')
  return h('ul', { className: 'pw-never' }, ...part.never.map((origin) => {
    const button = h('button', { className: 'link-btn', type: 'button', textContent: 'Remove', onclick: () => { void part.removeNever(origin) } })
    button.setAttribute('aria-label', `Offer to save passwords for ${origin} again`)
    return h('li', null, h('span', { className: 'pw-never-site', textContent: origin.replace(/^https:\/\//, ''), title: origin }), button)
  }))
}

/** One password made on request, to copy or remake; it is not kept anywhere. */
export function renderGenerator (state: SettingsState): HTMLElement {
  const part = state.part<PasswordsPart>('passwords')
  if (part.generated === null) return h('div', { className: 'pw-generate' }, h('button', { className: 'btn', type: 'button', textContent: 'Generate', onclick: () => { void part.generate() } }))
  const toast = part.toast?.where === 'generated' ? h('span', { className: 'toast', textContent: part.toast.text, role: 'status' }) : null
  return h('div', { className: 'pw-generate' },
    h('code', { className: 'pw-code pw-generated', textContent: part.generated }),
    h('span', { className: 'btn-row' },
      h('button', { className: 'btn', type: 'button', textContent: 'Again', onclick: () => { void part.generate() } }),
      h('button', { className: 'btn primary', type: 'button', textContent: 'Copy', onclick: () => { void part.copyGenerated() } })),
    toast)
}
