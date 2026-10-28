// The person names their own Ethereum server in Settings > Web3, and it is asked in place of Orivon's: the light client's
// first request reaches a loopback fixture at a path that holds a key, the key shows nowhere (the Settings list, the "Servers
// it asks" row, the Networks card, the main log, a bug report's preview), the light client fails in plain words when
// the server cannot take it further and does not fall back to Orivon's, and choosing Orivon's servers again starts the
// verifier host afresh without the fixture. Hermetic: HERMETIC_RESOLVER makes every name Orivon's servers would be reached by
// unresolvable, so nothing leaves the machine; the fixture is plain http at a loopback literal, which is the one reach
// the host allows for a server of the person's.
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, mainOutput, profileDirOf } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import type { ElectronApplication, Page } from 'playwright'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const KEY = 'FAKE-KEY-0123456789abcdef'
const MASK = '••••'
/** Ports other tests and the ports checkout's server hold on this machine. */
const HELD_PORTS = new Set([8875, 8876, 8885])

interface Fixture { readonly server: Server, readonly port: number, readonly address: string, readonly paths: string[], readonly methods: string[] }

/**
 * An Ethereum server on a loopback port that answers `eth_chainId` with mainnet and every other call with 401, and records
 * the path of each request and the method it asked.
 */
async function startFixture (): Promise<Fixture> {
  const paths: string[] = []
  const methods: string[] = []
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = createServer((request, response) => {
      paths.push(request.url ?? '')
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        let call: { id?: unknown, method?: unknown } = {}
        try { call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof call } catch { /* an unreadable body is answered below */ }
        methods.push(typeof call.method === 'string' ? call.method : '')
        if (call.method === 'eth_chainId') response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? 1, result: '0x1' }))
        else response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
      })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    if (!HELD_PORTS.has(port)) return { server, port, address: `http://127.0.0.1:${String(port)}/v3/${KEY}`, paths, methods }
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  throw new Error('no free loopback port outside the ones other servers hold')
}

/** A checkpoint an hour old in the test's own profile, so the light client starts however long ago the release's was taken. */
async function seedFreshCheckpoint (profile: string): Promise<void> {
  await mkdir(join(profile, 'verifier'), { recursive: true })
  await writeFile(join(profile, 'verifier', 'checkpoint.json'), JSON.stringify({ root: `0x${'1'.repeat(64)}`, timestamp: Math.floor(Date.now() / 1000) - 3600 }))
}

/** Types a .eth name without pressing Enter, which starts the verifier host ahead of the request. */
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
  await settings.waitForSelector('#row-web3-eth-servers')
  return settings
}

async function rowText (settings: Page, row: string): Promise<string> {
  return (await settings.locator(`#row-${row} .value`).textContent().catch(() => '')) ?? ''
}

async function openNetworks (app: ElectronApplication): Promise<Page> {
  const chrome = findChrome(app)
  await chrome.click('#networks-btn')
  let panel: Page | undefined
  await waitFor(() => { panel = app.windows().find((w) => w.url().endsWith('/renderer/networks/index.html')); return panel !== undefined })
  if (panel === undefined) throw new Error('the Available networks popup did not open')
  return panel
}

async function lightClientCard (panel: Page): Promise<{ state: string, note: string }> {
  return await evaluateRetrying(panel, () => {
    const card = document.querySelector('.card[data-id="light-client"]')
    return { state: card?.querySelector('.card-status')?.textContent ?? '', note: card?.querySelector('.card-note')?.textContent ?? '' }
  })
}

async function verifierPid (app: ElectronApplication): Promise<number | undefined> {
  return await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'Orivon verifier')?.pid)
}

async function logText (app: ElectronApplication): Promise<string> {
  const profile = profileDirOf(app)
  if (profile === undefined) return ''
  return await readFile(join(profile, 'diagnostics', 'logs', 'current.log'), 'utf8').catch(() => '')
}

async function reportPreview (app: ElectronApplication): Promise<{ page: Page, text: () => Promise<string> }> {
  await findChrome(app).evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('report.open') })
  let page: Page | undefined
  await waitFor(() => { page = app.windows().find((w) => w.url().startsWith('orivon://report') && !w.isClosed()); return page !== undefined })
  if (page === undefined) throw new Error('the report page did not open')
  await page.waitForSelector('#report-what')
  return { page, text: async () => (await page?.locator('#report-preview').textContent()) ?? '' }
}

it('asks the server the person named in place of Orivon\'s, hides its key everywhere, fails in plain words, and goes back to Orivon\'s on a choice', async () => {
  await runPhase('eth-custom-rpc', async (check) => {
    const fixture = await startFixture()
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_ETH_LIGHT_CLIENT: 'on' }, seedProfile: seedFreshCheckpoint })
      await waitFor(() => app?.windows().length === 2)
      await waitForAddressBarStable(findChrome(app))
      check('the fixture is asked nothing before the person names it', fixture.paths.length === 0)

      // Settings > Web3: choose Your own servers, then add the fixture's address.
      const settings = await openWeb3Settings(app)
      check('the list of addresses is not shown while Orivon\'s servers are chosen', await settings.locator('#row-web3-eth-rpcs').count() === 0)
      await settings.locator('#row-web3-eth-servers select').selectOption('custom')
      await settings.waitForSelector('#row-web3-eth-rpcs')
      await settings.locator('#row-web3-eth-rpcs input.host-list-field').fill(fixture.address)
      await settings.locator('#row-web3-eth-rpcs button', { hasText: 'Add' }).click()
      const masked = `127.0.0.1:${String(fixture.port)}/${MASK}`
      const listed = await waitFor(async () => ((await settings.locator('#row-web3-eth-rpcs .host-list-item').allTextContents()).join(' ')).includes(masked), 15_000)
      const listedText = (await settings.locator('#row-web3-eth-rpcs').textContent()) ?? ''
      check(`the saved address is listed masked (${listedText})`, listed && !listedText.includes(KEY))

      // A .eth name starts the host with the person's server: its chain id is asked on the key path.
      await typeEthAddress(app, 'custom-rpc.eth')
      const asked = await waitFor(() => fixture.paths.length > 0, 30_000)
      check(`the fixture is asked on the path that holds the key (${fixture.paths.join(',')})`, asked && fixture.paths.every((path) => path === `/v3/${KEY}`) && fixture.methods.includes('eth_chainId'))

      // "Servers it asks": the person's server, masked, in place of Orivon's.
      let servers = ''
      const shownServers = await waitFor(async () => { servers = await rowText(settings, 'web3-servers'); return servers.includes(masked) }, 20_000)
      check(`"Servers it asks" names the server masked and not Orivon's execution servers (${servers})`, shownServers && !servers.includes(KEY) && !servers.includes('eth.drpc.org') && /Your Ethereum RPCs/.test(servers))

      // The light client cannot go further without a beacon server it can reach, and says so; Orivon's servers are not asked instead.
      let state = ''
      const failed = await waitFor(async () => { state = await rowText(settings, 'web3-state'); return /^Failed: /.test(state) && /Orivon's servers are not asked instead/.test(state) }, 60_000)
      check(`Settings says the light client failed, that Orivon's servers are not asked instead, and how to go back (${state})`, failed && /choose Orivon's servers/.test(state) && !state.includes(KEY))
      const panel = await openNetworks(app)
      let card = { state: '', note: '' }
      const cardFailed = await waitFor(async () => { card = await lightClientCard(panel); return card.state === 'Not running' && /Orivon's servers are not asked instead/.test(card.note) }, 20_000)
      check(`the Networks card says Not running with the same sentence and no key (${JSON.stringify(card)})`, cardFailed && !card.note.includes(KEY))

      // The main log and a bug report's preview hold the masked address and never the key.
      const logged = await waitFor(async () => (await logText(app as ElectronApplication)).includes(`light client asks your own servers: http://${masked}`), 20_000)
      const log = await logText(app)
      check(`the main log says which servers the light client asks, masked (${logged ? 'found' : 'missing'})`, logged)
      check('current.log holds no key', !log.includes(KEY))
      check('the main process output holds no key', !mainOutput(app).includes(KEY))
      const { page: report, text } = await reportPreview(app)
      await report.fill('#report-what', 'The light client does not start with my own server')
      let preview = ''
      const previewed = await waitFor(async () => { preview = await text(); return preview.includes('light client asks your own servers') }, 20_000)
      check('the report preview holds the masked line about the servers and the choice, never the addresses', previewed && preview.includes('"web3.ethServers":"custom"') && !preview.includes('web3.ethRpcs') && !preview.includes('web3.ethBeacon'))
      check('the report preview holds no key', !preview.includes(KEY))

      // Back to Orivon's servers: the host starts afresh and the fixture is not asked again.
      const before = fixture.paths.length
      const oldPid = await verifierPid(app)
      // The report page took the foreground; Settings comes back with its own command.
      await openWeb3Settings(app)
      await settings.locator('#row-web3-eth-servers select').selectOption('orivon')
      const gone = await waitFor(async () => { const pid = await verifierPid(app as ElectronApplication); return pid === undefined || pid !== oldPid }, 20_000)
      check('choosing Orivon\'s servers puts the running verifier host to sleep', gone)
      await typeEthAddress(app, 'orivon-servers.eth')
      const restarted = await waitFor(async () => { const pid = await verifierPid(app as ElectronApplication); return pid !== undefined && pid !== oldPid }, 30_000)
      check('the next .eth name starts a new host', restarted)
      let again = ''
      const orivons = await waitFor(async () => { again = await rowText(settings, 'web3-servers'); return again.includes('eth.drpc.org') }, 20_000)
      check(`"Servers it asks" is Orivon's again (${again})`, orivons && !again.includes('127.0.0.1'))
      await delay(ABSENCE_SETTLE_MS)
      check(`the fixture is asked nothing more (${String(fixture.paths.length)} requests, ${String(before)} before)`, fixture.paths.length === before)
      expect([listed, asked, shownServers, failed, cardFailed, logged, previewed, gone, restarted, orivons]).toEqual([true, true, true, true, true, true, true, true, true, true])
    } finally {
      if (app !== undefined) await closeElectronApp(app, APP_CLOSE_RACE_MS)
      await new Promise<void>((resolve) => { fixture.server.close(() => { resolve() }) })
    }
  })
}, 240_000)
