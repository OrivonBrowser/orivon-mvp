import { describe, expect, it, vi } from 'vitest'
import { SHELL_EVENT_CHANNEL } from '../../channels.js'
import type { Catcher, CatcherHooks } from '../drop-catcher.js'
import { CANCEL_WAIT_MS } from '../native-drag-plan.js'
import type { DragClock, NativeOutcome } from '../native-drag-plan.js'
import { NativeTabDrag } from '../native-tab-drag.js'
import type { NativeDragOps } from '../native-tab-drag.js'
import type { ShellWindow } from '../window-registry.js'

function fakeClock (): DragClock & { elapse: (ms: number) => void } {
  let now = 0
  let timers: Array<{ at: number, fn: () => void }> = []
  return {
    after: (ms, fn) => {
      const timer = { at: now + ms, fn }
      timers.push(timer)
      return () => { timers = timers.filter((other) => other !== timer) }
    },
    elapse: (ms) => {
      now += ms
      const due = timers.filter((timer) => timer.at <= now)
      timers = timers.filter((timer) => timer.at > now)
      for (const timer of due) timer.fn()
    }
  }
}

interface FakeWindow { entry: ShellWindow, sent: unknown[], close: () => void, destroyed: () => boolean }

function fakeWindow (): FakeWindow {
  let destroyed = false
  const closers: Array<() => void> = []
  const sent: unknown[] = []
  const window = {
    isDestroyed: () => destroyed,
    once: (_event: string, fn: () => void) => { closers.push(fn) },
    removeListener: (_event: string, fn: () => void) => { closers.splice(0, closers.length, ...closers.filter((other) => other !== fn)) }
  }
  const chrome = { webContents: { isDestroyed: () => false, send: (channel: string, event: unknown) => { if (channel === SHELL_EVENT_CHANNEL) sent.push(event) } } }
  return {
    entry: { window, chrome } as unknown as ShellWindow,
    sent,
    close: () => { destroyed = true; for (const fn of [...closers]) fn() },
    destroyed: () => destroyed
  }
}

function setup (windowCount = 2) {
  const clock = fakeClock()
  const windows = Array.from({ length: windowCount }, fakeWindow)
  const catchers = new Map<ShellWindow, { hooks: CatcherHooks, log: string[] }>()
  const drag = new NativeTabDrag({
    windows: () => windows.filter((window) => !window.destroyed()).map((window) => window.entry),
    clock,
    catcher: (window, hooks) => {
      const log: string[] = []
      catchers.set(window, { hooks, log })
      const catcher: Catcher = {
        warm: () => { log.push('warm') },
        show: () => { log.push('show') },
        hide: () => { log.push('hide') },
        dispose: () => { log.push('dispose') }
      }
      return catcher
    },
    thumbnail: async () => 'data:image/png;base64,AA=='
  })
  const applied: Array<NativeOutcome<ShellWindow>> = []
  const previews: Array<string | null> = []
  const ops: NativeDragOps = {
    pinned: false,
    splitZone: (point) => point.x < 20 ? 'left' : null,
    setSplitPreview: (zone) => { previews.push(zone) },
    apply: (outcome) => { applied.push(outcome) }
  }
  const [a, b] = windows as [FakeWindow, FakeWindow]
  return { clock, windows, a, b, drag, catchers, applied, previews, ops, logOf: (window: FakeWindow) => catchers.get(window.entry)?.log ?? [] }
}

describe('NativeTabDrag', () => {
  it('puts a catcher over every window and tells the others the drag is on, then takes both away when it is over', () => {
    const { a, b, drag, ops, logOf } = setup()
    drag.start(a.entry, 'n1', { ...ops, pinned: true })

    expect(logOf(a)).toEqual(['show'])
    expect(logOf(b)).toEqual(['show'])
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([{ type: 'nativeTabDrag', on: true, pinned: true }])

    drag.dropped(b.entry, 'n1', 2, false)
    drag.ended(a.entry, 'n1')

    expect(logOf(a)).toEqual(['show', 'hide'])
    expect(logOf(b)).toEqual(['show', 'hide'])
    expect(b.sent.at(-1)).toEqual({ type: 'nativeTabDrag', on: false, pinned: false })
    expect(a.sent.at(-1)).toEqual({ type: 'nativeTabDrag', on: false, pinned: false })
  })

  it('moves the tab into the window whose strip took the drop, once the drag has ended', () => {
    const { a, b, drag, ops, applied } = setup()
    drag.start(a.entry, 'n1', ops)
    drag.dropped(b.entry, 'n1', 1, false)
    expect(applied).toEqual([])
    drag.ended(a.entry, 'n1')
    expect(applied).toEqual([{ kind: 'move', window: b.entry, index: 1 }])
  })

  it('reorders when the source\'s own strip took the drop', () => {
    const { a, drag, ops, applied } = setup()
    drag.start(a.entry, 'n1', ops)
    drag.dropped(a.entry, 'n1', 0, false)
    drag.ended(a.entry, 'n1')
    expect(applied).toEqual([{ kind: 'reorder', index: 0 }])
  })

  it('shows the split edge under the source catcher\'s pointer, and takes it away when the pointer leaves', () => {
    const { a, b, drag, ops, catchers, previews } = setup()
    drag.start(a.entry, 'n1', ops)

    catchers.get(a.entry)?.hooks.over({ x: 5, y: 200 })
    catchers.get(a.entry)?.hooks.over({ x: 300, y: 200 })
    catchers.get(a.entry)?.hooks.leave()
    catchers.get(b.entry)?.hooks.over({ x: 5, y: 200 })

    expect(previews).toEqual(['left', null, null])
  })

  it('splits when the source catcher took the drop at an edge, and opens a window anywhere else on any page', () => {
    const edge = setup()
    edge.drag.start(edge.a.entry, 'n1', edge.ops)
    edge.catchers.get(edge.a.entry)?.hooks.drop('n1', { x: 5, y: 100 })
    edge.drag.ended(edge.a.entry, 'n1')
    expect(edge.applied).toEqual([{ kind: 'split', zone: 'left' }])
    expect(edge.previews.at(-1)).toBeNull()

    const middle = setup()
    middle.drag.start(middle.a.entry, 'n1', middle.ops)
    middle.catchers.get(middle.a.entry)?.hooks.drop('n1', { x: 400, y: 100 })
    middle.drag.ended(middle.a.entry, 'n1')
    expect(middle.applied).toEqual([{ kind: 'window' }])

    const other = setup()
    other.drag.start(other.a.entry, 'n1', other.ops)
    other.catchers.get(other.b.entry)?.hooks.drop('n1', { x: 5, y: 100 })
    other.drag.ended(other.a.entry, 'n1')
    expect(other.applied).toEqual([{ kind: 'window' }])
  })

  it('opens a window of its own when the drag ends over nothing, after the wait for a cancel', () => {
    const { a, clock, drag, ops, applied } = setup()
    drag.start(a.entry, 'n1', ops)
    drag.ended(a.entry, 'n1')
    clock.elapse(CANCEL_WAIT_MS - 1)
    expect(applied).toEqual([])
    clock.elapse(1)
    expect(applied).toEqual([{ kind: 'window' }])
  })

  it('changes nothing when Escape follows the end', () => {
    const { a, clock, drag, ops, applied, logOf } = setup()
    drag.start(a.entry, 'n1', ops)
    drag.ended(a.entry, 'n1')
    clock.elapse(150)
    drag.cancelled(a.entry, 'n1')
    clock.elapse(1000)
    expect(applied).toEqual([{ kind: 'none' }])
    expect(logOf(a).at(-1)).toBe('hide')
  })

  it('hears only the drag it is in, from the window it began in for the end and the cancel', () => {
    const { a, b, clock, drag, ops, applied } = setup()
    drag.start(a.entry, 'n1', ops)

    drag.dropped(b.entry, 'old-drag', 1, false)
    drag.ended(b.entry, 'n1')
    drag.ended(a.entry, 'old-drag')
    clock.elapse(CANCEL_WAIT_MS * 2)
    expect(applied).toEqual([])

    drag.ended(a.entry, 'n1')
    clock.elapse(CANCEL_WAIT_MS)
    expect(applied).toEqual([{ kind: 'window' }])
  })

  it('lets a drop over the chrome below the strip and toolbar be a window of its own', () => {
    const { a, b, drag, ops, applied } = setup()
    drag.start(a.entry, 'n1', ops)
    drag.dropped(b.entry, 'n1', null, true)
    drag.ended(a.entry, 'n1')
    expect(applied).toEqual([{ kind: 'window' }])
  })

  it('does nothing about a drag whose source window closed', () => {
    const { a, b, clock, drag, ops, applied, logOf } = setup()
    drag.start(a.entry, 'n1', ops)
    a.close()
    drag.dropped(b.entry, 'n1', 1, false)
    drag.ended(a.entry, 'n1')
    clock.elapse(CANCEL_WAIT_MS * 2)
    expect(applied).toEqual([])
    expect(logOf(b).at(-1)).toBe('hide')
    expect(logOf(a).at(-1)).toBe('dispose')
  })

  it('drops an unfinished drag when another begins', () => {
    const { a, b, drag, ops, applied } = setup()
    drag.start(a.entry, 'n1', ops)
    drag.start(b.entry, 'n2', ops)
    drag.dropped(a.entry, 'n1', 0, false)
    drag.ended(a.entry, 'n1')
    drag.dropped(a.entry, 'n2', 3, false)
    drag.ended(b.entry, 'n2')
    expect(applied).toEqual([{ kind: 'move', window: a.entry, index: 3 }])
  })

  it('gets every window\'s catcher ready ahead of a drag, and answers a press with the thumbnail', async () => {
    const { a, b, drag, logOf } = setup()
    drag.warm()
    expect(logOf(a)).toEqual(['warm'])
    expect(logOf(b)).toEqual(['warm'])
    expect(await drag.thumbnail(a.entry, 't1')).toBe('data:image/png;base64,AA==')
  })

  it('makes a catcher once per window', () => {
    const made = vi.fn()
    const window = fakeWindow()
    const drag = new NativeTabDrag({
      windows: () => [window.entry],
      clock: fakeClock(),
      catcher: () => { made(); return { warm: vi.fn(), show: vi.fn(), hide: vi.fn(), dispose: vi.fn() } },
      thumbnail: async () => null
    })
    drag.warm()
    drag.warm()
    expect(made).toHaveBeenCalledTimes(1)
  })
})
