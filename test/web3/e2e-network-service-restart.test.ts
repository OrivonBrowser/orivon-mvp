// Chromium's network service is a process of its own, and the next one starts without what Orivon set on the old one:
// the certificate check the verifier's pages need, and secure DNS. The service is ended here the way a crash or the
// system's out-of-memory killer ends it. The pages that need the verifier still load, a request that starts after the
// process ended waits for the settings and then goes through, secure DNS is set again, and the report says what
// happened. Chromium offers no read of the resolver, so secure DNS is observed through the test seam
// (`__orivonDevNetworkService`): what main set the resolver to, in order.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { closeElectronApp, navigateToFixture } from '../support/e2e-helpers.js'
import { delay, waitFor } from '../support/smoke-helpers.mjs'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

interface Seam {
  ended: number
  resent: number
  resolverCalls: Array<{ at: number, mode: string | undefined, servers: number }>
  certificateChecks: number[]
  holds: Array<{ outcome: string, requests: number }>
}

const SITE = (name: string): Record<string, string> => ({ 'index.html': `<!doctype html><meta charset="utf-8"><title>${name} fixture</title><body>${name}</body>` })
const NAMES = ['first', 'held', 'later'] as const

/** Long enough that a request started once the new service answers is still inside the hold, short enough to keep the spec quick. */
const REAPPLY_DELAY_MS = 2_500

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function seed (dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'privacy.secureDns': 'cloudflare' } }))
}

const seamOf = async (app: ElectronApplication): Promise<Seam> =>
  await app.evaluate(() => structuredClone((globalThis as { __orivonDevNetworkService?: Seam }).__orivonDevNetworkService ?? { ended: 0, resent: 0, resolverCalls: [], certificateChecks: [], holds: [] }))

const networkServicePid = async (app: ElectronApplication): Promise<number> =>
  await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().find((metric) => metric.type === 'Utility' && metric.serviceName === 'network.mojom.NetworkService')?.pid ?? 0)

async function openReport (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('report.open') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://report') && !w.isClosed()))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://report') && !w.isClosed()) as Page
  await page.waitForSelector('#report-what')
  return page
}

/** The report as the form shows it, once `ok` holds: main rebuilds the preview shortly after the page asks. */
async function reportWhere (page: Page, ok: (report: { log: string[], diagnostics: { recentCrashes: Array<{ process: string, reason: string }> } }) => boolean): Promise<{ log: string[], diagnostics: { recentCrashes: Array<{ process: string, reason: string }> } }> {
  let last = { log: [] as string[], diagnostics: { recentCrashes: [] as Array<{ process: string, reason: string }> } }
  const read = async (): Promise<typeof last> => {
    const shown = JSON.parse(await page.locator('#report-preview').textContent() ?? '{}') as { log?: string[] | null, diagnostics?: typeof last.diagnostics | null }
    return { log: shown.log ?? [], diagnostics: shown.diagnostics ?? { recentCrashes: [] } }
  }
  expect(await waitFor(async () => { last = await read(); return ok(last) }, 15_000), JSON.stringify(last).slice(0, 600)).toBe(true)
  return last
}

async function launched (gateway: Awaited<ReturnType<typeof startFixtureGateway>>, env: Record<string, string>): Promise<{ app: ElectronApplication, chrome: Page }> {
  const { app, chrome } = await launchShell({
    seedProfile: seed,
    env: {
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify(Object.fromEntries(NAMES.map((name) => [`${name}.eth`, `ipfs://${gateway.roots[name]!}`]))),
      ORIVON_TEST_IPFS_GATEWAYS: gateway.url,
      ...env
    }
  })
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
  if (!listening) throw new Error('the verifier host never reported listening')
  return { app, chrome }
}

it('sends the certificate check and secure DNS again, holds a request started after the service ended, and reports it', async () => {
  const gateway = await startFixtureGateway(Object.fromEntries(NAMES.map((name) => [name, SITE(name)])))
  let app: ElectronApplication | undefined
  try {
    const started = await launched(gateway, { ORIVON_TEST_NETWORK_SERVICE_REAPPLY_DELAY_MS: String(REAPPLY_DELAY_MS) })
    app = started.app
    const running = app
    await navigateToFixture(running, 'https://first.eth/', 'first fixture')

    const before = await seamOf(running)
    expect(before.ended).toBe(0)
    expect(before.resolverCalls).toHaveLength(1)
    expect(before.resolverCalls[0]).toMatchObject({ mode: 'secure', servers: 1 })

    const oldPid = await networkServicePid(running)
    expect(oldPid).toBeGreaterThan(0)
    const killedAt = Date.now()
    process.kill(oldPid, 'SIGKILL')

    // The service ended, and the next one answers: a request from here on reaches Chromium's new network context.
    expect(await waitFor(async () => (await seamOf(running)).ended === 1, 15_000)).toBe(true)
    expect(await waitFor(async () => await running.evaluate(async ({ session }) => await session.defaultSession.resolveHost('127.0.0.1').then(() => true, () => false)), 15_000)).toBe(true)
    expect((await seamOf(running)).resent).toBe(0)

    // Started inside the hold: it must wait for the certificate check, not reach the new service with the default one,
    // which refuses the verifier's certificate and keeps refusing it for that host.
    const held = await running.evaluate(async ({ webContents }) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().includes('first.eth'))
      if (tab === undefined) return { outcome: 'no tab' as const, resent: -1 }
      const outcome = await tab.loadURL('https://held.eth/').then(() => 'loaded' as const, (error: unknown) => String(error))
      const seam = (globalThis as { __orivonDevNetworkService?: { resent: number } }).__orivonDevNetworkService
      return { outcome, resent: seam?.resent ?? -1, title: tab.getTitle() }
    })
    expect(held).toMatchObject({ outcome: 'loaded', resent: 1, title: 'held fixture' })

    // A second verifier page, opened the ordinary way, loads too.
    await navigateToFixture(running, 'https://later.eth/', 'later fixture')

    const after = await seamOf(running)
    expect(after.ended).toBe(1)
    expect(after.certificateChecks).toHaveLength(1)
    expect(after.certificateChecks[0]).toBeGreaterThanOrEqual(2)
    expect(after.resolverCalls).toHaveLength(2)
    expect(after.resolverCalls[1]).toMatchObject({ mode: 'secure', servers: 1 })
    expect(after.resolverCalls[1]!.at).toBeGreaterThanOrEqual(killedAt)
    expect(await networkServicePid(running)).not.toBe(oldPid)

    // What orivon://report collects: the log lines, and the end among the recorded problems.
    const report = await reportWhere(await openReport(running, started.chrome), ({ log }) => log.some((line) => line.includes('settings sent again')) && log.some((line) => line.includes('waited')))
    const ours = report.log.filter((line) => line.includes('[network-service]'))
    expect(ours.some((line) => line.includes('the network service ended (killed'))).toBe(true)
    const sent = ours.find((line) => /settings sent again \d+ ms after the service ended, answering after \d+ ms: /.test(line)) ?? ''
    expect(sent).toMatch(/certificate check \(\d+ sessions\)/)
    expect(sent).toMatch(/secure DNS \(secure, 1 server\)/)
    expect(sent).toMatch(/verifier host \(put to sleep\)/)
    expect(ours.some((line) => /[1-9]\d* requests? waited \d+ ms and went on/.test(line))).toBe(true)
    expect(report.diagnostics.recentCrashes).toContainEqual(expect.objectContaining({ process: 'Utility:network.mojom.NetworkService', reason: 'killed' }))
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await gateway.close()
  }
}, QA_TEST_TIMEOUT_MS)

it('loads a verifier page started as the new service answers, with no padding on the settings being sent', async () => {
  const gateway = await startFixtureGateway(Object.fromEntries(NAMES.map((name) => [name, SITE(name)])))
  let app: ElectronApplication | undefined
  try {
    const started = await launched(gateway, {})
    app = started.app
    const running = app
    await navigateToFixture(running, 'https://first.eth/', 'first fixture')
    const oldPid = await networkServicePid(running)
    expect(oldPid).toBeGreaterThan(0)

    // The load starts the instant the new network context answers: it races the settings being sent, with no padding.
    const loading = running.evaluate(async ({ app: electronApp, session, webContents }) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().includes('first.eth'))
      if (tab === undefined) return 'no tab'
      return await new Promise<string>((resolve) => {
        electronApp.on('child-process-gone', (_event, details) => {
          if (details.serviceName !== 'network.mojom.NetworkService') return
          const answered = async (): Promise<void> => {
            while (!await session.defaultSession.resolveHost('127.0.0.1').then(() => true, () => false)) await new Promise((wake) => setTimeout(wake, 5))
          }
          void answered().then(async () => await tab.loadURL('https://held.eth/')).then(() => { resolve(tab.getTitle()) }, (error: unknown) => { resolve(String(error)) })
        })
      })
    })
    await delay(200)
    process.kill(oldPid, 'SIGKILL')
    expect(await loading).toBe('held fixture')

    await navigateToFixture(running, 'https://later.eth/', 'later fixture')
    const after = await seamOf(running)
    expect(after.ended).toBe(1)
    expect(after.holds).toEqual([{ outcome: 'reapplied', requests: expect.any(Number) }])
    expect(after.resolverCalls).toHaveLength(2)
    expect(after.resolverCalls[1]).toMatchObject({ mode: 'secure', servers: 1 })
    expect(await networkServicePid(running)).not.toBe(oldPid)
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await gateway.close()
  }
}, QA_TEST_TIMEOUT_MS)

it('lets requests go at the bound when the settings cannot be sent, and the report says so', async () => {
  const gateway = await startFixtureGateway(Object.fromEntries(NAMES.map((name) => [name, SITE(name)])))
  let app: ElectronApplication | undefined
  try {
    const started = await launched(gateway, { ORIVON_TEST_NETWORK_SERVICE_REAPPLY_DELAY_MS: '20000', ORIVON_TEST_NETWORK_SERVICE_HOLD_BOUND_MS: '800' })
    app = started.app
    const running = app
    const pid = await networkServicePid(running)
    expect(pid).toBeGreaterThan(0)
    process.kill(pid, 'SIGKILL')
    expect(await waitFor(async () => (await seamOf(running)).ended === 1, 15_000)).toBe(true)
    expect(await waitFor(async () => (await seamOf(running)).holds.length === 1, 15_000)).toBe(true)
    expect((await seamOf(running)).holds[0]).toEqual({ outcome: 'timed-out', requests: 0 })
    expect((await seamOf(running)).resent).toBe(0)
    const report = await reportWhere(await openReport(running, started.chrome), ({ log }) => log.some((line) => line.includes('the settings were not sent again within')))
    expect(report.log.some((line) => /\[network-service\] the settings were not sent again within \d+ ms: 0 requests went on without them/.test(line))).toBe(true)
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await gateway.close()
  }
}, QA_TEST_TIMEOUT_MS)
