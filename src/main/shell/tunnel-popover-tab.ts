// Which tab the tunnel button's popover is about, when it is about a tab and not a website (ADR-0101). Pure.
import { originFromUrl } from '../../broker/policy/origin.js'
import { isProfilePartition } from '../route/site-partition.js'
import type { TabRecord, TabsSnapshot } from './tab-types.js'

/** The address a tab with no page yet is opening, by tab id: its `url` is '' until the first page commits, and main holds the address in flight. */
export type OpeningAddress = (id: string) => string | undefined

/** What `openingAddressOf` reads of a window's tabs. */
export interface OpeningTabs {
  readonly record: (id: string) => Pick<TabRecord, 'inflightTarget'> | undefined
  readonly liveWebContents: (id: string) => { readonly opener?: unknown } | undefined
}

/**
 * Where the first navigation of a tab leads now (`TabRecord.inflightTarget`, after its redirects), by tab id. Not for a tab whose page
 * has an opener: a popup shows its initial empty document until the website answers, and the page that opened it writes into that
 * document as freely as into its own, so what the tab was told it loads cannot speak for what it shows.
 */
export function openingAddressOf (tabs: OpeningTabs): OpeningAddress {
  return (id) => {
    const contents = tabs.liveWebContents(id)
    if (contents === undefined || (contents.opener ?? null) !== null) return undefined
    return tabs.record(id)?.inflightTarget
  }
}

/**
 * The address of the tab in front for a press the chrome sent no address with: its page's, which can have committed since the chrome
 * last drew, else the one it is opening. Undefined when it has neither, or no tab is in front.
 */
export function addressOfFrontTab (state: TabsSnapshot, opening: OpeningAddress): string | undefined {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId)
  if (active === undefined) return undefined
  return active.url === '' ? opening(active.id) : active.url
}

/**
 * The id of the tab in front when the tunnel button's popover is about the tab: a new tab, which shows no website to be about, and a
 * tab that carries a tunnel choice, whose every website the choice decides. A tab with no page yet is read as the page it is opening
 * (`opening`), so the popover is what it will be once the page has come. Not an installed app, nor a page in a session an app or a
 * temporary route made for it (a popup an app opened, a website opened through an app's tunnel): those keep the tunnel of that
 * session whatever the tab carries, so the popover is about the page. Not any page of a tab with no choice, nor a blank page that is
 * no new tab, nor a page of the shell's own, which has no button. Everything is read from the tab's record (`state`, `partitionOf`,
 * `opening`), never from what the chrome says it shows.
 */
export function tabForTunnelPopover (state: TabsSnapshot, partitionOf: (id: string) => string | undefined, isApp: (origin: string) => boolean, opening: OpeningAddress): string | undefined {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId)
  if (active === undefined || active.isInternal) return undefined
  if (active.isNewTab) return active.blankPage === true ? undefined : active.id
  if (active.tunnelChoice === undefined) return undefined
  const address = active.url === '' ? opening(active.id) : active.url
  const origin = address === undefined ? null : originFromUrl(address)
  if (origin !== null && isApp(origin)) return undefined
  const partition = partitionOf(active.id)
  return partition === undefined || isProfilePartition(partition) ? active.id : undefined
}
