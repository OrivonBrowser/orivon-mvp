import { describe, expect, it } from 'vitest'
import { CANCEL_WAIT_MS, DropSettler, planNativeDrop } from '../native-drag-plan.js'
import type { DragClock, DropReport, NativeOutcome } from '../native-drag-plan.js'

const A = 'window-a'
const B = 'window-b'

describe('planNativeDrop', () => {
  it.each<[string, DropReport<string> | null, boolean, NativeOutcome<string>]>([
    ['a drop on the source strip reorders it', { on: 'strip', window: A, index: 2 }, false, { kind: 'reorder', index: 2 }],
    ['a drop on another window\'s strip moves the tab there, at the slot', { on: 'strip', window: B, index: 1 }, false, { kind: 'move', window: B, index: 1 }],
    ['a drop the source strip took with nothing to do changes nothing', { on: 'strip', window: A, index: null }, false, { kind: 'none' }],
    ['a drop on the source page at a split edge splits', { on: 'page', window: A, zone: 'left' }, false, { kind: 'split', zone: 'left' }],
    ['a drop on the source page elsewhere opens a window', { on: 'page', window: A, zone: null }, false, { kind: 'window' }],
    ['a drop on another window\'s page opens a window', { on: 'page', window: B, zone: null }, false, { kind: 'window' }],
    ['a split edge of another window\'s page is no split', { on: 'page', window: B, zone: 'right' }, false, { kind: 'window' }],
    ['no drop opens a window', null, false, { kind: 'window' }],
    ['no drop after Escape changes nothing', null, true, { kind: 'none' }],
    ['a drop wins over a cancel', { on: 'strip', window: B, index: 0 }, true, { kind: 'move', window: B, index: 0 }]
  ])('%s', (_name, drop, cancelled, outcome) => {
    expect(planNativeDrop(A, drop, cancelled)).toEqual(outcome)
  })
})

function fakeClock (): DragClock & { elapse: (ms: number) => void, pending: () => number } {
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
    },
    pending: () => timers.length
  }
}

function settler () {
  const clock = fakeClock()
  const outcomes: Array<NativeOutcome<string>> = []
  const session = new DropSettler<string>(A, clock, (outcome) => outcomes.push(outcome))
  return { clock, outcomes, session }
}

describe('DropSettler', () => {
  it('waits for the drag to end, then acts on a drop it already has, with no wait', () => {
    const { clock, outcomes, session } = settler()
    session.dropped({ on: 'strip', window: B, index: 3 })
    expect(outcomes).toEqual([])
    session.end()
    expect(outcomes).toEqual([{ kind: 'move', window: B, index: 3 }])
    expect(clock.pending()).toBe(0)
  })

  it('takes a drop that arrives after the end, inside the wait', () => {
    const { clock, outcomes, session } = settler()
    session.end()
    clock.elapse(CANCEL_WAIT_MS - 1)
    session.dropped({ on: 'page', window: A, zone: 'bottom' })
    expect(outcomes).toEqual([{ kind: 'split', zone: 'bottom' }])
    clock.elapse(1000)
    expect(outcomes).toHaveLength(1)
  })

  it('opens a window when nothing was dropped and no cancel came within the wait', () => {
    const { clock, outcomes, session } = settler()
    session.end()
    clock.elapse(CANCEL_WAIT_MS - 1)
    expect(outcomes).toEqual([])
    clock.elapse(1)
    expect(outcomes).toEqual([{ kind: 'window' }])
  })

  it('changes nothing when Escape follows the end, and does not wait out the rest', () => {
    const { clock, outcomes, session } = settler()
    session.end()
    clock.elapse(150)
    session.cancel()
    expect(outcomes).toEqual([{ kind: 'none' }])
    expect(clock.pending()).toBe(0)
  })

  it('ignores an Escape before the drag ended, and one after a drop', () => {
    const early = settler()
    early.session.cancel()
    early.session.end()
    early.clock.elapse(CANCEL_WAIT_MS)
    expect(early.outcomes).toEqual([{ kind: 'window' }])

    const dropped = settler()
    dropped.session.dropped({ on: 'strip', window: A, index: 0 })
    dropped.session.end()
    dropped.session.cancel()
    expect(dropped.outcomes).toEqual([{ kind: 'reorder', index: 0 }])
  })

  it('keeps the first drop, and acts once', () => {
    const { outcomes, session } = settler()
    session.dropped({ on: 'strip', window: B, index: 1 })
    session.dropped({ on: 'strip', window: A, index: 4 })
    session.end()
    session.end()
    expect(outcomes).toEqual([{ kind: 'move', window: B, index: 1 }])
  })

  it('does nothing once disposed', () => {
    const { clock, outcomes, session } = settler()
    session.end()
    session.dispose()
    clock.elapse(CANCEL_WAIT_MS * 2)
    session.dropped({ on: 'strip', window: B, index: 1 })
    expect(outcomes).toEqual([])
  })
})
