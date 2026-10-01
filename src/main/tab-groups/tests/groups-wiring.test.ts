import { describe, expect, it } from 'vitest'
import { groupsStatePart } from '../../shell/state/groups.js'
import { groupToggle, groupMenu, groupMove } from '../../shell/actions/tab-group.js'
import { runChromeAction } from '../../shell/chrome-actions.js'
import { tabGroupsHook } from '../groups-hook.js'
import { groupSignal } from '../group-signal.js'
import { groupLabel } from '../group-label.js'
import { installTabGroups } from '../install-tab-groups.js'
import { groupsFor } from '../groups-model.js'
import { fakeStrip, groupOf } from './fake-strip.js'
import type { ShellServices } from '../../shell/shell-services.js'
import type { TabLifecycleListener } from '../../shell/tab-lifecycle.js'

describe('the state a window pushes', () => {
  it('lists each group in the order its first tab sits, and none that no tab holds', () => {
    const strip = fakeStrip(['a', 'b', 'c', 'd'])
    const late = groupOf(strip, ['c', 'd'], 'Late')
    const early = groupOf(strip, ['a'], 'Early')
    groupsFor(strip.tabs).create()
    const tabs = strip.tabs.getState().tabs as never
    const read = groupsStatePart.read(strip.ctx, { tabs, activeTabId: null }) as { groups: Array<{ id: string }> }
    expect(read.groups.map((group) => group.id)).toEqual([early, late])
  })

  it('pushes again when a group changes', () => {
    const strip = fakeStrip(['a'])
    let pushes = 0
    const stop = groupsStatePart.watch?.(strip.ctx, () => { pushes += 1 })
    const id = groupsFor(strip.tabs).create()
    groupsFor(strip.tabs).update(id, { title: 'A' })
    stop?.()
    groupsFor(strip.tabs).update(id, { title: 'B' })
    expect(pushes).toBe(2)
  })

  it('tells a tab\'s group, or null', () => {
    expect(groupSignal.state?.({ groupId: 'g-1' } as never, undefined)).toEqual({ group: 'g-1' })
    expect(groupSignal.state?.({} as never, undefined)).toEqual({ group: null })
  })
})

describe('what the chrome may ask', () => {
  it('collapses, opens the bubble and moves a group it names, and ignores a group it invents', () => {
    const strip = fakeStrip(['a', 'b', 'c'], { active: 'a' })
    const id = groupOf(strip, ['b', 'c'])
    runChromeAction('group.toggle', { id }, strip.ctx)
    expect(groupsFor(strip.tabs).get(id)?.collapsed).toBe(true)
    runChromeAction('group.toggle', { id: 'g-999' }, strip.ctx)
    runChromeAction('group.toggle', null, strip.ctx)
    runChromeAction('group.toggle', { id: { toString: () => id } }, strip.ctx)
    expect(groupsFor(strip.tabs).get(id)?.collapsed).toBe(true)

    const shown: unknown[][] = []
    ;(strip.ctx.window.overlays as unknown as { show: (...args: unknown[]) => void }).show = (...args) => { shown.push(args) }
    groupMenu({ id, anchor: { x: 1, y: 2, width: 3, height: 4 } }, strip.ctx)
    groupMenu({ id, anchor: { x: 'left' } }, strip.ctx)
    groupMenu({ id: 'g-999', anchor: { x: 1, y: 2, width: 3, height: 4 } }, strip.ctx)
    expect(shown).toEqual([['tab-group', { x: 1, y: 2, width: 3, height: 4 }, { id }]])

    groupMove({ id, index: 0 }, strip.ctx)
    expect(strip.order).toEqual(['b', 'c', 'a'])
    groupMove({ id, index: Number.NaN }, strip.ctx)
    groupMove({ id, index: '1' }, strip.ctx)
    expect(strip.order).toEqual(['b', 'c', 'a'])
    expect([groupToggle, groupMenu, groupMove]).toHaveLength(3)
  })
})

describe('the wiring of a window and the process', () => {
  it('reconciles on every state change once the window opens', () => {
    const strip = fakeStrip(['a', 'x', 'b'], { hook: false })
    const id = groupOf(strip, ['a', 'b'])
    tabGroupsHook.opened?.(strip.ctx, {} as never)
    strip.tabs.changed()
    expect(strip.shape()).toBe(`a:${id} b:${id} x:-`)
  })

  it('takes a tab that moves to another window out of its group', () => {
    let listener: TabLifecycleListener | undefined
    installTabGroups.install({} as never, { tabLifecycle: { subscribe: (added: TabLifecycleListener) => { listener = added } } } as unknown as ShellServices, {} as never, {} as never)
    const record = { groupId: 'g-1' }
    listener?.tabClosing?.({ id: 'a', index: 0, record: record as never, reason: 'closed', window: undefined })
    expect(record.groupId).toBe('g-1')
    listener?.tabClosing?.({ id: 'a', index: 0, record: record as never, reason: 'moved', window: undefined })
    expect(record.groupId).toBeNull()
  })

  it('names a group for a native menu', () => {
    expect(groupLabel({ title: 'Work', color: 'blue' })).toBe('Work')
    expect(groupLabel({ title: '', color: 'green' })).toBe('Untitled Group (Green)')
  })
})
