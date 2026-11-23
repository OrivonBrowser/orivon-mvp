import { afterEach, describe, expect, it, vi } from 'vitest'
import { AFTER_START_DELAY_MS, afterStart, runAfterStart } from '../after-start.js'
import type { Schedule } from '../after-start.js'

afterEach(() => { vi.restoreAllMocks() })

describe('afterStart', () => {
  it('runs nothing where it is called, and the tasks once, AFTER_START_DELAY_MS later', () => {
    const task = vi.fn()
    const scheduled: Array<{ run: () => void, delayMs: number }> = []
    const schedule: Schedule = (run, delayMs) => { scheduled.push({ run, delayMs }) }
    afterStart([{ name: 'one', run: task }], schedule)
    expect(task).not.toHaveBeenCalled()
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([AFTER_START_DELAY_MS])
    scheduled[0]?.run()
    expect(task).toHaveBeenCalledOnce()
  })

  it('lets the process end without waiting for the timer', () => {
    const unref = vi.fn()
    const timer = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as never)
    afterStart([{ name: 'one', run: () => {} }])
    expect(timer).toHaveBeenCalledWith(expect.any(Function), AFTER_START_DELAY_MS)
    expect(unref).toHaveBeenCalledOnce()
  })
})

describe('runAfterStart', () => {
  it('runs the tasks in order, each after the one before has ended', async () => {
    const log: string[] = []
    await runAfterStart([
      { name: 'slow', run: async () => { log.push('slow starts'); await new Promise<void>((resolve) => { setTimeout(resolve, 5) }); log.push('slow ends') } },
      { name: 'quick', run: () => { log.push('quick') } }
    ])
    expect(log).toEqual(['slow starts', 'slow ends', 'quick'])
  })

  it('serves the event loop between two tasks', async () => {
    const log: string[] = []
    await runAfterStart([
      { name: 'first', run: () => { log.push('first'); setImmediate(() => { log.push('a turn between') }) } },
      { name: 'second', run: () => { log.push('second') } }
    ])
    expect(log).toEqual(['first', 'a turn between', 'second'])
  })

  it('logs a task that throws or rejects by name and still runs the ones after it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const later = vi.fn()
    await runAfterStart([
      { name: 'throws', run: () => { throw new Error('boom') } },
      { name: 'rejects', run: async () => { throw new Error('refused') } },
      { name: 'fine', run: later }
    ])
    expect(later).toHaveBeenCalledOnce()
    expect(error.mock.calls.map((call) => String(call[0]))).toEqual([expect.stringContaining('throws'), expect.stringContaining('rejects')])
  })
})
