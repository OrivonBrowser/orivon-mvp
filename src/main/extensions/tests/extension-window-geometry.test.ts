import { describe, expect, it } from 'vitest'
import { extensionWindowType, placeExtensionWindow, updatedBounds } from '../extension-window-geometry.js'

const MIN = { width: 500, height: 400 }
const DEFAULT = { width: 1280, height: 800 }
const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 }
const RIGHT = { x: 1920, y: 0, width: 1280, height: 1024 }

describe('extensionWindowType', () => {
  it('is popup for a window created as one, and for the deprecated panel', () => {
    expect(extensionWindowType({ type: 'popup' })).toBe('popup')
    expect(extensionWindowType({ type: 'panel' })).toBe('popup')
    for (const type of [undefined, 'normal', 'app', 'devtools', 7]) expect(extensionWindowType({ type })).toBe('normal')
  })
})

describe('placeExtensionWindow on a create', () => {
  it('names nothing when the extension asked for nothing', () => {
    expect(placeExtensionWindow({}, [SCREEN], MIN, DEFAULT)).toEqual({})
  })

  it('keeps what fits, and never goes under the shell window\'s smallest size', () => {
    expect(placeExtensionWindow({ width: 400, height: 620, left: 100, top: 50 }, [SCREEN], MIN, DEFAULT)).toEqual({ x: 100, y: 50, width: 500, height: 620 })
    expect(placeExtensionWindow({ width: 10, height: 10, left: 0, top: 0 }, [SCREEN], MIN, DEFAULT)).toEqual({ x: 0, y: 0, width: 500, height: 400 })
  })

  it('centres a window that was given a size and no place, as the shell does', () => {
    expect(placeExtensionWindow({ width: 800, height: 600 }, [SCREEN], MIN, DEFAULT)).toEqual({ x: 560, y: 220, width: 800, height: 600 })
  })

  it('takes the shell\'s own size for the side it was not given', () => {
    expect(placeExtensionWindow({ left: 100, top: 50 }, [SCREEN], MIN, DEFAULT)).toEqual({ x: 100, y: 50, ...DEFAULT })
  })

  it('moves a corner back using the size the window will get, not the smallest', () => {
    expect(placeExtensionWindow({ left: 1800, top: 900 }, [SCREEN], MIN, DEFAULT)).toEqual({ x: 640, y: 240, ...DEFAULT })
  })

  it('shrinks to the display and moves back inside it', () => {
    expect(placeExtensionWindow({ width: 5000, height: 5000, left: -300, top: -300 }, [SCREEN], MIN, DEFAULT)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
    expect(placeExtensionWindow({ width: 600, height: 700, left: 1800, top: 900 }, [SCREEN], MIN, DEFAULT)).toEqual({ x: 1320, y: 340, width: 600, height: 700 })
  })

  it('puts the window on the display it overlaps most', () => {
    expect(placeExtensionWindow({ width: 600, height: 700, left: 1500, top: 10 }, [SCREEN, RIGHT], MIN, DEFAULT)).toEqual({ x: 1320, y: 10, width: 600, height: 700 })
    expect(placeExtensionWindow({ width: 600, height: 700, left: 1700, top: 10 }, [SCREEN, RIGHT], MIN, DEFAULT)).toEqual({ x: 1920, y: 10, width: 600, height: 700 })
    expect(placeExtensionWindow({ width: 600, height: 700, left: 2200, top: 10 }, [SCREEN, RIGHT], MIN, DEFAULT)).toEqual({ x: 2200, y: 10, width: 600, height: 700 })
  })

  it('sends a corner exactly at the next display\'s origin to that display', () => {
    expect(placeExtensionWindow({ width: 600, height: 700, left: 1920, top: 0 }, [SCREEN, RIGHT], MIN, DEFAULT)).toEqual({ x: 1920, y: 0, width: 600, height: 700 })
  })

  it('uses the nearest display for a place no display shows', () => {
    expect(placeExtensionWindow({ width: 600, height: 700, left: 9000, top: 10 }, [SCREEN, RIGHT], MIN, DEFAULT)).toEqual({ x: 2600, y: 10, width: 600, height: 700 })
  })

  it('ignores a value that is not a finite number', () => {
    expect(placeExtensionWindow({ width: Number.NaN, left: '5' as never, top: Infinity }, [SCREEN], MIN, DEFAULT)).toEqual({})
  })

  it('only holds the minimum when no display is known', () => {
    expect(placeExtensionWindow({ width: 100, left: -50 }, [], MIN, DEFAULT)).toEqual({ x: -50, width: 500 })
  })
})

describe('updatedBounds', () => {
  const current = { x: 200, y: 100, width: 700, height: 800 }

  it('is undefined when the request names none of left, top, width and height', () => {
    expect(updatedBounds({}, [SCREEN], MIN, current)).toBeUndefined()
    expect(updatedBounds({ focused: true, drawAttention: true } as never, [SCREEN], MIN, current)).toBeUndefined()
    expect(updatedBounds({ left: Number.NaN }, [SCREEN], MIN, current)).toBeUndefined()
  })

  it('moves one edge and keeps the rest', () => {
    expect(updatedBounds({ left: 10 }, [SCREEN], MIN, current)).toEqual({ x: 10, y: 100, width: 700, height: 800 })
    expect(updatedBounds({ height: 450 }, [SCREEN], MIN, current)).toEqual({ x: 200, y: 100, width: 700, height: 450 })
  })

  it('keeps a window inside the display it is mostly on', () => {
    expect(updatedBounds({ left: 1900 }, [SCREEN], MIN, current)).toEqual({ x: 1220, y: 100, width: 700, height: 800 })
  })

  it('does not move a window across two displays except as asked', () => {
    const across = { x: 1500, y: 100, width: 900, height: 800 }
    expect(updatedBounds({ top: 120 }, [SCREEN, RIGHT], MIN, across)).toEqual({ x: 1500, y: 120, width: 900, height: 800 })
  })
})
