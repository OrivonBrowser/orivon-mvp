import { describe, expect, it } from 'vitest'
import { ResolutionError } from '../../../resolution/records.js'
import { bootstrapMissing, clockBehind, heliosError } from '../helios-errors.js'

describe('heliosError', () => {
  it("turns a revert into the shape viem reads revert data from, so OffchainLookup is seen", () => {
    const mapped = heliosError(new Error('execution reverted: 556f1830000000000000000000000000EEEE')) as { code?: number, data?: string }
    expect(mapped.code).toBe(3)
    expect(mapped.data).toBe('0x556f1830000000000000000000000000eeee')
  })

  it('reads the revert as Helios words it, with its own "Error: " prefix', () => {
    expect((heliosError(new Error('Error: execution reverted: 0xabcd')) as { data?: string }).data).toBe('0xabcd')
  })

  it('never reads revert data out of RPC error text quoted inside another message', () => {
    const quoted = new Error('rpc error on method: eth_call, message: execution reverted: abcd')
    expect(heliosError(quoted)).toBe(quoted)
  })

  it('turns a revert with no data into empty revert data', () => {
    expect((heliosError(new Error('execution reverted: ')) as { data?: string }).data).toBe('0x')
  })

  it('reads a failed proof as a lie, never as an outage', () => {
    const mapped = heliosError(new Error('evm error: "invalid storage proof for address: 0xeEeE, slot: 0x3608"'))
    expect(mapped).toBeInstanceOf(ResolutionError)
    expect((mapped as ResolutionError).failure).toBe('unverifiable')
  })

  it('reads falling behind the chain as not synced', () => {
    expect((heliosError(new Error('out of sync: 67 seconds behind')) as ResolutionError).failure).toBe('not-synced')
  })

  it('passes anything else through unchanged', () => {
    const original = new Error('error sending request')
    expect(heliosError(original)).toBe(original)
  })
})

describe('clockBehind', () => {
  it("recognises Helios's refusal of an update from a slot this computer's clock has not reached", () => {
    for (const text of ['sync failed: invalid timestamp', 'Error: sync failed: invalid timestamp', 'invalid timestamp']) expect(clockBehind(new Error(text))).toBe(true)
    expect(clockBehind('sync failed: invalid timestamp')).toBe(true)
  })

  it('never reads a clock problem out of text quoted inside another message', () => {
    expect(clockBehind(new Error('rpc error: invalid timestamp in params'))).toBe(false)
    expect(clockBehind(new Error('sync failed: insufficient participation'))).toBe(false)
  })
})

describe('bootstrapMissing', () => {
  it('recognises Helios failing on a 404 of the consensus server\'s bootstrap, in either of its spellings', () => {
    expect(bootstrapMissing(new Error('could not fetch bootstrap: rpc error on method: bootstrap, message: status: 404, message: NOT_FOUND: Sync committee branch for block root 0xab not found'))).toBe(true)
    expect(bootstrapMissing('could not fetch bootstrap: rpc error on method: bootstrap, message: status: 404, message: not found')).toBe(true)
  })

  it.each([
    ['a request that failed', 'could not fetch bootstrap: rpc error on method: bootstrap, message: error sending request'],
    ['a server error', 'could not fetch bootstrap: rpc error on method: bootstrap, message: status: 503, message: unavailable'],
    ['a 404 of another request', 'could not fetch finality update: rpc error on method: finality_update, message: status: 404, message: not found'],
    ['the clock', 'invalid timestamp'],
    ['nothing', '']
  ])('does not take %s for it', (_name, text) => {
    expect(bootstrapMissing(new Error(text))).toBe(false)
  })
})
