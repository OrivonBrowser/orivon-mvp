// The name an app's cross-origin `fetch` dials is resolved by Chromium's resolver, the one the page's own requests,
// Secure DNS and the host-resolver rules configure, and not by the system's. The launch maps a made-up name to loopback
// with a host-resolver rule, which only Chromium's resolver reads: the system resolver does not know it. A grant that
// names the loopback address reaches the fixture by that name; a grant that names only the name is refused, since a name
// is never evidence that a loopback address was intended.
//
// The name maps to 127.0.0.2, not 127.0.0.1: a network that answers an unknown name with a loopback address (this
// machine's does) would otherwise hand the system resolver the right answer by accident. macOS has no 127.0.0.2, so
// there the name maps to 127.0.0.1 and the spec cannot tell the two resolvers apart.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-direct-dns.test.ts
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { appManifest, grantApp, pageCall, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'

/** A name only Chromium's resolver can answer: the launch maps it, and no DNS server has heard of it. */
const NAME = 'chromium-only.test'
/** The loopback address the name maps to, and the fixture listens on. */
const MAPPED = process.platform === 'darwin' ? '127.0.0.1' : '127.0.0.2'

let app: ElectronApplication
let chrome: Page
let fixture: Server
let fixturePort = 0
/** The requests that reached the fixture, with whether Chromium sent them itself. */
const seen: Array<{ host: string, native: boolean }> = []
const servers: AppServer[] = []

beforeAll(async () => {
  fixture = createServer((request, response) => {
    seen.push({ host: request.headers.host ?? '', native: request.headers.origin !== undefined })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('answered')
  })
  await new Promise<void>((resolve) => { fixture.listen(0, MAPPED, resolve) })
  fixturePort = (fixture.address() as AddressInfo).port
  const launched = await launchShell({ args: [`--host-resolver-rules=MAP ${NAME} ${MAPPED}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`] })
  app = launched.app
  chrome = launched.chrome
}, 120_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await Promise.all(servers.map(async (server) => { await server.close() }))
  await new Promise<void>((resolve) => { fixture.close(() => { resolve() }); fixture.closeAllConnections() })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Opens an app granted `pattern` and has its page fetch `http://NAME:port/`; the outcome is the body or the error's text. */
async function fetchByName (id: string, pattern: string): Promise<string> {
  const server = await startAppServer()
  servers.push(server)
  await grantApp(app, server.origin, appManifest(id, { net: { tcp: { connect: [pattern] } } }), [{ capability: 'tcp.connect', patterns: [pattern] }])
  const view = await visit(app, chrome, `${server.origin}/`)
  return await pageCall(server, view, async (url: string) => {
    try {
      return await (await fetch(url)).text()
    } catch (error) {
      return `failed: ${(error as Error).message}`
    }
  }, `http://${NAME}:${String(fixturePort)}/`)
}

it('[app:direct-app-names-resolve-through-chromium] a cross-origin fetch to a name only Chromium\'s resolver can resolve reaches the server it maps to, under a grant that names that address', async () => {
  const before = seen.length
  const outcome = await fetchByName('direct-dns-literal', `${MAPPED}:${String(fixturePort)}`)
  expect(outcome).toBe('answered')
  expect(seen.slice(before), 'one request, sent by the broker').toEqual([{ host: `${NAME}:${String(fixturePort)}`, native: false }])
}, QA_TEST_TIMEOUT_MS)

it('[app:named-host-resolving-to-loopback-is-refused] a grant that names only the host name does not reach a loopback address the name resolves to, and the broker sends nothing', async () => {
  const before = seen.length
  const outcome = await fetchByName('direct-dns-name', `${NAME}:${String(fixturePort)}`)
  expect(outcome).toMatch(/^failed: /)
  expect(seen.slice(before).filter((request) => !request.native), 'nothing the broker sent').toEqual([])
}, QA_TEST_TIMEOUT_MS)
