// uBlock Origin, the real one Orivon ships in a new profile, blocks in the two profile sessions as it does in the default one: a
// page in each loads an ad script from two hosts its lists name and a script from a host they do not, and the lists' two are cancelled
// before they leave (nothing arrives at the tunnel or at the server) while the other loads, whichever session the page runs in.
// uBlock Origin blocks only through blocking webRequest listeners, so this is the bridge of ADR-0053 working on each session.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-profiles-ublock.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { BUNDLED_UBLOCK_ORIGIN, seedPackedExtension } from '../support/extensions-fixtures.js'
import { selfSigned } from '../support/self-signed.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const SITES = { tunnelled: 'tunnelled.socks.test', direct: 'direct.socks.test', plain: 'plain.socks.test' } as const
type Site = keyof typeof SITES
/** Two hosts the filter lists name, and one they do not. */
const ADS = ['ad.doubleclick.net', 'pagead2.googlesyndication.com'] as const
const CLEAN = 'static.socks.test'
const TUNNEL = 'persist:tunnel-profile'
const DIRECT = 'persist:direct-profile'

let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let dir: string
let assets: Server
let assetsPort = 0
const hits: string[] = []
const servers: Server[] = []
const ports = {} as Record<Site, number>

/** Waits until uBlock Origin's lists have loaded (an ad request is refused), then loads each script and records what became of it. */
const PAGE = (title: string): string => `<!doctype html><title>${title}</title><body>${title}
<script>
(async () => {
  for (let n = 0; n < 300; n++) {
    try { await fetch('https://${ADS[0]}:${String(assetsPort)}/pagead/ping?' + n, { mode: 'no-cors', cache: 'no-store' }) } catch { break }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  window.__outcome = {}
  await Promise.all([...${JSON.stringify([...ADS, CLEAN])}].map((host) => new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://' + host + ':${String(assetsPort)}/pagead/x.js'
    script.onerror = () => { window.__outcome[host] = 'blocked'; resolve() }
    script.onload = () => { window.__outcome[host] = 'ran'; resolve() }
    document.body.appendChild(script)
  })))
  window.__done = true
})()
</script></body>`

const url = (site: Site): string => `https://${SITES[site]}:${String(ports[site])}/`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-extensions-profiles-ublock-e2e-'))
  const tls = selfSigned(dir, [...Object.values(SITES), ...ADS, CLEAN])
  assets = createServer(tls, (request, response) => {
    hits.push(`${request.headers.host ?? ''}${request.url ?? ''}`)
    response.writeHead(200, { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }).end('window.__ran = true')
  })
  await new Promise<void>((resolve) => { assets.listen(0, '127.0.0.1', resolve) })
  assetsPort = (assets.address() as AddressInfo).port
  const real: Partial<Record<Site, number>> = {}
  for (const site of Object.keys(SITES) as Site[]) {
    const make = async (): Promise<number> => {
      const server = createServer(tls, (_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE(site)) })
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      servers.push(server)
      return (server.address() as AddressInfo).port
    }
    real[site] = await make()
    ports[site] = await make()
  }
  const reachable: Record<string, { host: string, port: number }> = {}
  for (const host of [...ADS, CLEAN]) reachable[`${host}:${String(assetsPort)}`] = { host: '127.0.0.1', port: assetsPort }
  for (const site of ['tunnelled', 'plain'] as const) reachable[`${SITES[site]}:${String(ports[site])}`] = { host: '127.0.0.1', port: real[site] as number }
  socks = await startSocks5Fixture({ preferAuth: true, names: reachable })
  const mapping = [...Object.values(SITES), ...ADS, CLEAN].map((name) => `MAP ${name} 127.0.0.1`).join(', ')
  const origin = (site: Site): string => `https://${SITES[site]}:${String(ports[site])}`
  const launched = await launchShell({
    sandbox: true,
    args: [`--host-resolver-rules=${mapping}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, `--ignore-certificate-errors-spki-list=${tls.spki}`],
    seedProfile: async (userDataDir: string) => {
      mkdirSync(join(userDataDir, 'extensions'), { recursive: true })
      seedPackedExtension(userDataDir, BUNDLED_UBLOCK_ORIGIN, 'ublock-origin')
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, origins: [origin('tunnelled')], off: [origin('direct')], apart: [origin('tunnelled')], apartDirect: [origin('direct')] }))
    }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await socks.close()
  await new Promise<void>((resolve) => { assets.close(() => { resolve() }); assets.closeAllConnections() })
  for (const server of servers) await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const sessionNameOf = async (address: string): Promise<string> => await app.evaluate(({ webContents, session }, target) => {
  const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === target)
  if (contents === undefined) return 'none'
  if (contents.session === session.defaultSession) return 'default'
  for (const name of ['persist:tunnel-profile', 'persist:direct-profile']) if (contents.session === session.fromPartition(name)) return name
  return 'other'
}, address)

async function outcomeOn (site: Site, session: string): Promise<Record<string, string>> {
  await clickAddressBarRetrying(chrome, url(site))
  expect((await waitForTab(chrome, { address: url(site), title: site })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, url(site)) !== undefined)).toBe(true)
  const view = findViewShowing(app, chrome, url(site)) as Page
  expect(await sessionNameOf(url(site))).toBe(session)
  expect(await waitFor(async () => await view.evaluate(() => Boolean((window as unknown as { __done?: boolean }).__done)), 90_000), 'uBlock Origin\'s lists came into force').toBe(true)
  return await view.evaluate(() => (window as unknown as { __outcome: Record<string, string> }).__outcome)
}

it('[app:extensions-run-in-the-profiles] uBlock Origin cancels the ad requests of a page in the default session, in the tunnel profile and in the direct profile, and leaves the clean one', async () => {
  const expected = { [ADS[0]]: 'blocked', [ADS[1]]: 'blocked', [CLEAN]: 'ran' }
  expect(await outcomeOn('plain', 'default'), 'default session').toEqual(expected)
  expect(await outcomeOn('tunnelled', TUNNEL), 'tunnel profile').toEqual(expected)
  expect(await outcomeOn('direct', DIRECT), 'direct profile').toEqual(expected)
  expect(hits.filter((hit) => hit.includes('pagead/x.js') && ADS.some((ad) => hit.startsWith(ad))), 'no ad script reached the server').toEqual([])
}, 6 * QA_TEST_TIMEOUT_MS)
