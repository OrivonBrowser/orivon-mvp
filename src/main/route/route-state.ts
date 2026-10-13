// The rule that says whether an origin goes through the tunnel. Pure.
//
// Every origin is `on` or `off`. The browser's default says which when the origin has no entry of its own; an entry
// (`on` or `off`) overrides it. Where a website lives follows its entry alone (`site-partition.ts`'s `profileOf`), never the default,
// so that turning the default over moves no website's storage.

/** What a person set for one origin. */
export type TunnelEntry = 'on' | 'off'

/** The state an origin has: its entry, else the browser's default. */
export function tunnelStateOf (entry: TunnelEntry | undefined, everywhere: boolean): TunnelEntry {
  return entry ?? (everywhere ? 'on' : 'off')
}

/**
 * The entry that makes a website `wanted`: none when the default already says so, else `wanted` itself. An entry the
 * default already says is not kept, so the website goes back to the default session, where its storage was.
 */
export function entryFor (wanted: TunnelEntry, everywhere: boolean): TunnelEntry | undefined {
  return wanted === tunnelStateOf(undefined, everywhere) ? undefined : wanted
}
