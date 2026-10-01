import { describe, expect, it, vi } from 'vitest'
import { oncePerTurn } from '../once-per-turn.js'

describe('oncePerTurn', () => {
  it('runs once after a burst, and again for the next burst', async () => {
    const run = vi.fn()
    const notify = oncePerTurn(run)
    for (let index = 0; index < 2000; index += 1) notify()
    expect(run).not.toHaveBeenCalled()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(run).toHaveBeenCalledTimes(1)
    notify()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(run).toHaveBeenCalledTimes(2)
  })
})
