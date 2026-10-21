// An `<audio>` element in an installed app loads its source through the loader's reach path, which holds it to the
// app's `https.connect` grant: a source on a granted https host plays (here: becomes ready to play), and a source on an
// https host the app has no grant for, or on plain http even where the app may open a socket to that host, is refused
// and never reaches the server. The element is muted and never played, so nothing is heard, and the test reads the
// element's own events. The https servers present a certificate the main process trusts through NODE_EXTRA_CA_CERTS.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-passive-media.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { generateSelfSignedFixture } from '../../src/broker/adapters/tests/tls-adapter.test-helpers.js'
import type { Manifest } from '../../src/contracts/index.js'
import type { Loaded } from './passive-media-entry.js'
import { clickAddressBarRetrying, waitForPageGlobal } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { bundleForApp, serveApp } from '../node-runtime/pinned-app.js'

const ORIGIN = 'https://passive-media-e2e.orivon.test'

/** Half a second of 8-bit mono silence at 8 kHz, as a WAV file. */
function silence (): Buffer {
  const samples = 4_000
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8_000, 24)
  header.writeUInt32LE(8_000, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples, 40)
  return Buffer.concat([header, Buffer.alloc(samples, 0x80)])
}

const WAV = silence()

/** Answers a media request the way a media server does: the whole file, or the byte range the element asks for. */
function serveWav (request: IncomingMessage, response: ServerResponse): void {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  if (range === null) {
    response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': WAV.length, 'accept-ranges': 'bytes' })
    response.end(WAV)
    return
  }
  const start = Number(range[1])
  const end = range[2] === '' ? WAV.length - 1 : Math.min(Number(range[2]), WAV.length - 1)
  response.writeHead(206, { 'content-type': 'audio/wav', 'content-length': end - start + 1, 'content-range': `bytes ${String(start)}-${String(end)}/${String(WAV.length)}`, 'accept-ranges': 'bytes' })
  response.end(WAV.subarray(start, end + 1))
}

interface Source { readonly port: number, readonly requests: () => number, readonly close: () => Promise<void> }

async function source (create: (handler: (request: IncomingMessage, response: ServerResponse) => void) => HttpServer): Promise<Source> {
  let requests = 0
  const server = create((request, response) => { requests += 1; serveWav(request, response) })
  server.on('tlsClientError', () => {})
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    requests: () => requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) }
  }
}

let dir: string
let granted: Source
let ungranted: Source
let plain: Source
let app: ElectronApplication
let view: Page

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-passive-media-'))
  const fixture = generateSelfSignedFixture()
  const caFile = join(dir, 'trusted.pem')
  writeFileSync(caFile, fixture.cert)
  const https = (handler: (request: IncomingMessage, response: ServerResponse) => void): HttpServer => createHttpsServer({ key: fixture.key, cert: fixture.cert }, handler)
  granted = await source(https)
  ungranted = await source(https)
  plain = await source(createHttpServer)

  const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./passive-media-entry.ts', import.meta.url))))
  // The suite's blackhole resolver maps `localhost` to nothing; the certificate names it, so it resolves here (to loopback, as anywhere).
  const launched = await launchShell({ env: { NODE_EXTRA_CA_CERTS: caFile }, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] })
  app = launched.app
  const https_ = [`localhost:${String(granted.port)}`]
  const tcp = [`localhost:${String(plain.port)}`]
  const manifest: Manifest = {
    orivonApiVersion: 0,
    id: 'app.orivon.behaviour.passive-media',
    name: 'Behaviour passive-media',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { net: { https: { connect: https_ }, tcp: { connect: tcp } } }
  }
  const served = await serveApp(app, ORIGIN, manifest, 'https.connect', {
    '/index.html': new TextEncoder().encode('<!doctype html><title>passive media</title><body><script src="/app.js"></script></body>'),
    '/app.js': new TextEncoder().encode(script)
  }, https_, [{ capability: 'tcp.connect', patterns: tcp }])
  expect(served).toEqual({ granted: true, registered: true })

  await clickAddressBarRetrying(launched.chrome, `${ORIGIN}/`)
  expect((await waitForTab(launched.chrome, { address: `${ORIGIN}/` })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, launched.chrome, `${ORIGIN}/`) !== undefined)).toBe(true)
  view = findViewShowing(app, launched.chrome, `${ORIGIN}/`) as Page
  await view.waitForLoadState('load')
  await waitForPageGlobal(view, 'passiveMediaE2e')
}, 180_000)

afterAll(async () => {
  if (app !== undefined) await closeElectron(app)
  await Promise.all([granted, ungranted, plain].map(async (s) => { await s.close() }))
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function load (url: string): Promise<Loaded> {
  return await view.evaluate(async (target) => {
    const entry = (globalThis as unknown as { passiveMediaE2e: { load: (url: string) => Promise<unknown> } }).passiveMediaE2e
    return await entry.load(target)
  }, url) as Loaded
}

it('[app:audio-loads-from-granted-https-host] an <audio> source on an https host the app holds a grant for loads, and one on an https host it has no grant for, or on plain http, is refused and never reaches the server', async () => {
  const before = { granted: granted.requests(), ungranted: ungranted.requests(), plain: plain.requests() }

  const reached = await load(`https://localhost:${String(granted.port)}/silence.wav`)
  expect(reached, 'a granted https host').toEqual({ event: 'canplay' })
  expect(granted.requests(), 'and the server saw the request').toBeGreaterThan(before.granted)

  const refusedHttps = await load(`https://localhost:${String(ungranted.port)}/silence.wav`)
  expect(refusedHttps.event, 'an https host with no grant').toBe('error')

  const refusedHttp = await load(`http://localhost:${String(plain.port)}/silence.wav`)
  expect(refusedHttp.event, 'plain http, though the app may open a socket to that host').toBe('error')

  await delay(ABSENCE_SETTLE_MS)
  expect(ungranted.requests(), 'the host with no grant was never asked').toBe(before.ungranted)
  expect(plain.requests(), 'the plain http host was never asked').toBe(before.plain)
}, QA_TEST_TIMEOUT_MS)
