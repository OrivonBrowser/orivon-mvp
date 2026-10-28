import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHECK_INTERVAL_MS } from '../update-check.js'
import type { FetchLatestRelease, ReleaseInfo } from '../update-check.js'
import { createUpdateNotice } from '../update-notice.js'
import type { AskOutcome, NoticeState, PlaceResult } from '../update-notice.js'

const NOW = Date.parse('2026-10-28T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const RELEASE: ReleaseInfo = { version: 'v0.0.12', url: 'https://example.invalid/ignored' }
const RELEASE_URL = 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.12'
const IN_USE: PlaceResult<string> = { place: 'window-1' }
const BUSY: PlaceResult<string> = { waiting: 'the window is minimised' }
const SEEN: AskOutcome = { seen: true }
const UNSEEN: AskOutcome = { seen: false }

/** Lets every step of an ask that waits on nothing but promises run to its end. */
const settled = async (): Promise<void> => { await new Promise<void>((resolve) => { setImmediate(resolve) }) }

interface Over {
  state?: NoticeState
  current?: string
  release?: ReleaseInfo | null
  fetch?: FetchLatestRelease
  /** Runs inside the write, before the state counts as on disk. */
  write?: (state: NoticeState) => Promise<void>
  place?: () => PlaceResult<string>
  ask?: (place: string, release: ReleaseInfo) => Promise<AskOutcome>
  now?: number
}

function setup (over: Over = {}) {
  let disk: NoticeState = over.state ?? {}
  const writes: NoticeState[] = []
  const logs: string[] = []
  const fetchLatest = vi.fn<FetchLatestRelease>(over.fetch ?? (async () => ('release' in over ? over.release ?? null : RELEASE)))
  const place = vi.fn(over.place ?? (() => IN_USE))
  const ask = vi.fn(over.ask ?? (async () => SEEN))
  const clock = { now: over.now ?? NOW }
  const notice = createUpdateNotice<string>({
    currentVersion: over.current ?? '0.0.11',
    now: () => clock.now,
    read: async () => disk,
    write: async (state) => { await over.write?.(state); disk = state; writes.push(state) },
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
    const s = setup({ ask: async () => { await new Promise<void>((resolve) => { answer = resolve }); return SEEN } })
    await s.notice.runScheduled()
    await vi.waitFor(() => { expect(s.ask).toHaveBeenCalledTimes(1) })
    expect(s.ask).toHaveBeenCalledWith('window-1', expect.objectContaining({ version: 'v0.0.12' }))
    expect(s.disk()).toEqual({ lastCheckedAt: NOW, lastFoundVersion: 'v0.0.12' })
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: true })
    answer()
    await settled()
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
    const s = setup({ ask: async () => { await new Promise<void>((resolve) => { answer = resolve }); return SEEN } })
    await s.notice.runScheduled()
    await vi.waitFor(() => { expect(s.ask).toHaveBeenCalledTimes(1) })
    await s.notice.tryAsk()
    await s.notice.tryAsk()
    expect(s.ask).toHaveBeenCalledTimes(1)
    answer()
    await settled()
    expect(s.disk().lastNotifiedVersion).toBe('v0.0.12')
  })

  it('asks about a version once: not again at the next look, nor after a restart', async () => {
    const s = setup()
    await s.notice.runScheduled()
    await settled()
    s.clock.now += DEFAULT_CHECK_INTERVAL_MS
    await s.notice.runScheduled()
    await settled()
    expect(s.ask).toHaveBeenCalledTimes(1)
    const restarted = setup({ state: s.disk(), now: s.clock.now + 1 })
    await restarted.notice.runScheduled()
    await settled()
    await restarted.notice.tryAsk()
    expect(restarted.ask).not.toHaveBeenCalled()
  })

  it('asks again when a newer release than the one told comes out', async () => {
    const s = setup({ state: { lastCheckedAt: NOW - 2 * DEFAULT_CHECK_INTERVAL_MS, lastFoundVersion: 'v0.0.12', lastNotifiedVersion: 'v0.0.12' }, release: { version: 'v0.0.13', url: '' } })
    await s.notice.runScheduled()
    await settled()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.ask).toHaveBeenCalledWith('window-1', expect.objectContaining({ version: 'v0.0.13' }))
    expect(s.disk()).toEqual({ lastCheckedAt: NOW, lastFoundVersion: 'v0.0.13', lastNotifiedVersion: 'v0.0.13' })
  })

  it('asks at start about a release found earlier and not yet told, with no call to the network inside the day', async () => {
    const s = setup({ state: { lastCheckedAt: NOW - HOUR, lastFoundVersion: 'v0.0.12' } })
    await s.notice.runScheduled()
    await settled()
    expect(s.fetchLatest).not.toHaveBeenCalled()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.ask).toHaveBeenCalledWith('window-1', { version: 'v0.0.12', url: RELEASE_URL })
  })

  it('builds the release address from its constants and the tag, never from what the source answered', async () => {
    const s = setup({ release: { version: 'v0.0.12', url: 'https://evil.example/' } })
    await s.notice.runScheduled()
    await settled()
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
    await settled()
    await s.notice.tryAsk()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.disk().lastNotifiedVersion).toBeUndefined()
    expect(s.notice.offer()?.pending).toBe(true)
    s.clock.now += HOUR
    await s.notice.runScheduled()
    await settled()
    expect(s.ask).toHaveBeenCalledTimes(2)
  })

  it('leaves the release pending, and asks again, when the question closed before the person could see it', async () => {
    let outcome: AskOutcome = UNSEEN
    const s = setup({ ask: async () => outcome })
    await s.notice.runScheduled()
    await settled()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.disk().lastNotifiedVersion).toBeUndefined()
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: true })
    expect(s.logs.some((line) => line.includes('closed before it was shown'))).toBe(true)
    outcome = SEEN
    await s.notice.tryAsk()
    expect(s.ask).toHaveBeenCalledTimes(2)
    expect(s.disk().lastNotifiedVersion).toBe('v0.0.12')
  })

  it('stops asking after a few questions that were never shown, until the next look', async () => {
    const s = setup({ ask: async () => UNSEEN })
    await s.notice.runScheduled()
    await settled()
    for (let tries = 0; tries < 6; tries++) await s.notice.tryAsk()
    expect(s.ask).toHaveBeenCalledTimes(3)
    expect(s.notice.offer()?.pending).toBe(true)
    s.clock.now += HOUR
    await s.notice.runScheduled()
    await settled()
    expect(s.ask).toHaveBeenCalledTimes(4)
  })

  it('does not hold the next look back while a question waits for its answer', async () => {
    let answer: () => void = () => {}
    const s = setup({ ask: async () => { await new Promise<void>((resolve) => { answer = resolve }); return SEEN } })
    await expect(s.notice.runScheduled()).resolves.toBeUndefined()
    await vi.waitFor(() => { expect(s.ask).toHaveBeenCalledTimes(1) })
    s.clock.now += DEFAULT_CHECK_INTERVAL_MS
    await s.notice.runScheduled()
    expect(s.fetchLatest).toHaveBeenCalledTimes(2)
    expect(s.ask).toHaveBeenCalledTimes(1)
    answer()
    await settled()
    expect(s.disk().lastNotifiedVersion).toBe('v0.0.12')
  })

  it('never moves the told version back: a newer release shown in Settings while a question waited stays told', async () => {
    let newest: ReleaseInfo = RELEASE
    let answer: () => void = () => {}
    const s = setup({ fetch: async () => newest, ask: async () => { await new Promise<void>((resolve) => { answer = resolve }); return SEEN } })
    await s.notice.runScheduled()
    await vi.waitFor(() => { expect(s.ask).toHaveBeenCalledTimes(1) })
    newest = { version: 'v0.0.13', url: '' }
    await s.notice.checkNow()
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.13', pending: false })
    answer()
    await settled()
    expect(s.disk()).toEqual({ lastFoundVersion: 'v0.0.13', lastCheckedAt: NOW, lastNotifiedVersion: 'v0.0.13' })
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.13', pending: false })
    await s.notice.tryAsk()
    expect(s.ask).toHaveBeenCalledTimes(1)
  })

  it('does not ask about a release older than one the person was told about, as when the newer one was pulled back', async () => {
    const told = { lastCheckedAt: NOW - 2 * DEFAULT_CHECK_INTERVAL_MS, lastFoundVersion: 'v0.0.13', lastNotifiedVersion: 'v0.0.13' }
    const s = setup({ state: told })
    const heard: boolean[] = []
    s.notice.onChange((offer) => { heard.push(offer?.pending === true) })
    await s.notice.runScheduled()
    await settled()
    for (let tries = 0; tries < 3; tries++) await s.notice.tryAsk()
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: false })
    expect(heard).not.toContain(true)
    expect(s.disk()).toEqual({ lastCheckedAt: NOW, lastFoundVersion: 'v0.0.12', lastNotifiedVersion: 'v0.0.13' })
  })

  it('asks about a release newer than the one that was pulled back', async () => {
    const s = setup({
      state: { lastCheckedAt: NOW - 2 * DEFAULT_CHECK_INTERVAL_MS, lastFoundVersion: 'v0.0.13', lastNotifiedVersion: 'v0.0.13' },
      release: { version: 'v0.0.14', url: '' }
    })
    await s.notice.runScheduled()
    await settled()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.disk().lastNotifiedVersion).toBe('v0.0.14')
  })

  it('keeps the told version above the release it shows in Settings when the newer one was pulled back', async () => {
    const s = setup({ state: { lastFoundVersion: 'v0.0.13', lastNotifiedVersion: 'v0.0.13' } })
    const answer = await s.notice.checkNow()
    expect(answer).toMatchObject({ latest: 'v0.0.12', newer: true })
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: false })
    expect(s.disk().lastNotifiedVersion).toBe('v0.0.13')
  })

  it('keeps waiting, and logs why once, when asking where to ask throws', async () => {
    let broken = true
    const s = setup({ place: () => { if (broken) throw new Error('Object has been destroyed'); return IN_USE } })
    await s.notice.runScheduled()
    await expect(s.notice.tryAsk()).resolves.toBeUndefined()
    await expect(s.notice.tryAsk()).resolves.toBeUndefined()
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.notice.offer()).toMatchObject({ latest: 'v0.0.12', pending: true })
    expect(s.logs.filter((line) => line.includes('Object has been destroyed'))).toHaveLength(1)
    broken = false
    await s.notice.tryAsk()
    expect(s.ask).toHaveBeenCalledTimes(1)
  })

  it('writes the state file one write at a time, so two that finish together cannot mix their bytes, and the last state is the one kept', async () => {
    let active = 0
    let overlapped = false
    const s = setup({ write: async () => { active += 1; overlapped ||= active > 1; await settled(); active -= 1 } })
    await Promise.all([s.notice.runScheduled(), s.notice.checkNow()])
    await s.notice.tryAsk()
    expect(overlapped).toBe(false)
    expect(s.writes.length).toBeGreaterThanOrEqual(2)
    expect(s.disk()).toEqual({ lastCheckedAt: NOW, lastFoundVersion: 'v0.0.12', lastNotifiedVersion: 'v0.0.12' })
  })

  it('logs a write that failed, and writes again after it', async () => {
    let fail = true
    const s = setup({ place: () => BUSY, write: async () => { if (fail) throw new Error('disk full') } })
    await s.notice.runScheduled()
    await settled()
    expect(s.logs.filter((line) => line.includes('could not remember the update state: disk full'))).toHaveLength(1)
    fail = false
    await s.notice.checkNow()
    expect(s.disk()).toMatchObject({ lastFoundVersion: 'v0.0.12', lastNotifiedVersion: 'v0.0.12' })
  })

  it('never rejects', async () => {
    const s = setup()
    const broken = createUpdateNotice<string>({
      currentVersion: '0.0.11', now: () => NOW, read: async () => { throw new Error('disk') }, write: async () => {}, fetchLatest: async () => null, place: () => IN_USE, ask: async () => SEEN, log: () => {}
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
