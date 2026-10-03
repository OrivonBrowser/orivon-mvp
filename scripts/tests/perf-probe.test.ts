import { describe, expect, it } from 'vitest'
import { cpuTicksFromStat, pssKbFromRollup } from '../perf-probe.mjs'

describe('cpuTicksFromStat', () => {
  it('adds user and system ticks', () => {
    const stat = '4242 (electron) S 1 4242 4242 0 -1 4194304 1000 0 0 0 150 25 0 0 20 0 30 0 100 0 0'
    expect(cpuTicksFromStat(stat)).toBe(175)
  })

  it('reads past a command name holding spaces and parentheses', () => {
    const stat = '77 (Web Content (x)) S 1 77 77 0 -1 4194304 1000 0 0 0 9 3 0 0 20 0 30 0 100 0 0'
    expect(cpuTicksFromStat(stat)).toBe(12)
  })
})

describe('pssKbFromRollup', () => {
  it('reads the Pss line', () => {
    expect(pssKbFromRollup('55d0-7ffe ---p 00000000 00:00 0 [rollup]\nRss: 90000 kB\nPss: 61234 kB\nPss_Anon: 40000 kB\n')).toBe(61234)
  })

  it('is 0 when there is no Pss line', () => {
    expect(pssKbFromRollup('')).toBe(0)
  })
})
