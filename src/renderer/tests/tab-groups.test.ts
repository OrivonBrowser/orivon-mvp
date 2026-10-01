import { describe, expect, it } from 'vitest'
import type { ShellState, TabState } from '../../main/shell/tabs.js'
import type { ChromeContext } from '../chrome/context.js'
import { CHROME_MODULES, TAB_DECORATORS } from '../chrome/modules.js'
import { chipName, decorateTabGroup, memberCount, placeAmongAll } from '../chrome/tab-groups.js'
import { groupDropIndex } from '../chrome/tab-group-drag.js'
import { closeLabel, colorName, isModel, nextSwatch } from '../overlay/tab-group/model.js'

class FakeEl {
  hidden = false
  dataset: Record<string, string> = {}
  attrs = new Map<string, string>([['aria-label', 'Docs']])
  getAttribute (name: string): string | null { return this.attrs.get(name) ?? null }
  setAttribute (name: string, value: string): void { this.attrs.set(name, value) }
}

const tab = (id: string, group: string | null = null): TabState => ({ id, group } as unknown as TabState)
const state = (tabs: TabState[], groups: ShellState['groups']): ShellState => ({ tabs, activeTabId: null, groups } as unknown as ShellState)
const work = { id: 'g-1', title: 'Work', color: 'green', collapsed: false } as const

describe('a group\'s chip', () => {
  it('is named for its group, its size and whether its tabs are shown', () => {
    expect(chipName(work, 4)).toBe('Work, group of 4 tabs, expanded')
    expect(chipName({ ...work, collapsed: true }, 1)).toBe('Work, group of 1 tab, collapsed')
    expect(chipName({ ...work, title: '' }, 2)).toBe('Untitled group of 2 tabs, expanded')
  })

  it('counts the tabs the state puts in the group', () => {
    expect(memberCount(work, state([tab('a', 'g-1'), tab('b'), tab('c', 'g-1')], [work]))).toBe(2)
  })

  it('is a module of the chrome after the strip, and its decorator is one of the tab decorators', () => {
    const names = CHROME_MODULES.map((module) => module.name)
    expect(names.indexOf('tab-groups')).toBeGreaterThan(names.indexOf('tab-strip'))
    expect(TAB_DECORATORS).toContain(decorateTabGroup)
  })
})

describe('a tab of a group', () => {
  const decorate = (group: ShellState['groups'], id: string | null): FakeEl => {
    const el = new FakeEl()
    decorateTabGroup(el as unknown as HTMLElement, tab('a', id), state([tab('a', id)], group), {} as ChromeContext)
    return el
  }

  it('carries its group and colour, and its group\'s name in its accessible name', () => {
    const el = decorate([work], 'g-1')
    expect(el.dataset).toEqual({ group: 'g-1', color: 'green' })
    expect(el.hidden).toBe(false)
    expect(el.getAttribute('aria-label')).toBe('Docs, in group Work')
  })

  it('is hidden while its group is collapsed', () => {
    expect(decorate([{ ...work, collapsed: true }], 'g-1').hidden).toBe(true)
  })

  it('is left alone when it has no group, or the state does not list the one it names', () => {
    for (const el of [decorate([work], null), decorate([], 'g-1'), decorate(undefined, 'g-1')]) {
      expect(el.dataset).toEqual({})
      expect(el.hidden).toBe(false)
    }
  })
})

describe('dropping on a strip with a collapsed group', () => {
  const row = (entries: Array<[id: string, hidden: boolean]>): ParentNode => ({
    querySelectorAll: () => entries.map(([id, hidden]) => ({ dataset: { id }, hidden }))
  }) as unknown as ParentNode

  it('counts the hidden tabs of the group when it turns a place among the shown tabs into a place among all', () => {
    const strip = row([['a', false], ['g1', true], ['g2', true], ['b', false], ['held', false]])
    expect(placeAmongAll(strip, ['held'], 0)).toBe(0)
    expect(placeAmongAll(strip, ['held'], 1)).toBe(3)
    expect(placeAmongAll(strip, ['held'], 2)).toBe(4)
  })

  it('leaves the held tabs out of the count', () => {
    const strip = row([['a', false], ['x', false], ['y', false], ['b', false]])
    expect(placeAmongAll(strip, ['x', 'y'], 1)).toBe(1)
    expect(placeAmongAll(strip, ['x', null], 5)).toBe(3)
  })

  it('drops a group by the centres of the tabs outside it', () => {
    expect(groupDropIndex([50, 150, 250], 10)).toBe(0)
    expect(groupDropIndex([50, 150, 250], 160)).toBe(2)
    expect(groupDropIndex([50, 150, 250], 900)).toBe(3)
  })
})

describe('the group bubble\'s model', () => {
  it('reads a model main sent, and refuses anything else', () => {
    const model = { title: 'Work', color: 'blue', collapsed: false, count: 2, colors: ['blue'], maxTitle: 40, canMoveToWindow: true }
    expect(isModel(model)).toBe(true)
    expect(isModel({ ...model, color: 'mauve' })).toBe(false)
    expect(isModel(null)).toBe(false)
    expect(isModel({ ...model, count: '2' })).toBe(false)
  })

  it('words the close row, and what it says once armed', () => {
    expect(closeLabel(4, false)).toBe('Close group')
    expect(closeLabel(4, true)).toBe('Click again to close 4 tabs')
    expect(closeLabel(1, true)).toBe('Click again to close 1 tab')
    expect(colorName('teal')).toBe('Teal')
  })

  it('moves among the swatches with the arrow keys, wrapping at the ends', () => {
    expect(nextSwatch(8, 7, 'ArrowRight')).toBe(0)
    expect(nextSwatch(8, 0, 'ArrowLeft')).toBe(7)
    expect(nextSwatch(8, 3, 'ArrowRight')).toBe(4)
    expect(nextSwatch(0, 0, 'ArrowRight')).toBe(-1)
  })
})
