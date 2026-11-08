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
import { NETWORK_SERVICE, networkServicePid, seamOf, startCountedPage } from '../support/network-service-restart.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

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

interface Loaded { outcome: string, resentAtStart: number, resentAfter: number, title: string }

/**
 * Arms a load of `url` in the tab showing `shown`, to start from main the instant the next network service answers a
 * lookup on that tab's session: after the service ended and before any padded sending of its settings. Kill the service
 * after calling it.
 */
const loadWhenServiceAnswers = async (app: ElectronApplication, url: string, shown: string): Promise<Loaded> =>
  await app.evaluate(async ({ app: electronApp, webContents }, { target, part, service }) => {
    const tab = webContents.getAllWebContents().find((contents) => contents.getURL().includes(part))
    const resent = (): number => (globalThis as { __orivonDevNetworkService?: { resent: number } }).__orivonDevNetworkService?.resent ?? -1
    if (tab === undefined) return { outcome: 'no tab', resentAtStart: -1, resentAfter: -1, title: '' }
    let ended = false
    await new Promise<void>((resolve) => {
      electronApp.on('child-process-gone', (_event, details) => {
        if (ended || details.serviceName !== service) return
        ended = true
        resolve()
      })
    })
    // The tab's own session answers once its context in the new service exists.
    while (!await tab.session.resolveHost('127.0.0.1').then(() => true, () => false)) await new Promise((wake) => setTimeout(wake, 5))
    const resentAtStart = resent()
    const outcome = await tab.loadURL(target).then(() => 'loaded', (error: unknown) => String(error))
    return { outcome, resentAtStart, resentAfter: resent(), title: tab.getTitle() }
  }, { target: url, part: shown, service: NETWORK_SERVICE })

async function openReport (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('report.open') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://report') && !w.isClosed()))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://report') && !w.isClosed()) as Page
  await page.waitForSelector('#report-what')
  return page
}

/** The report as the form shows it, once `ok` holds: main rebuilds the preview shortly after the page asks. */
interface ReportRead {
  log: string[]
  diagnostics: { recentCrashes: Array<{ process: string, reason: string }>, browser?: { networkService?: { restarts: number, timedOut: number, last: string } } }
}

async function reportWhere (page: Page, ok: (report: ReportRead) => boolean): Promise<ReportRead> {
  let last: ReportRead = { log: [], diagnostics: { recentCrashes: [] } }
  const read = async (): Promise<ReportRead> => {
    // Empty until main has built the preview, and not JSON while it is written.
    const text = await page.locator('#report-preview').textContent() ?? ''
    const shown = (() => { try { return JSON.parse(text === '' ? '{}' : text) as { log?: string[] | null, diagnostics?: ReportRead['diagnostics'] | null } } catch { return {} as { log?: string[] | null, diagnostics?: ReportRead['diagnostics'] | null } } })()
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
    const held = loadWhenServiceAnswers(running, 'https://held.eth/', 'first.eth')
    await delay(200)
    process.kill(oldPid, 'SIGKILL')

    // Started inside the hold: it must wait for the certificate check, not reach the new service with the default one,
    // which refuses the verifier's certificate and keeps refusing it for that host.
    expect(await held).toMatchObject({ outcome: 'loaded', resentAtStart: 0, resentAfter: 1, title: 'held fixture' })

    // A second verifier page, opened the ordinary way, loads too.
    await navigateToFixture(running, 'https://later.eth/', 'later fixture')

    const after = await seamOf(running)
    expect(after.ended).toBe(1)
    // One per session, and every one sent after the first restart.
    expect(after.certificateChecks.length).toBeGreaterThanOrEqual(2)
    expect(new Set(after.certificateChecks)).toEqual(new Set([1]))
    expect(after.resolverCalls).toHaveLength(2)
    expect(after.resolverCalls[1]).toMatchObject({ mode: 'secure', servers: 1 })
    expect(after.resolverCalls[1]!.at).toBeGreaterThanOrEqual(killedAt)
    expect(after.holds.map((hold) => hold.outcome)).toEqual(['reapplied'])
    expect(after.holds[0]!.requests).toBeGreaterThanOrEqual(1)
    expect(await networkServicePid(running)).not.toBe(oldPid)

    // What orivon://report collects: the log lines, and the end among the recorded problems.
    const report = await reportWhere(await openReport(running, started.chrome), ({ log }) => log.some((line) => line.includes('settings sent again')) && log.some((line) => line.includes('waited')))
    const ours = report.log.filter((line) => line.includes('[network-service]'))
    expect(ours.some((line) => /the network service ended \(/.test(line))).toBe(true)
    const sent = ours.find((line) => /settings sent again \d+ ms after the service ended, answering after \d+ ms: /.test(line)) ?? ''
    expect(sent).toMatch(/certificate check \(\d+ sessions?\)/)
    expect(sent).toMatch(/secure DNS \(secure, 1 server\)/)
    expect(sent).toMatch(/verifier host \(put to sleep\)/)
    expect(ours.some((line) => /[1-9]\d* requests? waited \d+ ms and went on/.test(line))).toBe(true)
    expect(report.diagnostics.recentCrashes).toContainEqual(expect.objectContaining({ process: 'Utility:network.mojom.NetworkService' }))
    // The counts do not depend on the log: they survive its 1,000-line ring in a long run.
    expect(report.diagnostics.browser?.networkService).toEqual({ restarts: 1, timedOut: 0, last: 'reapplied' })
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await gateway.close()
  }
}, QA_TEST_TIMEOUT_MS)

it('loads a verifier page started as the new service answers, with no padding, and again after a second restart', async () => {
  const gateway = await startFixtureGateway(Object.fromEntries(NAMES.map((name) => [name, SITE(name)])))
  let app: ElectronApplication | undefined
  try {
    const started = await launched(gateway, {})
    app = started.app
    const running = app
    await navigateToFixture(running, 'https://first.eth/', 'first fixture')

    const firstPid = await networkServicePid(running)
    expect(firstPid).toBeGreaterThan(0)
    const first = loadWhenServiceAnswers(running, 'https://held.eth/', 'first.eth')
    await delay(200)
    process.kill(firstPid, 'SIGKILL')
    expect(await first).toMatchObject({ outcome: 'loaded', title: 'held fixture' })
    await navigateToFixture(running, 'https://later.eth/', 'later fixture')

    // The hold of the first restart came off; a second one puts it on and takes it off again.
    const secondPid = await networkServicePid(running)
    expect(secondPid).not.toBe(firstPid)
    const second = loadWhenServiceAnswers(running, 'https://first.eth/', 'later.eth')
    await delay(200)
    process.kill(secondPid, 'SIGKILL')
    expect(await second).toMatchObject({ outcome: 'loaded', title: 'first fixture' })

    const after = await seamOf(running)
    expect(after.ended).toBe(2)
    expect(after.resent).toBe(2)
    expect(after.holds.map((hold) => hold.outcome)).toEqual(['reapplied', 'reapplied'])
    expect(new Set(after.certificateChecks)).toEqual(new Set([1, 2]))
    expect(after.resolverCalls.map((call) => call.mode)).toEqual(['secure', 'secure', 'secure'])
    expect(await networkServicePid(running)).not.toBe(secondPid)
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await gateway.close()
  }
}, QA_TEST_TIMEOUT_MS)

it('lets a request that waited go at the bound when the settings cannot be sent, and the report says so', async () => {
  const gateway = await startFixtureGateway(Object.fromEntries(NAMES.map((name) => [name, SITE(name)])))
  const plain = await startCountedPage(() => 'plain fixture')
  let app: ElectronApplication | undefined
  try {
    const started = await launched(gateway, { ORIVON_TEST_NETWORK_SERVICE_REAPPLY_DELAY_MS: '20000', ORIVON_TEST_NETWORK_SERVICE_HOLD_BOUND_MS: '800' })
    app = started.app
    const running = app
    await navigateToFixture(running, 'https://first.eth/', 'first fixture')
    const pid = await networkServicePid(running)
    expect(pid).toBeGreaterThan(0)
    // A page that needs no certificate check: it loads only if the hold lets it go, and the settings are 20 s away.
    const waiting = loadWhenServiceAnswers(running, plain.url, 'first.eth')
    await delay(200)
    process.kill(pid, 'SIGKILL')
    expect(await waiting).toMatchObject({ outcome: 'loaded', resentAtStart: 0, resentAfter: 0, title: 'plain fixture' })
    expect(plain.hits()).toBe(1)
    const seam = await seamOf(running)
    expect(seam.holds).toEqual([{ outcome: 'timed-out', requests: expect.any(Number) as number }])
    // It waited: only a held request is counted, so a hold that let it through at once would show none.
    expect(seam.holds[0]!.requests).toBeGreaterThanOrEqual(1)
    expect(seam.resent).toBe(0)
    const report = await reportWhere(await openReport(running, started.chrome), ({ log }) => log.some((line) => line.includes('the settings were not sent again within')))
    expect(report.log.some((line) => /\[network-service\] the settings were not sent again within \d+ ms: [1-9]\d* requests? went on without them/.test(line))).toBe(true)
    expect(report.diagnostics.browser?.networkService).toEqual({ restarts: 1, timedOut: 1, last: 'timed-out' })
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await plain.close()
    await gateway.close()
  }
}, QA_TEST_TIMEOUT_MS)
