import { describe, expect, it } from 'vitest'
import { chromePanes, isChromePane, nextPane, PANE_ORDER } from '../pane-order.js'
import type { PaneName } from '../pane-order.js'

describe('nextPane', () => {
  const all: readonly PaneName[] = PANE_ORDER

  it('walks forward through every pane in reading order and wraps to the first', () => {
    const walked: PaneName[] = []
    let at: PaneName = 'address'
    for (let step = 0; step < all.length; step++) {
      at = nextPane(at, all, 1) as PaneName
      walked.push(at)
    }
    expect(walked).toEqual(['toolbar', 'tabs', 'bookmarks', 'side-panel', 'page', 'address'])
  })

  it('walks back and wraps from the first pane to the last', () => {
    expect(nextPane('toolbar', all, -1)).toBe('address')
    expect(nextPane('address', all, -1)).toBe('page')
  })

  it('skips a pane that is not available', () => {
    const shown: PaneName[] = ['address', 'tabs', 'page']
    expect(nextPane('address', shown, 1)).toBe('tabs')
    expect(nextPane('page', shown, -1)).toBe('tabs')
    expect(nextPane('page', shown, 1)).toBe('address')
  })

  it('lands next to a current pane that is not in the list', () => {
    const outside: PaneName[] = ['address', 'side-panel', 'page']
    expect(nextPane('bookmarks', outside, 1)).toBe('side-panel')
    expect(nextPane('bookmarks', outside, -1)).toBe('address')
    expect(nextPane('bookmarks', ['address', 'page'], 1)).toBe('page')
    expect(nextPane('page', ['address', 'toolbar'], 1)).toBe('address')
    expect(nextPane('page', ['address', 'toolbar'], -1)).toBe('toolbar')
  })

  it('stays on the only pane, and finds nothing in an empty list', () => {
    expect(nextPane('page', ['page'], 1)).toBe('page')
    expect(nextPane('page', ['page'], -1)).toBe('page')
    expect(nextPane('page', [], 1)).toBeNull()
  })

  it('does not depend on the order the available panes are listed in', () => {
    expect(nextPane('address', ['page', 'tabs', 'address'], 1)).toBe('tabs')
  })
})

describe('chromePanes', () => {
  it('keeps the four panes of the chrome, in order', () => {
    expect(chromePanes(['page', 'bookmarks', 'address', 'side-panel', 'tabs'])).toEqual(['address', 'tabs', 'bookmarks'])
    expect(isChromePane('toolbar')).toBe(true)
    expect(isChromePane('page')).toBe(false)
  })
})
