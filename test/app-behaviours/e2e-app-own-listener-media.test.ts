// An app that holds a `tcp.listen` grant plays media and shows images from the loopback port its own
// listener holds, and from no other loopback port (ADR-0069). The page runs `http.createServer` through
// the shim and points an `<audio>` and an `<img>` at it, as a torrent client does with its `<video>`;
// the same elements also point at a loopback server the test runs outside the page, and a page with no
// grant loads from that one as it always did. Once from a loopback origin on the shared session and once
// from a pinned, cache-served origin in its own partition.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-own-listener-media.test.ts
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { appManifest, grantApp, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import { GIF, silentWav } from './own-listener-media-bytes.js'
import type { OwnListenerMediaResult } from './own-listener-media-entry.js'
import { closeElectronApp, navigateToFixture } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerAccepting, stubNativeDialogs } from '../support/question-support.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchElectron } from '../support/launch-electron.mjs'
import { findChrome, tabViews, waitFor } from '../support/smoke-helpers.mjs'
import { bundleForApp, serveApp } from '../node-runtime/pinned-app.js'

const PINNED_ORIGIN = 'https://own-listener-media.orivon.test'

let outside: Server
let outsidePort = 0
let outsideHits = 0
let loopbackPort = 0
let pinnedPort = 0
const servers: AppServer[] = []

/** A port the page will listen on, found free now; the grant names it. */
async function freePort (): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
  return port
}

beforeAll(async () => {
  outside = createServer((req, res) => {
    outsideHits += 1
    const wav = req.url?.startsWith('/a.wav') === true
    res.writeHead(200, { 'content-type': wav ? 'audio/wav' : 'image/gif', 'cache-control': 'no-store' })
    res.end(wav ? silentWav() : GIF)
  })
  await new Promise<void>((resolve) => { outside.listen(0, '127.0.0.1', resolve) })
  outsidePort = (outside.address() as AddressInfo).port
  loopbackPort = await freePort()
  pinnedPort = await freePort()
})
afterAll(async () => {
  await Promise.all(servers.map(async (server) => { await server.close() }))
  outside.closeAllConnections()
  await new Promise<void>((resolve) => { outside.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const EVERY_SPELLING = { '127.0.0.1': 'loaded', localhost: 'loaded' }
const NO_SPELLING = { '127.0.0.1': 'error', localhost: 'error' }

async function resultOf (view: Page): Promise<OwnListenerMediaResult> {
  await view.waitForFunction(() => (globalThis as Record<string, unknown>)['ownListenerMediaResult'] !== undefined, undefined, { timeout: 30_000 })
  return await view.evaluate(async () => await (globalThis as unknown as { ownListenerMediaResult: Promise<OwnListenerMediaResult> }).ownListenerMediaResult)
}

it('[app:page-media-from-own-listener] a page that listens plays media and shows images from its own loopback port and from no other, on a loopback origin and on a cache-served one', async () => {
  const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./own-listener-media-entry.ts', import.meta.url))))
  const page = '<!doctype html><title>own listener media</title><body><script src="/app.js"></script></body>'
  const manifestFor = (port: number): ReturnType<typeof appManifest> => ({
    ...appManifest('own-listener-media', { net: { tcp: { listen: { local: [String(port)] } } } }),
    assets: ['app.js']
  })
  const server = await startAppServer({
    '/': { type: 'text/html; charset=utf-8', body: page },
    '/app.js': { type: 'text/javascript', body: script }
  })
  servers.push(server)
  // Not an app at all: nothing grants it, so the gate has no opinion about what it loads.
  const ordinary = await startAppServer({
    '/': { type: 'text/html; charset=utf-8', body: `<!doctype html><title>pending</title><body><script>var i = new Image(); i.onload = function () { document.title = 'img-loaded' }; i.onerror = function () { document.title = 'img-error' }; i.src = 'http://127.0.0.1:${String(outsidePort)}/a.gif'</script>` }
  })
  servers.push(ordinary)

  // The suite's resolver rules refuse every name but 127.0.0.1; `localhost` is one of the two spellings under test.
  const app = await launchElectron({ appPath: '.', args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  try {
    await grantApp(app, server.origin, manifestFor(loopbackPort), [{ capability: 'tcp.listen.local', patterns: [String(loopbackPort)] }])
    const loopbackView = await visit(app, chrome, `${server.origin}/?port=${String(loopbackPort)}&outside=${String(outsidePort)}`)
    const onLoopback = await resultOf(loopbackView)
    expect(onLoopback, 'from a loopback origin').toMatchObject({
      ownAudio: EVERY_SPELLING, ownImage: EVERY_SPELLING, outsideAudio: NO_SPELLING, outsideImage: NO_SPELLING
    })
    expect(outsideHits, 'the outside server saw nothing from the loopback origin').toBe(0)

    const served = await serveApp(app, PINNED_ORIGIN, manifestFor(pinnedPort), 'tcp.listen.local', {
      '/index.html': new TextEncoder().encode(page),
      '/app.js': new TextEncoder().encode(script)
    }, [String(pinnedPort)])
    expect(served).toEqual({ granted: true, registered: true })
    const pinnedView = await navigateToFixture(app, `${PINNED_ORIGIN}/?port=${String(pinnedPort)}&outside=${String(outsidePort)}`, 'own listener media')
    const onPinned = await resultOf(pinnedView)
    expect(onPinned, 'from a cache-served origin').toMatchObject({
      ownAudio: EVERY_SPELLING, ownImage: EVERY_SPELLING, outsideAudio: NO_SPELLING, outsideImage: NO_SPELLING
    })
    expect(outsideHits, 'the outside server saw nothing from the cache-served origin').toBe(0)

    const ordinaryView = await visit(app, chrome, `${ordinary.origin}/`)
    await ordinaryView.waitForFunction(() => document.title !== 'pending', undefined, { timeout: 30_000 })
    expect(await ordinaryView.title(), 'a page with no listen grant loads loopback images as before').toBe('img-loaded')
    expect(outsideHits).toBeGreaterThan(0)
  } finally {
    await closeElectronApp(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('[app:page-media-from-own-listener] an app opened from an ipfs:// address, installed and then run from its cache, plays from its own listener and from no other', async () => {
  const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./own-listener-media-entry.ts', import.meta.url))))
  const port = await freePort()
  const manifest = {
    ...appManifest('own-listener-media-ipfs', { net: { tcp: { listen: { local: [String(port)] } } } }),
    assets: ['app.js']
  }
  const gateway = await startFixtureGateway({
    app: {
      'index.html': '<!doctype html><meta charset="utf-8"><title>own listener media ipfs</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body><script src="app.js"></script></body>',
      'app.js': script,
      '.well-known/orivon.json': JSON.stringify(manifest)
    }
  })
  const app = await launchElectron({
    appPath: '.',
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
    env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
  })
  try {
    await stubNativeDialogs(app)
    expect(await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)).toBe(true)
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    const root = gateway.roots['app'] as string
    const origin = `https://${root}.ipfs.orivon`
    const hitsBefore = outsideHits
    await clickAddressBarRetrying(chrome, `ipfs://${root}/?port=${String(port)}&outside=${String(outsidePort)}`)
    // The first visit installs the app after the person allows it; the page then runs from its cache with its grants.
    await answerAccepting(app)
    let result: OwnListenerMediaResult | undefined
    expect(await waitFor(async () => {
      const view = tabViews(app, chrome).find((candidate: Page) => candidate.url().startsWith(origin))
      if (view === undefined) return false
      try {
        const seen = await view.evaluate(async () => await (globalThis as unknown as { ownListenerMediaResult?: Promise<OwnListenerMediaResult> }).ownListenerMediaResult)
        if (seen?.port === undefined) return false
        result = seen
        return true
      } catch {
        return false
      }
    }, 60_000)).toBe(true)
    expect(result, 'from an ipfs:// app').toMatchObject({
      ownAudio: EVERY_SPELLING, ownImage: EVERY_SPELLING, outsideAudio: NO_SPELLING, outsideImage: NO_SPELLING
    })
    expect(outsideHits, 'the outside server saw nothing from the ipfs:// app').toBe(hitsBefore)
  } finally {
    await closeElectronApp(app)
    await gateway.close()
  }
}, 180_000)
