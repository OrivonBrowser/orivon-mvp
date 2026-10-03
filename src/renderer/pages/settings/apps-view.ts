// The apps that hold permissions, one card each: what it may do (each with a
// button that takes it away), the files it was given, and what it has stored.
// Text goes in as text: an app's name and the words for what it asked for come
// from the app, and are never markup.
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import { h } from '../shared/dom.js'
import type { AppRow } from './apps-state.js'
import type { SettingsState } from './state.js'

const KIB = 1024

/** A size a person reads: bytes up to a kilobyte, then one decimal. */
export function sizeWords (bytes: number): string {
  if (bytes < KIB) return `${String(bytes)} bytes`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / KIB
  let unit = 0
  // Judged on the figure as it will be written, so a size just under a unit reads "1.0 MB", not "1024 KB".
  while (unit < units.length - 1 && Number(value.toFixed(value < 10 ? 1 : 0)) >= KIB) {
    value /= KIB
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'GB'}`
}

function card (app: AppRow, state: SettingsState): HTMLElement {
  const revoke = (label: string, run: () => Promise<void>): HTMLElement =>
    h('button', { className: 'btn small', type: 'button', textContent: label, onclick: () => { void run() } })
  const rows = [
    ...app.rows.map((row) => h('li', { className: row.warning ? 'perm warning' : 'perm' },
      h('span', { className: 'perm-text', textContent: row.message }),
      revoke('Revoke', async () => { await state.apps.revoke(app.origin, row.capability) }))),
    ...app.pickedPathRows.map((row) => h('li', { className: row.warning ? 'perm warning' : 'perm' },
      h('span', { className: 'perm-text', textContent: row.message }),
      revoke('Remove', async () => { await state.apps.revokePickedPath(app.origin, row.pickId) })))
  ]
  const stored = `Stores ${sizeWords(app.storage.filesBytes)} of files and ${sizeWords(app.storage.codeBytes)} of its own code.`
  return h('section', { className: 'app-card' },
    h('div', { className: 'app-head' },
      h('strong', { className: 'app-origin', textContent: BUILTIN_ADDRESSES.displayOrigin(app.origin) }),
      h('span', { className: 'muted', textContent: `Claims to be "${app.appName}".` })),
    rows.length === 0 ? h('p', { className: 'muted', textContent: 'Nothing is granted to it now.' }) : h('ul', { className: 'perms' }, ...rows),
    h('p', { className: 'muted app-stored', textContent: stored }))
}

export function renderApps (state: SettingsState): HTMLElement {
  if (state.apps.apps === null) {
    void state.apps.load()
    return h('p', { className: 'muted', textContent: 'Loading…' })
  }
  if (state.apps.apps.length === 0) return h('p', { className: 'muted', textContent: 'No app holds a permission. When you allow one, it is listed here, and you can take the permission back at any time.' })
  return h('div', { className: 'apps' }, ...state.apps.apps.map((app) => card(app, state)))
}
