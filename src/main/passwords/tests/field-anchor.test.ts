import { describe, expect, it } from 'vitest'
import { fieldAnchor } from '../field-anchor.js'

const view = { x: 0, y: 76, width: 1280, height: 720 }

describe('fieldAnchor', () => {
  it('places the box in the window: the view\'s corner plus the box', () => {
    expect(fieldAnchor(view, { rect: { x: 20, y: 45, width: 268, height: 21 }, viewWidth: 1280 })).toEqual({ x: 20, y: 121, width: 268, height: 21 })
  })

  it('scales by how wide the page said it was against how wide the view is', () => {
    expect(fieldAnchor(view, { rect: { x: 100, y: 50, width: 200, height: 20 }, viewWidth: 1024 })).toEqual({ x: 125, y: 76 + 62.5, width: 250, height: 25 })
  })

  it('follows a view that is not at the window\'s corner', () => {
    expect(fieldAnchor({ x: 300, y: 76, width: 640, height: 500 }, { rect: { x: 10, y: 10, width: 100, height: 20 }, viewWidth: 640 })).toEqual({ x: 310, y: 86, width: 100, height: 20 })
  })

  it('has no place for a box outside the view', () => {
    expect(fieldAnchor(view, { rect: { x: 20, y: -100, width: 268, height: 21 }, viewWidth: 1280 })).toBeUndefined()
    expect(fieldAnchor(view, { rect: { x: 20, y: 900, width: 268, height: 21 }, viewWidth: 1280 })).toBeUndefined()
    expect(fieldAnchor(view, { rect: { x: 2000, y: 10, width: 100, height: 21 }, viewWidth: 1280 })).toBeUndefined()
    expect(fieldAnchor(view, { rect: { x: -300, y: 10, width: 100, height: 21 }, viewWidth: 1280 })).toBeUndefined()
  })

  it('has no place when a size is not usable', () => {
    expect(fieldAnchor(view, { rect: { x: 1, y: 1, width: 0, height: 21 }, viewWidth: 1280 })).toBeUndefined()
    expect(fieldAnchor(view, { rect: { x: 1, y: 1, width: 10, height: 21 }, viewWidth: 0 })).toBeUndefined()
    expect(fieldAnchor({ ...view, width: 0 }, { rect: { x: 1, y: 1, width: 10, height: 21 }, viewWidth: 1280 })).toBeUndefined()
    expect(fieldAnchor(view, { rect: { x: Number.NaN, y: 1, width: 10, height: 21 }, viewWidth: 1280 })).toBeUndefined()
  })
})
