// The "Always use for this site" switch of the tunnel popup opened for a tab on a website (ADR-0104). Pure.
//
// The panel shows what the page does now: the tab's choice over the website's own entry (ADR-0101), else the entry, else what the
// browser does. The switch saves that as the website's own entry, which outlives the tab, and takes the entry away again. It never
// changes where the page leaves by; the plans below say what the tab and the entry become, and the controller carries them out.

import { entryFor } from './route-state.js'
import type { TunnelEntry, TunnelKind } from './route-state.js'
import { choiceForSwitch } from './tab-tunnel.js'
import type { TabTunnelChoice } from './tab-tunnel.js'

/** What the switch needs of the page: the tab's choice, the website's own entry, and whether the whole browser is on a tunnel. */
export interface AlwaysFacts {
  readonly choice: TabTunnelChoice | undefined
  readonly entry: TunnelEntry | undefined
  readonly everywhere: boolean
}

/** What to do with the tab and the website's entry, in this order: the tab first, because moving it is what can fail, then the entry. */
export interface RoutePlan {
  /** The choice the tab takes: undefined leaves it, null takes it away. */
  readonly tab?: TabTunnelChoice | null
  /** `choose` is the tunnel (null: no tunnel) to send the website through, which makes the entry the browser's rule for it requires; `forget` takes the entry away so the website follows the default. */
  readonly entry?: { readonly choose: TunnelKind | null } | 'forget'
}

/** The entry that saving the tab's choice makes, or undefined when it would add nothing: no choice, or a direct tab while the browser is on no tunnel, which a website already does. */
export function entryToSave (choice: TabTunnelChoice | undefined, everywhere: boolean): TunnelEntry | undefined {
  if (choice === undefined) return undefined
  return entryFor(choice === 'direct' ? 'off' : choice, everywhere)
}

/** The switch: on while the website has an entry of its own (an `off` entry too), available while it is on or the tab has a choice to save. */
export function alwaysState (facts: AlwaysFacts): { readonly on: boolean, readonly available: boolean } {
  const on = facts.entry !== undefined
  return { on, available: on || entryToSave(facts.choice, facts.everywhere) !== undefined }
}

function chooseOf (entry: TunnelEntry): { readonly choose: TunnelKind | null } {
  return { choose: entry === 'off' ? null : entry }
}

/** Turning the switch on: the tab's choice becomes the entry, and the tab is left as it is. Undefined when there is nothing to do. */
export function planAlwaysOn (facts: AlwaysFacts): RoutePlan | undefined {
  if (facts.entry !== undefined) return undefined
  const entry = entryToSave(facts.choice, facts.everywhere)
  return entry === undefined ? undefined : { entry: chooseOf(entry) }
}

/**
 * Turning the switch off: the entry goes, and the tab takes the tunnel the page goes through first, so nothing moves. A tab with no
 * choice takes the entry's (an `off` entry is direct); a direct tab takes the entry's tunnel, since a direct tab never loosens a
 * website's tunnel (ADR-0101); a tab with a tunnel keeps it, which won over the entry. Undefined when the website has no entry.
 */
export function planAlwaysOff (facts: AlwaysFacts): RoutePlan | undefined {
  const { choice, entry } = facts
  if (entry === undefined) return undefined
  const kept: TabTunnelChoice = choice !== undefined && choice !== 'direct' ? choice : entry === 'off' ? 'direct' : entry
  return kept === choice ? { entry: 'forget' } : { tab: kept, entry: 'forget' }
}

/** A row moved to `kind` (null: the lit row turned off): the tab takes it, and the entry too while the website has one, so the row really moves. */
export function planMove (facts: AlwaysFacts, kind: TunnelKind | null): RoutePlan {
  const tab = choiceForSwitch(kind, facts.everywhere)
  return facts.entry === undefined ? { tab } : { tab, entry: { choose: kind } }
}
