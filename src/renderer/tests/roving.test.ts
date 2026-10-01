import { describe, expect, it } from 'vitest'
import { isRovingKey, rovingTarget } from '../chrome/roving.js'

const on = true
const off = false

describe('rovingTarget', () => {
  it('moves to the next and previous item', () => {
    expect(rovingTarget([on, on, on], 0, 'ArrowRight')).toBe(1)
    expect(rovingTarget([on, on, on], 2, 'ArrowLeft')).toBe(1)
  })

  it('jumps to the first and last items with Home and End', () => {
    expect(rovingTarget([on, on, on, on], 2, 'Home')).toBe(0)
    expect(rovingTarget([on, on, on, on], 1, 'End')).toBe(3)
  })

  it('skips an item that is disabled, in both directions and for Home and End', () => {
    expect(rovingTarget([on, off, on], 0, 'ArrowRight')).toBe(2)
    expect(rovingTarget([on, off, on], 2, 'ArrowLeft')).toBe(0)
    expect(rovingTarget([off, on, on, off], 2, 'Home')).toBe(1)
    expect(rovingTarget([off, on, on, off], 1, 'End')).toBe(2)
  })

  it('does not wrap: an arrow at an end stays put', () => {
    expect(rovingTarget([on, on], 1, 'ArrowRight')).toBe(1)
    expect(rovingTarget([on, on], 0, 'ArrowLeft')).toBe(0)
    expect(rovingTarget([on, on, off], 1, 'ArrowRight')).toBe(1)
  })

  it('wraps round when asked to', () => {
    expect(rovingTarget([on, on, off], 1, 'ArrowRight', true)).toBe(0)
    expect(rovingTarget([off, on, on], 1, 'ArrowLeft', true)).toBe(2)
  })

  it('enters from no item at the end the arrow points away from', () => {
    expect(rovingTarget([on, on, on], -1, 'ArrowRight')).toBe(0)
    expect(rovingTarget([on, on, on], -1, 'ArrowLeft')).toBe(2)
    expect(rovingTarget([off, on, on], -1, 'ArrowRight')).toBe(1)
  })

  it('stays where it is when nothing is enabled, or the row is empty', () => {
    expect(rovingTarget([off, off], 0, 'ArrowRight')).toBe(0)
    expect(rovingTarget([off, off], 1, 'Home')).toBe(1)
    expect(rovingTarget([off, off], 0, 'End')).toBe(0)
    expect(rovingTarget([], -1, 'ArrowRight')).toBe(-1)
  })

  it('stays when the item is the only one that can be reached', () => {
    expect(rovingTarget([off, on, off], 1, 'ArrowRight')).toBe(1)
    expect(rovingTarget([off, on, off], 1, 'ArrowLeft', true)).toBe(1)
  })
})

describe('isRovingKey', () => {
  it('knows the four keys and nothing else', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) expect(isRovingKey(key)).toBe(true)
    for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'Enter', ' ', 'a']) expect(isRovingKey(key)).toBe(false)
  })
})
