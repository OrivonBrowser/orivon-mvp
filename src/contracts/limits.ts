// Transcribed from docs/architecture/handle-contracts.md's "Limits" section.
//
// This is the one file in src/contracts/ that emits runtime code -- a frozen
// object literal. It still references no module, so the purity guard is
// satisfied. Values live here rather than in the broker so that the shim, the
// renderer and any future engine agree on them without a round trip.

/**
 * Per-origin resource limits (security-model.md T11/T11b). Defaults chosen
 * against spike gate 4's measured numbers -- 100 concurrent sockets exercised
 * cleanly -- with headroom.
 *
 * Exceeding any of these yields an OrivonError with code 'limit'.
 *
 * CALLS BEYOND THE IN-FLIGHT CAP REJECT IMMEDIATELY; THEY DO NOT QUEUE. An
 * unbounded queue on the broker's UI thread is precisely how one misbehaving
 * origin freezes every tab (T11b). A rejection the app must retry keeps the
 * broker responsive to every other origin.
 */
export const LIMITS = {
  /**
   * The PLATFORM CEILING on TcpSocket + UdpSocket + accepted connections,
   * combined, per origin. An app declares its own need below this
   * (`manifest.js`'s `NetCapability.concurrentSockets`); the broker enforces
   * whichever of the two is lower, so no declaration can raise this number.
   */
  concurrentSockets: 512,
  /**
   * What an origin gets when its manifest declares no
   * `net.concurrentSockets` (owner decision, 2026-09-06).
   *
   * Modest ON PURPOSE, and this is the whole mechanism: an ordinary app never
   * reaches 64 open sockets, so the default costs it nothing, while anything
   * that genuinely needs the ceiling must declare a number -- which is then a
   * number the person granting the capability actually saw. A silent 512 for
   * every app would put the largest resource commitment in the system behind
   * no statement by anyone.
   */
  defaultConcurrentSockets: 64,
  /** Open FileHandles per origin. */
  concurrentFileHandles: 64,
  /** Operations awaiting a broker response, per origin. See this object's own doc on what happens beyond it. */
  inFlightOperations: 256,
  /**
   * Per-socket read credit window, in bytes. The broker sends at most this
   * many bytes ahead of what the renderer has acknowledged consuming, then
   * stops reading the underlying OS socket. See ./ipc.js.
   */
  readWindowBytes: 1024 * 1024,
  /**
   * Per-socket WRITE credit window, in bytes -- the write direction's
   * mirror of readWindowBytes, needed because MessagePortMain has no
   * flow-control API of its own (open-questions.md A37): the broker
   * refuses ('limit') rather than buffers once a socket has this many
   * bytes outstanding -- sent by the renderer, not yet accepted into the
   * OS socket's send buffer. See ./ipc.js's WriteMessage/WriteAckMessage.
   *
   * Deliberately a quarter of readWindowBytes, not a symmetric 1 MiB. The
   * aggregate an origin can pin is (its socket allowance) * (readWindowBytes
   * + writeWindowBytes), so this number is a multiplier on every socket the
   * origin holds: at the default allowance of 64 that is ~80 MiB, and at the
   * 512 ceiling ~640 MiB. A symmetric window would raise both figures for no
   * stated need.
   *
   * This is also the hard ceiling on a SINGLE WriteMessage.chunk (owner
   * decision d-0021, see ./ipc.js's WriteMessage): a caller with a larger
   * buffer splits it into pieces this size or smaller before posting, and
   * an oversized chunk is a protocol error the broker may reject outright
   * rather than split, truncate, or buffer itself.
   */
  writeWindowBytes: 256 * 1024
} as const

export type Limits = typeof LIMITS
