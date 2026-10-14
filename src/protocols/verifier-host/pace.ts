// How long the host waits at each step, by whether its requests go through a tunnel. A mixnet opens a stream in a few
// seconds and needs several round trips of about a second each before a first byte, so the steps that wait on the network
// (the light client's first sync and a name's proof) are given longer when the tunnel carries them; with no tunnel the
// direct values apply.

export interface Pace {
  /** How long a `.eth` load waits for the light client's first sync before it says "cannot verify yet". */
  readonly syncWaitMs: number
  /** How long a name is proved before the load fails. */
  readonly mountTimeoutMs: number
  /** How long after the host starts the shared light client starts syncing if no `.eth` name has asked for it by then; see below. */
  readonly lightClientStartAfterMs: number
}

export const DIRECT_PACE: Pace = { syncWaitMs: 8_000, mountTimeoutMs: 25_000, lightClientStartAfterMs: 0 }

/**
 * The light client's first sync fetches about two megabytes from the beacon API, which a mixnet carries at some 15 to 20
 * kilobytes a second: two minutes in which every other request through the same tunnel crawls, an `ipfs://` page included.
 * Through a tunnel the client starts when a `.eth` name first needs it, or three minutes after the host starts (so the stored
 * checkpoint is still renewed while a `.eth` name is never visited), whichever comes first.
 *
 * The sync through Nym measured 25 to 45 s from a cold tunnel, and a name's proof about as long again once synced. */
export const TUNNEL_PACE: Pace = {
  syncWaitMs: 60_000,
  mountTimeoutMs: 100_000,
  lightClientStartAfterMs: 3 * 60_000
}

/** What the light client takes of a pace. */
export function lightClientPace (pace: Pace): { readonly syncWaitMs: number, readonly startAfterMs: number } {
  return { syncWaitMs: pace.syncWaitMs, startAfterMs: pace.lightClientStartAfterMs }
}

export function paceOf (tunnelled: boolean): Pace {
  return tunnelled ? TUNNEL_PACE : DIRECT_PACE
}
