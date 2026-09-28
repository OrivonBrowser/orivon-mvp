import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DebouncedWriter, WRITE_DEBOUNCE_MS } from '../debounced-writer.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** A write the test finishes by hand, to hold one in flight. */
function gatedWrite (): { write: () => Promise<void>, started: () => number, finish: () => void, fail: (error: Error) => void } {
  let starts = 0
  let release: (() => void) | undefined
  let reject: ((error: Error) => void) | undefined
  return {
    write: async () => {
      starts += 1
      await new Promise<void>((resolve, rej) => { release = resolve; reject = rej })
    },
    started: () => starts,
    finish: () => { release?.() },
    fail: (error) => { reject?.(error) }
  }
}

describe('DebouncedWriter', () => {
  it('turns a burst of changes into one write', async () => {
    const write = vi.fn(async () => {})
    const writer = new DebouncedWriter(write)

    writer.schedule()
    writer.schedule()
    writer.schedule()
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    await writer.flush()

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('resolves flush at once when nothing is pending', async () => {
    const writer = new DebouncedWriter(async () => {})

    await expect(writer.flush()).resolves.toBeUndefined()
  })

  it('never runs two writes at once: a change during a write is written after it', async () => {
    const gate = gatedWrite()
    const writer = new DebouncedWriter(gate.write)

    writer.schedule()
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    expect(gate.started()).toBe(1)

    writer.schedule()
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    expect(gate.started()).toBe(1)

    const flushed = writer.flush()
    let settled = false
    void flushed.then(() => { settled = true })
    gate.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(gate.started()).toBe(2)
    expect(settled).toBe(false)

    gate.finish()
    await flushed
    expect(settled).toBe(true)
  })

  it('makes flush wait for a change queued behind the write in flight', async () => {
    const gate = gatedWrite()
    const writer = new DebouncedWriter(gate.write)
    writer.schedule()
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)

    // The timer for this change has not fired when the first write finishes.
    writer.schedule()
    const flushed = writer.flush()
    gate.finish()
    await vi.advanceTimersByTimeAsync(0)
    let settled = false
    void flushed.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    expect(gate.started()).toBe(2)
    gate.finish()
    await flushed
  })

  it('rejects flush with the write\'s error, and writes again after a change', async () => {
    let attempts = 0
    const writer = new DebouncedWriter(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('disk full')
    })

    writer.schedule()
    const failed = writer.flush()
    const outcome = expect(failed).rejects.toThrow('disk full')
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    await outcome

    writer.schedule()
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    await expect(writer.flush()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('flushAll waits for every writer and never rejects', async () => {
    const good = vi.fn(async () => {})
    const goodWriter = new DebouncedWriter(good)
    const failingWriter = new DebouncedWriter(async () => { throw new Error('nope') })
    goodWriter.schedule()
    failingWriter.schedule()

    const all = DebouncedWriter.flushAll()
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)

    await expect(all).resolves.toBeUndefined()
    expect(good).toHaveBeenCalledTimes(1)
  })
})
