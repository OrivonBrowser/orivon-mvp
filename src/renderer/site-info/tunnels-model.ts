import type { SiteInfo, SiteTunnelKind } from '../../main/permissions/site-info.js'
import { routeLineWords } from './route-line.js'
import { extensionsHint, tunnelHint } from './tunnel-view.js'

// What the tunnel list of the site-info popup shows, as data: one row for each tunnel a website or an installed app can go
// through, and the words under them. Pure, so the rows are tested without a DOM. A tunnel added later is one entry in TUNNEL_KINDS.

export type TunnelKindId = SiteTunnelKind

export interface TunnelKind {
  readonly id: TunnelKindId
  readonly name: string
  /** How a sentence names it: "Use Nym for this site". */
  readonly who: string
  /** The logo's address, or null for the generic tunnel icon. */
  readonly logo: string | null
}

export const TUNNEL_KINDS: readonly TunnelKind[] = [
  { id: 'nym', name: 'Nym', who: 'Nym', logo: new URL('../assets/tunnels/nym.png', import.meta.url).href },
  { id: 'socks5', name: 'Your proxy', who: 'your proxy', logo: null }
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
  /** The switch cannot be moved: the choice is fixed here, or the tunnel cannot take the page now. */
  readonly disabled: boolean
  /** The one line under the name: what the tunnel is doing for this page when it is on, why it cannot be chosen when it cannot. */
  readonly state: TunnelLine
  /** The row carries a link to Tunnels settings, with these words: the tunnel is switched off or has no address there. */
  readonly settingsLink: string | null
}

export interface TunnelListModel {
  readonly rows: readonly TunnelRowModel[]
  /** What else the person is told, in order: why the choice is fixed, what a profile does to extensions, what an app gives up. */
  readonly notes: readonly TunnelLine[]
  /** Said instead of rows when the page has no tunnel choice of its own. */
  readonly empty: string | null
  /** The hint under the list. */
  readonly hint: { readonly text: string, readonly link: string, readonly everywhere: boolean }
}

export const NYM_OFF_LINE = 'Nym is switched off in Settings.'
export const NYM_OFF_LINK = 'Switch it on in Tunnels settings'
export const PROXY_UNSET_LINE = 'No proxy address is set.'
export const PROXY_UNSET_LINK = 'Set it in Tunnels settings'
export const ENFORCE_LINK = 'Enforce a tunnel browser-wide'
export const HELD_LINE = 'This private window always goes through Nym, so this choice cannot be changed.'
export const NO_SWITCH_NOTE = 'A page from this computer is never sent through a tunnel.'
export const APP_UPDATES_NOTE = 'Its updates are not checked while it goes through a tunnel.'

export function everywhereHint (defaultKind: TunnelKindId): string {
  return `Every site and app that has no choice here goes through ${kindOf(defaultKind).who}. Change this in Tunnels settings.`
}

export function openedLine (via: TunnelKindId): string {
  return `This page goes through ${kindOf(via).who} because the app that opened it does.`
}

function kindOf (id: TunnelKindId): TunnelKind {
  return TUNNEL_KINDS.find((kind) => kind.id === id) ?? TUNNEL_KINDS[0] as TunnelKind
}

/** What the tunnel in use is doing for the page, as one line. */
function inUseLine (info: SiteInfo, subject: 'app' | 'site'): TunnelLine {
  const route = info.route ?? 'idle'
  return { text: routeLineWords(route, subject, info.nym), down: route === 'down' || route === 'no-proxy' || info.nym?.state === 'failed' || info.nym?.state === 'unavailable' }
}

/**
 * `view.pending` is the tunnel the person moved the switch to while the notice before a first move into a profile is open (null:
 * none), undefined while no notice is open; the rows show it as if it were done.
 */
export function tunnelListModel (info: SiteInfo, view: { readonly pending: TunnelKindId | null | undefined }): TunnelListModel {
  const everywhere = info.everywhere === true
  const defaultKind = info.tunnel?.defaultKind ?? info.tunnelKind ?? 'nym'
  // A window held to a tunnel says so on the row; under the list it only leads to Settings, where the same is shown fixed.
  const hint = info.tunnelHeld !== undefined || everywhere
    ? { text: info.tunnelHeld === undefined ? everywhereHint(defaultKind) : '', link: 'Open Tunnels settings', everywhere: false }
    : { text: '', link: ENFORCE_LINK, everywhere: true }
  const tunnel = info.tunnel
  if (tunnel === undefined) return { rows: [], notes: [], empty: NO_SWITCH_NOTE, hint }

  const held = info.tunnelHeld !== undefined
  const shown = view.pending === undefined ? tunnel.via : view.pending
  const fixed = held || tunnel.unreadable || tunnel.fixed !== undefined
  const rows = TUNNEL_KINDS.map((kind): TunnelRowModel => {
    const on = held ? kind.id === 'nym' : shown === kind.id
    const why = tunnel.blocked[kind.id]
    const blocked: { readonly line: TunnelLine, readonly link: string } | undefined = why === 'nym-off'
      ? { line: { text: NYM_OFF_LINE, down: true }, link: NYM_OFF_LINK }
      : why === 'no-proxy' ? { line: { text: PROXY_UNSET_LINE, down: true }, link: PROXY_UNSET_LINK } : undefined
    const using = on && kind.id === tunnel.via && view.pending === undefined
    return {
      kind,
      on,
      disabled: fixed || (!on && why !== undefined),
      state: using ? inUseLine(info, tunnel.subject) : blocked !== undefined && !on ? blocked.line : { text: '', down: false },
      settingsLink: blocked !== undefined && !on && !fixed ? blocked.link : null
    }
  })
  const hintText = tunnelHint(tunnel)
  const reach = tunnel.subject === 'site' ? extensionsHint(info.extensionsOnSite, tunnel.profile) : undefined
  const notes: TunnelLine[] = [
    ...(held ? [{ text: HELD_LINE, down: false }] : []),
    ...(tunnel.fixed === 'opened' && tunnel.via !== null ? [{ text: openedLine(tunnel.via), down: false }] : []),
    ...(hintText === undefined ? [] : [{ text: hintText, down: tunnel.unreadable }]),
    ...(reach === undefined ? [] : [{ text: reach, down: false }]),
    ...(tunnel.subject === 'app' && shown !== null && !held ? [{ text: APP_UPDATES_NOTE, down: false }] : [])
  ]
  return { rows, notes, empty: null, hint }
}
