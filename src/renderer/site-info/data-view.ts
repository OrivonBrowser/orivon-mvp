import type { SiteDataSnapshot } from '../../main/ipc/site-info-ipc.js'
import type { PickedPathRow } from '../../main/permissions/permissions.js'
import { backIcon } from './icons.js'
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

export interface DataPageCallbacks {
  readonly onBack: () => void
  readonly onClearBrowserData: () => void
  readonly onRevokePickedPath: (pickId: string) => void
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
    loading.className = 'empty-state'
    loading.textContent = 'Loading…'
    container.append(loading)
    return
  }

  const browserHeading = document.createElement('p')
  browserHeading.className = 'section-heading'
  browserHeading.textContent = 'Browser storage'
  container.append(browserHeading)

  const browserStats = document.createElement('ul')
  browserStats.className = 'stat-list'
  browserStats.append(statRow('Cookies', String(data.cookieCount)))
  browserStats.append(statRow(
    'Local storage, IndexedDB, cache',
    data.browserStorage === null ? 'Not available' : `Approximately ${formatBytes(data.browserStorage.usageBytes)}`
  ))
  container.append(browserStats)

  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'btn-secondary'
  clear.textContent = 'Clear browser data'
  clear.title = 'You may be signed out of this site'
  clear.addEventListener('click', callbacks.onClearBrowserData)
  container.append(clear)

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
