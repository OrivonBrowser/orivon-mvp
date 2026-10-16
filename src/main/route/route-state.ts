// The rule that says whether, and through which tunnel, an origin is sent. Pure.
//
// Every origin is `nym`, `socks5` (the person's own proxy) or `off`. The browser's default says which when the origin has
// no entry of its own: `off` while the whole browser is not on a tunnel, else the default tunnel. An entry overrides it.
// Where a website lives follows its entry alone (`site-partition.ts`'s `profileOf`), never the default, so that turning the
// default over moves no website's storage.

/** The tunnels an origin can be sent through. */
export type TunnelKind = 'nym' | 'socks5'

export const TUNNEL_KINDS: readonly TunnelKind[] = ['nym', 'socks5']

/** What a person set for one origin: a tunnel, or `off` for none. */
export type TunnelEntry = TunnelKind | 'off'

/** Whether `value` is one of the tunnels. */
export function isTunnelKind (value: unknown): value is TunnelKind {
  return value === 'nym' || value === 'socks5'
}

/** The state an origin has: its entry, else the browser's default (`defaultKind` while the whole browser is on a tunnel, else off). */
export function tunnelStateOf (entry: TunnelEntry | undefined, everywhere: boolean, defaultKind: TunnelKind): TunnelEntry {
  return entry ?? (everywhere ? defaultKind : 'off')
}

/**
 * The entry that makes a website `wanted`: none when the default already says so, else `wanted` itself. An entry the
 * default already says is not kept, so the website goes back to the default session, where its storage was.
 */
export function entryFor (wanted: TunnelEntry, everywhere: boolean, defaultKind: TunnelKind): TunnelEntry | undefined {
  return wanted === tunnelStateOf(undefined, everywhere, defaultKind) ? undefined : wanted
}
