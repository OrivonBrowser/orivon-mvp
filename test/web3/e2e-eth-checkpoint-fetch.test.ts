// A release whose own checkpoint has aged out renews it at run time: opening a .eth name asks two beacon servers for
// the finalized block, uses it only if they agree, and Settings says where the checkpoint came from. When they
// disagree it is not used, Settings says why, and the servers are not asked again for a while. The beacon servers are
// two loopback fixtures named by the test build; the release's checkpoint is taken to be 30 days old.
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import type { ElectronApplication, Page } from 'playwright'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const GENESIS_SECONDS = 1_606_824_023
const ROOT_A = `0x${'a'.repeat(64)}`
const ROOT_B = `0x${'b'.repeat(64)}`

interface Beacon { readonly server: Server, readonly origin: string, readonly seen: string[] }

/** A beacon server that answers every finalized-header request with `root` at the block an hour before now, and records the paths asked. */
async function startBeacon (root: string): Promise<Beacon> {
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(request.url ?? '')
    const slot = Math.floor((Date.now() / 1000 - 3600 - GENESIS_SECONDS) / 12)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ execution_optimistic: false, finalized: true, data: { root, canonical: true, header: { message: { slot: String(slot) } } } }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen }
}

async function launch (beacons: readonly Beacon[]): Promise<ElectronApplication> {
  return await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_ETH_LIGHT_CLIENT: 'on', ORIVON_TEST_SHIPPED_CHECKPOINT_AGE_DAYS: '30', ORIVON_TEST_BEACON_APIS: beacons.map((b) => b.origin).join(',') }
  })
}

async function typeEthAddress (app: ElectronApplication, name: string): Promise<void> {
  const chrome = findChrome(app)
  await chrome.click('#address')
  await chrome.fill('#address', name)
}

async function openWeb3Settings (app: ElectronApplication): Promise<Page> {
  const chrome = findChrome(app)
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/web3') })
  let settings: Page | undefined
  await waitFor(() => { settings = app.windows().find((w) => w.url().startsWith('orivon://settings')); return settings !== undefined })
  if (settings === undefined) throw new Error('Settings did not open')
  return settings
}

async function checkpointRow (settings: Page): Promise<string> {
  return (await settings.locator('#row-web3-checkpoint .value').textContent().catch(() => '')) ?? ''
}

it('fetches a checkpoint from two beacon servers that agree, uses it, and says where it came from', async () => {
  await runPhase('checkpoint-fetch-agree', async (check) => {
    const a = await startBeacon(ROOT_A)
    const b = await startBeacon(ROOT_A)
    let app: ElectronApplication | undefined
    try {
      app = await launch([a, b])
      await waitFor(() => app?.windows().length === 2)
      await waitForAddressBarStable(findChrome(app))
      check('no beacon server is asked before a .eth name is needed', a.seen.length === 0 && b.seen.length === 0)
      await typeEthAddress(app, 'checkpoint-fetch.eth')
      const asked = await waitFor(() => a.seen.length === 1 && b.seen.length === 1, 20_000)
      check(`both servers are asked once, for the finalized header (${a.seen.join(',')} ${b.seen.join(',')})`, asked && a.seen[0] === '/eth/v1/beacon/headers/finalized' && b.seen[0] === '/eth/v1/beacon/headers/finalized')
      const settings = await openWeb3Settings(app)
      let row = ''
      const said = await waitFor(async () => { row = await checkpointRow(settings); return /fetched while a \.eth name was opened/.test(row) }, 20_000)
      check(`Settings says the checkpoint was fetched, with its date and the servers that agreed (${row})`, said && /dated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(row) && row.includes('127.0.0.1 and 127.0.0.1 gave the same answer'))
      const servers = (await settings.locator('#row-web3-servers .value').textContent()) ?? ''
      check('Settings lists the servers asked for a fresh checkpoint', servers.includes(`Beacon servers for a fresh checkpoint, asked only when none is recent enough: ${a.origin}, ${b.origin}`))
      expect([asked, said]).toEqual([true, true])
    } finally {
      if (app !== undefined) await closeElectronApp(app, APP_CLOSE_RACE_MS)
      a.server.close()
      b.server.close()
    }
  })
}, 120_000)

it('uses nothing when the servers disagree, says why, and does not ask them again at once', async () => {
  await runPhase('checkpoint-fetch-disagree', async (check) => {
    const a = await startBeacon(ROOT_A)
    const b = await startBeacon(ROOT_B)
    let app: ElectronApplication | undefined
    try {
      app = await launch([a, b])
      await waitFor(() => app?.windows().length === 2)
      await waitForAddressBarStable(findChrome(app))
      await typeEthAddress(app, 'checkpoint-fetch.eth')
      await waitFor(() => a.seen.length === 1 && b.seen.length === 1, 20_000)
      const settings = await openWeb3Settings(app)
      let row = ''
      const said = await waitFor(async () => { row = await checkpointRow(settings); return /did not give the same answer/.test(row) }, 20_000)
      check(`Settings says no checkpoint is usable and why (${row})`, said && /^No usable checkpoint: the newest checkpoint \(shipped with this release\) is 30 days old/.test(row) && /A fresh one could not be fetched from the beacon servers: the beacon servers did not give the same answer/.test(row))
      await typeEthAddress(app, 'another-name.eth')
      await delay(ABSENCE_SETTLE_MS)
      check(`a second name opened within the wait asks nobody again (${String(a.seen.length)}, ${String(b.seen.length)})`, a.seen.length === 1 && b.seen.length === 1)
      expect(said).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app, APP_CLOSE_RACE_MS)
      a.server.close()
      b.server.close()
    }
  })
}, 120_000)
