import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostLifecycle, IDLE_STOP_MS, REFRESH_DELAY_MS, REFRESH_WHEN_OLDER_THAN_SECONDS } from '../host-lifecycle.js'
import type { LifecycleDeps } from '../host-lifecycle.js'

const MIN = 60_000
const DAY = 24 * 60 * 60

function setup (over: Partial<LifecycleDeps> = {}) {
  const state = { tab: false, age: undefined as number | undefined, delay: 0 }
  const start = vi.fn()
  const idle = vi.fn()
  const lifecycle = new HostLifecycle({
    start, idle, tabShowsVerifiedOrigin: () => state.tab, checkpointAgeSeconds: () => state.age, startDelayMs: () => state.delay, ...over
  })
  return { lifecycle, start, idle, state }
}

describe('HostLifecycle', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  describe('launch', () => {
    it('starts nothing at launch when the checkpoint is fresh', () => {
      const { lifecycle, start, state } = setup()
      state.age = 3 * DAY
      lifecycle.refreshAtLaunch()
      vi.advanceTimersByTime(REFRESH_DELAY_MS * 3)
      expect(start).not.toHaveBeenCalled()
    })

    it('starts nothing before the quiet delay, and one run after it with an 8-day-old checkpoint', () => {
      const { lifecycle, start, state } = setup()
      state.age = 8 * DAY
      lifecycle.refreshAtLaunch()
      vi.advanceTimersByTime(REFRESH_DELAY_MS - 1)
      expect(start).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(start).toHaveBeenCalledTimes(1)
    })

    it('starts nothing when the light client is off or has no checkpoint to start from', () => {
      const { lifecycle, start } = setup()
      lifecycle.refreshAtLaunch()
      vi.advanceTimersByTime(REFRESH_DELAY_MS)
      expect(start).not.toHaveBeenCalled()
    })

    it('puts the host it started for the checkpoint to sleep ten minutes later', () => {
      const { lifecycle, idle, state } = setup()
      state.age = REFRESH_WHEN_OLDER_THAN_SECONDS + 1
      lifecycle.refreshAtLaunch()
      vi.advanceTimersByTime(REFRESH_DELAY_MS)
      vi.advanceTimersByTime(IDLE_STOP_MS - 1000)
      expect(idle).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2 * MIN)
      expect(idle).toHaveBeenCalledTimes(1)
    })
  })

  describe('requests', () => {
    it('starts the host on the first request, and again on each later one (the supervisor ignores a running host)', () => {
      const { lifecycle, start } = setup()
      lifecycle.request()
      expect(start).toHaveBeenCalledTimes(1)
      lifecycle.request()
      expect(start).toHaveBeenCalledTimes(2)
    })

    it('holds the start back by the test delay, once however many requests arrive meanwhile', () => {
      const { lifecycle, start, state } = setup()
      state.delay = 500
      lifecycle.request()
      lifecycle.request()
      expect(start).not.toHaveBeenCalled()
      vi.advanceTimersByTime(500)
      expect(start).toHaveBeenCalledTimes(1)
    })
  })

  describe('idle stop', () => {
    it('puts the host to sleep after ten minutes with no tab on a verifier origin and no request', () => {
      const { lifecycle, idle } = setup()
      lifecycle.request()
      vi.advanceTimersByTime(IDLE_STOP_MS - 1)
      expect(idle).not.toHaveBeenCalled()
      vi.advanceTimersByTime(MIN)
      expect(idle).toHaveBeenCalledTimes(1)
    })

    it('does not put it to sleep while a tab shows a verifier origin, however long that lasts', () => {
      const { lifecycle, idle, state } = setup()
      state.tab = true
      lifecycle.request()
      vi.advanceTimersByTime(3 * 60 * MIN)
      expect(idle).not.toHaveBeenCalled()
    })

    it('waits another ten minutes after the last tab on a verifier origin goes', () => {
      const { lifecycle, idle, state } = setup()
      state.tab = true
      lifecycle.request()
      vi.advanceTimersByTime(60 * MIN)
      state.tab = false
      vi.advanceTimersByTime(IDLE_STOP_MS - 2 * MIN)
      expect(idle).not.toHaveBeenCalled()
      vi.advanceTimersByTime(3 * MIN)
      expect(idle).toHaveBeenCalledTimes(1)
    })

    it('a request restarts the ten minutes', () => {
      const { lifecycle, idle } = setup()
      lifecycle.request()
      vi.advanceTimersByTime(8 * MIN)
      lifecycle.request()
      vi.advanceTimersByTime(8 * MIN)
      expect(idle).not.toHaveBeenCalled()
      vi.advanceTimersByTime(3 * MIN)
      expect(idle).toHaveBeenCalledTimes(1)
    })

    it('starts again on the next request after it slept, and sleeps again after another ten minutes', () => {
      const { lifecycle, start, idle } = setup()
      lifecycle.request()
      vi.advanceTimersByTime(IDLE_STOP_MS + MIN)
      expect(idle).toHaveBeenCalledTimes(1)
      lifecycle.request()
      expect(start).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(IDLE_STOP_MS + MIN)
      expect(idle).toHaveBeenCalledTimes(2)
    })

    it('checks nothing while the host has not been asked for', () => {
      const { idle } = setup()
      vi.advanceTimersByTime(60 * MIN)
      expect(idle).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('stops its timers on dispose', () => {
      const { lifecycle } = setup()
      lifecycle.request()
      lifecycle.refreshAtLaunch()
      lifecycle.dispose()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
