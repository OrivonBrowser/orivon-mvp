import { describe, expect, it } from 'vitest'
import { ResolutionError } from '../../resolution/records.js'
import { heliosError } from '../helios-errors.js'

describe('heliosError', () => {
  it("turns a revert into the shape viem reads revert data from, so OffchainLookup is seen", () => {
    const mapped = heliosError(new Error('execution reverted: 556f1830000000000000000000000000EEEE')) as { code?: number, data?: string }
    expect(mapped.code).toBe(3)
    expect(mapped.data).toBe('0x556f1830000000000000000000000000eeee')
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
