// A server whose certificate no root vouches for, reached three ways from an app: the raw `orivon.net.connectSecure`,
// Node's `tls.connect` (the shim over it) and the page's own `fetch`. Both socket calls honour
// `rejectUnauthorized: false` and refuse by default; `fetch` has no TLS option, so a routed `fetch` to such a server is
// a network error whatever its init says. A server whose certificate the main process does trust (the launch adds it
// through NODE_EXTRA_CA_CERTS, the way an operator would) answers `fetch`, which shows the refusal is about trust and
// not about the route. The servers count what reaches them: a refused handshake is a dial that happened and was
// abandoned by the client, which is what separates it from a request that never left.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-self-signed-tls.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'
import type { Server as TlsServer } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { generateSelfSignedFixture } from '../../src/broker/adapters/tests/tls-adapter.test-helpers.js'
import { appManifest, grantApp, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import type { Fetched, Handshake } from './self-signed-tls-entry.js'
import { waitForPageGlobal } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay } from '../support/smoke-helpers.mjs'
import { bundleForApp } from '../node-runtime/pinned-app.js'

/** One certificate, served over raw TLS (a greeting) and over HTTPS (a body), with a count of the handshakes that finished. */
interface Host { readonly tlsPort: number, readonly httpsPort: number, readonly handshakes: () => number, readonly close: () => Promise<void> }

async function host (fixture: { cert: string, key: string }): Promise<Host> {
  let handshakes = 0
  const raw: TlsServer = createTlsServer({ key: fixture.key, cert: fixture.cert }, (socket) => { handshakes += 1; socket.on('error', () => {}); socket.end('hello over tls') })
  raw.on('tlsClientError', () => {})
  const web: HttpsServer = createHttpsServer({ key: fixture.key, cert: fixture.cert }, (_request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('hello over https') })
  web.on('secureConnection', () => { handshakes += 1 })
  web.on('tlsClientError', () => {})
  for (const server of [raw, web]) await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    tlsPort: (raw.address() as AddressInfo).port,
    httpsPort: (web.address() as AddressInfo).port,
    handshakes: () => handshakes,
    close: async () => {
      web.closeAllConnections()
      await Promise.all([raw, web].map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
    }
  }
}

let dir: string
let trusted: Host
let untrusted: Host
let server: AppServer
let app: ElectronApplication
let chrome: Page
let view: Page

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-self-signed-'))
  const known = generateSelfSignedFixture()
  const caFile = join(dir, 'trusted.pem')
  writeFileSync(caFile, known.cert)
  trusted = await host(known)
  untrusted = await host(generateSelfSignedFixture())

  const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./self-signed-tls-entry.ts', import.meta.url))))
  server = await startAppServer({
    '/': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>self-signed tls</title><body><script src="/app.js"></script></body>' },
    '/app.js': { type: 'text/javascript', body: script }
  })
  // The suite's blackhole resolver maps `localhost` to nothing; the certificates name it, so it resolves here (to loopback, as anywhere).
  const launched = await launchShell({ env: { NODE_EXTRA_CA_CERTS: caFile }, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] })
  app = launched.app
  chrome = launched.chrome
  const patterns = [trusted.tlsPort, trusted.httpsPort, untrusted.tlsPort, untrusted.httpsPort].map((port) => `localhost:${String(port)}`)
  await grantApp(app, server.origin, appManifest('self-signed-tls', { net: { https: { connect: patterns } } }), [{ capability: 'https.connect', patterns }])
  view = await visit(app, chrome, `${server.origin}/`)
  await waitForPageGlobal(view, 'selfSignedTlsE2e')
}, 180_000)

afterAll(async () => {
  if (app !== undefined) await closeElectron(app)
  await server.close()
  await Promise.all([trusted, untrusted].map(async (h) => { await h.close() }))
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Entry {
  readonly raw: Handshake
  readonly node: Handshake
  readonly routedFetch: Fetched
}

/** Calls `name` on the entry the page's script exposes. The entry runs in the page, so its calls to `window.orivon` carry the page's own frames. */
async function call<K extends keyof Entry> (name: K, ...args: readonly unknown[]): Promise<Entry[K]> {
  return await view.evaluate(async ({ method, values }) => {
    const entry = (globalThis as unknown as { selfSignedTlsE2e: Record<string, (...a: unknown[]) => Promise<unknown>> }).selfSignedTlsE2e
    return await (entry[method] as (...a: unknown[]) => Promise<unknown>)(...values)
  }, { method: name, values: [...args] }) as Entry[K]
}

it('[app:tls-self-signed-refused-unless-opted-out] the raw connectSecure refuses a self-signed server by default and reaches it, unauthorized and saying why, with rejectUnauthorized false', async () => {
  const before = untrusted.handshakes()
  const refused = await call('raw', untrusted.tlsPort)
  expect(refused, 'default verification').toMatchObject({ ok: false, code: 'unreachable' })
  expect(refused.platformCode, 'with the reason from the handshake').toMatch(/SELF.SIGNED/)
  expect(untrusted.handshakes(), 'a refused handshake is not a connection the server accepted').toBe(before)

  const explicit = await call('raw', untrusted.tlsPort, true)
  expect(explicit, 'rejectUnauthorized true is the default').toMatchObject({ ok: false, code: 'unreachable' })

  const reached = await call('raw', untrusted.tlsPort, false)
  expect(reached, 'rejectUnauthorized false').toMatchObject({ ok: true, text: 'hello over tls', authorized: false })
  expect(reached.authorizationError).toMatch(/SELF.SIGNED/)

  const known = await call('raw', trusted.tlsPort)
  expect(known, 'a certificate the main process trusts needs no opt-out').toMatchObject({ ok: true, text: 'hello over tls', authorized: true })
}, QA_TEST_TIMEOUT_MS)

it('[app:tls-connect-honours-reject-unauthorized] Node\'s tls.connect refuses a self-signed server with Node\'s own error and reaches it, unauthorized, with rejectUnauthorized false', async () => {
  const refused = await call('node', untrusted.tlsPort)
  expect(refused, 'default verification').toMatchObject({ ok: false, code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })

  const reached = await call('node', untrusted.tlsPort, false)
  expect(reached, 'rejectUnauthorized false').toMatchObject({ ok: true, text: 'hello over tls', authorized: false })
  expect(reached.authorizationError).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')

  const known = await call('node', trusted.tlsPort)
  expect(known, 'a certificate the main process trusts').toMatchObject({ ok: true, text: 'hello over tls', authorized: true })
}, QA_TEST_TIMEOUT_MS)

it('[app:routed-fetch-refuses-untrusted-certificate] a routed fetch to a self-signed server is a network error, whatever its init says, and reaches a server whose certificate is trusted', async () => {
  const url = `https://localhost:${String(untrusted.httpsPort)}/`
  const before = untrusted.handshakes()
  const refused = await call('routedFetch', url)
  expect(refused, 'fetch has no TLS option').toMatchObject({ ok: false, name: 'TypeError' })
  const asked = await call('routedFetch', url, { rejectUnauthorized: false })
  expect(asked, 'a Node-style rejectUnauthorized in the init changes nothing').toMatchObject({ ok: false, name: 'TypeError' })
  await delay(ABSENCE_SETTLE_MS)
  expect(untrusted.handshakes(), 'no request was ever served by the untrusted server').toBe(before)

  const known = await call('routedFetch', `https://localhost:${String(trusted.httpsPort)}/`)
  expect(known, 'the same call to a trusted certificate').toMatchObject({ ok: true, status: 200, text: 'hello over https' })
}, QA_TEST_TIMEOUT_MS)
