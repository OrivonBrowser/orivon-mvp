import { describe, expect, it } from 'vitest'
import { areaAfterKey, fullPageOffered } from '../choice.js'

describe('areaAfterKey', () => {
  it('moves between the two segments with the arrows, both ways round', () => {
    expect(areaAfterKey('visible', 'ArrowRight', true)).toBe('full')
    expect(areaAfterKey('full', 'ArrowRight', true)).toBe('visible')
    expect(areaAfterKey('full', 'ArrowLeft', true)).toBe('visible')
    expect(areaAfterKey('visible', 'ArrowUp', true)).toBe('full')
  })

  it('never lands on the full page while it is not offered', () => {
    expect(areaAfterKey('visible', 'ArrowRight', false)).toBe('visible')
    expect(areaAfterKey('visible', 'ArrowLeft', false)).toBe('visible')
  })

  it('leaves other keys alone', () => {
    expect(areaAfterKey('visible', 'Enter', true)).toBe('visible')
    expect(areaAfterKey('full', 'a', true)).toBe('full')
  })
})

describe('fullPageOffered', () => {
  it('reads only a true answer', () => {
    expect(fullPageOffered({ fullPage: true })).toBe(true)
    expect(fullPageOffered({ fullPage: false })).toBe(false)
    expect(fullPageOffered({ fullPage: 'yes' })).toBe(false)
    expect(fullPageOffered(null)).toBe(false)
    expect(fullPageOffered(undefined)).toBe(false)
  })
})
