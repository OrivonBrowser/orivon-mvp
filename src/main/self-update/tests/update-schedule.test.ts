import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleUpdateChecks, UPDATE_POLL_MS } from '../update-schedule.js'

function setup (enabled: boolean) {
  const state = { enabled, listener: undefined as (() => void) | undefined, finish: undefined as (() => void) | undefined }
  const run = vi.fn(async () => { await new Promise<void>((resolve) => { state.finish = resolve }) })
  const stop = scheduleUpdateChecks({
    enabled: () => state.enabled,
    onEnabledChange: (listener) => { state.listener = listener; return () => { state.listener = undefined } },
    run
  })
  const toggle = (value: boolean): void => { state.enabled = value; state.listener?.() }
  const finish = async (): Promise<void> => { state.finish?.(); await Promise.resolve(); await Promise.resolve() }
  return { run, stop, toggle, finish, state }
}

describe('scheduleUpdateChecks', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('checks at start when it is on, and again every hour while the browser stays open', async () => {
    const { run, finish } = setup(true)
    expect(run).toHaveBeenCalledTimes(1)
    await finish()
    vi.advanceTimersByTime(UPDATE_POLL_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('checks nothing while it is off, and at once when the person switches it on', async () => {
    const { run, toggle } = setup(false)
    vi.advanceTimersByTime(UPDATE_POLL_MS * 3)
    expect(run).not.toHaveBeenCalled()
    toggle(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never starts a check while another is still running', async () => {
    const { run, toggle, finish } = setup(true)
    toggle(false)
    toggle(true)
    vi.advanceTimersByTime(UPDATE_POLL_MS)
    expect(run).toHaveBeenCalledTimes(1)
    await finish()
    vi.advanceTimersByTime(UPDATE_POLL_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('stops its timer and its listener when stopped', () => {
    const { run, stop, state } = setup(false)
    stop()
    expect(state.listener).toBeUndefined()
    state.enabled = true
    vi.advanceTimersByTime(UPDATE_POLL_MS * 2)
    expect(run).not.toHaveBeenCalled()
  })
})
