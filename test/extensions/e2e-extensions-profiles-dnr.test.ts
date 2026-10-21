// A request-blocking extension filters a website in a profile as it does in the default session: its static
// declarativeNetRequest rule blocks the script on a website in the tunnel profile and on one in the direct profile, and
// a website in the default session is filtered as before. The rules belong to the extension, loaded once into each
// profile session.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-profiles-dnr.test.ts
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { loadableManifest, readExtensionManifest } from '../../src/broker/policy/extension-manifest.js'
import { resolveSlotKey } from '../../src/main/extensions/install-runner.js'
import { serializeRegistry } from '../../src/main/extensions/registry.js'
import { generateId } from '../../vendor/electron-chrome-web-store/src/browser/id.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { selfSigned } from '../support/self-signed.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { delay, findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const FIXTURE_DIR = fileURLToPath(new URL('../apps/extensions/dnr-blocker/', import.meta.url)).replace(/[/\\]$/, '')
const NAMES = { tunnelled: 'tunnelled.socks.test', direct: 'direct.socks.test', plain: 'plain.socks.test' } as const
type Name = keyof typeof NAMES

const PAGE = (title: string): string => `<!doctype html><title>${title}</title><body><script src="/ads/blocked.js" onerror="window.__adBlocked = true"></script></body>`

let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let dir: string
const servers: Server[] = []
const ports = {} as Record<Name, number>
const url = (name: Name): string => `https://${NAMES[name]}:${String(ports[name])}/`

function seedBlocker (userDataDir: string): void {
  const rawManifest: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`dnr-blocker fixture's own manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const key = resolveSlotKey(userDataDir, 'dnr-blocker')
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', 'dnr-blocker', parsed.facts.version)
  cpSync(FIXTURE_DIR, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const now = Date.now()
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry([{
    id: generateId(key), name: parsed.facts.name, version: parsed.facts.version, enabled: true, installedAt: now, updatedAt: now,
    source: { kind: 'unpacked', from: FIXTURE_DIR }, updater: { kind: 'none', reason: 'e2e fixture, seeded directly' }, path: targetDir, stripped
  }]))
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-extensions-profiles-dnr-e2e-'))
  const tls = selfSigned(dir, Object.values(NAMES))
  const real: Partial<Record<Name, number>> = {}
  const listen = async (title: string): Promise<number> => {
    const server = createServer(tls, (request, response) => {
      if (request.url?.startsWith('/ads/') === true) response.writeHead(200, { 'content-type': 'application/javascript' }).end('window.__adRan = true;')
      else response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE(title))
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    servers.push(server)
    return (server.address() as AddressInfo).port
  }
  for (const name of Object.keys(NAMES) as Name[]) {
    real[name] = await listen(name)
    ports[name] = await listen(name)
  }
  socks = await startSocks5Fixture({ preferAuth: true, names: { [`${NAMES.tunnelled}:${String(ports.tunnelled)}`]: { host: '127.0.0.1', port: real.tunnelled as number } } })
  const origin = (name: Name): string => `https://${NAMES[name]}:${String(ports[name])}`
  const launched = await launchShell({
    sandbox: true,
    args: [`--host-resolver-rules=${Object.values(NAMES).map((name) => `MAP ${name} 127.0.0.1`).join(', ')}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, `--ignore-certificate-errors-spki-list=${tls.spki}`],
    seedProfile: async (userDataDir: string) => {
      mkdirSync(join(userDataDir, 'extensions'), { recursive: true })
      seedBlocker(userDataDir)
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, origins: [origin('tunnelled')], off: [origin('direct')], apart: [origin('tunnelled')], apartDirect: [origin('direct')] }))
    }
  })
  app = launched.app
  chrome = launched.chrome
  // The extension's service worker adds its own rules; the static rule needs none, but the engine loads with the extension.
  await delay(4000)
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await socks.close()
  for (const server of servers) await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function blocked (name: Name): Promise<{ blocked: boolean, ran: boolean }> {
  await clickAddressBarRetrying(chrome, url(name))
  expect((await waitForTab(chrome, { address: url(name), title: name })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, url(name)) !== undefined)).toBe(true)
  const view = findViewShowing(app, chrome, url(name)) as Page
  await view.waitForLoadState('load')
  return await view.evaluate(() => ({ blocked: (window as unknown as { __adBlocked?: boolean }).__adBlocked === true, ran: (window as unknown as { __adRan?: boolean }).__adRan === true }))
}

it('[app:extensions-run-in-the-profiles] the blocker\'s rule applies in the tunnel profile, the direct profile and the default session', async () => {
  expect(await blocked('tunnelled'), 'tunnel profile').toEqual({ blocked: true, ran: false })
  expect(socks.requests.some((request) => request.destination === NAMES.tunnelled), 'and the page itself came through the tunnel').toBe(true)
  expect(await blocked('direct'), 'direct profile').toEqual({ blocked: true, ran: false })
  expect(await blocked('plain'), 'default session').toEqual({ blocked: true, ran: false })
}, 4 * QA_TEST_TIMEOUT_MS)
