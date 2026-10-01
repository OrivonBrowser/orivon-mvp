import { describe, expect, it } from 'vitest'
import { decidePopup, POPUP_INPUT_WINDOW_MS } from '../popup-policy.js'

const NOW = 100_000
const facts = { value: 'block' as const, lastInteractionAt: null, now: NOW, consumed: false }

describe('decidePopup', () => {
  it('lets every pop-up through for a site, or a default, that allows them', () => {
    expect(decidePopup({ ...facts, value: 'allow' })).toBe('allow')
    expect(decidePopup({ ...facts, value: 'allow', consumed: true, lastInteractionAt: null })).toBe('allow')
  })

  it('blocks a page that has had no input from the person', () => {
    expect(decidePopup(facts)).toBe('block')
  })

  it('lets through an open right after the person clicked or pressed a key', () => {
    expect(decidePopup({ ...facts, lastInteractionAt: NOW - 20 })).toBe('allow')
    expect(decidePopup({ ...facts, lastInteractionAt: NOW })).toBe('allow')
  })

  it('lets through an open up to the edge of the window and blocks one past it', () => {
    expect(decidePopup({ ...facts, lastInteractionAt: NOW - POPUP_INPUT_WINDOW_MS })).toBe('allow')
    expect(decidePopup({ ...facts, lastInteractionAt: NOW - POPUP_INPUT_WINDOW_MS - 1 })).toBe('block')
  })

  it('allows one open per input: the next needs a new click', () => {
    expect(decidePopup({ ...facts, lastInteractionAt: NOW - 20, consumed: true })).toBe('block')
  })

  it('blocks an input stamped in the future instead of trusting a clock that went backwards', () => {
    expect(decidePopup({ ...facts, lastInteractionAt: NOW + 5 })).toBe('block')
  })
})
