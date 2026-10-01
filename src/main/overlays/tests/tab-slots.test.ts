import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import { createTabSlots, MAX_WAITING, type SlotAsk, type SlotCloseReason, type TabSlots } from '../tab-slots.js'

interface FakeWindow {
  window: ShellWindow
  shows: Array<{ overlay: string, anchor: unknown, payload: unknown }>
  closes: string[]
  activate: (tabId: string) => void
}

function fakeWindow (active = 'a'): FakeWindow {
  let activeTabId = active
  const shows: FakeWindow['shows'] = []
  const closes: string[] = []
  const window = {
    tabs: { getState: () => ({ activeTabId }) },
    overlays: {
      show: (overlay: string, anchor?: unknown, payload?: unknown) => { shows.push({ overlay, anchor, payload }) },
      close: (overlay?: string) => { if (overlay !== undefined) closes.push(overlay) }
    }
  } as unknown as ShellWindow
  return { window, shows, closes, activate: (tabId) => { activeTabId = tabId } }
}

/** Runs deferred work by hand, so a test chooses when the window's own tab-switch close has run. */
function slotsWithQueue (): { slots: TabSlots, flush: () => void } {
  const queue: Array<() => void> = []
  return { slots: createTabSlots((run) => { queue.push(run) }), flush: () => { for (const run of queue.splice(0)) run() } }
}

function ask (fake: FakeWindow, overrides: Partial<SlotAsk> = {}): { ask: SlotAsk, closed: Array<SlotCloseReason> } {
  const closed: SlotCloseReason[] = []
  return { ask: { window: fake.window, tabId: 'a', slot: 'address', overlay: 'site-prompt', payload: { n: 1 }, closed: (reason) => { closed.push(reason) }, ...overrides }, closed }
}

describe('requestSlot', () => {
  it('shows an ask for the active tab at once, with its anchor and payload', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const first = ask(fake, { anchor: () => ({ x: 1, y: 2, width: 3, height: 4 }) })
    slots.requestSlot(first.ask)
    expect(fake.shows).toEqual([{ overlay: 'site-prompt', anchor: { x: 1, y: 2, width: 3, height: 4 }, payload: { n: 1 } }])
  })

  it('shows an ask for a tab in the background only when that tab comes to the front', () => {
    const { slots, flush } = slotsWithQueue()
    const fake = fakeWindow('a')
    slots.requestSlot(ask(fake, { tabId: 'b' }).ask)
    expect(fake.shows).toEqual([])
    fake.activate('b')
    slots.tabActivated(fake.window, 'b')
    expect(fake.shows).toEqual([])
    flush()
    expect(fake.shows).toHaveLength(1)
  })

  it('shows the first ask and queues the second behind it, in order', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const one = ask(fake, { payload: 1 })
    const two = ask(fake, { payload: 2 })
    slots.requestSlot(one.ask)
    slots.requestSlot(two.ask)
    expect(fake.shows.map((s) => s.payload)).toEqual([1])
    slots.slotClosed(fake.window, 'site-prompt', 'request')
    expect(one.closed).toEqual(['request'])
    expect(fake.shows.map((s) => s.payload)).toEqual([1, 2])
    expect(two.closed).toEqual([])
  })

  it('ends a fifth ask of one slot with queue-full, at once and once', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const asks = Array.from({ length: MAX_WAITING + 2 }, (_, i) => ask(fake, { payload: i }))
    for (const each of asks) slots.requestSlot(each.ask)
    expect(asks.map((each) => each.closed)).toEqual([[], [], [], [], ['queue-full']])
  })

  it('counts the two slots of a tab, and two tabs, separately', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const others = [ask(fake, { slot: 'center', overlay: 'https-warning' }), ask(fake, { tabId: 'b' })]
    for (let i = 0; i <= MAX_WAITING; i++) slots.requestSlot(ask(fake).ask)
    for (const each of others) slots.requestSlot(each.ask)
    expect(others.map((each) => each.closed)).toEqual([[], []])
  })

  it('shows one surface per tab at a time, the sheet before the prompt, and the prompt after the sheet closes', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const prompt = ask(fake)
    const sheet = ask(fake, { slot: 'center', overlay: 'https-warning' })
    slots.requestSlot(prompt.ask)
    slots.requestSlot(sheet.ask)
    expect(fake.shows.map((s) => s.overlay)).toEqual(['site-prompt'])
    slots.slotClosed(fake.window, 'site-prompt', 'request')
    expect(fake.shows.map((s) => s.overlay)).toEqual(['site-prompt', 'https-warning'])
    slots.slotClosed(fake.window, 'https-warning', 'request')
    expect(sheet.closed).toEqual(['request'])
  })

  it('reads the anchor again when a waiting ask finally shows', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    let x = 10
    slots.requestSlot(ask(fake).ask)
    slots.requestSlot(ask(fake, { anchor: () => ({ x, y: 0, width: 1, height: 1 }) }).ask)
    x = 99
    slots.slotClosed(fake.window, 'site-prompt', 'request')
    expect(fake.shows.at(-1)?.anchor).toEqual({ x: 99, y: 0, width: 1, height: 1 })
  })
})

describe('slotClosed', () => {
  it('keeps the ask on a tab switch and shows it again when its tab is activated', () => {
    const { slots, flush } = slotsWithQueue()
    const fake = fakeWindow()
    const one = ask(fake)
    slots.requestSlot(one.ask)
    fake.activate('b')
    slots.slotClosed(fake.window, 'site-prompt', 'tab-switch')
    expect(one.closed).toEqual([])
    fake.activate('a')
    slots.tabActivated(fake.window, 'a')
    flush()
    expect(fake.shows).toHaveLength(2)
    expect(one.closed).toEqual([])
  })

  it.each(['escape', 'blur', 'navigation', 'layout', 'request'] as const)('ends the ask on %s and shows the next', (reason) => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const one = ask(fake)
    const two = ask(fake)
    slots.requestSlot(one.ask)
    slots.requestSlot(two.ask)
    slots.slotClosed(fake.window, 'site-prompt', reason)
    expect(one.closed).toEqual([reason])
    expect(fake.shows).toHaveLength(2)
  })

  it('ends a pushed-out ask, but leaves the next to show later rather than push out what replaced it', () => {
    const { slots, flush } = slotsWithQueue()
    const fake = fakeWindow()
    const one = ask(fake)
    const two = ask(fake)
    slots.requestSlot(one.ask)
    slots.requestSlot(two.ask)
    slots.slotClosed(fake.window, 'site-prompt', 'replaced')
    expect(one.closed).toEqual(['replaced'])
    expect(fake.shows).toHaveLength(1)
    slots.tabActivated(fake.window, 'a')
    flush()
    expect(fake.shows).toHaveLength(2)
  })

  it('does not show anything once the window is closing', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    slots.requestSlot(ask(fake).ask)
    slots.requestSlot(ask(fake).ask)
    slots.slotClosed(fake.window, 'site-prompt', 'window-closed')
    expect(fake.shows).toHaveLength(1)
  })

  it('ignores an overlay it is not showing', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const one = ask(fake)
    slots.requestSlot(one.ask)
    slots.slotClosed(fake.window, 'menu', 'request')
    slots.slotClosed(fakeWindow().window, 'site-prompt', 'request')
    expect(one.closed).toEqual([])
  })

  it('calls closed exactly once, however often the overlay reports', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const one = ask(fake)
    slots.requestSlot(one.ask)
    slots.slotClosed(fake.window, 'site-prompt', 'request')
    slots.slotClosed(fake.window, 'site-prompt', 'escape')
    expect(one.closed).toEqual(['request'])
  })
})

describe('tabClosed', () => {
  it('ends every ask of the tab with tab-closed and closes what it was showing', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const asks = [ask(fake), ask(fake), ask(fake, { slot: 'center', overlay: 'https-warning' })]
    for (const each of asks) slots.requestSlot(each.ask)
    slots.tabClosed(fake.window, 'a')
    expect(asks.map((each) => each.closed)).toEqual([['tab-closed'], ['tab-closed'], ['tab-closed']])
    expect(fake.closes).toEqual(['site-prompt'])
  })

  it('leaves the asks of other tabs alone, and does nothing for a tab with none', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow('a')
    const other = ask(fake, { tabId: 'b' })
    slots.requestSlot(other.ask)
    slots.tabClosed(fake.window, 'a')
    slots.tabClosed(fake.window, 'never-asked')
    expect(other.closed).toEqual([])
  })

  it('ends once even if the closed overlay reports back', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const one = ask(fake)
    slots.requestSlot(one.ask)
    fake.window.overlays.close = (overlay) => { slots.slotClosed(fake.window, overlay ?? '', 'request') }
    slots.tabClosed(fake.window, 'a')
    expect(one.closed).toEqual(['tab-closed'])
  })
})

describe('cancel', () => {
  it('withdraws a waiting ask without showing it', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    slots.requestSlot(ask(fake).ask)
    const waiting = ask(fake)
    const handle = slots.requestSlot(waiting.ask)
    handle.cancel()
    handle.cancel()
    expect(waiting.closed).toEqual(['request'])
    slots.slotClosed(fake.window, 'site-prompt', 'request')
    expect(fake.shows).toHaveLength(1)
  })

  it('closes the overlay of a shown ask and moves on to the next', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const one = ask(fake)
    const two = ask(fake)
    const handle = slots.requestSlot(one.ask)
    slots.requestSlot(two.ask)
    handle.cancel()
    expect(fake.closes).toEqual(['site-prompt'])
    expect(one.closed).toEqual(['request'])
    expect(fake.shows).toHaveLength(2)
  })
})

describe('a failing overlay', () => {
  it('ends an ask whose show throws, and tries the next', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      let first = true
      fake.window.overlays.show = (overlay, _anchor, payload) => {
        if (first) { first = false; throw new Error('no such overlay') }
        fake.shows.push({ overlay, anchor: undefined, payload })
      }
      const one = ask(fake, { payload: 1 })
      const two = ask(fake, { payload: 2 })
      slots.requestSlot(one.ask)
      slots.requestSlot(two.ask)
      expect(one.closed).toEqual(['request'])
      expect(fake.shows.map((s) => s.payload)).toEqual([2])
    } finally {
      error.mockRestore()
    }
  })

  it('logs a closed hook that throws and still runs the rest', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      slots.requestSlot(ask(fake, { closed: () => { throw new Error('boom') } }).ask)
      const two = ask(fake)
      slots.requestSlot(two.ask)
      slots.slotClosed(fake.window, 'site-prompt', 'request')
      expect(fake.shows).toHaveLength(2)
    } finally {
      error.mockRestore()
    }
  })
})

describe('hasAsk', () => {
  it('is true for a tab with an ask shown or waiting, and false once it has ended', () => {
    const { slots, flush } = slotsWithQueue()
    const fake = fakeWindow('a')
    expect(slots.hasAsk(fake.window, 'b')).toBe(false)

    const waiting = slots.requestSlot(ask(fake, { tabId: 'b' }).ask)
    expect(slots.hasAsk(fake.window, 'b')).toBe(true)
    expect(slots.hasAsk(fake.window, 'a')).toBe(false)

    const shown = slots.requestSlot(ask(fake).ask)
    expect(slots.hasAsk(fake.window, 'a')).toBe(true)

    waiting.cancel()
    shown.cancel()
    flush()
    expect(slots.hasAsk(fake.window, 'a')).toBe(false)
    expect(slots.hasAsk(fake.window, 'b')).toBe(false)
  })
})
