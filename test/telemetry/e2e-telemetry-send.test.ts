// Telemetry on a real launch, against a loopback stand-in for the server: with consent it sends both
// reports and they hold what the notice says; with no choice, a refusal, a withdrawal or a launch that has
// telemetry off, nothing is sent. The counting itself runs on the real tab events and the real trust
// answer for a `.eth` fixture; only "focused and in use" is assumed (ORIVON_TELEMETRY_ASSUME_ACTIVE),
// because a headless run has no focused window and no input.
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { closeElectronApp, navigateToFixture } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, HERMETIC_RESOLVER, findChrome, waitFor } from '../support/smoke-helpers.mjs'
import { startIngest, telemetryHomeFolder, type Ingest, type IngestRequest } from '../support/telemetry-ingest.js'

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

const TEST_TIMEOUT_MS = 90_000
const HEX32 = /^[0-9a-f]{32}$/
const ACCEPTED = { state: 'accepted', atMs: Date.now(), noticeVersion: 4, source: 'welcome' }

interface Rig {
  readonly ingest: Ingest
  readonly home: string
  readonly ordinaryUrl: string
  readonly gatewayUrl: string
  readonly levelRoot: string
  stop: () => Promise<void>
}

async function rig (consent: unknown): Promise<Rig> {
  const ingest = await startIngest()
  const folder = await telemetryHomeFolder()
  if (consent !== undefined) await writeFile(join(folder.home, 'consent.json'), JSON.stringify(consent), 'utf8')
  const gateway = await startFixtureGateway({ level: { 'index.html': '<!doctype html><meta charset="utf-8"><title>level fixture</title><body>level</body>' } })
  const ordinary = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>ordinary page</title><body>ordinary</body>') })
  await new Promise<void>((resolve) => { ordinary.listen(0, '127.0.0.1', resolve) })
  return {
    ingest,
    home: folder.home,
    ordinaryUrl: `http://127.0.0.1:${String((ordinary.address() as AddressInfo).port)}/`,
    gatewayUrl: gateway.url,
    levelRoot: gateway.roots['level'] as string,
    stop: async () => { await ingest.close(); await gateway.close(); ordinary.close(); await folder.remove() }
  }
}

async function launchWith (r: Rig, env: Record<string, string> = {}): Promise<ElectronApplication> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: {
      ORIVON_TELEMETRY: 'on',
      ORIVON_TELEMETRY_HOME: r.home,
      ORIVON_TELEMETRY_URL: r.ingest.url,
      ORIVON_TELEMETRY_TICK_MS: '300',
      ORIVON_TELEMETRY_ASSUME_ACTIVE: '1',
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'level.eth': `ipfs://${r.levelRoot}` }),
      ORIVON_TEST_IPFS_GATEWAYS: r.gatewayUrl,
      ORIVON_TEST_DOH: `${r.gatewayUrl}/dns-query`,
      ...env
    }
  })
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
  if (!listening) throw new Error('the verifier host never reported listening')
  return app
}

const posted = (r: Rig, path: string): IngestRequest[] => r.ingest.requests.filter((request) => request.path === path)
const sorted = (value: Record<string, unknown>): string[] => Object.keys(value).sort()

it('with consent, sends the usage report and the sites report, each holding exactly what the notice lists', async () => {
  const r = await rig(ACCEPTED)
  let app: ElectronApplication | undefined
  try {
    app = await launchWith(r)
    await navigateToFixture(app, 'https://level.eth/', 'level fixture')
    // Seconds on the .eth site, counted from the real tab events and the real trust answer: Web2.5 (Level 2).
    expect(await waitFor(() => posted(r, '/v1/sites').some((request) => ((request.body['sites'] ?? {}) as Record<string, number>)['web25:level.eth'] !== undefined), 30_000)).toBe(true)
    await navigateToFixture(app, r.ordinaryUrl, 'ordinary page')
    expect(await waitFor(() => posted(r, '/v1/usage').some((request) => ((request.body['classes'] ?? {}) as Record<string, number>)['web2'] !== undefined && ((request.body['classes'] as Record<string, number>)['web2'] ?? 0) >= 1), 30_000)).toBe(true)

    const usage = posted(r, '/v1/usage').at(-1)?.body as Record<string, unknown>
    expect(sorted(usage)).toEqual(['activeSec', 'backgroundSec', 'classes', 'country', 'installId', 'period', 'schema', 'stream', 'version'])
    expect(sorted(usage['classes'] as Record<string, unknown>)).toEqual(['web2', 'web25', 'web3'])
    expect(usage).toMatchObject({ schema: 4 })
    expect(usage['installId']).toMatch(HEX32)
    expect(usage['stream']).toMatch(HEX32)
    expect(usage['country']).toMatch(/^([A-Z]{2}|unknown)$/)
    expect(usage['period']).toBe(new Date().toISOString().slice(0, 7))
    expect((usage['classes'] as Record<string, number>)['web25']).toBeGreaterThanOrEqual(1)
    expect(usage['activeSec'] as number).toBeGreaterThanOrEqual(2)

    const sites = posted(r, '/v1/sites').at(-1)?.body as Record<string, unknown>
    expect(sorted(sites)).toEqual(['installId', 'period', 'schema', 'sites', 'stream', 'version'])
    expect(sites).toMatchObject({ schema: 4, installId: usage['installId'], stream: usage['stream'] })
    expect(sorted(sites['sites'] as Record<string, unknown>)).toEqual(['web25:level.eth'])

    // Both reports carry the same install ID and stream, and neither names a Web2 site.
    expect(JSON.stringify(usage)).not.toContain('level.eth')
    expect(JSON.stringify(r.ingest.requests)).not.toContain('127.0.0.1')
    expect(posted(r, '/v1/erase')).toEqual([])
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await r.stop()
  }
}, TEST_TIMEOUT_MS)

it('accepting in Settings sends at once, without waiting for a tick, and quitting sends a last snapshot', async () => {
  const r = await rig(undefined)
  let app: ElectronApplication | undefined
  try {
    // A tick far longer than the test: nothing below can be a timer's send.
    app = await launchWith(r, { ORIVON_TELEMETRY_TICK_MS: '600000' })
    await navigateToFixture(app, 'https://level.eth/', 'level fixture')
    const chrome = findChrome(app)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/privacy') })
    expect(await waitFor(() => app?.windows().some((w) => w.url().startsWith('orivon://settings')) === true)).toBe(true)
    const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await page.waitForSelector('#row-usage-statistics #usage-state')
    expect(r.ingest.requests).toEqual([])
    await page.locator('#row-usage-statistics .switch').click()
    expect(await waitFor(() => posted(r, '/v1/usage').length > 0, 15_000)).toBe(true)
    expect(posted(r, '/v1/usage')[0]?.body).toMatchObject({ schema: 4, period: new Date().toISOString().slice(0, 7) })

    const before = posted(r, '/v1/usage').length
    await closeElectronApp(app)
    app = undefined
    expect(posted(r, '/v1/usage').length).toBeGreaterThan(before)
    const last = posted(r, '/v1/usage').at(-1)?.body as Record<string, unknown>
    expect(last['installId']).toBe(posted(r, '/v1/usage')[0]?.body['installId'])
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await r.stop()
  }
}, TEST_TIMEOUT_MS)

it('sends nothing when the person has not chosen, or has refused', async () => {
  for (const consent of [undefined, { state: 'declined', atMs: Date.now(), noticeVersion: 4, source: 'welcome' }]) {
    const r = await rig(consent)
    let app: ElectronApplication | undefined
    try {
      app = await launchWith(r)
      await navigateToFixture(app, 'https://level.eth/', 'level fixture')
      await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS * 2))
      expect(r.ingest.requests).toEqual([])
      // Nothing was counted either.
      const file = join(await app.evaluate(({ app: electron }) => electron.getPath('userData')), 'telemetry.json')
      const accounting = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { accounting: { perSite: Record<string, unknown> } }).accounting : { perSite: {} }
      expect(accounting.perSite).toEqual({})
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await r.stop()
    }
  }
}, TEST_TIMEOUT_MS * 2)

it('sends nothing after consent is withdrawn, by a choice another profile made at its next tick', async () => {
  const r = await rig(ACCEPTED)
  let app: ElectronApplication | undefined
  try {
    app = await launchWith(r)
    await navigateToFixture(app, 'https://level.eth/', 'level fixture')
    expect(await waitFor(() => posted(r, '/v1/usage').length > 0 && posted(r, '/v1/sites').length > 0, 30_000)).toBe(true)

    await writeFile(join(r.home, 'consent.json'), JSON.stringify({ state: 'declined', atMs: Date.now(), noticeVersion: 4, source: 'settings' }), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const before = r.ingest.requests.length
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS * 2))
    expect(r.ingest.requests.length).toBe(before)
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await r.stop()
  }
}, TEST_TIMEOUT_MS)

it('sends nothing when the launch has telemetry off, whatever the consent file says', async () => {
  const r = await rig(ACCEPTED)
  let app: ElectronApplication | undefined
  try {
    app = await launchWith(r, { ORIVON_TELEMETRY: 'off' })
    await navigateToFixture(app, 'https://level.eth/', 'level fixture')
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS * 2))
    expect(r.ingest.requests).toEqual([])
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await r.stop()
  }
}, TEST_TIMEOUT_MS)
