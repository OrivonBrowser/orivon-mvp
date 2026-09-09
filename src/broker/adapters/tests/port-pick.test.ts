import { describe, expect, it } from 'vitest'
import { countPorts, portAt, randomStart } from '../port-pick.js'

// Pure arithmetic, pulled out of udp-adapter.ts when listen-tcp.ts (via
// node-adapters.ts's listenTcp) needed the exact same three functions. The
// randomness itself is not asserted here -- port-pick.ts documents WHY it
// must be unpredictable (A88); this file pins the arithmetic every caller
// depends on regardless of which offset comes back.

describe('countPorts', () => {
  it('counts a single range inclusively', () => {
    expect(countPorts([{ lo: 6881, hi: 6889 }])).toBe(9)
  })

  it('sums across multiple ranges', () => {
    expect(countPorts([{ lo: 6881, hi: 6889 }, { lo: 30000, hi: 30010 }])).toBe(9 + 11)
  })

  it('counts a single-port range as one', () => {
    expect(countPorts([{ lo: 443, hi: 443 }])).toBe(1)
  })
})

describe('portAt', () => {
  it('returns the first port at offset 0', () => {
    expect(portAt([{ lo: 6881, hi: 6889 }], 0)).toBe(6881)
  })

  it('returns the last port at the range\'s final offset', () => {
    expect(portAt([{ lo: 6881, hi: 6889 }], 8)).toBe(6889)
  })

  it('crosses into the second range once the first is exhausted', () => {
    const ranges = [{ lo: 6881, hi: 6889 }, { lo: 30000, hi: 30010 }]
    expect(portAt(ranges, 9)).toBe(30000)
    expect(portAt(ranges, 19)).toBe(30010)
  })

  it('throws rather than returning undefined past the end -- callers always modulo first', () => {
    expect(() => portAt([{ lo: 6881, hi: 6889 }], 9)).toThrow()
  })
})

describe('randomStart', () => {
  it('always lands inside [0, total)', () => {
    for (let i = 0; i < 50; i += 1) {
      const start = randomStart(9)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(start).toBeLessThan(9)
    }
  })

  it('returns 0 for a single-port total, the only value in range', () => {
    expect(randomStart(1)).toBe(0)
  })
})
