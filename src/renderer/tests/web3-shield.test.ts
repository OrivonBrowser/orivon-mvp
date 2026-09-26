import { describe, expect, it } from 'vitest'
import { shieldLabel } from '../web3-shield.js'
import type { Web3Score } from '../../main/browsing/site-trust.js'

// Only the pure text this module produces is unit-tested here -- the DOM
// side (web3Shield/paintShield) has no test harness in this renderer
// directory (no DOM unit tests are planned; see vitest.config.ts), and is
// exercised by the e2e suite instead, the same split every other renderer
// module in this tree already follows.

function score (overrides: Partial<Web3Score> = {}): Web3Score {
  return { level: 1, overridden: false, delivery: 1, deliveryOverridden: false, ...overrides }
}

describe('shieldLabel', () => {
  it('is the bare "Web3 Score" when there is nothing to show', () => {
    expect(shieldLabel(null)).toBe('Web3 Score')
  })

  it('names the level, and Web2/Web3 at the ends of the scale', () => {
    expect(shieldLabel(score({ level: 1 }))).toBe('Website level 1 (Web2)')
    expect(shieldLabel(score({ level: 2 }))).toBe('Website level 2')
    expect(shieldLabel(score({ level: 3 }))).toBe('Website level 3')
    expect(shieldLabel(score({ level: 4 }))).toBe('Website level 4 (Web3)')
  })

  it('names a developer override, so it is never read as observed', () => {
    expect(shieldLabel(score({ level: 4, overridden: true }))).toBe('Website level 4 (Web3) (developer override)')
  })
})
