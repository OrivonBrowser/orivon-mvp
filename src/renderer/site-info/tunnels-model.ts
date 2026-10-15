import type { SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import { routeLineWords } from './route-line.js'
import { extensionsHint, tunnelHint } from './tunnel-view.js'

// What the tunnel list of the site-info popup shows, as data: the row of the tunnel in use, and the words under it.
// Pure, so the rows are tested without a DOM. A tunnel added later is one entry in TUNNEL_KINDS.

export type TunnelKindId = 'nym' | 'socks5'

export interface TunnelKind {
  readonly id: TunnelKindId
  readonly name: string
  /** The logo's address, or null for the generic tunnel icon. */
  readonly logo: string | null
}

export const TUNNEL_KINDS: readonly TunnelKind[] = [
  { id: 'nym', name: 'Nym', logo: new URL('../assets/tunnels/nym.png', import.meta.url).href },
  { id: 'socks5', name: 'Your SOCKS5 tunnel', logo: null }
]

export interface TunnelLine {
  readonly text: string
  /** The line is a problem: drawn in the warning colour. */
  readonly down: boolean
}

export interface TunnelRowModel {
  readonly kind: TunnelKind
  /** The switch is on. */
  readonly on: boolean
  /** The switch cannot be moved: an installed app's is on its card in Settings, a switched-off Nym cannot take a site. */
  readonly disabled: boolean
  /** The one line under the name. */
  readonly state: TunnelLine
  /** What else the person is told, in order: why the switch is fixed, the profile's extensions. */
  readonly notes: readonly TunnelLine[]
  /** The row carries a link to Tunnels settings: Nym is switched off there. */
  readonly settingsLink: boolean
}

export interface TunnelListModel {
  readonly rows: readonly TunnelRowModel[]
  /** Said instead of rows when the page has no tunnel switch of its own. */
  readonly empty: string | null
  /** The hint under the list. */
  readonly hint: { readonly text: string, readonly link: string, readonly everywhere: boolean }
}

export const NYM_OFF_LINE = 'Nym is switched off in Settings.'
export const NYM_OFF_LINK = 'Switch it on in Tunnels settings'
export const ENFORCE_LINK = 'Enforce a tunnel browser-wide'
export const EVERYWHERE_HINT = 'Every site goes through the tunnel unless you switch it off here. Change this in Tunnels settings.'
export const NO_SWITCH_NOTE = 'This page has no tunnel switch here. An installed app is switched on from its card in Settings, under Apps, and a page from this computer is never sent through a tunnel.'

function kindOf (id: TunnelKindId): TunnelKind {
  return TUNNEL_KINDS.find((kind) => kind.id === id) ?? TUNNEL_KINDS[0] as TunnelKind
}

/** A website's row: the switch is the site's own tunnel switch. */
function siteRow (info: SiteInfo, tunnel: SiteTunnel, extensions: readonly string[], shownOn: boolean): TunnelRowModel {
  const kind = kindOf(info.tunnelKind ?? 'nym')
  const hint = tunnelHint(tunnel)
  const reach = extensionsHint(extensions, tunnel.profile)
  const stopped = tunnel.nymOff
  const line: TunnelLine = stopped
    ? { text: NYM_OFF_LINE, down: true }
    : tunnel.on && info.route !== undefined
      ? { text: routeLineWords(info.route, 'site', info.nym), down: info.route === 'down' || info.route === 'no-proxy' || info.nym?.state === 'failed' || info.nym?.state === 'unavailable' }
      : { text: info.everywhere === true ? 'Switched off here: this site goes outside the tunnel.' : 'This site is not sent through the tunnel.', down: false }
  return {
    kind,
    on: shownOn,
    disabled: tunnel.unreadable || (!tunnel.on && (tunnel.blocked !== undefined || stopped)),
    state: line,
    notes: [
      ...(hint === undefined ? [] : [{ text: hint, down: tunnel.unreadable || tunnel.blocked !== undefined }]),
      ...(reach === undefined ? [] : [{ text: reach, down: false }])
    ],
    settingsLink: stopped
  }
}

/** An installed app's row, or a page opened through the tunnel from one: the route is set elsewhere, so the switch only shows it. */
function appRow (info: SiteInfo): TunnelRowModel {
  const route = info.route ?? 'idle'
  return {
    kind: kindOf(info.tunnelKind ?? (info.nym === undefined ? 'socks5' : 'nym')),
    on: true,
    disabled: true,
    state: { text: routeLineWords(route, 'app', info.nym), down: route === 'down' || route === 'no-proxy' || info.nym?.state === 'failed' || info.nym?.state === 'unavailable' },
    notes: [],
    settingsLink: false
  }
}

export function tunnelListModel (info: SiteInfo, view: { readonly next: boolean | null }): TunnelListModel {
  const everywhere = info.everywhere === true
  const hint = everywhere
    ? { text: EVERYWHERE_HINT, link: 'Open Tunnels settings', everywhere: false }
    : { text: '', link: ENFORCE_LINK, everywhere: true }
  if (info.tunnel !== undefined && info.route !== 'temporary') {
    return { rows: [siteRow(info, info.tunnel, info.extensionsOnSite, view.next ?? info.tunnel.on)], empty: null, hint }
  }
  if (info.route !== undefined) return { rows: [appRow(info)], empty: null, hint }
  return { rows: [], empty: NO_SWITCH_NOTE, hint }
}
