import { describe, expect, it } from 'vitest'
import { anchorScript, fallbackAnchor, parseAnchor } from '../extension-action-anchor.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

describe('anchorScript', () => {
  it('names the extension\'s icon and the Extensions button', () => {
    const script = anchorScript(ID) as string
    expect(script).toContain(`[id="${ID}"]`)
    expect(script).toContain('extensions-menu-btn')
  })

  it('writes nothing it was not sure of into the source', () => {
    for (const id of ['', 'short', `${ID}"]; alert(1); //`, ID.toUpperCase(), `${ID}x`, 'q'.repeat(32)]) expect(anchorScript(id), id).toBeNull()
  })
})

describe('parseAnchor', () => {
  it('takes a rectangle of finite numbers', () => {
    expect(parseAnchor({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('refuses anything else', () => {
    for (const value of [null, undefined, 'x', 5, {}, { x: 1, y: 2, width: 3 }, { x: 1, y: 2, width: 3, height: Infinity }, { x: '1', y: 2, width: 3, height: 4 }]) expect(parseAnchor(value)).toBeNull()
  })
})

describe('fallbackAnchor', () => {
  it('sits at the toolbar\'s right end, inside the window', () => {
    expect(fallbackAnchor(1280)).toEqual({ x: 1180, y: 36, width: 32, height: 40 })
    expect(fallbackAnchor(50).x).toBe(0)
  })
})
