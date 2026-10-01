import { describe, expect, it } from 'vitest'
import { groupAfterMove, isNormal, normalise, placeAfterGroup, placeInGroup, runOf, stepPlace, whenCollapsingActive } from '../group-order.js'

/** A strip written as "a b:G c:G d" is the ids in order, with the group after a colon. */
function strip (text: string): { order: string[], groupOf: (id: string) => string | null } {
  const entries = text.split(' ').map((part) => part.split(':') as [string, string | undefined])
  const groups = new Map(entries.map(([id, group]) => [id, group ?? null]))
  return { order: entries.map(([id]) => id), groupOf: (id) => groups.get(id) ?? null }
}

describe('where a group sits', () => {
  it('finds the run of a group', () => {
    const { order, groupOf } = strip('a b:G c:G d')
    expect(runOf(order, 'G', groupOf)).toEqual([1, 2])
    expect(runOf(order, 'H', groupOf)).toBeNull()
  })
})

describe('the group of a tab after a move', () => {
  const after = (text: string, moved: string[] = ['x']): string | null => {
    const { order, groupOf } = strip(text)
    return groupAfterMove(order, moved, groupOf)
  }

  it('joins a group when it lands between two of its tabs', () => {
    expect(after('a:G x b:G')).toBe('G')
  })

  it('leaves a group when it lands away from it', () => {
    expect(after('a x:G b')).toBeNull()
    expect(after('a:G b:G c x:G')).toBeNull()
  })

  it('stays in its group at the group\'s edge, and does not join one from outside its edge', () => {
    expect(after('x:G a:G b:G')).toBe('G')
    expect(after('a:G b:G x:G')).toBe('G')
    expect(after('a:G b:G x')).toBeNull()
    expect(after('x a:G b:G')).toBeNull()
  })

  it('changes from one group to the one it lands inside', () => {
    expect(after('a:H x:G b:H')).toBe('H')
  })

  it('looks at the neighbours of a joined pair as a whole', () => {
    expect(after('a:G x y b:G', ['x', 'y'])).toBe('G')
    expect(after('a:G x y b', ['x', 'y'])).toBeNull()
  })
})

describe('placing a tab in a group', () => {
  it('goes to the end of the group\'s run, among the other tabs', () => {
    const { order, groupOf } = strip('a b:G c:G d x')
    expect(placeInGroup(order, ['x'], 'G', groupOf)).toBe(3)
    expect(placeAfterGroup(order, ['c'], 'G', groupOf)).toBe(2)
  })
})

describe('bringing a strip back to the rules', () => {
  const run = (text: string, pinned: string[] = [], pairs: Array<[string, string]> = []) => {
    const { order, groupOf } = strip(text)
    return normalise(order, groupOf, (id) => pinned.includes(id), pairs)
  }

  it('changes nothing in a strip that follows them', () => {
    const { order, groupOf } = strip('p a:G b:G c')
    const result = normalise(order, groupOf, (id) => id === 'p', [])
    expect(isNormal(result, order)).toBe(true)
  })

  it('never leaves a pinned tab in a group', () => {
    const result = run('p:G a:G', ['p'])
    expect(result.groups.get('p')).toBeNull()
  })

  it('gathers a group into one run at its first tab', () => {
    expect(run('a:G b c:G d:G e').order).toEqual(['a', 'c', 'd', 'b', 'e'])
  })

  it('keeps two groups apart and in order', () => {
    expect(run('a:G b:H c:G d:H').order).toEqual(['a', 'c', 'b', 'd'])
  })

  it('gives the second pane of a joined pair the first pane\'s group', () => {
    const result = run('a:G b c', [], [['a', 'b']])
    expect(result.groups.get('b')).toBe('G')
    expect(run('a b:G c', [], [['a', 'b']]).groups.get('b')).toBeNull()
  })

  it('never splits a pair when it gathers', () => {
    const order = run('a:G b:G c d:G', [], [['a', 'b']]).order
    expect(order.indexOf('b')).toBe(order.indexOf('a') + 1)
    expect(order).toEqual(['a', 'b', 'd', 'c'])
  })

  it('gathers what is left of a group after a tab in the middle closed', () => {
    expect(run('a:G c:G').order).toEqual(['a', 'c'])
  })
})

describe('collapsing the group of the tab in front', () => {
  const to = (text: string, active: string, collapsed: string[] = []): string | null => {
    const { order, groupOf } = strip(text)
    return whenCollapsingActive(order, groupOf, (group) => collapsed.includes(group), 'G', active)
  }

  it('goes to the nearest tab outside the group, the right one when two are as near', () => {
    expect(to('a b:G c:G d', 'b')).toBe('a')
    expect(to('a b:G c:G d', 'c')).toBe('d')
    expect(to('a b:G c:G d:G e', 'c')).toBe('e')
  })

  it('skips tabs another collapsed group hides', () => {
    expect(to('a b:H c:G d', 'c', ['H'])).toBe('d')
    expect(to('a:H b:G', 'b', ['H'])).toBeNull()
  })

  it('has nowhere to go when the group is every tab', () => {
    expect(to('a:G b:G', 'a')).toBeNull()
  })
})

describe('the keys that move a tab one place', () => {
  const step = (text: string, moved: string, direction: -1 | 1, collapsed: string[] = []): number => {
    const { order, groupOf } = strip(text)
    return stepPlace(order, [moved], direction, (id) => collapsed.includes(groupOf(id) ?? ''), groupOf)
  }

  it('goes one place, or past a whole collapsed group', () => {
    expect(step('a x b c', 'x', 1)).toBe(2)
    expect(step('a x b c', 'x', -1)).toBe(0)
    expect(step('a x b:G c:G d', 'x', 1, ['G'])).toBe(3)
    expect(step('a:G b:G x d', 'x', -1, ['G'])).toBe(0)
  })
})
