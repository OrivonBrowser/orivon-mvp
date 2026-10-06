import { describe, expect, it } from 'vitest'
import { siteClassOfLevel } from '../site-class.js'

describe('siteClassOfLevel', () => {
  it('names Level 1 Web2, Levels 2 and 3 Web2.5 and Level 4 Web3', () => {
    expect([1, 2, 3, 4].map((level) => siteClassOfLevel(level as 1 | 2 | 3 | 4))).toEqual(['web2', 'web25', 'web25', 'web3'])
  })
})
