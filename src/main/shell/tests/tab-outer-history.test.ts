import { describe, expect, it } from 'vitest'
import { EMPTY_OUTER, keptInHistory, leaveView, noteCommit, OUTER_HISTORY_LIMIT, stepBack, stepForward } from '../tab-outer-history.js'
import type { OuterHistory } from '../tab-outer-history.js'

const page = (name: string) => ({ url: `https://${name}.example/`, title: name })
const urls = (entries: ReadonlyArray<{ url: string }>) => entries.map(({ url }) => url)

describe('keptInHistory', () => {
  it('keeps an address with an origin and drops blank, data, file and shell pages', () => {
    expect(keptInHistory('https://a.example/x')).toBe(true)
    for (const url of ['about:blank', 'data:text/html,x', 'file:///tmp/a.html', 'orivon-shell://renderer/settings.html']) expect(keptInHistory(url), url).toBe(false)
  })
})

describe('leaveView', () => {
  it('moves the pages up to the one being left behind the tab, before a new page that has not committed', () => {
    const outer = leaveView(EMPTY_OUTER, [page('a'), page('b'), page('c')], 1, false)
    expect(urls(outer.back)).toEqual(urls([page('a'), page('b')]))
    expect(outer.forward).toEqual([])
  })

  it('leaves out the new page once it has committed in the view being left', () => {
    const outer = leaveView({ back: [page('w')], forward: [] }, [page('a'), page('new')], 1, true)
    expect(urls(outer.back)).toEqual(urls([page('w'), page('a')]))
  })

  it('ends what was ahead of the view on a new page', () => {
    expect(leaveView({ back: [], forward: [page('z')] }, [page('a')], 0, false).forward).toEqual([])
  })

  it('keeps the pages ahead when the view committed a page from the middle of its list', () => {
    const outer = leaveView({ back: [], forward: [page('z')] }, [page('a'), page('b'), page('c')], 1, true)
    expect(urls(outer.forward)).toEqual(urls([page('c'), page('z')]))
  })

  it('drops pages that cannot be loaded again and keeps the newest within the limit', () => {
    const many = Array.from({ length: OUTER_HISTORY_LIMIT + 5 }, (_, i) => page(`p${i}`))
    const outer = leaveView(EMPTY_OUTER, [{ url: 'about:blank', title: '' }, ...many], many.length, false)
    expect(outer.back).toHaveLength(OUTER_HISTORY_LIMIT)
    expect(outer.back.at(-1)?.url).toBe(page(`p${many.length - 1}`).url)
    expect(urls(outer.back)).not.toContain('about:blank')
  })
})

describe('stepping out of the view', () => {
  const outer: OuterHistory = { back: [page('a'), page('b')], forward: [page('y'), page('z')] }

  it('Back reaches the page before the view and puts the view\'s pages ahead', () => {
    const step = stepBack(outer, [page('c'), page('d')], 0)
    expect(step?.target.url).toBe(page('b').url)
    expect(urls(step?.outer.back ?? [])).toEqual(urls([page('a')]))
    expect(urls(step?.outer.forward ?? [])).toEqual(urls([page('c'), page('d'), page('y'), page('z')]))
    expect(step?.outer.trimOnCommit).toBe(true)
  })

  it('Forward reaches the page after the view and puts the view\'s pages behind', () => {
    const step = stepForward(outer, [page('c'), page('d')], 1)
    expect(step?.target.url).toBe(page('y').url)
    expect(urls(step?.outer.back ?? [])).toEqual(urls([page('a'), page('b'), page('c'), page('d')]))
    expect(urls(step?.outer.forward ?? [])).toEqual(urls([page('z')]))
  })

  it('has nowhere to go past either end', () => {
    expect(stepBack(EMPTY_OUTER, [page('c')], 0)).toBeNull()
    expect(stepForward(EMPTY_OUTER, [page('c')], 0)).toBeNull()
  })

  it('round-trips: Back then Forward returns to the same lists', () => {
    const back = stepBack(outer, [page('c')], 0)
    const forward = back === null ? null : stepForward(back.outer, [back.target], 0)
    expect(forward?.target.url).toBe(page('c').url)
    expect(urls(forward?.outer.back ?? [])).toEqual(urls(outer.back))
    expect(urls(forward?.outer.forward ?? [])).toEqual(urls(outer.forward))
  })
})

describe('noteCommit', () => {
  const ahead: OuterHistory = { back: [], forward: [page('z')] }
  const seen = (list: string[], active: number) => noteCommit(ahead, list, active)

  it('only records the list on a view\'s first commit', () => {
    const outer = seen(['a', 'b'], 1)
    expect(outer.forward).toHaveLength(1)
    expect(outer.seen).toEqual({ urls: ['a', 'b'], active: 1 })
  })

  it('ends the pages ahead on a new page added at the end', () => {
    expect(noteCommit(seen(['a'], 0), ['a', 'b'], 1).forward).toEqual([])
  })

  it('ends them on a new page that replaced the view\'s own pages ahead', () => {
    expect(noteCommit(seen(['a', 'b', 'c'], 0), ['a', 'd'], 1).forward).toEqual([])
    expect(noteCommit(seen(['a', 'b'], 0), ['a', 'd'], 1).forward).toEqual([])
  })

  it('keeps them on a step through the view\'s own list, and on the same page again', () => {
    expect(noteCommit(seen(['a', 'b'], 0), ['a', 'b'], 1).forward).toHaveLength(1)
    expect(noteCommit(seen(['a', 'b'], 1), ['a', 'b'], 0).forward).toHaveLength(1)
    expect(noteCommit(seen(['a', 'b'], 1), ['a', 'b2'], 1).forward).toHaveLength(1)
  })
})
