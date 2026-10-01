import { describe, expect, it } from 'vitest'
import { groupsFor } from '../groups-model.js'
import { closeGroup, groupTab, groupTabNew, joinOpenerGroup, moveGroup, rejoinGroup, shownNeighbour, stepTab, toggleCollapsed, ungroupAll, ungroupTab } from '../groups-runner.js'
import { reconcile } from '../groups-sync.js'
import { fakeStrip, groupOf } from './fake-strip.js'

describe('making a group', () => {
  it('puts the tab in a new group where it is, with the next colour', () => {
    const strip = fakeStrip(['a', 'b', 'c'])
    const id = groupTab(strip.ctx, 'b', 'new')
    expect(id).toBeDefined()
    expect(strip.shape()).toBe(`a:- b:${id ?? ''} c:-`)
    expect(groupsFor(strip.tabs).get(id ?? '')).toMatchObject({ color: 'gray', title: '', collapsed: false })
  })

  it('asks the chrome to open the bubble of a group the command made, and of no other', () => {
    const strip = fakeStrip(['a', 'b'])
    groupTabNew(strip.ctx, 'a')
    expect(strip.sent).toEqual([{ type: 'module', module: 'tab-groups', payload: { type: 'menu', id: [...groupsFor(strip.tabs).list()][0]?.id } }])
    const other = fakeStrip(['a', 'b'])
    groupTab(other.ctx, 'a', 'new')
    expect(other.sent).toEqual([])
  })

  it('adds a tab to an existing group at its end', () => {
    const strip = fakeStrip(['a', 'b', 'c', 'd'])
    const id = groupOf(strip, ['a', 'b'])
    groupTab(strip.ctx, 'd', id)
    expect(strip.shape()).toBe(`a:${id} b:${id} d:${id} c:-`)
  })

  it('refuses a group this window does not have', () => {
    const strip = fakeStrip(['a', 'b'])
    expect(groupTab(strip.ctx, 'a', 'g-999')).toBeUndefined()
    expect(strip.shape()).toBe('a:- b:-')
  })

  it('unpins a pinned tab that is grouped, and the group starts after the pinned run', () => {
    const strip = fakeStrip(['p', 'q', 'a'], { pinned: ['p', 'q'] })
    const id = groupOf(strip, ['a'])
    expect(groupTab(strip.ctx, 'q', id)).toBe(id)
    expect(strip.records.get('q')?.pinned).toBe(false)
    expect(strip.shape()).toBe(`p:- a:${id} q:${id}`)
  })

  it('groups both tabs of a split pair', () => {
    const strip = fakeStrip(['a', 'b', 'c'], { pairs: [['b', 'c']] })
    const id = groupTab(strip.ctx, 'c', 'new')
    expect(strip.shape()).toBe(`a:- b:${id ?? ''} c:${id ?? ''}`)
  })

  it('takes a tab out of one group into another, and the group it left disappears when empty', () => {
    const strip = fakeStrip(['a', 'b', 'c'])
    const first = groupOf(strip, ['a'])
    const second = groupOf(strip, ['c'])
    groupTab(strip.ctx, 'a', second)
    expect(groupsFor(strip.tabs).has(first)).toBe(false)
    expect(strip.shape()).toBe(`b:- c:${second} a:${second}`)
  })
})

describe('taking tabs out', () => {
  it('moves a middle tab to just after the group', () => {
    const strip = fakeStrip(['a', 'b', 'c', 'd'])
    const id = groupOf(strip, ['a', 'b', 'c'])
    ungroupTab(strip.ctx, 'b')
    expect(strip.shape()).toBe(`a:${id} c:${id} b:- d:-`)
  })

  it('deletes a group whose last tab leaves', () => {
    const strip = fakeStrip(['a', 'b'])
    const id = groupOf(strip, ['a'])
    ungroupTab(strip.ctx, 'a')
    expect(groupsFor(strip.tabs).has(id)).toBe(false)
    expect(strip.shape()).toBe('a:- b:-')
  })

  it('does nothing for a tab in no group', () => {
    const strip = fakeStrip(['a', 'b'])
    ungroupTab(strip.ctx, 'a')
    expect(strip.shape()).toBe('a:- b:-')
  })

  it('dissolves the whole group where it stands', () => {
    const strip = fakeStrip(['a', 'b', 'c'])
    const id = groupOf(strip, ['a', 'b'])
    ungroupAll(strip.ctx, id)
    expect(strip.shape()).toBe('a:- b:- c:-')
    expect(groupsFor(strip.tabs).list()).toEqual([])
  })

  it('closes every tab of a group and the group goes with them', () => {
    const strip = fakeStrip(['a', 'b', 'c'])
    const id = groupOf(strip, ['a', 'c'])
    closeGroup(strip.ctx, id)
    expect(strip.order).toEqual(['b'])
    expect(groupsFor(strip.tabs).has(id)).toBe(false)
  })
})

describe('collapsing', () => {
  it('hides the group, and shows it again', () => {
    const strip = fakeStrip(['a', 'b', 'c'], { active: 'a' })
    const id = groupOf(strip, ['b', 'c'])
    toggleCollapsed(strip.ctx, id)
    expect(groupsFor(strip.tabs).get(id)?.collapsed).toBe(true)
    toggleCollapsed(strip.ctx, id)
    expect(groupsFor(strip.tabs).get(id)?.collapsed).toBe(false)
  })

  it('moves the tab in front out of the group first, to the nearest tab outside it', () => {
    const strip = fakeStrip(['a', 'b', 'c', 'd'], { active: 'b' })
    const id = groupOf(strip, ['b', 'c'])
    toggleCollapsed(strip.ctx, id)
    expect(strip.active).toBe('a')
    expect(groupsFor(strip.tabs).get(id)?.collapsed).toBe(true)
  })

  it('opens a new tab when the group is all there is', () => {
    const strip = fakeStrip(['a', 'b'], { active: 'a' })
    const id = groupOf(strip, ['a', 'b'])
    toggleCollapsed(strip.ctx, id)
    expect(strip.created).toBe(1)
    expect(strip.active).toBe('n1')
    expect(groupsFor(strip.tabs).get(id)?.collapsed).toBe(true)
  })

  it('shows a collapsed group again when something activates one of its tabs', () => {
    const strip = fakeStrip(['a', 'b', 'c'], { active: 'a' })
    const id = groupOf(strip, ['b', 'c'])
    groupsFor(strip.tabs).update(id, { collapsed: true })
    strip.tabs.activateTab('c')
    expect(groupsFor(strip.tabs).get(id)?.collapsed).toBe(false)
  })
})

describe('moving with the keys and the mouse', () => {
  it('joins a group between two of its tabs, stays at its edge, and leaves past it', () => {
    const strip = fakeStrip(['a', 'b', 'c', 'x'])
    const id = groupOf(strip, ['b', 'c'])
    stepTab(strip.tabs, 'x', -1)
    expect(strip.shape()).toBe(`a:- b:${id} x:${id} c:${id}`)
    stepTab(strip.tabs, 'x', -1)
    expect(strip.shape()).toBe(`a:- x:${id} b:${id} c:${id}`)
    stepTab(strip.tabs, 'x', -1)
    expect(strip.shape()).toBe(`x:- a:- b:${id} c:${id}`)
  })

  it('leaves a group by moving its last tab past it', () => {
    const strip = fakeStrip(['a', 'b', 'c', 'x'])
    const id = groupOf(strip, ['b', 'c'])
    stepTab(strip.tabs, 'c', 1)
    expect(strip.shape()).toBe(`a:- b:${id} x:- c:-`)
  })

  it('passes a collapsed group in one step', () => {
    const strip = fakeStrip(['x', 'b', 'c', 'd'])
    const id = groupOf(strip, ['b', 'c'])
    groupsFor(strip.tabs).update(id, { collapsed: true })
    stepTab(strip.tabs, 'x', 1)
    expect(strip.shape()).toBe(`b:${id} c:${id} x:- d:-`)
  })

  it('moves a whole group to a place among the tabs outside it', () => {
    const strip = fakeStrip(['a', 'b', 'c', 'd'])
    const id = groupOf(strip, ['a', 'b'])
    moveGroup(strip.ctx, id, 2)
    expect(strip.shape()).toBe(`c:- d:- a:${id} b:${id}`)
    moveGroup(strip.ctx, id, 1)
    expect(strip.shape()).toBe(`c:- a:${id} b:${id} d:-`)
  })

  it('keeps a group after the pinned tabs', () => {
    const strip = fakeStrip(['p', 'a', 'b'], { pinned: ['p'] })
    const id = groupOf(strip, ['b'])
    moveGroup(strip.ctx, id, 0)
    expect(strip.shape()).toBe(`p:- b:${id} a:-`)
  })

  it('moves a joined pair as one, and the pair joins or leaves together', () => {
    const strip = fakeStrip(['a', 'b', 'x', 'y'], { pairs: [['x', 'y']] })
    const id = groupOf(strip, ['a', 'b'])
    stepTab(strip.tabs, 'x', -1)
    expect(strip.shape()).toBe(`a:${id} x:${id} y:${id} b:${id}`)
  })
})

describe('what keeps a strip true to the rules', () => {
  it('takes a pinned tab out of its group', () => {
    const strip = fakeStrip(['p', 'a', 'b'], { pinned: ['p'] })
    const id = groupOf(strip, ['p', 'a'])
    reconcile(strip.tabs, null)
    expect(strip.shape()).toBe(`p:- a:${id} b:-`)
  })

  it('removes a group once no tab holds it', () => {
    const strip = fakeStrip(['a', 'b'])
    const id = groupOf(strip, ['a'])
    strip.tabs.closeTab('a')
    expect(groupsFor(strip.tabs).has(id)).toBe(false)
  })

  it('gathers a group a closed middle tab left, and a tab that opened inside it', () => {
    const strip = fakeStrip(['a', 'x', 'b'])
    const id = groupOf(strip, ['a', 'b'])
    reconcile(strip.tabs, null)
    expect(strip.shape()).toBe(`a:${id} b:${id} x:-`)
  })

  it('puts the second pane of a pair in the first pane\'s group', () => {
    const strip = fakeStrip(['a', 'b', 'c'], { pairs: [['b', 'c']] })
    const id = groupOf(strip, ['b'])
    reconcile(strip.tabs, null)
    expect(strip.shape()).toBe(`a:- b:${id} c:${id}`)
  })

  it('shows a collapsed group that holds the tab in front', () => {
    const strip = fakeStrip(['a', 'b'], { active: 'b' })
    const id = groupOf(strip, ['b'])
    groupsFor(strip.tabs).update(id, { collapsed: true })
    reconcile(strip.tabs, 'b')
    expect(groupsFor(strip.tabs).get(id)?.collapsed).toBe(false)
  })
})

describe('tabs that join a group on their own', () => {
  it('opens a link from a member at the end of its group', () => {
    const strip = fakeStrip(['a', 'b', 'c', 'n'])
    const id = groupOf(strip, ['a', 'b'])
    joinOpenerGroup(strip.tabs, 'n', 'a')
    expect(strip.shape()).toBe(`a:${id} b:${id} n:${id} c:-`)
  })

  it('does not group a link opened from a tab in none, or from itself', () => {
    const strip = fakeStrip(['a', 'n'])
    groupOf(strip, ['a'])
    joinOpenerGroup(strip.tabs, 'n', 'n')
    joinOpenerGroup(strip.tabs, 'n', null)
    expect(strip.shape()).toMatch(/n:-$/)
  })

  it('puts a reopened tab back in its group while the group exists, and not otherwise', () => {
    const strip = fakeStrip(['a', 'b', 'r'])
    const id = groupOf(strip, ['a', 'b'])
    rejoinGroup(strip.tabs, 'r', id)
    expect(strip.shape()).toBe(`a:${id} b:${id} r:${id}`)
    const other = fakeStrip(['a', 'r'])
    rejoinGroup(other.tabs, 'r', 'g-999')
    expect(other.shape()).toBe('a:- r:-')
  })

  it('lets a tab landing between two members of a group join it', () => {
    const strip = fakeStrip(['a', 'b'])
    const id = groupOf(strip, ['a', 'b'])
    strip.order.splice(1, 0, 'x')
    strip.records.set('x', { pinned: false, groupId: null } as never)
    strip.tabs.afterMove?.('x')
    expect(strip.records.get('x')?.groupId).toBe(id)
  })
})

describe('the next and previous tab keys', () => {
  it('wrap round the strip, and pass the tabs a collapsed group hides', () => {
    const strip = fakeStrip(['a', 'b', 'c', 'd'])
    const id = groupOf(strip, ['b', 'c'])
    expect(shownNeighbour(strip.tabs, 'a', 1)).toBe('b')
    groupsFor(strip.tabs).update(id, { collapsed: true })
    expect(shownNeighbour(strip.tabs, 'a', 1)).toBe('d')
    expect(shownNeighbour(strip.tabs, 'd', 1)).toBe('a')
    expect(shownNeighbour(strip.tabs, 'a', -1)).toBe('d')
    expect(shownNeighbour(strip.tabs, 'd', -1)).toBe('a')
    expect(shownNeighbour(strip.tabs, null, 1)).toBe('a')
  })
})
