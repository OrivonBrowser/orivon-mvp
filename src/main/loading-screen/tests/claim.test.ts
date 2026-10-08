import { describe, expect, it } from 'vitest'
import { claimCover, isCoverClaimed } from '../claim.js'

describe('claimCover', () => {
  it('holds a tab\'s cover until every claim is released, and releasing twice frees nothing more', () => {
    const tab = {}
    expect(isCoverClaimed(tab)).toBe(false)
    const first = claimCover(tab)
    const second = claimCover(tab)
    first()
    first()
    expect(isCoverClaimed(tab)).toBe(true)
    second()
    expect(isCoverClaimed(tab)).toBe(false)
  })

  it('claims one tab at a time', () => {
    const a = {}
    const b = {}
    claimCover(a)
    expect(isCoverClaimed(b)).toBe(false)
  })
})
