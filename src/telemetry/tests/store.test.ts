import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initialState, type AccountingState } from '../accounting.js'
import type { UsagePayload } from '../disclosure.js'
import { initialHistoryState } from '../history.js'
import { initialKindSchedule } from '../schedule.js'
import { parseTelemetryFile, serializeTelemetryFile, TelemetryStore, type TelemetryDisk } from '../store.js'

const STREAM = 'a1'.repeat(16)
const nextFixed = (): string => STREAM

const emptyDisk: TelemetryDisk = {
  stream: STREAM,
  accounting: initialState,
  history: initialHistoryState,
  schedules: { usage: initialKindSchedule, sites: initialKindSchedule },
  reportIds: {}
}

const usage: UsagePayload = {
  schema: 2, installId: 'b2'.repeat(16), stream: STREAM, region: 'EU', version: '0.1.0', period: '2026-09',
  activeSec: 1, backgroundSec: 2, classes: { web3: 1, web25: 0, web2: 0 }
}

describe('parseTelemetryFile / serializeTelemetryFile', () => {
  it('round-trips what serializeTelemetryFile writes', () => {
    const disk: TelemetryDisk = {
      stream: 'c3'.repeat(16),
      accounting: { ...initialState, perSite: { '2026-09': { 'web3:a.eth': 4.5 } }, currentSite: 'web3:a.eth', lastAccountedAt: 12345 },
      history: { entries: [{ payload: usage, sentAtMs: 999 }] },
      schedules: {
        usage: { offsetPeriod: '2026-09', offsetMs: 5, lastSentAtMs: 7, closedPeriod: '2026-08' },
        sites: initialKindSchedule
      },
      reportIds: { '2026-09': 'd4'.repeat(16) }
    }
    expect(parseTelemetryFile(serializeTelemetryFile(disk), nextFixed)).toEqual(disk)
  })

  it('yields a fresh default disk, with a newly made stream, for invalid JSON or JSON that is not an object', () => {
    expect(parseTelemetryFile('{not json', nextFixed)).toEqual(emptyDisk)
    expect(parseTelemetryFile('[1,2,3]', nextFixed)).toEqual(emptyDisk)
  })

  it('makes a new stream when the stored one is not 32 hex characters', () => {
    expect(parseTelemetryFile(JSON.stringify({ stream: 'short' }), nextFixed).stream).toBe(STREAM)
  })

  it('falls back to defaults for a malformed accounting shape, keeping the rest', () => {
    const raw = JSON.stringify({ stream: 'c3'.repeat(16), accounting: 'not an object', history: { entries: [] } })
    expect(parseTelemetryFile(raw, nextFixed)).toEqual({ ...emptyDisk, stream: 'c3'.repeat(16) })
  })

  it('reads accounting saved before the site split, with an empty split and the browser own pages in front', () => {
    const old = { perApp: { shell: { '2026-09': { activeSec: 60, backgroundSec: 30 } } }, openSessions: { shell: 1 }, focusedApp: 'shell', lastInteractionAt: 500, suspended: false, lastAccountedAt: 600 }
    const parsed = parseTelemetryFile(JSON.stringify({ stream: STREAM, accounting: old }), nextFixed)
    expect(parsed.accounting).toEqual({ ...old, perSite: {}, currentSite: 'internal' })
  })

  it('drops history entries made before reports had a schema', () => {
    const raw = JSON.stringify({ stream: STREAM, history: { entries: [{ payload: { installId: 'x', country: '', version: '1', period: '2026-08', perApp: {} }, sentAtMs: 1 }, { payload: usage, sentAtMs: 2 }] } })
    expect(parseTelemetryFile(raw, nextFixed).history.entries).toEqual([{ payload: usage, sentAtMs: 2 }])
  })

  it('does not read a consent or an install ID out of the profile file: both are system-wide', () => {
    const parsed = parseTelemetryFile(JSON.stringify({ stream: STREAM, consent: 'accepted', installId: 'old', country: 'IT' }), nextFixed)
    expect(Object.keys(parsed).sort()).toEqual(['accounting', 'history', 'reportIds', 'schedules', 'stream'])
  })
})

describe('TelemetryStore', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-telemetry-'))
    filePath = join(dir, 'nested', 'telemetry.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('makes a stream and persists it at once on first launch', async () => {
    const store = new TelemetryStore(filePath, nextFixed)
    await store.load()
    expect(store.getStream()).toBe(STREAM)
    expect(parseTelemetryFile(await readFile(filePath, 'utf8'), () => 'zz').stream).toBe(STREAM)
  })

  it('starts from defaults, without throwing, when the file is corrupt', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(filePath, 'not json at all', 'utf8')
    const store = new TelemetryStore(filePath, nextFixed)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.getAccountingState()).toEqual(initialState)
  })

  it('holds accounting, history and schedule changes in memory until checkpoint()', async () => {
    const store = new TelemetryStore(filePath, nextFixed)
    await store.load()
    const accounting: AccountingState = { ...initialState, lastAccountedAt: 777 }
    store.setAccountingState(accounting)
    store.setSchedule('sites', { ...initialKindSchedule, offsetMs: 9 })
    expect(store.getAccountingState()).toEqual(accounting)
    expect(store.getSchedule('sites').offsetMs).toBe(9)
    expect(parseTelemetryFile(await readFile(filePath, 'utf8'), nextFixed).accounting).toEqual(initialState)

    await store.checkpoint()
    const reloaded = new TelemetryStore(filePath, nextFixed)
    await reloaded.load()
    expect(reloaded.getAccountingState()).toEqual(accounting)
    expect(reloaded.getSchedule('sites').offsetMs).toBe(9)
  })

  it('gives the same report ID for a period every time, a new one for the next, and keeps only the newest three', () => {
    let n = 0
    const store = new TelemetryStore(filePath, () => String(n++).padStart(32, '0'))
    const september = store.reportIdFor('2026-09')
    expect(store.reportIdFor('2026-09')).toBe(september)
    const october = store.reportIdFor('2026-10')
    expect(october).not.toBe(september)
    store.reportIdFor('2026-11')
    store.reportIdFor('2026-12')
    expect(store.reportIdFor('2026-10')).toBe(october)
    expect(store.reportIdFor('2026-09')).not.toBe(september)
  })

  it('erases what was counted and sent but keeps the stream', async () => {
    const store = new TelemetryStore(filePath, nextFixed)
    await store.load()
    store.setAccountingState({ ...initialState, lastAccountedAt: 5 })
    store.setHistoryState({ entries: [{ payload: usage, sentAtMs: 1 }] })
    store.setSchedule('usage', { ...initialKindSchedule, offsetMs: 3 })
    store.reportIdFor('2026-09')
    await store.eraseMeasurements()

    const onDisk = parseTelemetryFile(await readFile(filePath, 'utf8'), () => 'zz')
    expect(onDisk).toEqual(emptyDisk)
  })
})
