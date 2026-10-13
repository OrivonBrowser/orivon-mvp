// The apps that hold permissions, one card each: what it may do (each with a
// button that takes it away), the files it was given, the devices it may use, the kinds of link it opens, and what it has stored.
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

/** What the switch that routes an app says under its label, about the person's situation rather than the program's. */
export function routeWords (route: AppRow['route']): string {
  if (route.unreadable === true) return 'Orivon could not read which apps you routed, so while a tunnel is set every app goes through it. Mend or remove routes.json in your profile folder and restart Orivon to choose again.'
  if (route.state === 'off') {
    if (route.blocked === 'no-proxy') return 'Set a tunnel under Privacy and data first.'
    if (route.blocked === 'not-cached') return 'Only an app Orivon holds on this computer can be routed.'
    return 'Off: this app connects as you do.'
  }
  if (route.state === 'no-proxy') return 'No tunnel is set, so this app\'s traffic is stopped, not sent directly. Set one under Privacy and data.'
  if (route.state === 'down') return 'Your tunnel is not answering. This app\'s traffic is stopped, not sent directly.'
  return 'Everything this app sends leaves through your tunnel, and what the tunnel cannot carry is refused. Its updates are not checked while this is on.'
}

function routeRow (app: AppRow, state: SettingsState): HTMLElement {
  const on = app.route.state !== 'off'
  const input = h('input', { type: 'checkbox', id: `route-${app.origin}`, checked: on, disabled: app.route.unreadable === true || (!on && app.route.blocked !== undefined) })
  input.addEventListener('change', () => {
    // A click leaves the switch focused, and a focused input that is not settled holds every redraw (main.ts).
    input.dataset['settled'] = 'true'
    void state.apps.setRoute(app.origin, input.checked)
  })
  return h('div', { className: 'app-route' },
    h('div', { className: 'app-route-text' },
      h('label', { htmlFor: `route-${app.origin}`, textContent: 'Send this app\'s traffic through my tunnel' }),
      h('p', { className: app.route.unreadable === true || app.route.state === 'down' || app.route.state === 'no-proxy' ? 'problem' : 'muted', textContent: routeWords(app.route) }),
      state.apps.routeRefused.has(app.origin) ? h('p', { className: 'problem', role: 'alert', textContent: 'That could not be changed. Check the tunnel under Privacy and data.' }) : null),
    h('span', { className: 'switch' }, input, h('span', { className: 'track' })))
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
      revoke('Remove', async () => { await state.apps.revokePickedPath(app.origin, row.pickId) }))),
    ...app.deviceRows.map((row) => h('li', { className: 'perm' },
      h('span', { className: 'perm-text', textContent: `Can use ${row.label}.` }),
      revoke('Forget', async () => { await state.apps.forgetDevice(app.origin, row.key) }))),
    ...app.linkSchemes.map((scheme) => h('li', { className: 'perm' },
      h('span', { className: 'perm-text', textContent: `Opens ${scheme} links.` }),
      revoke('Stop', async () => { await state.apps.forgetLink(app.origin, scheme) })))
  ]
  const stored = `Stores ${sizeWords(app.storage.filesBytes)} of files and ${sizeWords(app.storage.codeBytes)} of its own code.`
  return h('section', { className: 'app-card' },
    h('div', { className: 'app-head' },
      h('strong', { className: 'app-origin', textContent: BUILTIN_ADDRESSES.displayOrigin(app.origin) }),
      h('span', { className: 'muted', textContent: `Claims to be "${app.appName}".` })),
    rows.length === 0 ? h('p', { className: 'muted', textContent: 'Nothing is granted to it now.' }) : h('ul', { className: 'perms' }, ...rows),
    routeRow(app, state),
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
