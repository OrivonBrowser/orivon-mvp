// The pause both WASI hosts wait on: its slices, and cancelling it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { delay, pause } from '../time.js'

afterEach(() => { vi.useRealTimers() })

describe('pause', () => {
  it('settles once its time has passed, and a pause of zero yields once to the event loop', async () => {
    vi.useFakeTimers()
    let settled = false
    void pause(50).done.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(49)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    let yielded = false
    void delay(0).then(() => { yielded = true })
    expect(yielded).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(yielded).toBe(true)
  })

  it('takes a wait longer than setTimeout allows in slices', async () => {
    vi.useFakeTimers()
    let settled = false
    void pause(2 ** 31 + 4).done.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5)
    expect(settled).toBe(true)
  })

  it('clears its timer and settles at once when cancelled, in whichever slice it was', async () => {
    vi.useFakeTimers()
    const long = pause(2 ** 31 + 4)
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
    expect(vi.getTimerCount()).toBe(1)
    long.cancel()
    expect(vi.getTimerCount()).toBe(0)
    await expect(long.done).resolves.toBeUndefined()
    long.cancel()
  })
})
