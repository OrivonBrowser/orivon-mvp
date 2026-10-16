// The person's extensions load into the two persistent profile sessions websites with an entry of their own live in, once each, and
// not once per site: a content script runs on a website in the tunnel profile and on one in the direct profile, however many
// websites share a profile; every tunnelled website shares one session; the extensions of the default session are the
// same ones. (The toolbar, popup, webRequest blockers and the direct profile's lifecycle are the other specs of this row.)
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-profiles.test.ts
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
import { seedExtensions } from '../support/extensions-fixtures.js'
import { selfSigned } from '../support/self-signed.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const NAMES = { tunnelled: 'tunnelled.socks.test', also: 'also.socks.test', direct: 'direct.socks.test', plain: 'plain.socks.test' } as const
type Name = keyof typeof NAMES

let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let dir: string
const servers: Server[] = []
const ports = {} as Record<Name, number>

async function serve (title: string, tls: { cert: string, key: string }): Promise<{ port: number, decoy: number }> {
  const make = async (): Promise<number> => {
    const server = createServer(tls, (_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><body>${title}</body>`) })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    servers.push(server)
    return (server.address() as AddressInfo).port
  }
  return { port: await make(), decoy: await make() }
}

const url = (name: Name): string => `https://${NAMES[name]}:${String(ports[name])}/`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-extensions-profiles-e2e-'))
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
      [`${NAMES.also}:${String(ports.also)}`]: { host: '127.0.0.1', port: real.also as number }
    }
  })
  const mapping = Object.values(NAMES).map((name) => `MAP ${name} 127.0.0.1`).join(', ')
  const origin = (name: Name): string => `https://${NAMES[name]}:${String(ports[name])}`
  const launched = await launchShell({
    sandbox: true,
    args: [`--host-resolver-rules=${mapping}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, `--ignore-certificate-errors-spki-list=${tls.spki}`],
    seedProfile: async (userDataDir: string) => {
      mkdirSync(join(userDataDir, 'extensions'), { recursive: true })
      seedExtensions(userDataDir)
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
      // Two websites with an on entry and one with an off entry, already apart, as a profile that has used the tunnel would hold them.
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, origins: [origin('tunnelled'), origin('also')], off: [origin('direct')], apart: [origin('tunnelled'), origin('also')], apartDirect: [origin('direct')] }))
    }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await socks.close()
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

const marked = async (view: Page): Promise<boolean> => await waitFor(async () => await view.evaluate(() => document.documentElement.dataset['orivonExtensionMarker']) === 'ran')

const sessionNameOf = async (address: string): Promise<string> => await app.evaluate(({ webContents, session }, target) => {
  const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === target)
  if (contents === undefined) return 'none'
  if (contents.session === session.defaultSession) return 'default'
  for (const name of ['persist:proxy-profile', 'persist:direct-profile']) if (contents.session === session.fromPartition(name)) return name
  return 'other'
}, address)

const extensionCount = async (partition: string | undefined): Promise<number> => await app.evaluate(({ session }, name) =>
  (name === undefined ? session.defaultSession : session.fromPartition(name)).extensions.getAllExtensions().length, partition)

it('[app:extensions-run-in-the-profiles] a website with an on entry lives in the tunnel profile with the person\'s extensions, and so does a second one, in the same session', async () => {
  const first = await visit('tunnelled')
  expect(await sessionNameOf(url('tunnelled'))).toBe('persist:proxy-profile')
  expect(await marked(first), 'the content script ran in the tunnel profile').toBe(true)
  expect(socks.requests.some((request) => request.destination === NAMES.tunnelled), 'through the tunnel').toBe(true)

  const second = await visit('also')
  expect(await sessionNameOf(url('also')), 'one session for every tunnelled website').toBe('persist:proxy-profile')
  expect(await marked(second)).toBe(true)
  expect(await extensionCount('persist:proxy-profile'), 'the extensions were loaded once, not once per website').toBe(2)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:extensions-run-in-the-profiles] a website with an off entry lives in the direct profile with the extensions, and a plain website in the default session', async () => {
  const direct = await visit('direct')
  expect(await sessionNameOf(url('direct'))).toBe('persist:direct-profile')
  expect(await marked(direct), 'the content script ran in the direct profile').toBe(true)
  expect(await extensionCount('persist:direct-profile')).toBe(2)

  const plain = await visit('plain')
  expect(await sessionNameOf(url('plain'))).toBe('default')
  expect(await marked(plain)).toBe(true)
  expect(await extensionCount(undefined)).toBe(2)
}, 4 * QA_TEST_TIMEOUT_MS)
