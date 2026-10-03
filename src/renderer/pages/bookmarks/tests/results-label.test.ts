import { describe, expect, it } from 'vitest'
import { resultsLabel } from '../view-list.js'

describe('resultsLabel', () => {
  it('says "+" only when main found more results than it sent, whatever the count', () => {
    expect(resultsLabel(200, false)).toBe('200 results')
    expect(resultsLabel(200, true)).toBe('200+ results')
    expect(resultsLabel(1, false)).toBe('1 result')
    expect(resultsLabel(0, false)).toBe('0 results')
  })
})
