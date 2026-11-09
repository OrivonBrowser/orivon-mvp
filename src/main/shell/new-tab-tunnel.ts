// The tunnel choice a blank tab takes from the tab it is opened from (ADR-0101). Pure but for the type of the tab collection it reads: the tab's facts arrive as values.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { TunnelEntry } from '../route/route-state.js'
import { choiceForBlankTab } from '../route/site-always.js'
import { canTunnel, isProfilePartition } from '../route/site-partition.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import type { TabManager } from './tabs.js'
import { addressOfTab, openingAddressOf } from './tunnel-popover-tab.js'

/** What the choice reads of the tab a blank tab is opened from. */
export interface NewTabSource {
  /** The tab's own choice. */
  readonly choice: TabTunnelChoice | undefined
  /** The address the tab shows, or is opening when its page has not come; undefined when it has none. */
  readonly address: string | undefined
  /** The session the tab's page runs in. */
  readonly partition: string | undefined
  /** Whether `origin` is an installed app, which keeps its own route whatever a tab carries. */
  readonly isApp: (origin: string) => boolean
  /** The website's own entry; undefined for none, and always while the tunnel settings cannot be read, when no entry is what a page follows. */
  readonly entryOf: (origin: string) => TunnelEntry | undefined
}

/**
 * The entry of the website the tab follows: the one at its address, when the tunnel button is about that website. Not an installed
 * app, nor a page that cannot go through a tunnel, nor a page in a session an app or a temporary route made for it: those leave by
 * the route of that session, not by an entry the tab follows.
 */
function entryFollowed (source: NewTabSource): TunnelEntry | undefined {
  const origin = source.address === undefined ? null : originFromUrl(source.address)
  if (origin === null || !canTunnel(origin) || source.isApp(origin)) return undefined
  if (source.partition !== undefined && !isProfilePartition(source.partition)) return undefined
  return source.entryOf(origin)
}

/** The choice a blank tab opened from the tab described by `source` takes: its own, else the tunnel of the website's entry it follows (`choiceForBlankTab`). */
export function choiceForNewTabFrom (source: NewTabSource): TabTunnelChoice | undefined {
  return choiceForBlankTab({ choice: source.choice, entry: source.choice === undefined ? entryFollowed(source) : undefined })
}

/** What `newTabChoice` reads of the tunnel routes. */
interface RoutesRead {
  readonly hub: { readonly unreadable: () => boolean }
  readonly store: { readonly stateOf: (origin: string) => TunnelEntry | undefined }
}

/**
 * The choice a blank tab opened from the tab `id` of `tabs` takes (`choiceForNewTabFrom`), read from the tab's record, the address it
 * shows or is opening and the session it runs in. None for no tab. While the tunnel settings cannot be read no entry is read, since every
 * website then takes the one tunnel they all take; the tab's own choice still counts.
 */
export function newTabChoice (tabs: Pick<TabManager, 'record' | 'getState' | 'liveWebContents'>, id: string | null, routes: RoutesRead | undefined, isApp: ((origin: string) => boolean) | undefined): TabTunnelChoice | undefined {
  const record = id === null ? undefined : tabs.record(id)
  if (id === null || record === undefined) return undefined
  return choiceForNewTabFrom({
    choice: record.tunnelChoice,
    address: addressOfTab(tabs.getState(), id, openingAddressOf(tabs)),
    partition: record.partition,
    isApp: isApp ?? (() => false),
    entryOf: (origin) => routes === undefined || routes.hub.unreadable() ? undefined : routes.store.stateOf(origin)
  })
}
