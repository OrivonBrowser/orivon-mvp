import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import { groupsFor } from '../groups-model.js'
import { asGroupRequest, tabGroupOverlay } from '../tab-group-overlay.js'
import { fakeStrip, groupOf } from './fake-strip.js'

function open (ids = ['a', 'b', 'c']) {
  const strip = fakeStrip(ids)
  const id = groupOf(strip, ['a', 'b'], 'Work')
  const openWindow = vi.fn()
  const win = { ...strip.ctx, services: { commands: { openWindow } }, send: vi.fn(), close: vi.fn() } as unknown as OverlayWindow
  const handler = tabGroupOverlay.attach(win)
  return { strip, id, win, handler, openWindow }
}

describe('the group bubble', () => {
  it('shows the group it was told to show, with its tab count', () => {
    const { handler, id } = open()
    expect(handler.show?.({ id })).toMatchObject({ title: 'Work', color: 'gray', count: 2, collapsed: false, canMoveToWindow: true })
  })

  it('closes at once for a group that is not there, or an id that is not text', () => {
    const { handler, win } = open()
    expect(handler.show?.({ id: 'g-999' })).toBeNull()
    expect(handler.show?.({ id: 5 })).toBeNull()
    expect(win.close).toHaveBeenCalledTimes(2)
  })

  it('renames and recolours the group, saving the title as text of at most 40 characters', () => {
    const { handler, id, strip } = open()
    handler.show?.({ id })
    handler.request({ type: 'rename', title: `  ${'x'.repeat(60)}` })
    expect(groupsFor(strip.tabs).get(id)?.title).toHaveLength(40)
    handler.request({ type: 'color', color: 'green' })
    expect(groupsFor(strip.tabs).get(id)?.color).toBe('green')
    handler.request({ type: 'color', color: 'mauve' })
    handler.request({ type: 'rename', title: 12 })
    expect(groupsFor(strip.tabs).get(id)?.color).toBe('green')
    expect(groupsFor(strip.tabs).get(id)?.title).toHaveLength(40)
  })

  it('acts on no group until it has been shown one, and never on one named by the page', () => {
    const { handler, id, strip } = open()
    handler.request({ type: 'rename', title: 'Nope' })
    expect(groupsFor(strip.tabs).get(id)?.title).toBe('Work')
    handler.show?.({ id })
    handler.request({ type: 'rename', title: 'Fine', id: 'g-999' })
    expect(groupsFor(strip.tabs).get(id)?.title).toBe('Fine')
  })

  it('opens a new tab in the group', () => {
    const { handler, id, strip, win } = open()
    handler.show?.({ id })
    handler.request({ type: 'newTab' })
    expect(win.close).toHaveBeenCalled()
    expect(strip.records.get('n1')?.groupId).toBe(id)
    expect(strip.order.indexOf('n1')).toBe(2)
  })

  it('ungroups the whole group, closes it, or sends it to a window of its own', () => {
    const one = open()
    one.handler.show?.({ id: one.id })
    one.handler.request({ type: 'ungroup' })
    expect(one.strip.shape()).toBe('a:- b:- c:-')

    const two = open()
    two.handler.show?.({ id: two.id })
    two.handler.request({ type: 'close' })
    expect(two.strip.order).toEqual(['c'])

    const three = open()
    three.handler.show?.({ id: three.id })
    three.handler.request({ type: 'toWindow' })
    expect(three.openWindow).toHaveBeenCalledWith(expect.objectContaining({ instant: true, first: expect.any(Function) }))
  })

  it('keeps a group that is every tab of its window from leaving it', () => {
    const { handler, id } = open(['a', 'b'])
    expect(handler.show?.({ id })).toMatchObject({ canMoveToWindow: false })
    handler.request({ type: 'toWindow' })
  })

  it('reads a request only if it is one of the listed kinds', () => {
    expect(asGroupRequest({ type: 'ungroup' })).toEqual({ type: 'ungroup' })
    expect(asGroupRequest({ type: 'delete' })).toBeUndefined()
    expect(asGroupRequest(null)).toBeUndefined()
    expect(asGroupRequest('close')).toBeUndefined()
    expect(asGroupRequest({ type: 'color', color: 'teal' })).toEqual({ type: 'color', color: 'teal' })
    expect(asGroupRequest({ type: 'color', color: 'teal ' })).toBeUndefined()
  })
})
