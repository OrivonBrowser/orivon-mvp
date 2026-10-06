import type { SiteDataSnapshot } from '../../main/ipc/site-info-ipc.js'
import type { PickedPathRow } from '../../main/permissions/permissions.js'
import { backIcon, chevronIcon } from './icons.js'
import { cookieRows } from '../pages/shared/cookie-row.js'
import { grantIcon } from '../grant-icons.js'

// The Cookies and site data page -- two sections, kept visibly separate
// (`ADR-0003`'s tiers): the site's ordinary browser storage, and what it
// stores through Orivon's own `fs` capability. Every figure here is
// approximate and says so: `navigator.storage.estimate()` pads opaque
// cache entries and never counts localStorage's own bytes, and disk sizes
// are read at the moment the page opened, not live.

function formatBytes (bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`
}

/** What the page remembers between draws: the popover redraws the whole page on every change. */
export interface DataPageView {
  readonly cookiesOpen: boolean
  /** The button that has had its first click, waiting for its second. */
  readonly armed: 'cookies' | 'site' | 'file' | null
  /** Something was deleted since the page opened, so the tab still shows what it had. */
  readonly deleted: boolean
}

export interface DataPageCallbacks {
  readonly onBack: () => void
  readonly onClearBrowserData: () => void
  readonly onToggleCookies: () => void
  readonly onRemoveCookie: (key: string) => void
  readonly onClearCookies: () => void
  readonly onReload: () => void
  readonly onRevokePickedPath: (pickId: string) => void
  /** Present only for a local file: deletes its grants, saved data and record. */
  readonly onDeleteLocalFile?: () => void
}

/** A line of explanation under the control it is about. */
function help (text: string): HTMLElement {
  const el = document.createElement('p')
  el.className = 'data-help'
  el.textContent = text
  return el
}

function note (text: string): HTMLElement {
  const el = document.createElement('p')
  el.className = 'empty-state'
  el.textContent = text
  return el
}

/** A button that deletes, and asks twice: the first press arms it and the second does it. */
function destructive (label: string, armed: boolean, onPress: () => void, id: string, title?: string): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.id = id
  button.className = armed ? 'btn-secondary armed' : 'btn-secondary'
  button.textContent = armed ? 'Click again to delete' : label
  button.setAttribute('aria-label', armed ? `Click again: ${label}` : label)
  if (title !== undefined && !armed) button.title = title
  button.addEventListener('click', onPress)
  return button
}

function reloadBanner (onReload: () => void): HTMLElement {
  const banner = document.createElement('div')
  banner.className = 'reload-banner'
  banner.setAttribute('role', 'status')
  const text = document.createElement('span')
  text.textContent = 'Reload the page to apply your changes.'
  const reload = document.createElement('button')
  reload.type = 'button'
  reload.className = 'btn-secondary'
  reload.textContent = 'Reload'
  reload.addEventListener('click', onReload)
  banner.append(text, reload)
  return banner
}

/** The cookie count; a count above nothing opens the list. */
function cookiesRow (data: SiteDataSnapshot, view: DataPageView, callbacks: DataPageCallbacks): HTMLElement {
  if (data.cookies.length === 0) return statRow('Cookies', '0')
  const li = document.createElement('li')
  li.className = 'stat-row'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'expander'
  toggle.id = 'cookies-toggle'
  toggle.setAttribute('aria-expanded', String(view.cookiesOpen))
  toggle.setAttribute('aria-controls', 'cookie-list')
  toggle.append(chevronIcon())
  const label = document.createElement('span')
  label.className = 'stat-label'
  label.textContent = 'Cookies'
  toggle.append(label)
  toggle.addEventListener('click', callbacks.onToggleCookies)
  const value = document.createElement('span')
  value.className = 'stat-value'
  value.textContent = String(data.cookies.length)
  li.append(toggle, value)
  return li
}

function statRow (label: string, value: string): HTMLElement {
  const li = document.createElement('li')
  li.className = 'stat-row'
  const labelEl = document.createElement('span')
  labelEl.className = 'stat-label'
  labelEl.textContent = label
  const valueEl = document.createElement('span')
  valueEl.className = 'stat-value'
  valueEl.textContent = value
  li.append(labelEl, valueEl)
  return li
}

export function renderDataPage (
  container: HTMLElement,
  data: SiteDataSnapshot | null,
  pickedPathRows: readonly PickedPathRow[],
  view: DataPageView,
  callbacks: DataPageCallbacks
): void {
  container.replaceChildren()

  const backRow = document.createElement('button')
  backRow.type = 'button'
  backRow.className = 'back-row'
  backRow.append(backIcon())
  const backLabel = document.createElement('span')
  backLabel.textContent = 'Cookies and site data'
  backRow.append(backLabel)
  backRow.addEventListener('click', callbacks.onBack)
  container.append(backRow)

  if (data === null) {
    const loading = document.createElement('p')
    loading.className = 'empty-state loading'
    const spinner = document.createElement('span')
    spinner.className = 'spinner'
    spinner.setAttribute('role', 'status')
    spinner.setAttribute('aria-label', 'Loading')
    loading.append(spinner, 'Loading…')
    container.append(loading)
    return
  }

  const browserHeading = document.createElement('p')
  browserHeading.className = 'section-heading'
  browserHeading.textContent = 'Browser storage'
  container.append(browserHeading)

  if (view.deleted) container.append(reloadBanner(callbacks.onReload))

  const browserStats = document.createElement('ul')
  browserStats.className = 'stat-list'
  browserStats.append(cookiesRow(data, view, callbacks))
  browserStats.append(statRow(
    'Local storage, IndexedDB, cache',
    data.browserStorage === null ? 'Not available' : `Approximately ${formatBytes(data.browserStorage.usageBytes)}`
  ))
  container.append(browserStats)

  if (data.cookies.length === 0) {
    container.append(note('This site has not stored any cookies.'))
  } else if (view.cookiesOpen) {
    const list = document.createElement('ul')
    list.className = 'cookie-list'
    list.id = 'cookie-list'
    list.append(...cookieRows(data.cookies, callbacks.onRemoveCookie))
    container.append(list)
  }
  container.append(help('Cookies from other sites embedded here are listed under those sites in Settings.'))

  const actions = document.createElement('div')
  actions.className = 'data-actions'
  if (data.cookies.length > 0) actions.append(destructive('Delete all cookies for this site', view.armed === 'cookies', callbacks.onClearCookies, 'clear-cookies'))
  if (callbacks.onDeleteLocalFile === undefined) {
    actions.append(destructive('Delete all data for this site', view.armed === 'site', callbacks.onClearBrowserData, 'clear-site', 'You may be signed out of this site'))
  } else {
    actions.append(destructive('Delete data for this file', view.armed === 'file', callbacks.onDeleteLocalFile, 'clear-file', 'Removes what this file may do, the files it saved, and what its own session kept'))
  }
  container.append(actions)

  container.append(document.createElement('hr'))

  const orivonHeading = document.createElement('p')
  orivonHeading.className = 'section-heading'
  orivonHeading.textContent = 'Orivon storage'
  container.append(orivonHeading)

  if (data.orivonCodeVersion === undefined && data.orivonFilesQuotaBytes === undefined && pickedPathRows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = 'This site stores nothing through Orivon.'
    container.append(empty)
    return
  }

  const orivonStats = document.createElement('ul')
  orivonStats.className = 'stat-list'
  if (data.orivonCodeVersion !== undefined) {
    orivonStats.append(statRow('App code (pinned copy)', `${formatBytes(data.orivonCodeBytes)}, version ${data.orivonCodeVersion}`))
  }
  if (data.orivonFilesQuotaBytes !== undefined) {
    orivonStats.append(statRow('Private files', formatBytes(data.orivonFilesBytes)))
    orivonStats.append(statRow('Limit the app declared', formatBytes(data.orivonFilesQuotaBytes)))
  }
  container.append(orivonStats)

  if (pickedPathRows.length > 0) {
    const picksHeading = document.createElement('p')
    picksHeading.className = 'section-heading'
    picksHeading.textContent = 'Files and folders picked'
    container.append(picksHeading)
    const picks = document.createElement('ul')
    picks.className = 'row-list'
    for (const pick of pickedPathRows) {
      const li = document.createElement('li')
      li.className = 'row'
      li.classList.toggle('warning', pick.warning)
      const text = document.createElement('span')
      text.className = 'row-message'
      text.textContent = pick.message
      const revoke = document.createElement('button')
      revoke.type = 'button'
      revoke.className = 'btn-secondary'
      revoke.textContent = 'Remove'
      revoke.addEventListener('click', () => { callbacks.onRevokePickedPath(pick.pickId) })
      li.append(grantIcon(pick.kind), text, revoke)
      picks.append(li)
    }
    container.append(picks)
  }
}
