import { describe, expect, it } from 'vitest'
import { createStartupMarks, processAgeMs, STARTUP_LINE_PREFIX, STARTUP_MARKS, startupLine } from '../startup-marks.js'
import type { StartupClock } from '../startup-marks.js'

/** A clock the test moves: the wall clock and the monotonic one advance together, as they do in a real run. */
function fakeClock (createdAt: number | null, wallStart = 1_000_000, perfStart = 250): StartupClock & { advance: (ms: number) => void } {
  let moved = 0
  return {
    perfNow: () => perfStart + moved,
    wallNow: () => wallStart + moved,
    createdAt,
    advance: (ms) => { moved += ms }
  }
}

describe('createStartupMarks', () => {
  it('counts from the creation of the process: what had passed when it began, plus what passed since', () => {
    const clock = fakeClock(1_000_000 - 300)
    const marks = createStartupMarks(clock)
    clock.advance(120)
    marks.mark('entry')
    clock.advance(500)
    marks.mark('windowShown')
    const record = marks.record()
    expect(record.base).toBe('process-creation')
    expect(record.marks.entry).toBe(420)
    expect(record.marks.windowShown).toBe(920)
  })

  it('records whole milliseconds', () => {
    const clock = fakeClock(1_000_000 - 100)
    const marks = createStartupMarks(clock)
    clock.advance(10.6)
    marks.mark('entry')
    clock.advance(0.3)
    marks.hook({ name: 'a', phase: 'afterReady', ms: 2.5 })
    const record = marks.record()
    expect(record.marks.entry).toBe(111)
    expect(record.hooks).toEqual([{ name: 'a', phase: 'afterReady', ms: 3 }])
  })

  it('keeps the first reading of a mark, so code that runs for every window may mark without asking which', () => {
    const clock = fakeClock(1_000_000)
    const marks = createStartupMarks(clock)
    clock.advance(50)
    marks.mark('windowShown')
    clock.advance(900)
    marks.mark('windowShown')
    expect(marks.record().marks.windowShown).toBe(50)
  })

  it('lists every mark in a fixed order, a null for one not reached', () => {
    const marks = createStartupMarks(fakeClock(1_000_000))
    marks.mark('appReady')
    const { marks: read } = marks.record()
    expect(Object.keys(read)).toEqual([...STARTUP_MARKS])
    expect(read.appReady).toBe(0)
    expect(read.firstTabLoaded).toBeNull()
  })

  it('is complete once the window is shown, its chrome page has loaded and its first tab has loaded, and not before', () => {
    const marks = createStartupMarks(fakeClock(null))
    expect(marks.isComplete()).toBe(false)
    marks.mark('windowShown')
    expect(marks.isComplete()).toBe(false)
    marks.mark('chromeLoaded')
    expect(marks.isComplete()).toBe(false)
    marks.mark('firstTabLoaded')
    expect(marks.isComplete()).toBe(true)
    expect(marks.record().complete).toBe(true)
  })

  it('waits for the chrome page when the window was shown and the tab loaded first', () => {
    const marks = createStartupMarks(fakeClock(null))
    marks.mark('windowShown')
    marks.mark('firstTabLoaded')
    expect(marks.isComplete()).toBe(false)
    expect(marks.record().complete).toBe(false)
    marks.mark('chromeLoaded')
    expect(marks.isComplete()).toBe(true)
  })

  it('counts from the performance clock and says so when the system gives no creation time', () => {
    const clock = fakeClock(null, 1_000_000, 250)
    const marks = createStartupMarks(clock)
    clock.advance(40)
    marks.mark('entry')
    expect(marks.record().base).toBe('performance-origin')
    expect(marks.record().marks.entry).toBe(290)
  })

  it.each([['ahead of the wall clock', 1_000_000 + 5_000], ['hours behind it', 1_000_000 - 3 * 3_600_000]])('does not trust a creation time %s', (_label, createdAt) => {
    const clock = fakeClock(createdAt, 1_000_000, 250)
    const marks = createStartupMarks(clock)
    marks.mark('entry')
    expect(marks.record().base).toBe('performance-origin')
    expect(marks.record().marks.entry).toBe(250)
  })

  it('keeps the hooks in the order they ran, with their phase', () => {
    const marks = createStartupMarks(fakeClock(1_000_000))
    marks.hook({ name: 'diagnostics', phase: 'beforeReady', ms: 1 })
    marks.hook({ name: 'broker', phase: 'afterReady', ms: 40 })
    expect(marks.record().hooks.map(({ name, phase }) => `${phase}:${name}`)).toEqual(['beforeReady:diagnostics', 'afterReady:broker'])
  })

  it('carries the facts of the start, and is a snapshot: a mark after it is not in it', () => {
    const marks = createStartupMarks(fakeClock(1_000_000))
    marks.setFacts({ firstRun: true, electron: '44.0.0', app: '0.1.0', packaged: true })
    const before = marks.record()
    marks.mark('extensionsSeeded')
    expect(before.firstRun).toBe(true)
    expect(before.electron).toBe('44.0.0')
    expect(before.marks.extensionsSeeded).toBeNull()
    expect(marks.record().marks.extensionsSeeded).toBe(0)
  })
})

describe('startupLine', () => {
  it('is one line: the prefix a probe looks for and then the record as JSON, with the keys in a fixed order', () => {
    const marks = createStartupMarks(fakeClock(1_000_000))
    marks.setFacts({ firstRun: false, electron: '44.0.0', app: '0.1.0', packaged: false })
    marks.hook({ name: 'broker', phase: 'afterReady', ms: 40 })
    const line = startupLine(marks.record())
    expect(line.startsWith(STARTUP_LINE_PREFIX)).toBe(true)
    expect(STARTUP_LINE_PREFIX).toBe('[orivon][startup] ')
    expect(line).not.toContain('\n')
    const parsed = JSON.parse(line.slice(STARTUP_LINE_PREFIX.length)) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['schema', 'base', 'complete', 'firstRun', 'electron', 'app', 'packaged', 'marks', 'hooks'])
    expect(parsed['hooks']).toEqual([{ name: 'broker', phase: 'afterReady', ms: 40 }])
  })
})

describe('processAgeMs', () => {
  it('is how long ago the system created the process', () => {
    expect(processAgeMs({ wallNow: () => 1_000_300, createdAt: 1_000_000 })).toBe(300)
  })

  it('is null with no creation time, and for one ahead of the wall clock or more than ten minutes behind it', () => {
    expect(processAgeMs({ wallNow: () => 1_000_000, createdAt: null })).toBeNull()
    expect(processAgeMs({ wallNow: () => 1_000_000, createdAt: 1_000_001 })).toBeNull()
    expect(processAgeMs({ wallNow: () => 1_000_000 + 10 * 60_000 + 1, createdAt: 1_000_000 })).toBeNull()
  })
})
