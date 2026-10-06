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

describe('anchorsMoved', () => {
  it('places each shown ask under its anchor as it is now, and leaves an ask with no anchor where it is', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const reanchors: Array<[string, unknown]> = []
    ;(fake.window.overlays as unknown as { reanchor: (name: string, anchor: unknown) => void }).reanchor = (name, anchor) => { reanchors.push([name, anchor]) }
    let x = 1
    slots.requestSlot(ask(fake, { anchor: () => ({ x, y: 2, width: 3, height: 4 }) }).ask)
    slots.requestSlot(ask(fake, { slot: 'center', overlay: 'sheet' }).ask)
    x = 50
    slots.anchorsMoved(fake.window)
    expect(reanchors).toEqual([['site-prompt', { x: 50, y: 2, width: 3, height: 4 }]])
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

describe('the backdrop behind a sheet', () => {
  function withBackdrop (): { slots: TabSlots, calls: string[] } {
    const calls: string[] = []
    const backdrop = { raise: (_w: ShellWindow, tabId: string) => { calls.push(`raise ${tabId}`) }, lower: (_w: ShellWindow, tabId: string) => { calls.push(`lower ${tabId}`) } }
    return { slots: createTabSlots((run) => { run() }, () => backdrop), calls }
  }

  it('is raised while a sheet is shown over the tab and lowered when it ends', () => {
    const { slots, calls } = withBackdrop()
    const fake = fakeWindow()
    slots.requestSlot(ask(fake, { slot: 'center', overlay: 'cert-error' }).ask)
    expect(calls).toEqual(['raise a'])
    slots.slotClosed(fake.window, 'cert-error', 'request')
    expect(calls).toEqual(['raise a', 'lower a'])
  })

  it('is lowered between two queued sheets and raised again for the next, and not touched by a prompt', () => {
    const { slots, calls } = withBackdrop()
    const fake = fakeWindow()
    slots.requestSlot(ask(fake, { slot: 'center', overlay: 'one' }).ask)
    slots.requestSlot(ask(fake, { slot: 'center', overlay: 'two' }).ask)
    slots.slotClosed(fake.window, 'one', 'request')
    expect(calls).toEqual(['raise a', 'lower a', 'raise a'])
    const prompts = withBackdrop()
    prompts.slots.requestSlot(ask(fake, { slot: 'address' }).ask)
    expect(prompts.calls).toEqual([])
  })

  it('is lowered when the tab goes to the background and raised when it comes back', () => {
    const { slots, calls } = withBackdrop()
    const fake = fakeWindow()
    slots.requestSlot(ask(fake, { slot: 'center', overlay: 'cert-error' }).ask)
    slots.slotClosed(fake.window, 'cert-error', 'tab-switch')
    expect(calls).toEqual(['raise a', 'lower a'])
    slots.tabActivated(fake.window, 'a')
    expect(calls).toEqual(['raise a', 'lower a', 'raise a'])
  })
})

describe('a cover', () => {
  const coverAsk = (fake: FakeWindow, overrides: Partial<SlotAsk> = {}): ReturnType<typeof ask> => ask(fake, { slot: 'cover', overlay: 'loading-screen', payload: { url: 'u1' }, ...overrides })

  it('shows for the active tab at once and for a background tab when it comes to the front', () => {
    const { slots, flush } = slotsWithQueue()
    const fake = fakeWindow('a')
    slots.requestSlot(coverAsk(fake).ask)
    slots.requestSlot(coverAsk(fake, { tabId: 'b', payload: { url: 'u2' } }).ask)
    expect(fake.shows.map((s) => s.payload)).toEqual([{ url: 'u1' }])
    fake.activate('b')
    slots.tabActivated(fake.window, 'b')
    flush()
    expect(fake.shows.map((s) => s.payload)).toEqual([{ url: 'u1' }, { url: 'u2' }])
  })

  it('is shown beside the tab\'s head ask and before it, so it lies under it', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    slots.requestSlot(ask(fake, { slot: 'center', overlay: 'sheet' }).ask)
    slots.requestSlot(coverAsk(fake).ask)
    expect(fake.shows.map((s) => s.overlay)).toEqual(['sheet', 'loading-screen'])
    slots.slotClosed(fake.window, 'sheet', 'request')
    expect(fake.shows.map((s) => s.overlay)).toEqual(['sheet', 'loading-screen'])
  })

  it('shows before a head ask that was waiting for the tab', () => {
    const { slots, flush } = slotsWithQueue()
    const fake = fakeWindow('a')
    slots.requestSlot(ask(fake, { tabId: 'b', slot: 'center', overlay: 'sheet' }).ask)
    slots.requestSlot(coverAsk(fake, { tabId: 'b' }).ask)
    fake.activate('b')
    slots.tabActivated(fake.window, 'b')
    flush()
    expect(fake.shows.map((s) => s.overlay)).toEqual(['loading-screen', 'sheet'])
  })

  it('ends the older cover of a tab with replaced and shows the new payload in the same overlay', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const first = coverAsk(fake)
    const second = coverAsk(fake, { payload: { url: 'u2' } })
    slots.requestSlot(first.ask)
    slots.requestSlot(second.ask)
    expect(first.closed).toEqual(['replaced'])
    expect(second.closed).toEqual([])
    expect(fake.shows.map((s) => s.payload)).toEqual([{ url: 'u1' }, { url: 'u2' }])
    expect(fake.closes).toEqual([])
    slots.slotClosed(fake.window, 'loading-screen', 'request')
    expect(second.closed).toEqual(['request'])
  })

  it('is hidden by a tab switch, kept, and shown again when its tab is activated', () => {
    const { slots, flush } = slotsWithQueue()
    const fake = fakeWindow('a')
    const mine = coverAsk(fake)
    slots.requestSlot(mine.ask)
    fake.activate('b')
    slots.slotClosed(fake.window, 'loading-screen', 'tab-switch')
    expect(mine.closed).toEqual([])
    fake.activate('a')
    slots.tabActivated(fake.window, 'a')
    flush()
    expect(fake.shows).toHaveLength(2)
  })

  it('ends when its overlay closes for any other reason, and a later one shows afresh', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const first = coverAsk(fake)
    slots.requestSlot(first.ask)
    slots.slotClosed(fake.window, 'loading-screen', 'request')
    expect(first.closed).toEqual(['request'])
    slots.requestSlot(coverAsk(fake).ask)
    expect(fake.shows).toHaveLength(2)
  })

  it('is closed by cancel, once, and a cancel of a cover that never showed shows nothing', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow('a')
    const shown = coverAsk(fake)
    const handle = slots.requestSlot(shown.ask)
    handle.cancel()
    handle.cancel()
    expect(fake.closes).toEqual(['loading-screen'])
    expect(shown.closed).toEqual(['request'])

    const waiting = coverAsk(fake, { tabId: 'b' })
    slots.requestSlot(waiting.ask).cancel()
    expect(waiting.closed).toEqual(['request'])
    expect(fake.closes).toEqual(['loading-screen'])
    expect(fake.shows).toHaveLength(1)
  })

  it('ends tab-closed with the tab, and closes its overlay', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const mine = coverAsk(fake)
    slots.requestSlot(mine.ask)
    slots.tabClosed(fake.window, 'a')
    expect(mine.closed).toEqual(['tab-closed'])
    expect(fake.closes).toEqual(['loading-screen'])
  })

  it('is not an ask whose loss would cost an answer: hasAsk stays false for a tab with only a cover', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    slots.requestSlot(coverAsk(fake).ask)
    expect(slots.hasAsk(fake.window, 'a')).toBe(false)
    slots.requestSlot(ask(fake, { slot: 'center', overlay: 'sheet' }).ask)
    expect(slots.hasAsk(fake.window, 'a')).toBe(true)
  })

  it('does not raise or lower the sheet backdrop', () => {
    const raise = vi.fn()
    const lower = vi.fn()
    const slots = createTabSlots(queueMicrotask, () => ({ raise, lower }))
    const fake = fakeWindow()
    const mine = coverAsk(fake)
    slots.requestSlot(mine.ask)
    slots.slotClosed(fake.window, 'loading-screen', 'request')
    expect(raise).not.toHaveBeenCalled()
    expect(lower).not.toHaveBeenCalled()
  })

  it('ends an ask whose show throws, without shadowing the tab\'s other asks', () => {
    const { slots } = slotsWithQueue()
    const fake = fakeWindow()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const original = fake.window.overlays.show.bind(fake.window.overlays)
    ;(fake.window.overlays as { show: unknown }).show = (overlay: string, ...rest: unknown[]) => {
      if (overlay === 'loading-screen') throw new Error('boom')
      original(overlay, ...(rest as []))
    }
    const mine = coverAsk(fake)
    const sheet = ask(fake, { slot: 'center', overlay: 'sheet' })
    slots.requestSlot(mine.ask)
    slots.requestSlot(sheet.ask)
    expect(mine.closed).toEqual(['request'])
    expect(fake.shows.map((s) => s.overlay)).toEqual(['sheet'])
    error.mockRestore()
  })
})
