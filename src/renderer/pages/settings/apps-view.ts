// The apps, one card each: a switch for everything it may do (the rows the key popup shows, so an app switched off
// stays here to be switched on), the files it was given, the devices it may use and the kinds of link it opens (each
// a switch that is on, and switching it off takes it away), and what it has stored.
// Text goes in as text: an app's name and the words for what it asked for come
// from the app, and are never markup.
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import { h } from '../shared/dom.js'
import { globeIcon } from '../shared/globe-icon.js'
import { grantIcon } from '../shared/grant-icons.js'
import type { GrantIconKind } from '../shared/grant-icons.js'
import type { AppRow, AppTunnel, CapabilityRow } from './apps-state.js'
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

/** How a sentence names the tunnel an app goes through. */
const TUNNEL_NAME = { nym: 'Nym', socks5: 'your proxy' } as const

/** Why a tunnel cannot be chosen for an app now, in words about the person's situation. */
const BLOCKED_WORDS = {
  'no-proxy': 'Your proxy has no address yet: set one under Tunnels.',
  'not-cached': 'Only an app Orivon holds on this computer can be sent through a tunnel.',
  'nym-off': 'Nym is switched off: switch it on under Tunnels.'
} as const

/** What the choice of an app's tunnel says under its label, about the person's situation rather than the program's. */
export function routeWords (route: AppRow['route']): string {
  if (route.unreadable === true) return 'Orivon could not read which apps you sent through a tunnel, so every app goes through your default tunnel, or through Nym when that has no address. Mend or remove routes.json in your profile folder and restart Orivon to choose again.'
  if (route.state === 'off' || route.via === null) {
    const why = [...new Set(Object.values(route.blocked))].map((reason) => BLOCKED_WORDS[reason])
    return ['Off: this app connects as you do.', ...why].join(' ')
  }
  const tunnel = TUNNEL_NAME[route.via]
  const name = route.via === 'nym' ? 'Nym' : 'Your proxy'
  if (route.state === 'no-proxy') return `${name} has no address, so this app's traffic is stopped, not sent directly. Set one under Tunnels.`
  if (route.state === 'down') return `${name} is not answering. This app's traffic is stopped, not sent directly.`
  return `Everything this app sends leaves through ${tunnel}, and what the tunnel cannot carry is refused. Its updates are not checked while this is on.`
}

/** The options of the choice: what each says, and why it cannot be picked now. */
export function routeOptions (route: AppRow['route']): ReadonlyArray<{ readonly value: '' | AppTunnel, readonly label: string, readonly disabled: boolean }> {
  return [
    { value: '', label: 'Off', disabled: false },
    { value: 'nym', label: 'Nym', disabled: route.via !== 'nym' && route.blocked.nym !== undefined },
    { value: 'socks5', label: 'Your proxy', disabled: route.via !== 'socks5' && route.blocked.socks5 !== undefined }
  ]
}

function routeRow (app: AppRow, state: SettingsState): HTMLElement {
  const select = h('select', { id: `route-${app.origin}`, disabled: app.route.unreadable === true },
    ...routeOptions(app.route).map((option) => h('option', { value: option.value, textContent: option.label, disabled: option.disabled, selected: option.value === (app.route.via ?? '') })))
  select.dataset['focusKey'] = `${app.origin}|route`
  select.addEventListener('change', () => {
    // A choice leaves the control focused, and a focused control that is not settled holds every redraw (main.ts).
    select.dataset['settled'] = 'true'
    void state.apps.setRoute(app.origin, select.value === 'nym' || select.value === 'socks5' ? select.value : null)
  })
  return h('div', { className: 'app-route' },
    h('div', { className: 'app-route-text' },
      h('label', { htmlFor: `route-${app.origin}`, textContent: 'Tunnel for this app' }),
      h('p', { className: app.route.unreadable === true || app.route.state === 'down' || app.route.state === 'no-proxy' ? 'problem' : 'muted', textContent: routeWords(app.route) }),
      state.apps.routeRefused.has(app.origin) ? h('p', { className: 'problem', role: 'alert', textContent: 'That could not be changed. Check the tunnels under Tunnels.' }) : null),
    select)
}

/** Why an off switch cannot be turned on from this page. */
export const OPEN_APP_FIRST = 'Open the app once to turn this on again.'
/** What a row says when its switch could not be moved, by the way the person moved it. */
export function capabilityFailure (on: boolean): string {
  return on
    ? 'Orivon could not turn that on. The app may have changed what it asks for: look at the row and try again.'
    : 'Orivon could not turn that off. Try again.'
}

/** One row of a card: what the permission is, in words, and the switch that gives or takes it. */
function switchRow (icon: SVGSVGElement, message: string, options: { on: boolean, disabled: boolean, busy?: boolean, warning: boolean, focusKey: string, note?: string, problem?: string }, change: (on: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: options.on, disabled: options.disabled })
  // Every switch of every card is in the one row, so the page finds this one again after a redraw by its key (main.ts).
  input.dataset['focusKey'] = options.focusKey
  input.setAttribute('aria-label', message)
  input.addEventListener('change', () => {
    // A switch whose request is in flight stays enabled, so the keyboard keeps it through the redraw (a disabled input cannot hold focus), and a press is put back.
    if (options.busy === true) { input.checked = !input.checked; return }
    // A click leaves the switch focused, and a focused input that is not settled holds every redraw (main.ts).
    input.dataset['settled'] = 'true'
    change(input.checked)
  })
  icon.setAttribute('aria-hidden', 'true')
  input.setAttribute('aria-busy', String(options.busy === true))
  return h('li', { className: `perm${options.warning ? ' warning' : ''}${options.busy === true ? ' busy' : ''}` },
    icon,
    h('span', { className: 'perm-text' },
      h('span', { textContent: message }),
      options.note === undefined ? null : h('span', { className: 'perm-note muted', textContent: options.note }),
      options.problem === undefined ? null : h('span', { className: 'perm-note problem', role: 'alert', textContent: options.problem })),
    h('span', { className: 'switch' }, input, h('span', { className: 'track' })))
}

function capabilityRow (app: AppRow, row: CapabilityRow, state: SettingsState): HTMLElement {
  const refused = state.apps.capabilityRefused.get(`${app.origin}|${row.capability}`)
  const blocked = !row.on && !row.canTurnOn
  const busy = state.apps.capabilityBusy.has(`${app.origin}|${row.capability}`)
  const item = switchRow(grantIcon(row.capability as GrantIconKind), row.message,
    { on: row.on, disabled: blocked, busy, warning: row.warning, focusKey: `${app.origin}|cap|${row.capability}`, ...(blocked ? { note: OPEN_APP_FIRST } : {}), ...(refused === undefined ? {} : { problem: capabilityFailure(refused) }) },
    (on) => { void state.apps.setCapability(app.origin, row, on) })
  item.dataset['capability'] = row.capability
  return item
}

function card (app: AppRow, state: SettingsState): HTMLElement {
  const rows = [
    ...app.capabilityRows.map((row) => capabilityRow(app, row, state)),
    ...app.pickedPathRows.map((row) => switchRow(grantIcon(row.kind === 'directory' ? 'directory' : 'file'), row.message, { on: true, disabled: false, warning: row.warning, focusKey: `${app.origin}|pick|${row.pickId}` }, () => { void state.apps.revokePickedPath(app.origin, row.pickId) })),
    ...app.deviceRows.map((row) => switchRow(grantIcon('devices.hid'), `Can use ${row.label}.`, { on: true, disabled: false, warning: false, focusKey: `${app.origin}|device|${row.key}` }, () => { void state.apps.forgetDevice(app.origin, row.key) })),
    ...app.linkSchemes.map((scheme) => switchRow(globeIcon(), `Opens ${scheme} links.`, { on: true, disabled: false, warning: false, focusKey: `${app.origin}|link|${scheme}` }, () => { void state.apps.forgetLink(app.origin, scheme) }))
  ]
  const stored = `Stores ${sizeWords(app.storage.filesBytes)} of files and ${sizeWords(app.storage.codeBytes)} of its own code.`
  const section = h('section', { className: 'app-card' },
    h('div', { className: 'app-head' },
      h('strong', { className: 'app-origin', textContent: BUILTIN_ADDRESSES.displayOrigin(app.origin) }),
      h('span', { className: 'muted', textContent: `Claims to be "${app.appName}".` })),
    rows.length === 0 ? h('p', { className: 'muted', textContent: 'It has not asked for anything.' }) : h('ul', { className: 'perms' }, ...rows),
    routeRow(app, state),
    h('p', { className: 'muted app-stored', textContent: stored }))
  section.dataset['origin'] = app.origin
  return section
}

export function renderApps (state: SettingsState): HTMLElement {
  if (state.apps.apps === null) {
    void state.apps.load()
    return h('p', { className: 'muted', textContent: 'Loading…' })
  }
  if (state.apps.apps.length === 0) return h('p', { className: 'muted', textContent: 'No app is installed. When you let one in, it is listed here, with a switch for everything it may do.' })
  return h('div', { className: 'apps' }, ...state.apps.apps.map((app) => card(app, state)))
}
