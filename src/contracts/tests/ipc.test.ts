import { describe, expect, it } from 'vitest'
import { DATAGRAM_CREDIT_COALESCE, WRITE_HEARTBEAT_MS, WRITE_SILENCE_TIMEOUT_MS } from '../ipc.js'
import { LIMITS } from '../limits.js'

// The one runtime-checkable claim about the write-side timing constants
// (open-questions.md A37's resolution): a heartbeat distinguishes peer
// slowness from transport loss only if it can fire more than once before the
// silence timeout expires. A silence timeout at or below the heartbeat
// interval would fire on the very first legitimate stall, collapsing the
// heartbeat back into the flat deadline it exists to avoid.
describe('write-side timing constants', () => {
  it('gives the silence timeout enough room for at least two heartbeats', () => {
    expect(WRITE_SILENCE_TIMEOUT_MS).toBeGreaterThan(2 * WRITE_HEARTBEAT_MS)
  })
})

// The same treatment for the datagram window's constants. Each claim below is
// one whose violation is SILENT -- a socket that quietly drops everything, or
// a legal datagram that can never be delivered -- rather than a crash anyone
// would notice, which is the only reason these are worth a test at all.
describe('datagram window constants', () => {
  it('releases credit long before the window it is meant to refill runs out', () => {
    // At or above the window, the renderer's first credit message would not be
    // sent until the window was already exhausted: every subsequent datagram
    // discarded, no credit ever released, and no error anywhere.
    expect(DATAGRAM_CREDIT_COALESCE).toBeLessThan(LIMITS.inboundDatagramWindow)
  })

  it('leaves room for one datagram of the largest legal size', () => {
    // A byte window smaller than one maximum datagram makes that datagram
    // undeliverable in every case rather than in a rare one.
    expect(LIMITS.maxDatagramBytes).toBeLessThan(LIMITS.inboundDatagramWindowBytes)
  })

  it('bounds the outbound backlog more tightly than the inbound one', () => {
    // Inbound arrival is paced by the network, where a burst is normal.
    // Outbound is paced by the app, where a deep backlog already means it is
    // outrunning the OS. A larger outbound window would just delay the point
    // at which that becomes visible.
    expect(LIMITS.outboundDatagramWindow).toBeLessThan(LIMITS.inboundDatagramWindow)
  })

  it('pins no more memory per UDP socket than per TCP socket', () => {
    // The per-origin ceiling in LIMITS.defaultConcurrentSockets is computed
    // against the TCP windows. A UDP socket that could pin more would make that
    // arithmetic wrong for any app that opens one.
    expect(LIMITS.inboundDatagramWindowBytes).toBe(LIMITS.readWindowBytes)
  })
})
