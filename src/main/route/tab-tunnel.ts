// What a tab's own tunnel choice means for the websites it shows. Pure, apart from the two answers the shell supplies once.
//
// A tab can carry a choice (a tunnel or `direct`) that holds for every website opened in it until it closes, and is never
// written as a website's entry. It decides which profile each website runs in, ahead of the website's own entry:
// a tunnel choice wins over an `off` entry and over the other tunnel, and a `direct` choice wins only over a website with
// no tunnel of its own, so a tab is never less tunnelled than a promise made for a website (ADR-0101).

import { canTunnel } from './site-partition.js'
import type { Profile } from './site-partition.js'
import { isTunnelKind } from './route-state.js'
import type { TunnelKind } from './route-state.js'

/** What a tab was told to do with the websites it opens: go through a tunnel, or go through none. */
export type TabTunnelChoice = TunnelKind | 'direct'

/** Whether `value` is one of the three choices: for anything read back from a file. */
export function isTabTunnelChoice (value: unknown): value is TabTunnelChoice {
  return value === 'direct' || isTunnelKind(value)
}

/** The tunnel a choice sends through, or undefined for `direct` and for no choice. */
export function tunnelOfChoice (choice: TabTunnelChoice | undefined): TunnelKind | undefined {
  return choice === undefined || choice === 'direct' ? undefined : choice
}

/**
 * The profile the website at `origin` runs in, in a tab with `choice`, given the profile its own entry calls for
 * (`ownProfile`, undefined for no entry). Undefined means the session the website would follow with no entry at all: an
 * origin that cannot go through a tunnel (this computer, anything that is not a web origin) is never in a profile.
 */
export function profileForTab (choice: TabTunnelChoice | undefined, origin: string, ownProfile: Profile | undefined): Profile | undefined {
  if (choice === undefined) return ownProfile
  if (!canTunnel(origin)) return undefined
  if (choice !== 'direct') return choice
  return ownProfile === 'nym' || ownProfile === 'socks5' ? ownProfile : 'direct'
}

/** What the shell knows of its tabs, for the parts of the routes that decide per request. */
export interface TabTunnelSource {
  /** The choice of the tab whose page is the web contents `webContentsId`; undefined for a tab with none and for a contents that is no tab. */
  readonly choiceOfContents: (webContentsId: number) => TabTunnelChoice | undefined
  /** The tunnel a tab with a tunnel choice goes through, when one shows, or is loading, a page at `origin`. */
  readonly kindShowing: (origin: string) => TunnelKind | undefined
}

let source: TabTunnelSource | undefined

/** Called once at start by the shell, which owns the tabs: `route/` never imports them. */
export function setTabTunnelSource (next: TabTunnelSource | undefined): void {
  source = next
}

/** The choice of the tab showing web contents `webContentsId`, or undefined. */
export function tabChoiceOfContents (webContentsId: number): TabTunnelChoice | undefined {
  return source?.choiceOfContents(webContentsId)
}

/** The tunnel a tab with a tunnel choice sends the website at `origin` through, while one shows or loads it. */
export function tabKindShowing (origin: string): TunnelKind | undefined {
  return source?.kindShowing(origin)
}
