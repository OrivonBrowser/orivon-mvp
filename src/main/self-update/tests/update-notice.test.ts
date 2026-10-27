import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHECK_INTERVAL_MS } from '../update-check.js'
import type { FetchLatestRelease, ReleaseInfo } from '../update-check.js'
import { createUpdateNotice } from '../update-notice.js'
import type { NoticeState, PlaceResult } from '../update-notice.js'

const NOW = Date.parse('2026-10-28T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const RELEASE: ReleaseInfo = { version: 'v0.0.12', url: 'https://example.invalid/ignored' }
const RELEASE_URL = 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.12'
const IN_USE: PlaceResult<string> = { place: 'window-1' }
const BUSY: PlaceResult<string> = { waiting: 'the window is minimised' }

interface Over {
  state?: NoticeState
  current?: string
  release?: ReleaseInfo | null
  fetch?: FetchLatestRelease
  place?: () => PlaceResult<string>
  ask?: (place: string, release: ReleaseInfo) => Promise<void>
  now?: number
}

function setup (over: Over = {}) {
  let disk: NoticeState = over.state ?? {}
  const writes: NoticeState[] = []
  const logs: string[] = []
  const fetchLatest = vi.fn<FetchLatestRelease>(over.fetch ?? (async () => ('release' in over ? over.release ?? null : RELEASE)))
  const place = vi.fn(over.place ?? (() => IN_USE))
  const ask = vi.fn(over.ask ?? (async () => {}))
  const clock = { now: over.now ?? NOW }
  const notice = createUpdateNotice<string>({
    currentVersion: over.current ?? '0.0.11',
    now: () => clock.now,
    read: async () => disk,
    write: async (state) => { disk = state; writes.push(state) },
    fetchLatest,
    place,
    ask,
    log: (line) => { logs.push(line) }
  })
  return { notice, writes, logs, fetchLatest, place, ask, clock, disk: () => disk }
}

describe('the update notice', () => {
  it('finds a newer release, remembers it, asks in the window in use, and writes it as told only after the question is answered', async () => {
    let answer: () => void = () => {}
    const s = setup({ ask: async () => { await new Promise<void>((resolve) => { answer = resolve }) } })
    const running = s.notice.runScheduled()
    await vi.waitFor(() => { expect(s.ask).toHaveBeenCalledTimes(1) })
    expect(s.ask).toHaveBeenCalledWith('window-1', expect.objectContaining({ version: 'v0.0.12' }))
    expect(s.disk()).toEqual({ lastCheckedAt: NOW, lastFoundVersion: 'v0.0.12' })
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: true })
    answer()
    await running
    expect(s.disk()).toEqual({ lastCheckedAt: NOW, lastFoundVersion: 'v0.0.12', lastNotifiedVersion: 'v0.0.12' })
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: false })
  })

  it('never asks while there is no window in use, and keeps the release waiting without writing it as told', async () => {
    const s = setup({ place: () => BUSY })
    await s.notice.runScheduled()
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.disk().lastNotifiedVersion).toBeUndefined()
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: true })
  })

  it('asks as soon as a window is in use, without asking the network again', async () => {
    let free = false
    const s = setup({ place: () => (free ? IN_USE : BUSY) })
    await s.notice.runScheduled()
    expect(s.ask).not.toHaveBeenCalled()
    free = true
    await s.notice.tryAsk()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.fetchLatest).toHaveBeenCalledTimes(1)
    expect(s.disk().lastNotifiedVersion).toBe('v0.0.12')
  })

  it('logs why it waits once per reason, and says when it asks', async () => {
    const s = setup({ place: () => BUSY })
    await s.notice.runScheduled()
    await s.notice.tryAsk()
    await s.notice.tryAsk()
    expect(s.logs.filter((line) => line.includes('waiting for a window in use'))).toEqual(['waiting for a window in use: the window is minimised'])
    expect(s.logs.some((line) => line.includes('release found: v0.0.12'))).toBe(true)
  })

  it('runs one question at a time', async () => {
    let answer: () => void = () => {}
    const s = setup({ ask: async () => { await new Promise<void>((resolve) => { answer = resolve }) } })
    const first = s.notice.runScheduled()
    await vi.waitFor(() => { expect(s.ask).toHaveBeenCalledTimes(1) })
    await s.notice.tryAsk()
    await s.notice.tryAsk()
    expect(s.ask).toHaveBeenCalledTimes(1)
    answer()
    await first
  })

  it('asks about a version once: not again at the next look, nor after a restart', async () => {
    const s = setup()
    await s.notice.runScheduled()
    s.clock.now += DEFAULT_CHECK_INTERVAL_MS
    await s.notice.runScheduled()
    expect(s.ask).toHaveBeenCalledTimes(1)
    const restarted = setup({ state: s.disk(), now: s.clock.now + 1 })
    await restarted.notice.runScheduled()
    await restarted.notice.tryAsk()
    expect(restarted.ask).not.toHaveBeenCalled()
  })

  it('asks again when a newer release than the one told comes out', async () => {
    const s = setup({ state: { lastCheckedAt: NOW - 2 * DEFAULT_CHECK_INTERVAL_MS, lastFoundVersion: 'v0.0.12', lastNotifiedVersion: 'v0.0.12' }, release: { version: 'v0.0.13', url: '' } })
    await s.notice.runScheduled()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.ask).toHaveBeenCalledWith('window-1', expect.objectContaining({ version: 'v0.0.13' }))
    expect(s.disk()).toEqual({ lastCheckedAt: NOW, lastFoundVersion: 'v0.0.13', lastNotifiedVersion: 'v0.0.13' })
  })

  it('asks at start about a release found earlier and not yet told, with no call to the network inside the day', async () => {
    const s = setup({ state: { lastCheckedAt: NOW - HOUR, lastFoundVersion: 'v0.0.12' } })
    await s.notice.runScheduled()
    expect(s.fetchLatest).not.toHaveBeenCalled()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.ask).toHaveBeenCalledWith('window-1', { version: 'v0.0.12', url: RELEASE_URL })
  })

  it('builds the release address from its constants and the tag, never from what the source answered', async () => {
    const s = setup({ release: { version: 'v0.0.12', url: 'https://evil.example/' } })
    await s.notice.runScheduled()
    expect(s.ask).toHaveBeenCalledWith('window-1', { version: 'v0.0.12', url: RELEASE_URL })
    expect(s.notice.offer()?.url).toBe(RELEASE_URL)
  })

  it('drops a persisted release the running version has caught up with', async () => {
    const s = setup({ current: '0.0.12', state: { lastCheckedAt: NOW - HOUR, lastFoundVersion: 'v0.0.12' } })
    await s.notice.runScheduled()
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.notice.offer()).toBeNull()
  })

  it('clears the offer when the newest release is no newer than the running one, as a rolled-back release is', async () => {
    const s = setup({ state: { lastCheckedAt: NOW - 2 * DEFAULT_CHECK_INTERVAL_MS, lastFoundVersion: 'v0.0.12' }, release: { version: 'v0.0.11', url: '' }, place: () => BUSY })
    await s.notice.runScheduled()
    expect(s.notice.offer()).toBeNull()
    expect(s.disk()).toEqual({ lastCheckedAt: NOW })
  })

  it('clears the offer when the source has no release to report', async () => {
    const s = setup({ state: { lastCheckedAt: NOW - 2 * DEFAULT_CHECK_INTERVAL_MS, lastFoundVersion: 'v0.0.12' }, release: null })
    await s.notice.runScheduled()
    expect(s.notice.offer()).toBeNull()
    expect(s.ask).not.toHaveBeenCalled()
  })

  it('keeps the earlier offer, records no check and says why, when the source was not reached', async () => {
    const s = setup({
      state: { lastCheckedAt: NOW - 2 * DEFAULT_CHECK_INTERVAL_MS, lastFoundVersion: 'v0.0.12' },
      fetch: async () => { throw new Error('the release source answered 403') },
      place: () => BUSY
    })
    await s.notice.runScheduled()
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: true })
    expect(s.writes).toEqual([])
    expect(s.logs.some((line) => line.includes('could not reach the release list: the release source answered 403'))).toBe(true)
  })

  it('does not look inside the day, and tells its listeners when the offer changes', async () => {
    const s = setup({ state: { lastCheckedAt: NOW - HOUR } })
    const heard: Array<string | null> = []
    s.notice.onChange((offer) => { heard.push(offer?.latest ?? null) })
    await s.notice.runScheduled()
    expect(s.fetchLatest).not.toHaveBeenCalled()
    expect(heard).toEqual([])
    s.clock.now += DEFAULT_CHECK_INTERVAL_MS
    await s.notice.runScheduled()
    expect(heard[0]).toBe('v0.0.12')
  })

  it('leaves the release waiting, and does not ask again until the next look, when the question could not be shown', async () => {
    const s = setup({ ask: async () => { throw new Error('no panel') } })
    await s.notice.runScheduled()
    await s.notice.tryAsk()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.disk().lastNotifiedVersion).toBeUndefined()
    expect(s.notice.offer()?.pending).toBe(true)
    s.clock.now += HOUR
    await s.notice.runScheduled()
    expect(s.ask).toHaveBeenCalledTimes(2)
  })

  it('never rejects', async () => {
    const s = setup()
    const broken = createUpdateNotice<string>({
      currentVersion: '0.0.11', now: () => NOW, read: async () => { throw new Error('disk') }, write: async () => {}, fetchLatest: async () => null, place: () => IN_USE, ask: async () => {}, log: () => {}
    })
    await expect(broken.runScheduled()).resolves.toBeUndefined()
    await expect(s.notice.tryAsk()).resolves.toBeUndefined()
  })
})

describe('"Check now"', () => {
  it('answers what it found, keeps it on offer and counts it as told, since the person has just read it', async () => {
    const s = setup({ place: () => BUSY })
    const answer = await s.notice.checkNow()
    expect(answer).toEqual({ reached: true, current: '0.0.11', latest: 'v0.0.12', newer: true, url: RELEASE_URL })
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: false })
    expect(s.disk()).toEqual({ lastFoundVersion: 'v0.0.12', lastNotifiedVersion: 'v0.0.12' })
  })

  it('does not ask afterwards about the release it just showed', async () => {
    const s = setup()
    await s.notice.checkNow()
    await s.notice.tryAsk()
    expect(s.ask).not.toHaveBeenCalled()
  })

  it('answers that nothing is newer, and clears an earlier offer', async () => {
    const s = setup({ release: { version: 'v0.0.11', url: '' }, state: { lastFoundVersion: 'v0.0.12' } })
    await s.notice.runScheduled()
    const answer = await s.notice.checkNow()
    expect(answer).toMatchObject({ reached: true, newer: false, latest: 'v0.0.11' })
    expect(s.notice.offer()).toBeNull()
  })

  it('answers not reached, and leaves an earlier offer alone', async () => {
    let fail = false
    const s = setup({ fetch: async () => { if (fail) throw new Error('offline'); return RELEASE }, place: () => BUSY })
    await s.notice.runScheduled()
    fail = true
    expect(await s.notice.checkNow()).toEqual({ reached: false, current: '0.0.11', latest: null, newer: false, url: null })
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12' })
  })
})
