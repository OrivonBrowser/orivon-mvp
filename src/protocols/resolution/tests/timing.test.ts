import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sleepOrAbort, unlessAborted, withTimeout } from '../timing.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('withTimeout', () => {
  it('answers with the promise, and leaves no timer behind', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'work')).resolves.toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects once the time passes first, naming what took too long', async () => {
    const late = expect(withTimeout(new Promise(() => {}), 2_000, 'the proxy check')).rejects.toThrow('the proxy check took longer than 2 s')
    await vi.advanceTimersByTimeAsync(2_000)
    await late
  })
})

describe('sleepOrAbort', () => {
  it('waits the full time, then stops listening to the signal', async () => {
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    let done = false
    const sleeping = sleepOrAbort(500, controller.signal).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await sleeping
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('returns early, clearing its timer, once the signal aborts', async () => {
    const controller = new AbortController()
    const sleeping = sleepOrAbort(60_000, controller.signal)
    controller.abort()
    await sleeping
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('unlessAborted', () => {
  it('rejects with the signal\'s reason while the work carries on for whoever else waits on it', async () => {
    let finish!: (value: string) => void
    const work = new Promise<string>((resolve) => { finish = resolve })
    const controller = new AbortController()
    const leaving = unlessAborted(work, controller.signal)
    controller.abort(new Error('the client left'))
    await expect(leaving).rejects.toThrow('the client left')
    finish('done')
    await expect(work).resolves.toBe('done')
  })

  it('rejects at once for a signal that already fired, and passes through with none', async () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(unlessAborted(Promise.resolve(1), controller.signal)).rejects.toThrow('gone')
    await expect(unlessAborted(Promise.resolve(2), undefined)).resolves.toBe(2)
  })
})
