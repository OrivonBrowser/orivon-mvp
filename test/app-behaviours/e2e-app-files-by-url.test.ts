// An app that holds an `fs` grant shows its own files by URL (ADR-0070). A ported Electron app builds a
// root-absolute `/orivon/app/<path>` for a CSS image or an `<img>`, and `file:///orivon/app/<path>` for a
// sound; both load from the files the app wrote with `fs`. Once from a loopback origin on the shared
// session and once from a pinned, cache-served origin in its own partition. Another origin's page, an
// origin with no `fs` grant, a path that leaves the app's root (by `..` or a symlink) and a `file:` URL
// outside the root get nothing from this.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-files-by-url.test.ts
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { appDataRoot } from '../../src/broker/grants/origin-hash.js'
import { appManifest, grantApp, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import { GIF } from './own-listener-media-bytes.js'
import type { AppFilesByUrlResult, Loaded } from './app-files-by-url-entry.js'
import { closeElectronApp, navigateToFixture } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { findChrome, waitFor } from '../support/smoke-helpers.mjs'
import { bundleForApp, serveApp } from '../node-runtime/pinned-app.js'

const PINNED_ORIGIN = 'https://app-files-by-url.orivon.test'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>'
const servers: AppServer[] = []

afterAll(async () => {
  await Promise.all(servers.map(async (server) => { await server.close() }))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type Probe = (url: string) => Promise<Loaded>

async function resultOf (view: Page): Promise<AppFilesByUrlResult> {
  await view.waitForFunction(() => (globalThis as Record<string, unknown>)['appFilesByUrl'] !== undefined, undefined, { timeout: 30_000 })
  return await view.evaluate(async () => await (globalThis as unknown as { appFilesByUrl: { result: Promise<AppFilesByUrlResult> } }).appFilesByUrl.result)
}

function probeIn (view: Page): Probe {
  return async (url) => await view.evaluate(async (target) => await (globalThis as unknown as { appFilesByUrl: { probe: (u: string) => Promise<Loaded> } }).appFilesByUrl.probe(target), url)
}

/** Everything one app origin must show, from its page `view`; `root` is the directory its files live in on disk. */
async function expectOwnFilesShown (view: Page, root: string, label: string): Promise<void> {
  const responses: Array<{ url: string, status: number }> = []
  view.on('response', (response) => { responses.push({ url: response.url(), status: response.status() }) })

  expect(await resultOf(view), `${label}: by URL and by file:// URL`).toEqual({
    rootImage: 'loaded',
    fileUrlImageAttribute: 'loaded',
    audioConstructor: 'loaded',
    audioProperty: 'loaded',
    audioRootPath: 'loaded',
    audioSource: 'loaded',
    fileUrlOutsideRoot: 'error',
    hostOnlyImage: 'error'
  })

  await view.evaluate(() => { (globalThis as unknown as { appFilesByUrl: { showCssImage: () => void } }).appFilesByUrl.showCssImage() })
  expect(await waitFor(() => responses.some((seen) => seen.url.startsWith('orivon-file:') && seen.url.endsWith('/css/bg.gif') && seen.status === 200), 15_000),
    `${label}: a CSS image is answered from the app's files, saw ${JSON.stringify(responses.map((seen) => `${seen.status} ${seen.url}`).slice(-6))}`).toBe(true)

  // The root is where the page wrote; the checks below add what a page cannot make: links out of it.
  const outside = mkdtempSync(join(tmpdir(), 'orivon-app-files-'))
  writeFileSync(join(outside, 'outside.gif'), GIF)
  symlinkSync(join(outside, 'outside.gif'), join(root, 'link.gif'))
  symlinkSync(outside, join(root, 'linkdir'))
  const probe = probeIn(view)
  expect(await probe('/orivon/app/.config/Posters/mark.gif'), `${label}: control`).toBe('loaded')
  const refused: Record<string, Loaded> = {}
  for (const path of [
    '/orivon/app/link.gif',
    '/orivon/app/linkdir/outside.gif',
    `/orivon/app/..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2F${encodeURIComponent(join(outside, 'outside.gif').slice(1))}`,
    '/orivon/app/..%2F..%2Fapps',
    '/orivon/app/.config/Posters',
    '/orivon/app/.config/Posters/missing.gif',
    '/orivon/app/a%00.gif'
  ]) refused[path] = await probe(path)
  expect(Object.values(refused), `${label}: ${JSON.stringify(refused)}`).toEqual(Object.values(refused).map(() => 'error'))
}

it('[app:page-shows-own-files-by-url] an app that holds fs shows its own files at /orivon/app/<path> and by file:///orivon/app/<path>, and nothing else is shown', async () => {
  const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./app-files-by-url-entry.ts', import.meta.url))))
  const page = '<!doctype html><title>app files by url</title><body><script src="/app.js"></script></body>'
  const manifest = { ...appManifest('app-files-by-url', { fs: { quotaBytes: 1_048_576 } }), assets: ['app.js'] }
  const hostRoutes = {
    '/': { type: 'text/html; charset=utf-8', body: page },
    '/app.js': { type: 'text/javascript', body: script },
    '/orivon/app/host-only.svg': { type: 'image/svg+xml', body: SVG }
  }
  const server = await startAppServer(hostRoutes)
  servers.push(server)
  // Not an app: nothing grants it, so its host keeps answering /orivon/app/ as it always did.
  const ordinary = await startAppServer({
    '/': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>ordinary</title><body>ordinary</body>' },
    '/orivon/app/host-only.svg': { type: 'image/svg+xml', body: SVG }
  })
  servers.push(ordinary)

  const app = await launchElectron({ appPath: '.', args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  try {
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    await grantApp(app, server.origin, manifest, [{ capability: 'fs', patterns: [] }])
    const loopbackView = await visit(app, chrome, `${server.origin}/`)
    const loopbackRoot = join(appDataRoot(userData, server.origin), 'files')
    await expectOwnFilesShown(loopbackView, loopbackRoot, 'from a loopback origin')

    // Another origin's page pointed at the app's file gets what the app's host says (nothing), and an
    // origin that holds no fs grant keeps the files its own host serves under the same prefix.
    const ordinaryView = await visit(app, chrome, `${ordinary.origin}/`)
    const fromOther = await ordinaryView.evaluate(async (url) => await new Promise<string>((resolve) => {
      const image = new Image()
      image.onload = () => { resolve('loaded') }
      image.onerror = () => { resolve('error') }
      image.src = url
    }), `${server.origin}/orivon/app/.config/Posters/mark.gif`)
    expect(fromOther, "another origin's page cannot show the app's file").toBe('error')
    const ownHost = await ordinaryView.evaluate(async () => await new Promise<string>((resolve) => {
      const image = new Image()
      image.onload = () => { resolve(image.naturalWidth === 3 ? 'loaded' : 'wrong size') }
      image.onerror = () => { resolve('error') }
      image.src = '/orivon/app/host-only.svg'
    }))
    expect(ownHost, 'an origin with no fs grant still loads what its host serves there').toBe('loaded')

    const served = await serveApp(app, PINNED_ORIGIN, manifest, 'fs', {
      '/index.html': new TextEncoder().encode(page),
      '/app.js': new TextEncoder().encode(script)
    })
    expect(served).toEqual({ granted: true, registered: true })
    const pinnedView = await navigateToFixture(app, `${PINNED_ORIGIN}/`, 'app files by url')
    await expectOwnFilesShown(pinnedView, join(appDataRoot(userData, PINNED_ORIGIN), 'files'), 'from a cache-served origin')
  } finally {
    await closeElectronApp(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
