import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUBBLE_MAX_WIDTH, BUBBLE_MIN_WIDTH, BUBBLE_RADIUS, bubblePlace } from '../bubble-geometry.js'
import { HIDE_DELAY_MS, LinkStatus } from '../link-status.js'
import type { LinkStatusPorts, LinkTab } from '../link-status.js'
import { MAX_TEXT_LENGTH } from '../link-status-view.js'
import type { LinkStatusView } from '../link-status-view.js'

const WINDOW = { width: 1200, height: 800 }
const FULL = { x: 0, y: 76, width: 1200, height: 724 }
const R = BUBBLE_RADIUS

interface Rig {
  status: LinkStatus
  calls: Array<[string, unknown]>
  state: { suppressed: boolean, window: typeof WINDOW | undefined }
  /** The newest view the page was handed. */
  last: () => LinkStatusView | undefined
  names: () => string[]
}

function rig (): Rig {
  const calls: Array<[string, unknown]> = []
  const state = { suppressed: false, window: WINDOW as typeof WINDOW | undefined }
  let status: LinkStatus
  const ports: LinkStatusPorts = {
    show: (bounds, view) => { calls.push(['show', { bounds, view }]) },
    place: (bounds) => { calls.push(['place', bounds]) },
    send: (view) => { calls.push(['send', view]) },
    // What the host does when told to hide: it closes the overlay and says so.
    hide: () => { calls.push(['hide', undefined]); status.closed() },
    window: () => state.window,
    suppressed: () => state.suppressed
  }
  status = new LinkStatus(ports)
  return {
    status, calls, state,
    last: () => {
      const entry = [...calls].reverse().find(([name]) => name === 'show' || name === 'send')
      if (entry === undefined) return undefined
      return entry[0] === 'show' ? (entry[1] as { view: LinkStatusView }).view : entry[1] as LinkStatusView
    },
    names: () => calls.map(([name]) => name)
  }
}

const tab = (id: string, pane: LinkTab['pane'] = () => FULL): LinkTab => ({ id, pane })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('LinkStatus: showing', () => {
  it('shows at once for a link, in a place of no size until its page has measured the text', () => {
    const { status, calls, last } = rig()
    status.hovered(tab('a'), 'https://example.com/')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['show', { bounds: { x: 0, y: 776, width: 0, height: 0 }, view: last() }])
    expect(last()).toMatchObject({ text: 'https://example.com/', side: 'left', inset: { left: R, right: 0, bottom: R } })
  })

  it('takes its place when the page reports the width, and only then', () => {
    const { status, calls, last } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    const seq = last()?.seq ?? -1

    status.width(seq, 180)

    expect(calls.at(-1)).toEqual(['place', bubblePlace(FULL, WINDOW, 'left', 180)?.bounds])
  })

  it('clamps the width a page reports', () => {
    const { status, calls, last } = rig()
    status.hovered(tab('a'), 'https://example.com/')

    status.width(last()?.seq ?? -1, 100_000)
    expect((calls.at(-1)?.[1] as { width: number }).width).toBe(BUBBLE_MAX_WIDTH + R)
    status.width(last()?.seq ?? -1, -5)
    expect((calls.at(-1)?.[1] as { width: number }).width).toBe(BUBBLE_MIN_WIDTH + R)
  })

  it('ignores a width measured for a text that has since changed', () => {
    const { status, calls, last } = rig()
    status.hovered(tab('a'), 'https://one.example/')
    const old = last()?.seq ?? -1
    status.hovered(tab('a'), 'https://two.example/')
    const before = calls.length

    status.width(old, 400)

    expect(calls).toHaveLength(before)
  })

  it('ignores a width when nothing is shown', () => {
    const { status, calls } = rig()
    status.width(1, 200)
    expect(calls).toEqual([])
  })

  it('does nothing more for the same link reported again', () => {
    const { status, calls } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    const before = calls.length

    status.hovered(tab('a'), 'https://example.com/')

    expect(calls).toHaveLength(before)
  })

  it('swaps the text in place for another link: no new view, no hide', () => {
    const { status, names, last } = rig()
    status.hovered(tab('a'), 'https://one.example/')
    status.hovered(tab('a'), 'https://two.example/')

    expect(names()).toEqual(['show', 'send'])
    expect(last()?.text).toBe('https://two.example/')
  })

  it('numbers each text, so a late measurement cannot be taken for the newer one', () => {
    const { status, last } = rig()
    status.hovered(tab('a'), 'https://one.example/')
    const first = last()?.seq ?? 0
    status.hovered(tab('a'), 'https://two.example/')
    expect(last()?.seq).toBeGreaterThan(first)
  })

  it('cuts a very long address before it is sent anywhere', () => {
    const { status, last } = rig()
    status.hovered(tab('a'), `data:text/plain;base64,${'A'.repeat(5_000_000)}`)
    expect(last()?.text).toHaveLength(MAX_TEXT_LENGTH)
  })

  it('shows nothing for an address with no text', () => {
    const { status, calls } = rig()
    status.hovered(tab('a'), '')
    expect(calls).toEqual([])
  })
})

describe('LinkStatus: where it shows', () => {
  it('takes the corner of the pane of the tab the link is in', () => {
    const { status, calls, last } = rig()
    const right = { x: 604, y: 76, width: 596, height: 724 }
    status.hovered(tab('b', () => right), 'https://example.com/')
    status.width(last()?.seq ?? -1, 200)

    expect(calls.at(-1)).toEqual(['place', { x: 604, y: 776, width: 200, height: 30 }])
  })

  it('moves to the corner of the other pane when the pointer goes to a link there', () => {
    const { status, calls, last } = rig()
    const right = { x: 604, y: 76, width: 596, height: 724 }
    status.hovered(tab('a', () => ({ x: 0, y: 76, width: 596, height: 724 })), 'https://one.example/')
    status.width(last()?.seq ?? -1, 200)
    status.hovered(tab('b', () => right), 'https://two.example/')

    // At once it leaves the old corner, and only takes the new one when the text is measured.
    expect(calls.slice(-2).map(([name]) => name)).toEqual(['place', 'send'])
    expect(calls.at(-2)?.[1]).toMatchObject({ width: 0 })
    status.width(last()?.seq ?? -1, 220)
    expect(calls.at(-1)).toEqual(['place', { x: 604, y: 776, width: 220, height: 30 }])
  })

  it('shows nothing for a tab that is not on screen', () => {
    const { status, calls } = rig()
    status.hovered(tab('a', () => undefined), 'https://example.com/')
    expect(calls).toEqual([])
  })

  it('shows nothing in a pane too narrow, and hides one that is up', () => {
    const { status, names } = rig()
    status.hovered(tab('a'), 'https://one.example/')
    status.hovered(tab('b', () => ({ x: 0, y: 76, width: 50, height: 724 })), 'https://two.example/')
    expect(names()).toEqual(['show', 'hide'])
  })

  it('shows nothing while a page holds the whole screen', () => {
    const { status, calls, state } = rig()
    state.suppressed = true
    status.hovered(tab('a'), 'https://example.com/')
    expect(calls).toEqual([])
  })

  it('hides one that is up when a page takes the whole screen', () => {
    const { status, names, state } = rig()
    status.hovered(tab('a'), 'https://one.example/')
    state.suppressed = true
    status.hovered(tab('a'), 'https://two.example/')
    expect(names()).toEqual(['show', 'hide'])
  })

  it('shows nothing once the window is gone', () => {
    const { status, calls, state } = rig()
    state.window = undefined
    status.hovered(tab('a'), 'https://example.com/')
    expect(calls).toEqual([])
  })
})

describe('LinkStatus: hiding', () => {
  it('hides a moment after the pointer leaves the link, not at once', () => {
    const { status, names } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    status.hovered(tab('a'), '')

    vi.advanceTimersByTime(HIDE_DELAY_MS - 1)
    expect(names()).toEqual(['show'])
    vi.advanceTimersByTime(1)
    expect(names()).toEqual(['show', 'hide'])
  })

  it('keeps one bubble when the pointer goes to the next link within the delay', () => {
    const { status, names, last } = rig()
    status.hovered(tab('a'), 'https://one.example/')
    status.hovered(tab('a'), '')
    vi.advanceTimersByTime(HIDE_DELAY_MS / 2)
    status.hovered(tab('a'), 'https://two.example/')
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3)

    expect(names()).toEqual(['show', 'send'])
    expect(last()?.text).toBe('https://two.example/')
  })

  it('keeps one bubble when the same link is reported again within the delay', () => {
    const { status, names } = rig()
    status.hovered(tab('a'), 'https://one.example/')
    status.hovered(tab('a'), '')
    status.hovered(tab('a'), 'https://one.example/')
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3)
    expect(names()).toEqual(['show'])
  })

  it('is not hidden by the other pane losing the link it had', () => {
    const { status, names } = rig()
    status.hovered(tab('b'), 'https://two.example/')
    status.hovered(tab('a'), '')
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3)
    expect(names()).toEqual(['show'])
  })

  it('counts the delay once however often the page says the link is gone', () => {
    const { status, names } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    status.hovered(tab('a'), '')
    vi.advanceTimersByTime(HIDE_DELAY_MS - 10)
    status.hovered(tab('a'), '')
    vi.advanceTimersByTime(10)
    expect(names()).toEqual(['show', 'hide'])
  })

  it('shows again from the start after it hid', () => {
    const { status, names } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    status.hovered(tab('a'), '')
    vi.advanceTimersByTime(HIDE_DELAY_MS)
    status.hovered(tab('a'), 'https://example.com/')
    expect(names()).toEqual(['show', 'hide', 'show'])
  })

  it('hides at once when the tab it is about navigates or goes', () => {
    const { status, names } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    status.left('a')
    expect(names()).toEqual(['show', 'hide'])
  })

  it('leaves the bubble of another tab alone when a tab navigates', () => {
    const { status, names } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    status.left('b')
    expect(names()).toEqual(['show'])
  })

  it('has nothing pending once the host closed it', () => {
    const { status, names } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    status.hovered(tab('a'), '')
    status.closed()
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3)
    expect(names()).toEqual(['show'])
  })

  it('has nothing pending once disposed', () => {
    const { status, names } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    status.hovered(tab('a'), '')
    status.dispose()
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3)
    expect(names()).toEqual(['show'])
  })
})

describe('LinkStatus: getting out of the pointer\'s way', () => {
  function shownOnLeft (): Rig {
    const r = rig()
    r.status.hovered(tab('a'), 'https://example.com/')
    r.status.width(r.last()?.seq ?? -1, 200)
    return r
  }

  it('moves to the bottom-right corner when the pointer enters it', () => {
    const { status, calls, last } = shownOnLeft()
    status.pointerEntered()

    expect(calls.at(-2)).toEqual(['place', bubblePlace(FULL, WINDOW, 'right', 200)?.bounds])
    expect(last()).toMatchObject({ side: 'right', inset: { left: 0, right: R, bottom: R } })
  })

  it('ends up steadily on the right: the link is lost, the bubble moves, the link is hovered again', () => {
    const { status, names, calls, last } = shownOnLeft()

    status.hovered(tab('a'), '')
    status.pointerEntered()
    status.hovered(tab('a'), 'https://example.com/')
    vi.advanceTimersByTime(HIDE_DELAY_MS * 5)

    expect(names()).toEqual(['show', 'place', 'place', 'send'])
    expect(last()?.side).toBe('right')
    expect(calls.at(-2)?.[1]).toEqual(bubblePlace(FULL, WINDOW, 'right', 200)?.bounds)
    expect(status.isOpen()).toBe(true)
  })

  it('ends the same way when the pointer enters before the link is reported lost', () => {
    const { status, names, last } = shownOnLeft()

    status.pointerEntered()
    status.hovered(tab('a'), '')
    status.hovered(tab('a'), 'https://example.com/')
    vi.advanceTimersByTime(HIDE_DELAY_MS * 5)

    expect(names()).toEqual(['show', 'place', 'place', 'send'])
    expect(last()?.side).toBe('right')
    expect(status.isOpen()).toBe(true)
  })

  it('stays on the right for the next links, until it has hidden', () => {
    const { status, calls, last } = shownOnLeft()
    status.pointerEntered()
    status.hovered(tab('a'), 'https://two.example/')
    status.width(last()?.seq ?? -1, 150)

    expect(last()?.side).toBe('right')
    expect(calls.at(-1)).toEqual(['place', bubblePlace(FULL, WINDOW, 'right', 150)?.bounds])
  })

  it('goes back to the left corner for the next bubble once it has hidden', () => {
    const { status, last } = shownOnLeft()
    status.pointerEntered()
    status.hovered(tab('a'), '')
    vi.advanceTimersByTime(HIDE_DELAY_MS)
    status.hovered(tab('a'), 'https://two.example/')

    expect(last()?.side).toBe('left')
  })

  it('does nothing more when the pointer enters it on the right', () => {
    const { status, calls } = shownOnLeft()
    status.pointerEntered()
    const before = calls.length
    status.pointerEntered()
    expect(calls).toHaveLength(before)
  })

  it('waits for the width when the pointer enters before the text was measured', () => {
    const { status, calls, last } = rig()
    status.hovered(tab('a'), 'https://example.com/')
    status.pointerEntered()
    expect(calls.map(([name]) => name)).toEqual(['show', 'send'])

    status.width(last()?.seq ?? -1, 120)
    expect(calls.at(-1)).toEqual(['place', bubblePlace(FULL, WINDOW, 'right', 120)?.bounds])
  })

  it('ignores the pointer when nothing is shown', () => {
    const { status, calls } = rig()
    status.pointerEntered()
    expect(calls).toEqual([])
  })
})
