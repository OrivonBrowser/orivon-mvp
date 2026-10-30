// The list of sites and apps that have a tunnel setting or storage of their own, under the tunnel's address: each with
// what its setting does and, for a website that keeps storage of its own, the button that clears it.
import { h } from '../../shared/dom.js'
import { tunnelRowWords } from '../route-part.js'
import type { RoutePart, TunnelRowView } from '../route-part.js'
import type { SettingsState } from '../state.js'

export const EMPTY_TUNNEL_LIST = 'No site or app has its own tunnel setting yet. Keep one for a website with Always use for this site in the tunnel button in the address bar, or for an app under Apps.'
export const REMOVE_STORAGE = 'Remove its separate storage'

function rowOf (row: TunnelRowView, part: RoutePart): HTMLElement {
  const clearing = part.clearing.has(row.origin)
  return h('div', { className: 'tunnel-list-row' },
    h('div', { className: 'tunnel-list-text' },
      h('span', { className: 'tunnel-list-origin', textContent: row.origin }),
      h('p', { className: 'muted', textContent: tunnelRowWords(row) }),
      part.refused.has(row.origin) ? h('p', { className: 'problem', role: 'alert', textContent: 'Its storage could not be removed.' }) : h('span')),
    row.kind === 'site' && row.apart
      ? h('button', { className: 'btn', type: 'button', textContent: clearing ? 'Removing…' : REMOVE_STORAGE, disabled: clearing, onclick: () => { void part.removeStorage(row.origin) } })
      : h('span'))
}

/** The heading a row is listed under: websites by the profile they live in or keep storage in, installed apps together. */
export function groupOf (row: TunnelRowView): 'nym' | 'socks5' | 'direct' | 'apps' {
  if (row.kind === 'app') return 'apps'
  return row.profile ?? row.apartIn[0] ?? 'nym'
}

const GROUP_TITLES = { nym: 'Nym profile', socks5: 'Proxy profile', direct: 'Direct profile', apps: 'Apps' } as const

export function renderTunnelList (state: SettingsState): HTMLElement {
  const part = state.part<RoutePart>('route')
  if (part.rows === null) return h('div', { className: 'tunnel-list' }, h('p', { className: 'muted', textContent: 'Loading…' }))
  if (part.rows.length === 0) return h('div', { className: 'tunnel-list' }, h('p', { className: 'muted', textContent: EMPTY_TUNNEL_LIST }))
  const sorted = [...part.rows].sort((a, b) => a.origin.localeCompare(b.origin))
  const groups = (['nym', 'socks5', 'direct', 'apps'] as const).flatMap((group) => {
    const rows = sorted.filter((row) => groupOf(row) === group)
    return rows.length === 0 ? [] : [h('h4', { className: 'tunnel-list-group', textContent: GROUP_TITLES[group] }), ...rows.map((row) => rowOf(row, part))]
  })
  return h('div', { className: 'tunnel-list' }, ...groups)
}
