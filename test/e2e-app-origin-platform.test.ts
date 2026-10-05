// What an app's page can count on from the browser around it, on an origin that is an app: a secure context,
// history moves, a service worker, a settling wake lock, a noopener window, and Web Locks and pagehide
// across two tabs of the same origin. One launch. Every check carries the id of the behaviour it protects
// (docs/development/app-behaviours.md).
//
// The page is a bare loopback origin made an app by the developer-only grant, so the e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-app-origin-platform.test.ts
import type { Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, pageCall, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from './support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from './support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from './support/qa-helpers.js'
import { findViewShowing, tabIds, waitFor } from './support/smoke-helpers.mjs'

const HTML = 'text/html; charset=utf-8'
const JS = 'text/javascript'
// A registered app's own policy admits no inline script: every script is a file.
const MAIN_JS = `
document.querySelector('#open-noopener').addEventListener('click', () => { window.open('/target', '_blank', 'noopener,noreferrer') })
document.querySelector('#open-second').addEventListener('click', () => { window.open('/second', '_blank') })
`
const TARGET_JS = "document.title = 'opener-' + String(window.opener)"
const SECOND_JS = "window.__ready = true"
const SW_JS = "self.addEventListener('message', (event) => { event.source.postMessage('pong:' + event.data) })"
const MAIN_PAGE = '<!doctype html><title>main</title><button id="open-noopener">noopener</button><button id="open-second">second</button><script src="/main.js"></script>'

let server: AppServer
beforeAll(async () => {
  server = await startAppServer({
    '/': { type: HTML, body: MAIN_PAGE },
    '/main.js': { type: JS, body: MAIN_JS },
    '/target': { type: HTML, body: '<!doctype html><title>target</title><script src="/target.js"></script>' },
    '/target.js': { type: JS, body: TARGET_JS },
    '/second': { type: HTML, body: '<!doctype html><title>second</title><script src="/second.js"></script>' },
    '/second.js': { type: JS, body: SECOND_JS },
    '/sw.js': { type: JS, body: SW_JS }
  })
})
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:secure-context-on-app-origin] [app:history-back-forward-in-app] [app:service-worker-registers-on-app-origin] [app:wake-lock-request-settles] [app:window-open-noopener-opens-tab] [app:web-lock-held-until-tab-closes] [app:pagehide-fires-on-tab-close] the page platform an app counts on', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('app origin platform', async (check) => {
      await grantApp(app, server.origin, appManifest('origin-platform', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const main = await visit(app, chrome, `${server.origin}/`)
      const mainId = (await tabIds(chrome))[0]

      const secure = await main.evaluate(() => ({
        isSecureContext,
        subtle: typeof crypto.subtle?.digest,
        uuid: typeof crypto.randomUUID === 'function' && crypto.randomUUID().length === 36
      }))
      check('[app:secure-context-on-app-origin] the page is a secure context with crypto.subtle and crypto.randomUUID', secure.isSecureContext && secure.subtle === 'function' && secure.uuid, JSON.stringify(secure))

      const moves = await main.evaluate(async () => {
        const popped = async (move: () => void): Promise<string> => await new Promise<string>((resolve) => {
          addEventListener('popstate', () => { resolve(location.pathname) }, { once: true })
          move()
        })
        history.pushState({}, '', '/a')
        history.pushState({}, '', '/b')
        const back = await popped(() => { history.back() })
        const forward = await popped(() => { history.forward() })
        history.replaceState({}, '', '/')
        return { back, forward }
      })
      check('[app:history-back-forward-in-app] history.back() and history.forward() move through the entries the app pushed', moves.back === '/a' && moves.forward === '/b', JSON.stringify(moves))

      const reply = await main.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js')
        const registration = await navigator.serviceWorker.ready
        const answered = new Promise<string>((resolve) => { navigator.serviceWorker.addEventListener('message', (event) => { resolve(String(event.data)) }) })
        registration.active?.postMessage('hello')
        return await answered
      }).catch((error: unknown) => `failed: ${String(error)}`)
      check('[app:service-worker-registers-on-app-origin] a service worker registers and answers a message from the page', reply === 'pong:hello', reply)

      const wake = await main.evaluate(async () => {
        if (!('wakeLock' in navigator)) return 'absent'
        const outcome = await Promise.race([
          navigator.wakeLock.request('screen').then(() => 'granted', (error: Error) => `refused:${error.name}`),
          new Promise<string>((resolve) => { setTimeout(() => { resolve('hung') }, 10_000) })
        ])
        return outcome
      })
      check('[app:wake-lock-request-settles] navigator.wakeLock.request settles, granted or refused, and never hangs', wake !== 'hung' && wake !== 'absent', wake)

      await main.click('#open-noopener')
      const targetUrl = `${server.origin}/target`
      const opened = await waitFor(() => findViewShowing(app, chrome, targetUrl) !== undefined)
      const target = findViewShowing(app, chrome, targetUrl) as Page | undefined
      const targetTitle = target === undefined ? 'no tab' : await waitFor(async () => (await target.title()).startsWith('opener-')).then(async () => await target.title())
      check('[app:window-open-noopener-opens-tab] window.open(url, "_blank", "noopener,noreferrer") from a click opens a tab whose window.opener is null', opened && targetTitle === 'opener-null', targetTitle)
      for (const id of (await tabIds(chrome) as string[]).filter((id) => id !== mainId)) await chrome.click(`[data-id="${id}"] .close`)

      await pageCall(server, main, async () => {
        await new Promise<void>((resolve) => { void navigator.locks.request('app-lock', { mode: 'exclusive' }, () => { resolve(); return new Promise<void>(() => {}) }) })
      })
      await main.evaluate(() => {
        addEventListener('pagehide', () => { localStorage.setItem('pagehide-seen', 'yes') })
      })
      await main.click('#open-second')
      const secondUrl = `${server.origin}/second`
      expect(await waitFor(() => findViewShowing(app, chrome, secondUrl) !== undefined)).toBe(true)
      const second = findViewShowing(app, chrome, secondUrl) as Page
      await second.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true)
      const heldElsewhere = await second.evaluate(async () => await navigator.locks.request('app-lock', { ifAvailable: true }, (lock) => lock === null))
      check('[app:web-lock-held-until-tab-closes] while one tab holds an exclusive Web Lock, another tab of the origin is told it is taken', heldElsewhere === true)
      await second.evaluate(() => {
        const state = window as unknown as { __got: boolean }
        state.__got = false
        void navigator.locks.request('app-lock', () => { state.__got = true })
      })
      await chrome.click(`[data-id="${mainId}"] .close`)
      const got = await waitFor(async () => await second.evaluate(() => (window as unknown as { __got: boolean }).__got), 20_000)
      check('[app:web-lock-held-until-tab-closes] closing the tab that holds the lock lets the waiting tab take it', got)
      const hid = await waitFor(async () => await second.evaluate(() => localStorage.getItem('pagehide-seen') === 'yes'), 20_000)
      check('[app:pagehide-fires-on-tab-close] closing a tab fires pagehide in its page', hid)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
