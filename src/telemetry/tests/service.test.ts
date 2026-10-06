import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { totalsFor } from '../accounting.js'
import { deriveInstallId } from '../install-id.js'
import type { SentPayload } from '../disclosure.js'
import { TelemetryService } from '../service.js'
import { TelemetryStore } from '../store.js'
import { SystemStore } from '../system-store.js'

const SEC = 1000
const MACHINE = '0123456789abcdef0123456789abcdef'
const start = Date.UTC(2026, 9, 6, 12, 0, 0)

describe('TelemetryService', () => {
  let dir: string
  let now: number
  let sent: SentPayload[]
  let erased: string[]
  let machineReads: number
  let sendOk: boolean
  let order: string[]
  let gate: Promise<void> | undefined
  let service: TelemetryService
  let system: SystemStore
  let store: TelemetryStore

  async function build (): Promise<void> {
    store = new TelemetryStore(join(dir, 'profile', 'telemetry.json'), () => 'ab'.repeat(16))
    await store.load()
    system = new SystemStore(join(dir, 'home'))
    service = new TelemetryService({
      store,
      system,
      version: '0.1.0',
      region: () => 'EU',
      machineReaders: { platform: 'linux', readFile: async () => { machineReads += 1; return MACHINE }, run: async () => undefined },
      randomId: () => 'cd'.repeat(16),
      clock: () => now,
      send: async (payload) => { order.push('send-start'); if (gate !== undefined) await gate; sent.push(payload); order.push('send-end'); return sendOk },
      sendErase: async (payload) => { order.push('erase'); erased.push(payload.installId); return true },
      offsetWindowMs: 0,
      notify: () => {}
    })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-telemetry-service-'))
    now = start
    sent = []
    erased = []
    machineReads = 0
    sendOk = true
    order = []
    gate = undefined
    await build()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const focused = [{ id: 1, focused: true }]

  async function browse (seconds: number, site: string): Promise<void> {
    service.noteSite(site)
    await service.checkpointTick(focused, true)
    now += seconds * SEC
    await service.checkpointTick(focused, true)
  }

  it('counts nothing and sends nothing while the person has not chosen, and never reads the machine', async () => {
    await service.checkpointTick(focused, true)
    now += 120 * SEC
    await service.checkpointTick(focused, true)
    await service.sendTick()
    expect(sent).toEqual([])
    expect(machineReads).toBe(0)
    expect(totalsFor(store.getAccountingState(), 'shell', '2026-10')).toEqual({ activeSec: 0, backgroundSec: 0 })
    const status = await service.status()
    expect(status).toMatchObject({ consent: 'undecided', installId: null })
    expect(status.usage.installId).toBe('(made when you turn this on)')
    expect(machineReads).toBe(0)
  })

  it('counts and sends once accepted, under the ID derived from the machine', async () => {
    await service.setOn(true, 'welcome')
    await browse(60, 'web3:vitalik.eth')
    await service.sendTick()
    const usage = sent.find((payload) => !('reportId' in payload))
    expect(usage).toMatchObject({ schema: 2, installId: deriveInstallId(MACHINE), stream: 'ab'.repeat(16), region: 'EU', period: '2026-10', activeSec: 60, classes: { web3: 60, web25: 0, web2: 0 } })
    expect(sent.find((payload) => 'reportId' in payload)).toMatchObject({ sites: { 'web3:vitalik.eth': 60 } })
    expect((await service.status()).sent).toHaveLength(2)
  })

  it('starts counting on the site that was already in front when it was turned on', async () => {
    service.noteSite('web25:app.example.org')
    await service.checkpointTick(focused, false)
    await service.setOn(true, 'settings')
    await service.checkpointTick(focused, true)
    now += 30 * SEC
    await service.checkpointTick(focused, true)
    expect(store.getAccountingState().perSite['2026-10']?.['web25:app.example.org']).toBe(30)
  })

  it('withdrawal stops counting and drops what was queued, and nothing pending is sent later', async () => {
    sendOk = false
    await service.setOn(true, 'welcome')
    await browse(60, 'web3:vitalik.eth')
    await service.sendTick()
    expect(sent.length).toBeGreaterThan(0)
    const before = sent.length

    await service.setOn(false, 'settings')
    sendOk = true
    now += 24 * 3600 * SEC
    await service.sendTick()
    expect(sent).toHaveLength(before)

    const counted = totalsFor(store.getAccountingState(), 'shell', '2026-10').activeSec
    now += 60 * SEC
    await service.checkpointTick(focused, true)
    expect(totalsFor(store.getAccountingState(), 'shell', '2026-10').activeSec).toBe(counted)
  })

  it('reads a choice another profile made, at the next tick', async () => {
    await new SystemStore(join(dir, 'home')).writeConsent({ state: 'accepted', atMs: start, noticeVersion: 2, source: 'welcome', everAccepted: true })
    await service.checkpointTick(focused, true)
    now += 40 * SEC
    await service.checkpointTick(focused, true)
    expect(totalsFor(store.getAccountingState(), 'shell', '2026-10').activeSec).toBe(40)
  })

  it('ignores an acceptance given under an older notice', async () => {
    await system.writeConsent({ state: 'accepted', atMs: start, noticeVersion: 1, source: 'welcome', everAccepted: true })
    expect(await service.consent()).toBe('undecided')
    await service.sendTick()
    expect(sent).toEqual([])
  })

  it('delete my data: turns telemetry off, forgets what was counted and asks the server to erase the install ID', async () => {
    await service.setOn(true, 'welcome')
    await browse(60, 'web3:vitalik.eth')
    expect((await service.status()).everAccepted).toBe(true)
    const outcome = await service.erase()
    expect(outcome).toBe('done')
    expect(erased).toEqual([deriveInstallId(MACHINE)])
    expect(await service.consent()).toBe('declined')
    expect(store.getAccountingState().perSite).toEqual({})
    expect((await service.status()).usage.activeSec).toBe(0)
    expect((await service.status()).everAccepted).toBe(false)
  })

  it('offers the welcome choice only while the system consent is open', async () => {
    expect(await service.offerAtWelcome()).toBe(true)
    await service.setOn(false, 'welcome')
    expect(await service.offerAtWelcome()).toBe(false)
  })

  it('writes the counted time to disk at each checkpoint', async () => {
    await service.setOn(true, 'welcome')
    await browse(60, 'web2')
    const reloaded = new TelemetryStore(join(dir, 'profile', 'telemetry.json'))
    await reloaded.load()
    expect(totalsFor(reloaded.getAccountingState(), 'shell', '2026-10').activeSec).toBe(60)
    vi.restoreAllMocks()
  })

  it('delete my data with nothing ever accepted: says there is nothing to delete, reads no machine and posts nothing', async () => {
    expect((await service.status()).everAccepted).toBe(false)
    expect(await service.erase()).toBe('nothing')
    await service.setOn(false, 'welcome')
    expect(await service.erase()).toBe('nothing')
    expect(machineReads).toBe(0)
    expect(erased).toEqual([])
  })

  it('keeps knowing that an acceptance happened after a refusal, so the data can still be deleted', async () => {
    await service.setOn(true, 'welcome')
    await service.setOn(false, 'settings')
    expect((await service.status()).everAccepted).toBe(true)
    expect(await service.erase()).toBe('done')
  })

  it('delete my data waits for a send in flight: its result is discarded, its POST lands before the erase, and no history is left', async () => {
    await service.setOn(true, 'welcome')
    await browse(60, 'web3:vitalik.eth')
    let open: () => void = () => {}
    gate = new Promise<void>((resolve) => { open = resolve })
    const tick = service.sendTick()
    while (!order.includes('send-start')) await new Promise((resolve) => setTimeout(resolve, 1))

    const erasing = service.erase()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(order).not.toContain('erase')

    open()
    gate = undefined
    await tick
    expect(await erasing).toBe('done')
    expect(order.indexOf('erase')).toBeGreaterThan(order.indexOf('send-end'))
    expect(order.filter((entry) => entry === 'send-start')).toHaveLength(1)
    expect(store.getHistoryState().entries).toEqual([])
    expect((await service.status()).sent).toEqual([])
    expect(store.getAccountingState().perSite).toEqual({})
  })

  it('turning it off mid-send discards the finishing send and never writes its history back', async () => {
    await service.setOn(true, 'welcome')
    await browse(60, 'web3:vitalik.eth')
    let open: () => void = () => {}
    gate = new Promise<void>((resolve) => { open = resolve })
    const tick = service.sendTick()
    while (!order.includes('send-start')) await new Promise((resolve) => setTimeout(resolve, 1))
    const turningOff = service.setOn(false, 'settings')
    await new Promise((resolve) => setTimeout(resolve, 30))
    open()
    gate = undefined
    await Promise.all([tick, turningOff])
    expect(order.filter((entry) => entry === 'send-start')).toHaveLength(1)
    expect(store.getHistoryState().entries).toEqual([])
  })

  it('does not credit the time between a process that lost its quit write and the next one', async () => {
    await service.setOn(true, 'welcome')
    await browse(60, 'web2')
    await store.checkpoint()
    await service.setOn(false, 'settings')
    // The old process saved with its session open and then vanished.
    const raw = JSON.parse(await readFile(join(dir, 'profile', 'telemetry.json'), 'utf8')) as { accounting: Record<string, unknown> }
    raw.accounting['openSessions'] = { shell: 1 }
    raw.accounting['lastAccountedAt'] = now
    await writeFile(join(dir, 'profile', 'telemetry.json'), JSON.stringify(raw), 'utf8')
    now += 10 * 24 * 3600 * SEC
    await build()
    await service.setOn(true, 'settings')
    await service.checkpointTick(focused, false)
    now += 60 * SEC
    await service.checkpointTick(focused, false)
    expect(totalsFor(store.getAccountingState(), 'shell', '2026-10').backgroundSec).toBeLessThan(200)
  })

  it('writes the end of the counting to disk when it is turned off', async () => {
    await service.setOn(true, 'welcome')
    await browse(30, 'web2')
    await service.setOn(false, 'settings')
    const reloaded = new TelemetryStore(join(dir, 'profile', 'telemetry.json'))
    await reloaded.load()
    expect(reloaded.getAccountingState().openSessions).toEqual({})
    expect(totalsFor(reloaded.getAccountingState(), 'shell', '2026-10').activeSec).toBe(30)
  })
})
