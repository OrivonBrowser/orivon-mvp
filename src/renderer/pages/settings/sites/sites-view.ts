// Draws the "Sites with their own settings" list from `SitesPart` and sends what the person does back to it; it
// never asks main itself. The list is one element kept across page redraws, so what is typed in its search box and
// where the keyboard is survive a change made elsewhere (a prompt answered in a tab pushes one).
import { h, replaceChildren } from '../../shared/dom.js'
import { chevronRightIcon, slidersIcon, trashIcon } from '../../shared/icons.js'
import { SITE_KIND_ICONS } from '../../shared/site-kind-icons.js'
import type { SettingsState } from '../state.js'
import { badgesFor, hostOf, markColor, markLetter, sentenceFor } from './sites-model.js'
import type { SiteKindRow, SiteSummary } from './sites-model.js'
import type { SiteDeviceRow, SitesPart } from './sites-part.js'

const EMPTY_TEXT = 'No site has its own settings yet. Choices you make when a site asks appear here.'
const PRIVATE_TEXT = 'Choices made in a private window are forgotten when it closes.'

function kindRow (origin: string, row: SiteKindRow, part: SitesPart): HTMLElement {
  const icon = SITE_KIND_ICONS[row.kind]()
  icon.setAttribute('aria-hidden', 'true')
  const select = h('select', { className: 'select site-select' })
  for (const option of row.options) select.append(h('option', { value: option.value, textContent: option.label }))
  select.value = row.value
  select.setAttribute('aria-label', `${row.label} on ${hostOf(origin)}`)
  select.dataset['focusKey'] = `${origin}:${row.kind}`
  // A choice that was made is finished, though it keeps the keyboard.
  select.addEventListener('change', () => { select.dataset['settled'] = 'true'; void part.choose(origin, row.kind, select.value) })
  return h('li', { className: 'site-kind' }, h('span', { className: 'site-kind-label' }, icon, h('span', { textContent: row.label })), select)
}

function deviceRow (origin: string, device: SiteDeviceRow, part: SitesPart): HTMLElement {
  const forget = h('button', { className: 'btn small', type: 'button', textContent: 'Forget', onclick: () => { void part.forgetDevice(origin, device.key) } })
  forget.setAttribute('aria-label', `Forget ${device.label} on ${hostOf(origin)}`)
  forget.dataset['focusKey'] = `${origin}:device:${device.key}`
  return h('li', { className: 'site-kind' }, h('span', { className: 'site-kind-label' }, h('span', { textContent: device.label })), forget)
}

function resetButton (site: SiteSummary, part: SitesPart): HTMLButtonElement {
  const host = hostOf(site.origin)
  if (part.armedReset !== site.origin) {
    const button = h('button', { className: 'btn icon', type: 'button', title: `Reset ${host}`, onclick: () => { void part.pressReset(site.origin) } }, trashIcon())
    button.setAttribute('aria-label', `Reset the settings of ${host}`)
    button.dataset['focusKey'] = `${site.origin}:reset`
    return button
  }
  const button = h('button', { className: 'btn small danger armed', type: 'button', textContent: 'Click again to reset', onclick: () => { void part.pressReset(site.origin) } })
  button.setAttribute('aria-label', `Click again to reset the settings of ${host}`)
  button.dataset['focusKey'] = `${site.origin}:reset`
  return button
}

function siteItem (site: SiteSummary, part: SitesPart): HTMLElement {
  const host = hostOf(site.origin)
  const open = part.open.has(site.origin)
  const mark = h('span', { className: 'item-icon mark site-mark', textContent: markLetter(host) })
  mark.dataset['color'] = markColor(host)
  mark.setAttribute('aria-hidden', 'true')
  const { shown, more } = badgesFor(site)
  const badges = h('span', { className: 'site-badges' },
    ...shown.map((badge) => h('span', { className: `badge ${badge.tone}`, textContent: badge.text })),
    more > 0 ? h('span', { className: 'badge', textContent: `+${String(more)}` }) : null)
  const chevron = chevronRightIcon()
  chevron.classList.add('site-chevron')
  const toggle = h('button', { className: 'site-toggle', type: 'button', onclick: () => { void part.toggle(site.origin) } }, mark, h('span', { className: 'site-host', textContent: host, title: site.origin }), badges, chevron)
  toggle.setAttribute('aria-expanded', String(open))
  toggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} the settings of ${sentenceFor(site)}`)
  toggle.dataset['focusKey'] = `${site.origin}:toggle`
  const rows = part.rows.get(site.origin) ?? []
  const devices = part.devices.get(site.origin) ?? []
  const item = h('li', { className: open ? 'site-item open' : 'site-item' },
    h('div', { className: 'site-line' }, toggle, resetButton(site, part)),
    open ? h('ul', { className: 'site-kinds' }, ...rows.map((row) => kindRow(site.origin, row, part)), ...devices.map((device) => deviceRow(site.origin, device, part))) : null)
  item.dataset['origin'] = site.origin
  return item
}

/** An app the person refused: its host, and the one thing to do about it. */
function declinedItem (origin: string, part: SitesPart): HTMLElement {
  const host = hostOf(origin)
  const again = h('button', { className: 'btn small', type: 'button', textContent: 'Ask again', onclick: () => { void part.askAgain(origin) } })
  again.setAttribute('aria-label', `Ask again about ${host} as an app`)
  again.dataset['focusKey'] = `${origin}:ask-again`
  const item = h('li', { className: 'site-item declined-app' }, h('div', { className: 'site-line' }, h('span', { className: 'site-host', textContent: host, title: origin }), again))
  item.dataset['origin'] = origin
  return item
}

const skeletonRow = (): HTMLElement => h('li', { className: 'site-skeleton' }, h('span', { className: 'skeleton site-skeleton-mark' }), h('span', { className: 'skeleton site-skeleton-line' }))

function emptyState (text: string): HTMLElement {
  return h('div', { className: 'empty-state compact' }, slidersIcon(), h('p', { textContent: text }))
}

function build (part: SitesPart): HTMLElement {
  const search = h('input', { className: 'text search', type: 'search', placeholder: 'Search sites', autocomplete: 'off', spellcheck: false })
  search.setAttribute('aria-label', 'Search sites')
  search.dataset['settled'] = 'true'
  search.addEventListener('input', () => { part.setQuery(search.value) })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || search.value === '') return
    event.stopPropagation()
    search.value = ''
    part.setQuery('')
  })
  const notice = h('div', { className: 'banner info', role: 'status', textContent: PRIVATE_TEXT })
  const list = h('ul', { className: 'sites-ul', role: 'list' })
  const showAll = h('button', { className: 'link-btn sites-show-all', type: 'button', onclick: () => { part.showEverything() } })
  const resetAll = h('button', { className: 'btn danger', type: 'button', onclick: () => { void part.pressResetAll() } })
  resetAll.dataset['focusKey'] = 'reset-all'
  const declinedHead = h('h3', { className: 'sites-declined-head', textContent: 'Apps you refused' })
  const declinedNote = h('p', { className: 'sites-declined-note', textContent: 'These open as plain websites. Ask again to be asked what each may do the next time you visit it.' })
  const declined = h('ul', { className: 'sites-ul sites-declined', role: 'list' })
  const root = h('div', { className: 'sites-list' }, h('div', { className: 'sites-head' }, search), notice, list, showAll, h('div', { className: 'btn-row sites-foot' }, resetAll), declinedHead, declinedNote, declined)
  // The page hands the keyboard back to a control inside this element after it redraws.
  root.dataset['keepFocus'] = 'true'

  const update = (): void => {
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset['focusKey'] : undefined
    notice.hidden = !part.isPrivate
    search.disabled = !part.loaded
    // Nothing to search until a site has settings of its own.
    search.hidden = part.loaded && part.sites.length === 0
    const { shown, hidden, matching } = part.page()
    if (!part.loaded) {
      list.setAttribute('aria-busy', 'true')
      replaceChildren(list, skeletonRow(), skeletonRow())
    } else {
      list.removeAttribute('aria-busy')
      if (part.sites.length === 0) replaceChildren(list, emptyState(EMPTY_TEXT))
      else if (matching === 0) replaceChildren(list, emptyState(`No sites match "${part.query.trim()}".`))
      else replaceChildren(list, ...shown.map((site) => siteItem(site, part)))
    }
    showAll.hidden = hidden === 0
    showAll.textContent = `Show all ${String(matching)}`
    resetAll.hidden = part.sites.length === 0
    resetAll.className = part.armedResetAll ? 'btn danger armed' : 'btn danger'
    resetAll.textContent = part.armedResetAll ? 'Click again to reset' : 'Reset all site settings'
    declinedHead.hidden = declinedNote.hidden = declined.hidden = part.declinedApps.length === 0
    replaceChildren(declined, ...part.declinedApps.map((origin) => declinedItem(origin, part)))
    if (focused !== undefined) (root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`) ?? search).focus()
  }
  part.subscribe(update)
  update()
  return root
}

const views = new WeakMap<SitesPart, HTMLElement>()

/** The "Sites with their own settings" control: the same element on every redraw of the page. */
export function renderSitesList (state: SettingsState): HTMLElement {
  const part = state.part<SitesPart>('sites')
  let root = views.get(part)
  if (root === undefined) {
    root = build(part)
    views.set(part, root)
  }
  return root
}
