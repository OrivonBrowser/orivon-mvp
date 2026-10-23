import { describe, expect, it } from 'vitest'
import { extensionWindowType, placeExtensionWindow } from '../extension-window-geometry.js'

const MIN = { width: 500, height: 400 }
const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 }
const RIGHT = { x: 1920, y: 0, width: 1280, height: 1024 }

describe('extensionWindowType', () => {
  it('is popup only for a window created as one', () => {
    expect(extensionWindowType({ type: 'popup' })).toBe('popup')
    for (const type of [undefined, 'normal', 'panel', 'app', 'devtools', 7]) expect(extensionWindowType({ type })).toBe('normal')
  })
})

describe('placeExtensionWindow on a create', () => {
  it('keeps what fits and names only what the extension gave', () => {
    expect(placeExtensionWindow({ width: 400, height: 620, left: 100, top: 50 }, [SCREEN], MIN)).toEqual({ x: 100, y: 50, width: 500, height: 620 })
    expect(placeExtensionWindow({}, [SCREEN], MIN)).toEqual({})
    expect(placeExtensionWindow({ width: 800 }, [SCREEN], MIN)).toEqual({ width: 800 })
  })

  it('never goes under the shell window\'s smallest size', () => {
    expect(placeExtensionWindow({ width: 10, height: 10 }, [SCREEN], MIN)).toEqual({ width: 500, height: 400 })
  })

  it('shrinks to the work area and moves back inside it', () => {
    expect(placeExtensionWindow({ width: 5000, height: 5000, left: -300, top: -300 }, [SCREEN], MIN)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
    expect(placeExtensionWindow({ width: 600, height: 700, left: 1800, top: 900 }, [SCREEN], MIN)).toEqual({ x: 1320, y: 340, width: 600, height: 700 })
  })

  it('uses the work area of the display the corner is on, else the nearest', () => {
    expect(placeExtensionWindow({ width: 600, height: 700, left: 3000, top: 10 }, [SCREEN, RIGHT], MIN)).toEqual({ x: 2600, y: 10, width: 600, height: 700 })
    expect(placeExtensionWindow({ width: 600, height: 700, left: 9000, top: 10 }, [SCREEN, RIGHT], MIN)).toEqual({ x: 2600, y: 10, width: 600, height: 700 })
  })

  it('ignores a value that is not a finite number', () => {
    expect(placeExtensionWindow({ width: Number.NaN, left: '5' as never, top: Infinity }, [SCREEN], MIN)).toEqual({})
  })

  it('only bounds the minimum when no display is known', () => {
    expect(placeExtensionWindow({ width: 100, left: -50 }, [], MIN)).toEqual({ x: -50, width: 500 })
  })
})

describe('placeExtensionWindow on an update', () => {
  const current = { x: 200, y: 100, width: 700, height: 800 }

  it('moves one edge and keeps the rest', () => {
    expect(placeExtensionWindow({ left: 10 }, [SCREEN], MIN, current)).toEqual({ x: 10, y: 100, width: 700, height: 800 })
    expect(placeExtensionWindow({ height: 450 }, [SCREEN], MIN, current)).toEqual({ x: 200, y: 100, width: 700, height: 450 })
  })

  it('answers nothing to change for an empty request', () => {
    expect(placeExtensionWindow({}, [SCREEN], MIN, current)).toEqual(current)
  })

  it('keeps a window inside the work area it is on', () => {
    expect(placeExtensionWindow({ left: 1900 }, [SCREEN], MIN, current)).toEqual({ x: 1220, y: 100, width: 700, height: 800 })
  })
})
