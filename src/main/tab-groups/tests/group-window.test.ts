import { describe, expect, it, vi } from 'vitest'
import { moveGroupToNewWindow } from '../group-window.js'
import { groupsFor } from '../groups-model.js'
import { fakeStrip, groupOf } from './fake-strip.js'

describe('sending a group to a window of its own', () => {
  it('opens a window that takes the tabs and makes the group again, open, with the same name and colour', () => {
    const source = fakeStrip(['a', 'b', 'c'])
    const id = groupOf(source, ['a', 'b'], 'Work')
    groupsFor(source.tabs).update(id, { color: 'teal', collapsed: true })
    const target = fakeStrip(['n'], { hook: false })
    const given: string[] = []
    ;(source.tabs as unknown as { takeTab: (id: string) => unknown }).takeTab = (tab) => { source.order.splice(source.order.indexOf(tab), 1); return source.records.get(tab) ?? null }
    ;(target.tabs as unknown as { giveTab: (id: string, record: unknown) => void }).giveTab = (tab, record) => { given.push(tab); target.order.push(tab); target.records.set(tab, record as never) }
    const openWindow = vi.fn((options: { first: (tabs: unknown) => void }) => { options.first(target.tabs) })
    const ctx = { ...source.ctx, services: { commands: { openWindow } } } as never

    expect(moveGroupToNewWindow(ctx, id)).toBe(true)

    expect(given).toEqual(['a', 'b'])
    const made = groupsFor(target.tabs).list()
    expect(made).toEqual([{ id: expect.any(String), title: 'Work', color: 'teal', collapsed: false }])
    expect(target.records.get('a')?.groupId).toBe(made[0]?.id)
    expect(made[0]?.id).not.toBe(id)
  })

  it('stays when the group is every tab, or is not there', () => {
    const strip = fakeStrip(['a', 'b'])
    const id = groupOf(strip, ['a', 'b'])
    const openWindow = vi.fn()
    const ctx = { ...strip.ctx, services: { commands: { openWindow } } } as never
    expect(moveGroupToNewWindow(ctx, id)).toBe(false)
    expect(moveGroupToNewWindow(ctx, 'g-999')).toBe(false)
    expect(openWindow).not.toHaveBeenCalled()
  })
})
