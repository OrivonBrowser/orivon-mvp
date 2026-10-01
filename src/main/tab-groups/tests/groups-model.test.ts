import { describe, expect, it, vi } from 'vitest'
import { GROUP_COLORS, MAX_GROUP_TITLE, TabGroups, cleanGroupTitle, groupsFor } from '../groups-model.js'

describe('the groups of a window', () => {
  it('gives each group an id no other window shares', () => {
    const one = new TabGroups()
    const two = new TabGroups()
    const ids = [one.create(), two.create(), one.create(), two.create()]
    expect(new Set(ids).size).toBe(4)
    expect(ids.every((id) => /^g-\d+$/.test(id))).toBe(true)
  })

  it('takes the first colour its window has not used, and starts again when all are', () => {
    const groups = new TabGroups()
    const colours = GROUP_COLORS.map(() => groups.get(groups.create())?.color)
    expect(colours).toEqual([...GROUP_COLORS])
    expect(GROUP_COLORS).toContain(groups.get(groups.create())?.color)
    const other = new TabGroups()
    const first = other.create()
    other.remove(first)
    expect(other.get(other.create())?.color).toBe('gray')
  })

  it('keeps a title as text, trimmed and at most 40 characters', () => {
    expect(cleanGroupTitle('  Work  ')).toBe('Work')
    expect(cleanGroupTitle('x'.repeat(41))).toHaveLength(MAX_GROUP_TITLE)
    expect(cleanGroupTitle(42)).toBe('')
    const groups = new TabGroups()
    const id = groups.create()
    groups.update(id, { title: '<b>Work</b>' })
    expect(groups.get(id)?.title).toBe('<b>Work</b>')
  })

  it('refuses a colour outside the list and leaves the group as it was', () => {
    const groups = new TabGroups()
    const id = groups.create('blue')
    expect(groups.update(id, { color: 'chartreuse' })).toBe(false)
    expect(groups.update(id, { color: 7 })).toBe(false)
    expect(groups.get(id)?.color).toBe('blue')
    expect(groups.update(id, { color: 'teal', collapsed: true })).toBe(true)
    expect(groups.get(id)).toEqual({ id, title: '', color: 'teal', collapsed: true })
  })

  it('tells a listener of each change, and of none that changes nothing', () => {
    const groups = new TabGroups()
    const listener = vi.fn()
    const stop = groups.onChange(listener)
    const id = groups.create()
    groups.update(id, { title: 'A' })
    groups.update(id, { title: 'A' })
    groups.remove(id)
    groups.remove(id)
    expect(listener).toHaveBeenCalledTimes(3)
    expect(listener.mock.calls.map(([change]) => [change.kind, change.group.id, change.group.title])).toEqual([['created', id, ''], ['updated', id, 'A'], ['removed', id, 'A']])
    stop()
    groups.create()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('is one set of groups per tab collection', () => {
    const tabs = {}
    expect(groupsFor(tabs)).toBe(groupsFor(tabs))
    expect(groupsFor({})).not.toBe(groupsFor(tabs))
  })
})
