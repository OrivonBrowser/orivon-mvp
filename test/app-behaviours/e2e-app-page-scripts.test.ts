// What a script an app's page loads can do to the page around it: a script loaded first in `<head>` redefines
// `navigator.userAgent` on the navigator instance and every later script reads the new value, and the Cache API stores a
// response and reads it back on the app's origin. One launch. Every check carries the id of the behaviour it protects
// (test/app-behaviours/catalogue.md).
//
// The page is a bare loopback origin made an app by the developer-only grant, so the e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-page-scripts.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { appManifest, grantApp, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'

const HTML = 'text/html; charset=utf-8'
const JS = 'text/javascript'
const REDEFINED = 'Redefined/1.0 (probe) Electron/99.0.0'
// A registered app's own policy admits no inline script: every script is a file.
const HEAD_JS = `Object.defineProperty(navigator, 'userAgent', { get: () => '${REDEFINED}', configurable: true })`
const FIRST_JS = "window.__seenByFirst = navigator.userAgent"
const SECOND_JS = "window.__seenBySecond = navigator.userAgent; window.__ready = true"
const PAGE = '<!doctype html><html><head><title>scripts</title><script src="/head.js"></script></head><body><script src="/first.js"></script><script src="/second.js"></script></body></html>'

let server: AppServer
let app: ElectronApplication
let chrome: Page
let view: Page

beforeAll(async () => {
  server = await startAppServer({
    '/': { type: HTML, body: PAGE },
    '/head.js': { type: JS, body: HEAD_JS },
    '/first.js': { type: JS, body: FIRST_JS },
    '/second.js': { type: JS, body: SECOND_JS },
    '/cached.txt': { type: 'text/plain', body: 'cached over the network' }
  })
  const launched = await launchShell()
  app = launched.app
  chrome = launched.chrome
  await grantApp(app, server.origin, appManifest('page-scripts', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
  view = await visit(app, chrome, `${server.origin}/`)
}, 180_000)

afterAll(async () => {
  if (app !== undefined) await closeElectron(app)
  await server?.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:user-agent-redefinable-by-head-script] [app:cache-api-stores-and-reads-back] what a page script can change and keep', async () => {
  await runPhase('app page scripts', async (check) => {
    await view.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true)
    const seen = await view.evaluate(() => {
      const state = window as unknown as { __seenByFirst: string, __seenBySecond: string }
      return { first: state.__seenByFirst, second: state.__seenBySecond, now: navigator.userAgent }
    })
    check('[app:user-agent-redefinable-by-head-script] a script loaded first in head redefines navigator.userAgent, and the scripts after it read the new value', seen.first === REDEFINED && seen.second === REDEFINED && seen.now === REDEFINED, JSON.stringify(seen))

    const cached = await view.evaluate(async () => {
      const cache = await caches.open('behaviour-probe')
      await cache.put('/stored-by-put', new Response('stored by put', { headers: { 'content-type': 'text/plain' } }))
      await cache.add('/cached.txt')
      const put = await cache.match('/stored-by-put')
      const added = await cache.match('/cached.txt')
      const missing = await cache.match('/never-stored')
      const names = await caches.keys()
      const removed = await caches.delete('behaviour-probe')
      return { put: await put?.text(), added: await added?.text(), missing: missing === undefined, names, removed }
    }).catch((error: unknown) => ({ failed: String(error) }))
    check('[app:cache-api-stores-and-reads-back] caches.open, put, add and match store a response and read it back; a miss is undefined', 'failed' in cached ? false : cached.put === 'stored by put' && cached.added === 'cached over the network' && cached.missing && cached.names.includes('behaviour-probe') && cached.removed, JSON.stringify(cached))
  })
}, QA_TEST_TIMEOUT_MS)
