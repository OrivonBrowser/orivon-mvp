// The rule that says whether an origin goes through the tunnel and whether it keeps storage of its own. Pure.
//
// Every origin is `on` or `off`. The browser's default says which when the origin has no entry of its own; an entry
// (`on` or `off`) overrides it. A website whose state differs from the default runs in a session of its own.

/** What a person set for one origin. */
export type TunnelEntry = 'on' | 'off'

/** The state an origin has: its entry, else the browser's default. */
export function tunnelStateOf (entry: TunnelEntry | undefined, everywhere: boolean): TunnelEntry {
  return entry ?? (everywhere ? 'on' : 'off')
}

/** Whether an origin's state differs from the default, which is when a website needs storage of its own. */
export function differsFromDefault (entry: TunnelEntry | undefined, everywhere: boolean): boolean {
  return entry !== undefined && tunnelStateOf(entry, everywhere) !== tunnelStateOf(undefined, everywhere)
}
