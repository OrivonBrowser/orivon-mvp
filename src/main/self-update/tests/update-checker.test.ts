import { describe, expect, it, vi } from 'vitest'
import { createUpdateChecker } from '../update-checker.js'
import type { CheckerDeps, CheckerState } from '../update-checker.js'
import type { ReleaseInfo } from '../update-check.js'

const DAY = 86_400_000
const NEW: ReleaseInfo = { version: 'v1.2.0', url: 'https://example.test/r' }

function setup (patch: Partial<CheckerDeps> = {}, initial: CheckerState = {}): { checker: ReturnType<typeof createUpdateChecker>, written: CheckerState[], fetchLatest: ReturnType<typeof vi.fn>, ask: ReturnType<typeof vi.fn>, offer: ReturnType<typeof vi.fn>, clock: { at: number } } {
  let stored = initial
  const written: CheckerState[] = []
  const clock = { at: 10 * DAY }
  const fetchLatest = vi.fn(async () => NEW as ReleaseInfo | null)
  const ask = vi.fn(async () => true)
  const offer = vi.fn(async () => {})
  const checker = createUpdateChecker({
    currentVersion: '1.0.0',
    now: () => clock.at,
    read: async () => stored,
    write: async (state) => { stored = state; written.push(state) },
    fetchLatest,
    offer,
    ask,
    ...patch
  })
  return { checker, written, fetchLatest, ask, offer, clock }
}

describe('the scheduled check', () => {
  it('asks once about a newer release and records the day and the version', async () => {
    const { checker, ask, offer, written, clock } = setup()
    await checker.runScheduled()
    expect(offer).toHaveBeenCalledWith(NEW)
    expect(ask).toHaveBeenCalledWith(NEW)
    expect(written).toEqual([{ lastCheckedAt: clock.at, lastNotifiedVersion: 'v1.2.0' }])
  })

  it('does not ask again about a version it asked about, even after a day', async () => {
    const { checker, ask, clock } = setup()
    await checker.runScheduled()
    clock.at += DAY + 1
    await checker.runScheduled()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('asks the network at most once a day', async () => {
    const { checker, fetchLatest, clock } = setup({}, { lastCheckedAt: 10 * DAY - 1000 })
    await checker.runScheduled()
    expect(fetchLatest).not.toHaveBeenCalled()
    clock.at += DAY
    await checker.runScheduled()
    expect(fetchLatest).toHaveBeenCalledTimes(1)
  })

  it('waits for a window in use without recording the day, and asks as soon as there is one without asking the network again', async () => {
    const ask = vi.fn(async () => false)
    const { checker, fetchLatest, written, clock } = setup({ ask })
    await checker.runScheduled()
    expect(written).toEqual([])
    ask.mockResolvedValueOnce(true)
    clock.at += 60 * 60_000
    await checker.runScheduled()
    expect(fetchLatest).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(written).toEqual([{ lastCheckedAt: clock.at, lastNotifiedVersion: 'v1.2.0' }])
  })

  it('records the day and asks nothing when the newest release is not newer', async () => {
    const { checker, ask, written, clock } = setup({ fetchLatest: async () => ({ version: 'v1.0.0', url: 'u' }) })
    await checker.runScheduled()
    expect(ask).not.toHaveBeenCalled()
    expect(written).toEqual([{ lastCheckedAt: clock.at }])
  })

  it('records the day when no release is signed yet', async () => {
    const { checker, ask, written, clock } = setup({ fetchLatest: async () => null })
    await checker.runScheduled()
    expect(ask).not.toHaveBeenCalled()
    expect(written).toEqual([{ lastCheckedAt: clock.at }])
  })

  it('changes nothing when the source is out of reach, so the next look tries again', async () => {
    const { checker, ask, written } = setup({ fetchLatest: async () => { throw new Error('offline') } })
    await checker.runScheduled()
    expect(ask).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  it('never rejects, whatever fails inside', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { checker } = setup({ read: async () => { throw new Error('disk') } })
    await expect(checker.runScheduled()).resolves.toBeUndefined()
    quiet.mockRestore()
  })
})

describe('check now', () => {
  it('looks whatever was asked last, offers what it found, asks nobody and records nothing', async () => {
    const { checker, fetchLatest, ask, offer, written } = setup({}, { lastCheckedAt: 10 * DAY, lastNotifiedVersion: 'v1.2.0' })
    const result = await checker.checkNow()
    expect(fetchLatest).toHaveBeenCalledTimes(1)
    expect(result.shouldNotify).toBe(true)
    expect(offer).toHaveBeenCalledWith(NEW)
    expect(ask).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  it('offers nothing when the release found is not newer', async () => {
    const { checker, offer } = setup({ fetchLatest: async () => ({ version: 'v0.9.0', url: 'u' }) })
    await checker.checkNow()
    expect(offer).toHaveBeenCalledWith(null)
  })
})
