import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { nodeLedgerStorage } from '../../../broker/grants/node-ledger-storage.js'
import { APP, baseDeps, manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { SubsystemContext } from '../../registry.js'
import { createAppSwitches } from '../app-switches.js'
import { createPermissionsController } from '../permissions.js'

// Proven against a real broker over a real directory, so a restart is a second broker over the same files.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-app-switches-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const brokerOver = (): Broker => createBroker({ ...baseDeps(), ledgerStorage: nodeLedgerStorage(dir) })
const ctxOf = (broker: Broker): SubsystemContext => ({ broker }) as unknown as SubsystemContext
const MANIFEST = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })

describe('the apps card switches for an app that is open', () => {
  it('has a row for everything the app declares, on for what it holds and off for the rest', async () => {
    const broker = brokerOver()
    await broker.registerApp(APP, MANIFEST)
    await broker.grant(APP, 'fs', [])
    const rows = await createAppSwitches(ctxOf(broker)).rowsFor(APP)
    expect(rows.map((row) => [row.capability, row.on, row.canTurnOn]).sort()).toEqual([['fs', true, true], ['tcp.connect', false, true]])
  })

  it('switches a capability off, keeping the row, and on again within what the manifest declares', async () => {
    const broker = brokerOver()
    await broker.registerApp(APP, MANIFEST)
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])
    const switches = createAppSwitches(ctxOf(broker))

    expect(await switches.set(APP, 'tcp.connect', false, [])).toBe('ok')
    expect(await broker.app.grants(APP)).toEqual([])
    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
    const off = (await switches.rowsFor(APP)).find((row) => row.capability === 'tcp.connect')
    expect(off).toMatchObject({ on: false, canTurnOn: true })

    expect(await switches.set(APP, 'tcp.connect', true, off?.patterns ?? [])).toBe('ok')
    expect(broker.app.heldSync(APP, 'tcp.connect')).toBe(true)
    expect(await broker.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  it('tells the chrome after each switch it moved, so the key\'s dot follows at once, and not after one it refused', async () => {
    const broker = brokerOver()
    await broker.registerApp(APP, MANIFEST)
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])
    const changed = vi.fn()
    const switches = createAppSwitches(ctxOf(broker), () => undefined, changed)
    await switches.set(APP, 'tcp.connect', false, [])
    expect(changed).toHaveBeenCalledTimes(1)
    await switches.set(APP, 'tcp.connect', true, ['other.example:443'])
    expect(changed).toHaveBeenCalledTimes(1)
    const row = (await switches.rowsFor(APP)).find((candidate) => candidate.capability === 'tcp.connect')
    await switches.set(APP, 'tcp.connect', true, row?.patterns ?? [])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('grants nothing when the patterns the row showed are not what the manifest says now', async () => {
    const broker = brokerOver()
    await broker.registerApp(APP, MANIFEST)
    expect(await createAppSwitches(ctxOf(broker)).set(APP, 'tcp.connect', true, ['other.example:443'])).toBe('stale')
    expect(broker.app.heldSync(APP, 'tcp.connect')).toBe(false)
  })

  it('shows an unlimited grant without its warning at Level 4, and with it otherwise (ADR-0037)', async () => {
    const broker = brokerOver()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    await broker.grant(APP, 'tcp.connect', ['*:*'])
    expect((await createAppSwitches(ctxOf(broker)).rowsFor(APP))[0]).toMatchObject({ warning: true })
    expect((await createAppSwitches(ctxOf(broker), () => 4).rowsFor(APP))[0]).toMatchObject({ warning: false })
  })

  it('refuses to turn on a capability the manifest does not declare', async () => {
    const broker = brokerOver()
    await broker.registerApp(APP, MANIFEST)
    expect(await createAppSwitches(ctxOf(broker)).set(APP, 'media.camera', true, [])).toBe('not-declared')
  })
})

describe('the apps card switches for an app not opened since Orivon started', () => {
  async function restarted (): Promise<Broker> {
    const first = brokerOver()
    await first.registerApp(APP, MANIFEST)
    await first.grant(APP, 'tcp.connect', ['api.example.com:443'])
    await first.grant(APP, 'fs', [])
    return brokerOver()
  }

  it('shows what it holds as on, and lets the person switch it off', async () => {
    const broker = await restarted()
    const switches = createAppSwitches(ctxOf(broker))
    expect((await switches.rowsFor(APP)).map((row) => [row.capability, row.on]).sort()).toEqual([['fs', true], ['tcp.connect', true]])
    expect(await switches.set(APP, 'fs', false, [])).toBe('ok')
    expect(Object.keys(broker.app.persistedAppsSync()[0]?.grants ?? {})).toEqual(['tcp.connect'])
  })

  it('keeps what was switched off as an off row that waits for the app to be opened, and lists the app', async () => {
    const broker = await restarted()
    const switches = createAppSwitches(ctxOf(broker))
    await switches.set(APP, 'fs', false, [])
    await switches.set(APP, 'tcp.connect', false, [])

    const rows = await switches.rowsFor(APP)
    expect(rows.map((row) => [row.capability, row.on, row.canTurnOn]).sort()).toEqual([['fs', false, false], ['tcp.connect', false, false]])
    expect(await switches.set(APP, 'fs', true, [])).toBe('not-registered')
    // The grant list leaves it out, as it always did; the Settings card adds it through `idleApps`.
    expect(await createPermissionsController(ctxOf(broker)).list()).toEqual([])
    expect(await switches.idleApps(new Set())).toEqual([{ origin: APP, appName: expect.any(String) as string }])
    expect(await switches.idleApps(new Set([APP]))).toEqual([])
  })

  it('does not list a record that holds nothing and remembers no refusal', async () => {
    const broker = await restarted()
    await broker.revokePersisted(APP, 'fs')
    await broker.revokePersisted(APP, 'tcp.connect')
    expect(await createPermissionsController(ctxOf(broker)).list()).toEqual([])
    expect(await createAppSwitches(ctxOf(broker)).idleApps(new Set())).toEqual([])
  })
})
