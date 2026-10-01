// Draws the "Sites that store data" control from `SiteDataPart` and sends what the person does back to it; it
// never asks main itself. The control is one element kept across page redraws, so what is typed in its search
// box and where the keyboard is survive a change made elsewhere.
import { h, replaceChildren } from '../../shared/dom.js'
import { chevronRightIcon, databaseIcon, trashIcon } from '../../shared/icons.js'
import { cookieRows } from '../../shared/cookie-row.js'
import { markColor, markLetter } from '../passwords/passwords-model.js'
import type { SiteRow } from '../../../../main/privacy/site-data-domain.js'
import type { SettingsState } from '../state.js'
import { siteLine, totalText } from './site-data-model.js'
import type { SiteDataPart } from './site-data-part.js'

function iconButton (action: string, key: string, label: string, child: Node, onclick: () => void, extra: Partial<HTMLButtonElement> = {}): HTMLButtonElement {
  const button = h('button', { className: 'btn icon', type: 'button', title: label, onclick, ...extra }, child)
  button.setAttribute('aria-label', label)
  button.dataset['focusKey'] = `${key}:${action}`
  return button
}

function deleteButton (site: SiteRow, part: SiteDataPart): HTMLButtonElement {
  const label = `Delete data for ${site.domain}`
  if (!part.isArmed({ kind: 'site', domain: site.domain })) return iconButton('delete', site.domain, label, trashIcon(), () => { void part.pressDeleteSite(site.domain) })
  const button = h('button', { className: 'btn small danger armed', type: 'button', textContent: 'Click again to delete', onclick: () => { void part.pressDeleteSite(site.domain) } })
  button.setAttribute('aria-label', `Click again to delete the data for ${site.domain}`)
  button.dataset['focusKey'] = `${site.domain}:delete`
  return button
}

function hostsBlock (site: SiteRow, part: SiteDataPart): HTMLElement {
  const loaded = part.hosts.get(site.domain)
  if (loaded === undefined) return h('div', { className: 'sd-hosts' }, h('span', { className: 'skeleton sd-skeleton' }))
  // A site with one address, the domain itself, needs no heading above its cookies.
  const named = site.hosts.length > 1 || site.hosts[0] !== site.domain
  return h('div', { className: 'sd-hosts' }, ...site.hosts.map((host) => {
    const own = loaded.find((entry) => entry.host === host)?.cookies ?? []
    return h('div', { className: 'sd-host' },
      named ? h('div', { className: 'sd-host-name', textContent: host, title: host }) : null,
      own.length === 0
        ? h('p', { className: 'muted', textContent: 'No cookies. It keeps other site data.' })
        : h('ul', { className: 'cookie-list' }, ...cookieRows(own, (key) => { void part.removeCookie(site.domain, key) })))
  }))
}

function renderSite (site: SiteRow, part: SiteDataPart): HTMLElement {
  const open = part.open.has(site.domain)
  const mark = h('span', { className: 'mark sd-mark', textContent: markLetter(site.domain) })
  mark.dataset['color'] = markColor(site.domain)
  mark.setAttribute('aria-hidden', 'true')
  const chevron = chevronRightIcon()
  chevron.classList.add('sd-chevron')
  // The whole row opens it, as in the list of sites with their own settings; only the delete button sits outside.
  const toggle = h('button', { className: 'sd-toggle', type: 'button', onclick: () => { void part.toggle(site.domain) } },
    mark,
    h('span', { className: 'sd-text' },
      h('span', { className: 'sd-domain', textContent: site.domain, title: site.hosts.join(', ') }),
      h('span', { className: 'sd-line', textContent: siteLine(site) })),
    chevron)
  toggle.setAttribute('aria-expanded', String(open))
  toggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} what ${site.domain} stores`)
  toggle.dataset['focusKey'] = `${site.domain}:toggle`
  const item = h('li', { className: open ? 'sd-site open' : 'sd-site' },
    h('div', { className: 'sd-row' }, toggle, deleteButton(site, part)),
    open ? hostsBlock(site, part) : null)
  item.dataset['domain'] = site.domain
  return item
}

const emptyState = (text: string): HTMLElement => h('li', { className: 'empty-state compact' }, databaseIcon(), h('p', { textContent: text }))

const skeletonRow = (): HTMLElement => h('li', { className: 'sd-skeleton-row' }, h('span', { className: 'skeleton sd-skeleton-mark' }), h('span', { className: 'skeleton sd-skeleton-line' }))

function build (part: SiteDataPart): HTMLElement {
  const search = h('input', { className: 'text search', type: 'search', placeholder: 'Search sites', autocomplete: 'off', spellcheck: false })
  search.setAttribute('aria-label', 'Search sites that store data')
  search.dataset['settled'] = 'true'
  search.addEventListener('input', () => { part.setQuery(search.value) })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || search.value === '') return
    event.stopPropagation()
    search.value = ''
    part.setQuery('')
  })
  const sortButton = (sort: 'name' | 'size', label: string): HTMLButtonElement => h('button', { type: 'button', textContent: label, onclick: () => { part.setSort(sort) } })
  const byName = sortButton('name', 'Name')
  const bySize = sortButton('size', 'Size')
  const sorter = h('div', { className: 'segmented', role: 'group' }, byName, bySize)
  sorter.setAttribute('aria-label', 'Sort sites')
  const list = h('ul', { className: 'sd-list' })
  list.setAttribute('role', 'list')
  const showAll = h('button', { className: 'link-btn sd-show-all', type: 'button', onclick: () => { part.showEverything() } })
  const deleteAll = h('button', { className: 'btn danger', type: 'button', onclick: () => { void part.pressDeleteAll() } })
  const notice = h('p', { className: 'problem', role: 'alert' })
  const root = h('div', { className: 'sd', id: 'site-data' }, h('div', { className: 'sd-head' }, search, sorter), list, showAll, h('div', { className: 'sd-foot' }, deleteAll, notice))
  root.dataset['keepFocus'] = 'true'

  const update = (): void => {
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset['focusKey'] : undefined
    byName.setAttribute('aria-pressed', String(part.sort === 'name'))
    bySize.setAttribute('aria-pressed', String(part.sort === 'size'))
    const armedAll = part.isArmed({ kind: 'all' })
    deleteAll.className = armedAll ? 'btn danger armed' : 'btn danger'
    deleteAll.textContent = armedAll ? 'Click again to delete all site data' : 'Delete all site data'
    deleteAll.disabled = part.sites !== null && part.sites.length === 0
    // Nothing to search or sort until a site has stored data.
    const none = part.sites !== null && part.sites.length === 0
    search.hidden = none
    sorter.hidden = none
    notice.textContent = part.failed ? 'Some of that could not be deleted.' : ''
    const { shown, hidden, matching } = part.rows()
    if (part.sites === null) {
      list.setAttribute('aria-busy', 'true')
      replaceChildren(list, skeletonRow(), skeletonRow(), skeletonRow())
    } else {
      list.removeAttribute('aria-busy')
      if (part.sites.length === 0) replaceChildren(list, emptyState('No site has stored data.'))
      else if (matching === 0) replaceChildren(list, emptyState(`No sites match "${part.query.trim()}".`))
      else replaceChildren(list, ...shown.map((site) => renderSite(site, part)))
    }
    showAll.hidden = hidden === 0
    showAll.textContent = `Show all ${String(matching)}`
    if (focused !== undefined) (list.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`) ?? search).focus()
  }
  part.subscribe(update)
  update()
  return root
}

const views = new WeakMap<SiteDataPart, HTMLElement>()

/** The "Sites that store data" control: the same element on every redraw of the page. */
export function renderSiteData (state: SettingsState): HTMLElement {
  const part = state.part<SiteDataPart>('siteData')
  let root = views.get(part)
  if (root === undefined) {
    root = build(part)
    views.set(part, root)
  }
  return root
}

export function dataStoredText (state: SettingsState): string {
  return totalText(state.part<SiteDataPart>('siteData').total)
}
