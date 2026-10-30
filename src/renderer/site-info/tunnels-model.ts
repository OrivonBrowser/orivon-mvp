import type { SiteInfo, SiteRoute, SiteTunnel, SiteTunnelKind } from '../../main/permissions/site-info.js'
import { nymTestingWords, nymTestWords } from '../pages/shared/nym-words.js'
import { proxyTestWords } from '../pages/shared/proxy-words.js'
import type { ProxyTestResult } from '../pages/shared/proxy-words.js'
import { routeLineWords } from './route-line.js'
import { ALWAYS_LABEL, ALWAYS_LINE_NOTHING, ALWAYS_LINE_OFF, ALWAYS_LINE_ON, tabNotes } from './tab-words.js'
import { extensionsHint, tunnelHint } from './tunnel-view.js'
import type { RouteSubject } from './route-line.js'
import type { NymState } from '../../main/route/nym-status.js'

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

/** The switch under the Browser-wide rows: whether the IPFS and Swarm nodes follow the tunnel too. */
export interface NodesModel {
  readonly label: string
  readonly line: string
  readonly on: boolean
  /** The switch cannot be moved: no tunnel is on browser-wide so it would do nothing, or the choice is fixed here. */
  readonly disabled: boolean
}

/** The "Always use for this site" switch under the rows of a tab showing a website. */
export interface AlwaysModel {
  readonly label: string
  /** What it does, in the state it is in. */
  readonly line: string
  /** The website has an entry of its own. */
  readonly on: boolean
  /** The switch cannot be moved: the choice is fixed here, a storage notice is open, or nothing is chosen so there is nothing to keep. */
  readonly disabled: boolean
}

/** The question before a tunnel is set browser-wide while tabs keep their own: nothing is set until it is answered. */
export interface PromptModel {
  readonly text: string
  readonly tabs: ReadonlyArray<{ readonly title: string, /** What the tab keeps: Nym, Your proxy or Direct. */ readonly kept: string }>
}

export interface TunnelListModel {
  readonly rows: readonly TunnelRowModel[]
  /** What else the person is told, in order: why the choice is fixed, what a profile does to extensions, what an app gives up. */
  readonly notes: readonly TunnelLine[]
  /** Said instead of rows when the page has no tunnel choice of its own. */
  readonly empty: string | null
  /** The line under the list, before the link to Settings: what the browser's tunnel does for what has no choice here. */
  readonly hint: { readonly text: string }
  /** The "Always" switch, on the first panel of a tab showing a website only. */
  readonly always: AlwaysModel | null
  /** The nodes switch, on the Browser-wide panel only. */
  readonly nodes: NodesModel | null
  /** The question of the Browser-wide panel, while it is open. */
  readonly prompt: PromptModel | null
}

export const NYM_OFF_LINE = 'Nym is switched off in Settings.'
export const NYM_OFF_LINK = 'Switch it on in Tunnels settings'
export const PROXY_UNSET_LINE = 'No proxy address is set.'
export const SETTINGS_LINK = 'Open Tunnels settings'
export const HELD_LINE = 'This private window always goes through Nym, so this choice cannot be changed.'
export const NO_SWITCH_NOTE = 'A page from this computer is never sent through a tunnel.'
export const APP_UPDATES_NOTE = 'Its updates are not checked while it goes through a tunnel.'

export function everywhereHint (defaultKind: TunnelKindId): string {
  return `Every site and app that has no choice here goes through ${kindOf(defaultKind).who}. Change this under Browser-wide.`
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

/** What the tunnel in use is doing for the page (or the whole browser), as one line. */
export function inUseLine (route: SiteRoute | undefined, nym: NymState | undefined, subject: RouteSubject): TunnelLine {
  const now = route ?? 'idle'
  return { text: routeLineWords(now, subject, nym), down: now === 'down' || now === 'no-proxy' || now === 'moving' || nym?.state === 'failed' || nym?.state === 'unavailable' }
}

/** What the rows of one panel are built from: the website's or tab's own tunnel for the first panel, the whole browser's for Browser-wide. */
export interface RowFacts {
  readonly via: TunnelKindId | null
  readonly blocked: SiteTunnel['blocked']
  readonly proxy: SiteTunnel['proxy']
  /** The window is held to a tunnel for its whole life: Nym is lit and nothing moves. */
  readonly held: boolean
  /** The choice is fixed here: held, the settings cannot be read, or the page's session decides it. */
  readonly fixed: boolean
  /** What the tunnel in use is doing, as the line under its name. */
  readonly inUse: TunnelLine
}

/**
 * One row for each tunnel. `view.pending` is the tunnel the person moved the switch to while a question is open (null: none),
 * undefined while none is; the rows show it as if it were done.
 */
export function tunnelRows (facts: RowFacts, view: TunnelView): readonly TunnelRowModel[] {
  const { held, fixed } = facts
  const shown = view.pending === undefined ? facts.via : view.pending
  return TUNNEL_KINDS.map((kind): TunnelRowModel => {
    const on = held ? kind.id === 'nym' : shown === kind.id
    const why = facts.blocked[kind.id]
    const blocked: { readonly line: TunnelLine, readonly link: string | null } | undefined = why === 'nym-off'
      ? { line: { text: NYM_OFF_LINE, down: true }, link: NYM_OFF_LINK }
      : why === 'no-proxy' ? { line: { text: PROXY_UNSET_LINE, down: true }, link: null } : undefined
    const using = on && kind.id === facts.via && view.pending === undefined
    // The proxy has no address: its switch asks for one instead of being held up.
    const pressOpensEditor = kind.id === 'socks5' && why === 'no-proxy' && !on && !fixed
    const editing = kind.id === 'socks5' && !fixed && (view.editor !== undefined && view.editor !== null || facts.proxy.address === '')
    const address: AddressModel | null = kind.id === 'socks5' && !fixed
      ? {
          saved: facts.proxy.address,
          editing,
          text: view.editor?.text ?? facts.proxy.address,
          error: view.editor?.error ?? null,
          confirm: view.editor?.confirm === true ? addressChangeWords(facts.proxy.users) : null
        }
      : null
    const canTest = !fixed && (kind.id === 'nym' ? why !== 'nym-off' : facts.proxy.address !== '')
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
      state: using ? facts.inUse : blocked !== undefined && !on && !pressOpensEditor ? blocked.line : { text: '', down: false },
      settingsLink: blocked?.link !== undefined && blocked.link !== null && !on && !fixed ? blocked.link : null
    }
  })
}

/** The first panel: the tunnel of this website, installed app or tab. */
export function tunnelListModel (info: SiteInfo, view: TunnelView): TunnelListModel {
  const everywhere = info.everywhere === true
  const defaultKind = info.tunnel?.defaultKind ?? info.tunnelKind ?? 'nym'
  // A window held to a tunnel says so on the row; what the browser's tunnel does for the rest is said under the list.
  const hint = { text: info.tunnelHeld === undefined && everywhere ? everywhereHint(defaultKind) : '' }
  const tunnel = info.tunnel
  if (tunnel === undefined) return { rows: [], notes: [], empty: NO_SWITCH_NOTE, hint, always: null, nodes: null, prompt: null }

  const held = info.tunnelHeld !== undefined
  const shown = view.pending === undefined ? tunnel.via : view.pending
  const fixed = held || tunnel.unreadable || tunnel.fixed !== undefined
  const rows = tunnelRows({ via: tunnel.via, blocked: tunnel.blocked, proxy: tunnel.proxy, held, fixed, inUse: inUseLine(info.route, info.nym, lineSubject(tunnel)) }, view)
  const hintText = tunnelHint(tunnel)
  const forTab = tunnel.subject === 'tab' ? tabNotes(tunnel, everywhere, fixed) : []
  const reach = tunnel.subject === 'site' || tunnel.always !== undefined ? extensionsHint(info.extensionsOnSite, tunnel.profile) : undefined
  const notes: TunnelLine[] = [
    ...(held ? [{ text: HELD_LINE, down: false }] : []),
    ...(tunnel.fixed === 'opened' && tunnel.via !== null ? [{ text: openedLine(tunnel.via), down: false }] : []),
    ...(hintText === undefined ? [] : [{ text: hintText, down: tunnel.unreadable }]),
    ...forTab.map((text) => ({ text, down: false })),
    ...(reach === undefined ? [] : [{ text: reach, down: false }]),
    ...(tunnel.subject === 'app' && shown !== null && !held ? [{ text: APP_UPDATES_NOTE, down: false }] : [])
  ]
  return { rows, notes, empty: null, hint, always: alwaysModel(tunnel, fixed, view.pending !== undefined), nodes: null, prompt: null }
}

/** A tab with no choice that shows a website with an entry of its own goes where the website was sent: the line is about the website, not the tab. */
function lineSubject (tunnel: SiteTunnel): RouteSubject {
  return tunnel.subject === 'tab' && tunnel.tabChoice === undefined && tunnel.always?.on === true && tunnel.via !== null ? 'site' : tunnel.subject
}

function alwaysModel (tunnel: SiteTunnel, fixed: boolean, asking: boolean): AlwaysModel | null {
  const always = tunnel.always
  if (always === undefined) return null
  // A switch held for a reason the notes already give (a held window, unreadable settings) still says what it would do.
  const line = always.on ? ALWAYS_LINE_ON : always.available || fixed ? ALWAYS_LINE_OFF : ALWAYS_LINE_NOTHING
  return { label: ALWAYS_LABEL, line, on: always.on, disabled: fixed || asking || (!always.on && !always.available) }
}
