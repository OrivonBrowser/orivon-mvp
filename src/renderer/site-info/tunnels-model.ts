import type { SiteInfo, SiteTunnel, SiteTunnelKind } from '../../main/permissions/site-info.js'
import { nymTestingWords, nymTestWords } from '../pages/shared/nym-words.js'
import { proxyTestWords } from '../pages/shared/proxy-words.js'
import type { ProxyTestResult } from '../pages/shared/proxy-words.js'
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

/** The address of the person's proxy as the proxy row shows and edits it. */
export interface AddressModel {
  /** The address saved, '' when none. */
  readonly saved: string
  /** The field is shown: no address is saved, or the person pressed Change or the proxy's switch. */
  readonly editing: boolean
  readonly text: string
  /** Why the last Save did not take. */
  readonly error: string | null
  /** The question asked before an address that sites or apps use is changed; null while none is open. */
  readonly confirm: string | null
}

/** What the page remembers between drawings about the proxy's address and the Test of a tunnel. */
export interface TunnelView {
  /** The tunnel the switches were moved to while the storage notice is open (null: none), undefined while it is not. */
  readonly pending: TunnelKindId | null | undefined
  /** The address being typed, or undefined while the field is not open by the person's own doing. */
  readonly editor?: { readonly text: string, readonly error: string | null, readonly confirm: boolean } | null
  /** The last Test the person pressed, under way or answered. */
  readonly test?: { readonly kind: TunnelKindId, readonly busy: boolean, readonly result: ProxyTestResult | null } | null
}

export interface TunnelRowModel {
  readonly kind: TunnelKind
  /** The switch is on. */
  readonly on: boolean
  /** The switch cannot be moved: the choice is fixed here, or the tunnel cannot take the page now. */
  readonly disabled: boolean
  /** Pressing the switch opens the address field instead of choosing the tunnel: the proxy has no address yet. */
  readonly pressOpensEditor: boolean
  /** The proxy row's address, saved or being typed. Null on any other row, and where the choice is fixed. */
  readonly address: AddressModel | null
  /** Whether the Test button is offered: the tunnel is not fixed away, and the proxy has an address saved. */
  readonly canTest: boolean
  /** What the Test says: that it is under way, or what it found. Null before one is pressed. */
  readonly testLine: (TunnelLine & { readonly busy: boolean }) | null
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

export const ADDRESS_PROBLEM = 'Enter an address as host:port, like 127.0.0.1:9050'
export const ADDRESS_NOT_SAVED = 'The address could not be saved.'

/** The sentence asked before the address of the proxy is changed while sites or apps go through it. Empty when nobody does. */
export function addressChangeWords (users: SiteTunnel['proxy']['users']): string {
  const parts = [
    ...(users.everything ? ['Everything you browse'] : []),
    ...(users.sites > 0 ? [`${String(users.sites)} ${users.sites === 1 ? 'site' : 'sites'}`] : []),
    ...(users.apps > 0 ? [`${String(users.apps)} ${users.apps === 1 ? 'app' : 'apps'}`] : [])
  ]
  if (parts.length === 0) return ''
  const plural = parts.length > 1 || users.sites + users.apps > 1 || users.everything
  const who = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}` : parts[0] ?? ''
  return `${who} ${plural ? 'go' : 'goes'} through your proxy now. ${plural ? 'They' : 'It'} will use the new address, and what ${plural ? 'they have' : 'it has'} open is closed.`
}

/** What the tunnel in use is doing for the page, as one line. */
function inUseLine (info: SiteInfo, subject: 'app' | 'site'): TunnelLine {
  const route = info.route ?? 'idle'
  return { text: routeLineWords(route, subject, info.nym), down: route === 'down' || route === 'no-proxy' || route === 'moving' || info.nym?.state === 'failed' || info.nym?.state === 'unavailable' }
}

/**
 * `view.pending` is the tunnel the person moved the switch to while the notice before a first move into a profile is open (null:
 * none), undefined while no notice is open; the rows show it as if it were done.
 */
export function tunnelListModel (info: SiteInfo, view: TunnelView): TunnelListModel {
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
    const blocked: { readonly line: TunnelLine, readonly link: string | null } | undefined = why === 'nym-off'
      ? { line: { text: NYM_OFF_LINE, down: true }, link: NYM_OFF_LINK }
      : why === 'no-proxy' ? { line: { text: PROXY_UNSET_LINE, down: true }, link: null } : undefined
    const using = on && kind.id === tunnel.via && view.pending === undefined
    // The proxy has no address: its switch asks for one instead of being held up.
    const pressOpensEditor = kind.id === 'socks5' && why === 'no-proxy' && !on && !fixed
    const editing = kind.id === 'socks5' && !fixed && (view.editor !== undefined && view.editor !== null || tunnel.proxy.address === '')
    const address: AddressModel | null = kind.id === 'socks5' && !fixed
      ? {
          saved: tunnel.proxy.address,
          editing,
          text: view.editor?.text ?? tunnel.proxy.address,
          error: view.editor?.error ?? null,
          confirm: view.editor?.confirm === true ? addressChangeWords(tunnel.proxy.users) : null
        }
      : null
    const canTest = !fixed && (kind.id === 'nym' ? why !== 'nym-off' : tunnel.proxy.address !== '')
    const test = view.test !== undefined && view.test !== null && view.test.kind === kind.id ? view.test : null
    const testLine = test === null || !canTest ? null
      : test.busy ? { text: kind.id === 'nym' ? nymTestingWords() : 'Testing…', down: false, busy: true }
        : test.result === null ? null
          : { text: test.result.nym === true ? nymTestWords(test.result) : proxyTestWords(test.result), down: !test.result.ok, busy: false }
    return {
      kind,
      on,
      disabled: fixed || (!on && why !== undefined && !pressOpensEditor),
      pressOpensEditor,
      address,
      canTest,
      testLine,
      state: using ? inUseLine(info, tunnel.subject) : blocked !== undefined && !on && !pressOpensEditor ? blocked.line : { text: '', down: false },
      settingsLink: blocked?.link !== undefined && blocked.link !== null && !on && !fixed ? blocked.link : null
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
