import { describe, expect, it } from 'vitest'
import { WRITE_HEARTBEAT_MS, WRITE_SILENCE_TIMEOUT_MS } from './ipc.js'

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
