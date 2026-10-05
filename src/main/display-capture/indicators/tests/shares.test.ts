import { describe, expect, it } from 'vitest'
import type { ActiveShare } from '../../types.js'
import { barText, newestShare, sharesOfWindow } from '../shares.js'

const share = (id: string, kind: ActiveShare['kind'], startedAt: number, origin = 'https://meet.example'): ActiveShare =>
  ({ id, requester: { id } as never, origin, kind, label: id, audio: false, startedAt })

describe('barText', () => {
  it('says who shares what, for each kind', () => {
    expect(barText([share('a', 'screen', 1)])).toBe('https://meet.example is sharing your screen')
    expect(barText([share('a', 'window', 1)])).toBe('https://meet.example is sharing a window')
    expect(barText([share('a', 'tab', 1)])).toBe('https://meet.example is sharing a tab')
  })

  it('names the newest share and counts the others', () => {
    const shares = [share('a', 'screen', 1), share('b', 'tab', 3), share('c', 'window', 2)]
    expect(barText(shares)).toBe('https://meet.example is sharing a tab and 2 more')
    expect(barText(shares.slice(0, 2))).toBe('https://meet.example is sharing a tab and 1 more')
  })

  it('says nothing when nothing is shared', () => {
    expect(barText([])).toBe('')
  })
})

describe('newestShare and sharesOfWindow', () => {
  it('picks the share that started last, the later of two that started together', () => {
    expect(newestShare([])).toBeUndefined()
    expect(newestShare([share('a', 'tab', 1), share('b', 'tab', 2)])?.id).toBe('b')
    expect(newestShare([share('a', 'tab', 2), share('b', 'tab', 2)])?.id).toBe('b')
  })

  it('keeps the shares whose requester the window holds', () => {
    const shares = [share('a', 'tab', 1), share('b', 'tab', 2)]
    expect(sharesOfWindow(shares, (contents) => (contents as unknown as { id: string }).id === 'b').map((s) => s.id)).toEqual(['b'])
  })
})
