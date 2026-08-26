// Transcribed from docs/architecture/handle-contracts.md SSLimits.
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
  /** TcpSocket + UdpSocket + accepted connections, combined, per origin. */
  concurrentSockets: 512,
  concurrentFileHandles: 64,
  inFlightOperations: 256,
  /**
   * Per-socket read credit window, in bytes. The broker sends at most this
   * many bytes ahead of what the renderer has acknowledged consuming, then
   * stops reading the underlying OS socket. See ./ipc.js.
   */
  readWindowBytes: 1024 * 1024
} as const

export type Limits = typeof LIMITS
