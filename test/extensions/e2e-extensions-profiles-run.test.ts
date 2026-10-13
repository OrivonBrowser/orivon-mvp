// The person's extensions run in the two profile sessions as they do in the default one, and the direct profile's run only while
// a website the person left out of the tunnel is open in it. With the whole browser on the tunnel:
//   - an MV2 extension's blocking webRequest listener (the way uBlock Origin blocks) cancels a fixture ad request from a page in
//     the tunnel profile, and from one in the direct profile, as it does from a page in the default session;
//   - while no website of the direct profile is open, the direct profile holds no extension and none of its copies makes a request;
//     opening one brings the extension back, and closing it takes it away again.
// Fixtures: test/apps/extensions/webrequest-mv2/ (blocks /wr-ads/) and test/apps/extensions/profile-beacon/ (asks a server of the
// test for /beacon every 250 ms, naming its own copy).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-profiles-run.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttp } from 'node:http'
import type { Server as HttpServer } from 'node:http'
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
import { seedExtensions } from '../support/extensions-fixtures.js'
import { selfSigned } from '../support/self-signed.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { delay, findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const NAMES = { tunnelled: 'tunnelled.socks.test', direct: 'direct.socks.test', plain: 'plain.socks.test' } as const
type Name = keyof typeof NAMES
const TUNNEL = 'persist:tunnel-profile'
const DIRECT = 'persist:direct-profile'

/** The page of a site: it waits until the extension's blocking listener is in force, then asks for a script the listener cancels. */
const PAGE = (title: string): string => `<!doctype html><title>${title}</title><body>${title}
<script>
(async () => {
  for (let n = 0; n < 150; n++) {
    try { await fetch('/wr-ads/ping?' + n, { cache: 'no-store' }) } catch { break }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  window.__listening = true
  const ad = document.createElement('script')
  ad.src = '/wr-ads/x.js'
  ad.onerror = () => { window.__adBlocked = true }
  ad.onload = () => { window.__adRan = true }
  document.body.appendChild(ad)
})()
</script></body>`

let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let dir: string
let beacon: HttpServer
const servers: Server[] = []
const ports = {} as Record<Name, number>
/** Every copy of the beacon extension that has asked, with the time of its last request. */
const beacons = new Map<string, number>()
let beaconId = ''

async function serve (title: string, tls: { cert: string, key: string }): Promise<{ port: number, decoy: number }> {
  const make = async (): Promise<number> => {
    const server = createServer(tls, (request, response) => {
      if (request.url?.startsWith('/dyn-ads') === true) response.writeHead(200, { 'content-type': 'application/javascript' }).end('window.__dynRan = true')
      else if (request.url?.startsWith('/wr-ads/x.js') === true) response.writeHead(200, { 'content-type': 'application/javascript' }).end('window.__adRan = true')
      else if (request.url?.startsWith('/wr-ads/') === true) response.writeHead(200, { 'content-type': 'text/plain' }).end('ad')
      else response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE(title))
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    servers.push(server)
    return (server.address() as AddressInfo).port
  }
  return { port: await make(), decoy: await make() }
}

const url = (name: Name): string => `https://${NAMES[name]}:${String(ports[name])}/`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-extensions-profiles-run-e2e-'))
  beacon = createHttp((request, response) => {
    const copy = new URL(request.url ?? '/', 'http://x').searchParams.get('copy')
    if (copy !== null) beacons.set(copy, Date.now())
    response.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok')
  })
  await new Promise<void>((resolve) => { beacon.listen(0, '127.0.0.1', resolve) })
  const beaconUrl = `http://127.0.0.1:${String((beacon.address() as AddressInfo).port)}/beacon`

  const tls = selfSigned(dir, Object.values(NAMES))
  const real: Partial<Record<Name, number>> = {}
  for (const name of Object.keys(NAMES) as Name[]) {
    const served = await serve(name, tls)
    ports[name] = served.decoy
    real[name] = served.port
  }
  socks = await startSocks5Fixture({
    preferAuth: true,
    names: {
      [`${NAMES.tunnelled}:${String(ports.tunnelled)}`]: { host: '127.0.0.1', port: real.tunnelled as number },
      [`${NAMES.plain}:${String(ports.plain)}`]: { host: '127.0.0.1', port: real.plain as number }
    }
  })
  const mapping = Object.values(NAMES).map((name) => `MAP ${name} 127.0.0.1`).join(', ')
  const origin = (name: Name): string => `https://${NAMES[name]}:${String(ports[name])}`
  const launched = await launchShell({
    sandbox: true,
    args: [`--host-resolver-rules=${mapping}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, `--ignore-certificate-errors-spki-list=${tls.spki}`],
    seedProfile: async (userDataDir: string) => {
      mkdirSync(join(userDataDir, 'extensions'), { recursive: true })
      beaconId = seedExtensions(userDataDir, ['webrequest-mv2', 'profile-beacon']).find((entry) => entry.name.includes('Beacon'))?.id ?? ''
      writeFileSync(join(userDataDir, 'extensions', 'profile-beacon', '1.0.0', 'config.js'), `self.BEACON_URL = ${JSON.stringify(beaconUrl)}\n`)
      // The whole browser is on the tunnel; one website is set to on and one to off, already apart, as a profile that has used both holds them.
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, 'network.tunnel.everywhere': true } }))
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, origins: [origin('tunnelled')], off: [origin('direct')], apart: [origin('tunnelled')], apartDirect: [origin('direct')] }))
    }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await socks.close()
  await new Promise<void>((resolve) => { beacon.close(() => { resolve() }); beacon.closeAllConnections() })
  for (const server of servers) await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function visit (name: Name): Promise<Page> {
  await clickAddressBarRetrying(chrome, url(name))
  expect((await waitForTab(chrome, { address: url(name), title: name })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, url(name)) !== undefined)).toBe(true)
  const view = findViewShowing(app, chrome, url(name)) as Page
  await view.waitForLoadState('load')
  return view
}

const flag = async (view: Page, name: string): Promise<boolean> => await view.evaluate((n) => Boolean((window as unknown as Record<string, unknown>)[n]), name)

/** The extensions a session holds, and the extension pages (background pages) that exist in it. */
const inSession = async (partition: string | undefined): Promise<{ extensions: number, backgrounds: number }> => await app.evaluate(({ session, webContents }, name) => {
  const target = name === undefined ? session.defaultSession : session.fromPartition(name)
  return {
    extensions: target.extensions.getAllExtensions().length,
    backgrounds: webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.session === target && wc.getType() === 'backgroundPage').length
  }
}, partition)

const sessionNameOf = async (address: string): Promise<string> => await app.evaluate(({ webContents, session }, target) => {
  const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === target)
  if (contents === undefined) return 'none'
  if (contents.session === session.defaultSession) return 'default'
  for (const name of ['persist:tunnel-profile', 'persist:direct-profile']) if (contents.session === session.fromPartition(name)) return name
  return 'other'
}, address)

async function expectBlocked (name: Name, session: string): Promise<void> {
  const view = await visit(name)
  expect(await sessionNameOf(url(name)), `${name} lives in ${session}`).toBe(session)
  expect(await waitFor(async () => await flag(view, '__listening'), 60_000), 'the extension\'s blocking listener came into force').toBe(true)
  expect(await waitFor(async () => await flag(view, '__adBlocked')), 'the ad script was cancelled').toBe(true)
  expect(await flag(view, '__adRan'), 'the cancelled script never ran').toBe(false)
}

it('[app:extensions-run-in-the-profiles] a blocking webRequest listener cancels a request from a page in the default session, in the tunnel profile and in the direct profile', async () => {
  await expectBlocked('plain', 'default')
  await expectBlocked('tunnelled', TUNNEL)
  await expectBlocked('direct', DIRECT)
  expect(socks.requests.some((request) => request.destination === NAMES.tunnelled), 'the tunnelled site went through the tunnel').toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:extensions-run-in-the-profiles] with the whole browser on the tunnel, the direct profile holds no extension, and none of its copies makes a request, while no website of it is open', async () => {
  // Three copies of the beacon run now: the default session's, the tunnel profile's and the direct profile's.
  expect(await inSession(DIRECT)).toMatchObject({ extensions: 2 })
  const copyIn = async (partition: string | undefined): Promise<string> => {
    let found = ''
    await waitFor(async () => {
      found = await app.evaluate(async ({ session, webContents }, [name, id]) => {
        const target = name === undefined ? session.defaultSession : session.fromPartition(name)
        const page = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.session === target && wc.getType() === 'backgroundPage' && wc.getURL().startsWith(`chrome-extension://${id}/`))
        return page === undefined ? '' : await page.executeJavaScript('new Promise((resolve) => chrome.storage.local.get("copy", (stored) => resolve(stored.copy || "")))') as string
      }, [partition, beaconId] as const)
      return found !== ''
    }, 10_000).catch(() => false)
    return found
  }
  const directCopy = await copyIn(DIRECT)
  expect(directCopy).toMatch(/^[a-z0-9]+$/)
  expect(new Set([await copyIn(undefined), await copyIn(TUNNEL), directCopy]).size, 'each session has a copy of its own').toBe(3)
  const lastHeard = (): number => beacons.get(directCopy) ?? 0
  const heard = await waitFor(() => Date.now() - lastHeard() < 1_000)
  expect(heard, 'the direct profile\'s copy is asking while its website is open').toBe(true)

  // The only tab leaves the direct website for a plain one: no website of the direct profile is open, and its extensions go.
  expect(await sessionNameOf(url('direct'))).toBe(DIRECT)
  await visit('plain')
  expect(await waitFor(async () => (await inSession(DIRECT)).extensions === 0 && (await inSession(DIRECT)).backgrounds === 0, 20_000), 'the direct profile holds no extension').toBe(true)
  const silentSince = Date.now()
  await delay(3_000)
  expect(lastHeard() < silentSince, 'the direct profile\'s copy made no request after it was taken away').toBe(true)
  expect((await inSession(TUNNEL)).extensions, 'the tunnel profile keeps its own').toBe(2)
  expect((await inSession(undefined)).extensions).toBe(2)

  // Another website of the direct profile opens: the extensions come back, with the same storage.
  const view = await visit('direct')
  expect(await waitFor(async () => (await inSession(DIRECT)).extensions === 2, 20_000)).toBe(true)
  expect(await waitFor(() => Date.now() - lastHeard() < 1_000, 20_000), 'the copy asks again').toBe(true)
  expect(await waitFor(async () => await flag(view, '__adBlocked'), 60_000), 'and blocks again').toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)

/** Runs `code` in the page of the beacon extension that session `partition` holds. */
const inBeacon = async (partition: string, code: string): Promise<unknown> => await app.evaluate(async ({ session, webContents }, [name, id, run]) => {
  const target = session.fromPartition(name as string)
  const page = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.session === target && wc.getType() === 'backgroundPage' && wc.getURL().startsWith(`chrome-extension://${id as string}/`))
  if (page === undefined) throw new Error(`no beacon page in ${name as string}`)
  return await page.executeJavaScript(run as string)
}, [partition, beaconId, code] as const)

it('[app:extensions-run-in-the-profiles] a declarativeNetRequest rule an extension adds at run time in a profile blocks a request from a page of that profile', async () => {
  for (const [name, session, id] of [['tunnelled', TUNNEL, 901], ['direct', DIRECT, 902]] as const) {
    const view = await visit(name)
    expect(await sessionNameOf(url(name))).toBe(session)
    const path = `/dyn-ads-${name}/`
    await inBeacon(session, `chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: ${String(id)}, priority: 1, action: { type: 'block' }, condition: { urlFilter: '${path}', resourceTypes: ['script'] } }] })`)
    const held = await inBeacon(session, 'chrome.declarativeNetRequest.getDynamicRules()') as Array<{ id: number }>
    expect(held.some((rule) => rule.id === id), 'the profile\'s copy reads its rule back').toBe(true)
    const result = await view.evaluate(async (src) => await new Promise<string>((resolve) => {
      const script = document.createElement('script')
      script.src = src
      script.onerror = () => { resolve('blocked') }
      script.onload = () => { resolve('ran') }
      document.body.appendChild(script)
    }), `${path}x.js`)
    expect(result, `${name}: the run-time rule applies`).toBe('blocked')
    // A path no rule names still loads: the rule blocks what it names and nothing else.
    expect(await view.evaluate(async () => await new Promise<string>((resolve) => {
      const script = document.createElement('script')
      script.src = '/dyn-ads-other/x.js'
      script.onerror = () => { resolve('blocked') }
      script.onload = () => { resolve('ran') }
      document.body.appendChild(script)
    }))).toBe('ran')
  }
}, 4 * QA_TEST_TIMEOUT_MS)
