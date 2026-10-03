import { describe, expect, it } from 'vitest'
import { isMemoryLow } from '../memory-pressure.js'

const GB = 1024 * 1024
const KB_PER_MB = 1024

describe('isMemoryLow', () => {
  it('is low below one gigabyte available, whatever the total', () => {
    expect(isMemoryLow({ total: 4 * GB, free: 100, available: 1 * GB - 1 })).toBe(true)
    expect(isMemoryLow({ total: 4 * GB, free: 100, available: 1 * GB })).toBe(false)
  })

  it('is low below a tenth of the total once the total is large', () => {
    expect(isMemoryLow({ total: 32 * GB, free: 0, available: 3 * GB })).toBe(true)
    expect(isMemoryLow({ total: 32 * GB, free: 0, available: 3.3 * GB })).toBe(false)
  })

  it('reads the available figure where there is one, and free where there is not', () => {
    expect(isMemoryLow({ total: 16 * GB, free: 10 * KB_PER_MB, available: 8 * GB })).toBe(false)
    expect(isMemoryLow({ total: 16 * GB, free: 10 * KB_PER_MB })).toBe(true)
    expect(isMemoryLow({ total: 16 * GB, free: 8 * GB })).toBe(false)
  })

  it('is not low when the system gives no usable reading', () => {
    expect(isMemoryLow({ total: 0, free: 0 })).toBe(false)
    expect(isMemoryLow({ total: Number.NaN, free: Number.NaN })).toBe(false)
  })
})
