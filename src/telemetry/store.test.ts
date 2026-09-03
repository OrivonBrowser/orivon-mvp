import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initialState, type AccountingState } from './accounting.js'
import { initialConsentState } from './disclosure.js'
import { initialHistoryState } from './history.js'
import {
  parseTelemetryFile,
  serializeTelemetryFile,
  TelemetryStore,
  type TelemetryDisk
} from './store.js'

const FIXED_ID = '4c2f2f3a-1111-4444-8888-abcde1234567'
const nextFixedId = (): string => FIXED_ID

const emptyDisk: TelemetryDisk = {
  installId: FIXED_ID,
  country: '',
  consent: initialConsentState,
  accounting: initialState,
  history: initialHistoryState
}

describe('parseTelemetryFile / serializeTelemetryFile', () => {
  it('round-trips what serializeTelemetryFile writes', () => {
    const disk: TelemetryDisk = {
      installId: FIXED_ID,
      country: 'IT',
      consent: 'accepted',
      accounting: { ...initialState, lastAccountedAt: 12345 },
      history: { entries: [{ payload: { installId: FIXED_ID, country: 'IT', version: '0.1.0', period: '2026-09', perApp: {} }, sentAtMs: 999 }] }
    }
    expect(parseTelemetryFile(serializeTelemetryFile(disk), nextFixedId)).toEqual(disk)
  })

  it('yields a fresh default disk, with a newly generated installId, for invalid JSON', () => {
    expect(parseTelemetryFile('{not json', nextFixedId)).toEqual(emptyDisk)
  })

  it('yields a fresh default disk when the JSON is not an object', () => {
    expect(parseTelemetryFile('[1,2,3]', nextFixedId)).toEqual(emptyDisk)
  })

  it('keeps a valid installId/country/consent but falls back to defaults for a malformed accounting shape', () => {
    const raw = JSON.stringify({
      installId: 'existing-id',
      country: 'FR',
      consent: 'declined',
      accounting: 'not an object', // corrupt
      history: { entries: [] }
    })
    expect(parseTelemetryFile(raw, nextFixedId)).toEqual({
      installId: 'existing-id',
      country: 'FR',
      consent: 'declined',
      accounting: initialState,
      history: initialHistoryState
    })
  })

  it('falls back to "undecided" for a consent value outside the known three', () => {
    const raw = JSON.stringify({ installId: 'x', country: '', consent: 'yes-please', accounting: initialState, history: initialHistoryState })
    expect(parseTelemetryFile(raw, nextFixedId).consent).toBe('undecided')
  })

  it('falls back to a fresh installId when the persisted one is not a non-empty string', () => {
    const raw = JSON.stringify({ installId: '', country: '', consent: 'undecided', accounting: initialState, history: initialHistoryState })
    expect(parseTelemetryFile(raw, nextFixedId).installId).toBe(FIXED_ID)
  })

  it('preserves a real, deeply-nested accounting state exactly', () => {
    const accounting: AccountingState = {
      perApp: { shell: { '2026-09': { activeSec: 60, backgroundSec: 30 } } },
      openSessions: { shell: 1 },
      focusedApp: 'shell',
      lastInteractionAt: 500,
      suspended: false,
      lastAccountedAt: 600
    }
    const disk: TelemetryDisk = { ...emptyDisk, accounting }
    expect(parseTelemetryFile(serializeTelemetryFile(disk), nextFixedId)).toEqual(disk)
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

  it('generates a fresh installId and persists it immediately on first launch (no file yet)', async () => {
    const store = new TelemetryStore(filePath, nextFixedId)
    await store.load()
    expect(store.getInstallId()).toBe(FIXED_ID)

    const onDisk = parseTelemetryFile(await readFile(filePath, 'utf8'), nextFixedId)
    expect(onDisk.installId).toBe(FIXED_ID)
  })

  it('starts from defaults, without throwing, when the file is corrupt', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(filePath, 'not json at all', 'utf8')

    const store = new TelemetryStore(filePath, nextFixedId)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.getConsentState()).toBe('undecided')
    expect(store.getAccountingState()).toEqual(initialState)
  })

  it('reads back an existing valid file exactly, including its installId', async () => {
    const disk: TelemetryDisk = {
      installId: 'already-there',
      country: 'DE',
      consent: 'accepted',
      accounting: { ...initialState, lastAccountedAt: 42 },
      history: initialHistoryState
    }
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(filePath, serializeTelemetryFile(disk), 'utf8')

    const store = new TelemetryStore(filePath, nextFixedId)
    await store.load()
    expect(store.getInstallId()).toBe('already-there')
    expect(store.getCountry()).toBe('DE')
    expect(store.getConsentState()).toBe('accepted')
    expect(store.getAccountingState()).toEqual({ ...initialState, lastAccountedAt: 42 })
  })

  it('setCountry persists immediately, no debounce', async () => {
    const store = new TelemetryStore(filePath, nextFixedId)
    await store.load()
    await store.setCountry('IT')

    const onDisk = parseTelemetryFile(await readFile(filePath, 'utf8'), nextFixedId)
    expect(onDisk.country).toBe('IT')
  })

  it('setConsentState persists immediately -- a consent decision must survive a crash right after the click', async () => {
    const store = new TelemetryStore(filePath, nextFixedId)
    await store.load()
    await store.setConsentState('accepted')

    const onDisk = parseTelemetryFile(await readFile(filePath, 'utf8'), nextFixedId)
    expect(onDisk.consent).toBe('accepted')
  })

  it('setAccountingState/setHistoryState update in-memory reads immediately but do NOT write to disk until checkpoint()', async () => {
    const store = new TelemetryStore(filePath, nextFixedId)
    await store.load()

    const accounting: AccountingState = { ...initialState, lastAccountedAt: 777 }
    store.setAccountingState(accounting)
    expect(store.getAccountingState()).toEqual(accounting)

    // Still just the first-launch installId write -- the accounting change above is not on disk yet.
    const beforeCheckpoint = parseTelemetryFile(await readFile(filePath, 'utf8'), nextFixedId)
    expect(beforeCheckpoint.accounting).toEqual(initialState)

    await store.checkpoint()
    const afterCheckpoint = parseTelemetryFile(await readFile(filePath, 'utf8'), nextFixedId)
    expect(afterCheckpoint.accounting).toEqual(accounting)
  })

  it('a fresh store reloading after checkpoint() sees the same accounting and history state', async () => {
    const store = new TelemetryStore(filePath, nextFixedId)
    await store.load()

    const accounting: AccountingState = { ...initialState, perApp: { shell: { '2026-09': { activeSec: 10, backgroundSec: 5 } } } }
    store.setAccountingState(accounting)
    store.setHistoryState({ entries: [{ payload: { installId: FIXED_ID, country: '', version: '0.1.0', period: '2026-09', perApp: {} }, sentAtMs: 1 }] })
    await store.checkpoint()

    const reloaded = new TelemetryStore(filePath, nextFixedId)
    await reloaded.load()
    expect(reloaded.getAccountingState()).toEqual(accounting)
    expect(reloaded.getHistoryState().entries).toHaveLength(1)
    // The installId generated on first launch must survive -- a second store reading
    // the same file must never mint a second identity for one real install.
    expect(reloaded.getInstallId()).toBe(FIXED_ID)
  })
})
