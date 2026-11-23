import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STARTUP_LINE_PREFIX } from '../startup-marks.js'

/** Each test gets a fresh runner: it keeps one record and one "printed" flag for the life of the process. */
async function freshRunner (): Promise<typeof import('../startup-marks-runner.js')> {
  vi.resetModules()
  return await import('../startup-marks-runner.js')
}

interface ParsedLine { readonly complete: boolean, readonly firstRun: boolean, readonly marks: Record<string, number | null>, readonly hooks: unknown[] }

describe('the start-up line', () => {
  let printed: string[]

  const lines = (): ParsedLine[] => printed.filter((line) => line.startsWith(STARTUP_LINE_PREFIX)).map((line) => JSON.parse(line.slice(STARTUP_LINE_PREFIX.length)) as ParsedLine)

  beforeEach(() => {
    printed = []
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { printed.push(String(line)) })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is printed once, when the window is shown and its chrome page and first tab have loaded', async () => {
    const runner = await freshRunner()
    runner.describeStartup({ firstRun: true, electron: '44.0.0', app: '0.1.0', packaged: false })
    runner.noteStartupHook('broker', 'afterReady', 12)
    runner.markStartup('entry')
    runner.markStartup('windowShown')
    runner.markStartup('firstTabLoaded')
    expect(lines()).toEqual([])
    runner.markStartup('chromeLoaded')
    runner.markStartup('windowShown')
    expect(printed.filter((line) => line.startsWith(STARTUP_LINE_PREFIX))).toHaveLength(1)
    const [record] = lines()
    expect(record?.complete).toBe(true)
    expect(record?.firstRun).toBe(true)
    expect(record?.marks['entry']).toEqual(expect.any(Number))
    expect(record?.marks['extensionsSeeded']).toBeNull()
    expect(record?.hooks).toEqual([{ name: 'broker', phase: 'afterReady', ms: 12 }])
  })

  it('is printed at the cap with what exists when the first tab never loads, and not a second time', async () => {
    const runner = await freshRunner()
    runner.markStartup('entry')
    runner.printStartupLineAtCap()
    vi.advanceTimersByTime(59_000)
    expect(lines()).toEqual([])
    vi.advanceTimersByTime(2_000)
    expect(lines().map(({ complete }) => complete)).toEqual([false])
    runner.markStartup('windowShown')
    runner.markStartup('chromeLoaded')
    runner.markStartup('firstTabLoaded')
    expect(lines()).toHaveLength(1)
  })

  it('leaves a mark reached after the line in the record a report carries', async () => {
    const runner = await freshRunner()
    runner.markStartup('windowShown')
    runner.markStartup('chromeLoaded')
    runner.markStartup('firstTabLoaded')
    expect(runner.startupRecord().marks.extensionsSeeded).toBeNull()
    runner.markStartup('extensionsSeeded')
    expect(runner.startupRecord().marks.extensionsSeeded).toEqual(expect.any(Number))
  })

  it('tells a listener once the line has printed, never before, and at once when it printed already', async () => {
    const runner = await freshRunner()
    const told: string[] = []
    runner.onStartupLine(() => { told.push('early') })
    runner.markStartup('windowShown')
    runner.markStartup('chromeLoaded')
    expect(told).toEqual([])
    runner.markStartup('firstTabLoaded')
    expect(told).toEqual(['early'])
    runner.onStartupLine(() => { told.push('late') })
    runner.markStartup('entry')
    expect(told).toEqual(['early', 'late'])
  })

  it('goes on past a listener that throws: the line still printed and the other listeners are told', async () => {
    const runner = await freshRunner()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const told: string[] = []
    runner.onStartupLine(() => { throw new Error('boom') })
    runner.onStartupLine(() => { told.push('second') })
    runner.markStartup('windowShown')
    runner.markStartup('chromeLoaded')
    expect(() => { runner.markStartup('firstTabLoaded') }).not.toThrow()
    expect(lines()).toHaveLength(1)
    expect(told).toEqual(['second'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(() => { runner.onStartupLine(() => { throw new Error('late boom') }) }).not.toThrow()
  })

  it('never keeps the process alive for its cap timer', async () => {
    const runner = await freshRunner()
    const set = vi.spyOn(globalThis, 'setTimeout')
    runner.printStartupLineAtCap()
    const timer = set.mock.results[0]?.value as { hasRef: () => boolean }
    expect(timer.hasRef()).toBe(false)
  })
})
