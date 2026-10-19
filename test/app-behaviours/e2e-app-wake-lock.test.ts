// What a page that keeps the screen on can count on: on a visible tab, an app's or an ordinary website's,
// `navigator.wakeLock.request('screen')` is granted with no question, the sentinel is a screen lock that
// holds until the page releases it, and a tab put behind another tab does not keep holding one for the
// person who is looking at something else. Every check carries the id of the behaviour it protects
// (test/app-behaviours/catalogue.md).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-wake-lock.test.ts
import type { Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from '../support/qa-helpers.js'
import { tabIds, waitFor } from '../support/smoke-helpers.mjs'

const HTML = 'text/html; charset=utf-8'

let appServer: AppServer
let website: FixtureServer
let embedded: FixtureServer
beforeAll(async () => {
  appServer = await startAppServer({ '/': { type: HTML, body: '<!doctype html><title>wake app</title><body>app</body>' } })
  embedded = await startServer((_request, response) => { html(response, '<!doctype html><title>embedded</title><body>embedded</body>') })
  website = await startServer((request, response) => {
    html(response, request.url === '/framed'
      ? `<!doctype html><title>framed</title><body><iframe id="frame" src="${embedded.origin}/" allow="screen-wake-lock"></iframe></body>`
      : '<!doctype html><title>wake site</title><body>site</body>')
  })
})
afterAll(async () => {
  await appServer.close()
  await website.close()
  await embedded.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Outcome { outcome: string, type?: string, released?: boolean }

/** Asks for a screen lock and keeps the sentinel on `window.__sentinel`, so a later call can read or release it. */
const request = async (run: (fn: () => Promise<Outcome>) => Promise<Outcome>): Promise<Outcome> => await run(async () => {
  try {
    const sentinel = await navigator.wakeLock.request('screen')
    ;(window as unknown as { __sentinel: WakeLockSentinel }).__sentinel = sentinel
    return { outcome: 'granted', type: sentinel.type, released: sentinel.released }
  } catch (error) {
    return { outcome: `refused:${(error as Error).name}` }
  }
})

const sentinelState = async (view: Page): Promise<{ released: boolean, visibility: string }> =>
  await view.evaluate(() => ({ released: (window as unknown as { __sentinel?: WakeLockSentinel }).__sentinel?.released ?? false, visibility: document.visibilityState }))

it('[app:wake-lock-held-on-a-visible-page] a visible tab, an app\'s or a website\'s, is granted a screen wake lock with no question, and the page releases it', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('wake lock on visible tabs', async (check) => {
      await grantApp(app, appServer.origin, appManifest('wake-lock', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const appPage = await visit(app, chrome, `${appServer.origin}/`)
      expect(await appPage.evaluate(() => document.visibilityState)).toBe('visible')

      const held = await request(async (fn) => await appPage.evaluate(fn))
      check('[app:wake-lock-held-on-a-visible-page] an app tab in front is granted a screen wake lock', held.outcome === 'granted' && held.type === 'screen' && held.released === false, JSON.stringify(held))
      await appPage.evaluate(async () => { await (window as unknown as { __sentinel?: WakeLockSentinel }).__sentinel?.release() })
      check('[app:wake-lock-held-on-a-visible-page] the page releases the lock it holds', (await sentinelState(appPage)).released)

      await chrome.click('#new-tab')
      const sitePage = await visit(app, chrome, `${website.origin}/`)
      const siteHeld = await request(async (fn) => await sitePage.evaluate(fn))
      check('[app:wake-lock-held-on-a-visible-page] an ordinary website tab in front is granted a screen wake lock', siteHeld.outcome === 'granted' && siteHeld.type === 'screen' && siteHeld.released === false, JSON.stringify(siteHeld))
      check('[app:wake-lock-held-on-a-visible-page] the lock of a visible website tab is still held a moment later', await waitFor(async () => (await sentinelState(sitePage)).released === false))
      await sitePage.evaluate(async () => { await (window as unknown as { __sentinel?: WakeLockSentinel }).__sentinel?.release() })
      check('[app:wake-lock-held-on-a-visible-page] the website releases the lock it holds', (await sentinelState(sitePage)).released)

      const framed = await visit(app, chrome, `${website.origin}/framed`)
      const frame = await waitFor(() => framed.frames().find((candidate) => candidate.url().startsWith(embedded.origin)) !== undefined)
      const inner = framed.frames().find((candidate) => candidate.url().startsWith(embedded.origin))
      const frameOutcome = frame && inner !== undefined ? await inner.evaluate(async () => await navigator.wakeLock.request('screen').then(() => 'granted', (error: Error) => `refused:${error.name}`)) : 'no frame'
      check('[app:wake-lock-held-on-a-visible-page] a frame embedded in the page is refused, since only the top frame is released when its tab goes behind another', frameOutcome === 'refused:NotAllowedError', frameOutcome)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('[app:wake-lock-absent-outside-a-secure-context] [app:wake-lock-released-when-the-tab-goes-behind] a page that is not a secure context has no wake lock, and a lock ends when its tab goes behind another', async () => {
  const insecure = await startServer((_request, response) => { html(response, '<!doctype html><title>insecure</title><body>insecure</body>') })
  const port = new URL(insecure.origin).port
  const { app, chrome } = await launchShell({ args: [`--host-resolver-rules=MAP insecure.test 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`] })
  try {
    await runPhase('wake lock gating', async (check) => {
      const plain = await visit(app, chrome, 'http://insecure.test/')
      const facts = await plain.evaluate(() => ({ secure: isSecureContext, wakeLock: 'wakeLock' in navigator }))
      check('[app:wake-lock-absent-outside-a-secure-context] a page that is not a secure context has no navigator.wakeLock', facts.secure === false && facts.wakeLock === false, JSON.stringify(facts))

      const front = await visit(app, chrome, `${website.origin}/`)
      const [frontTab] = await tabIds(chrome) as string[]
      const held = await request(async (fn) => await front.evaluate(fn))
      check('[app:wake-lock-released-when-the-tab-goes-behind] a website tab in front holds a screen wake lock', held.outcome === 'granted', JSON.stringify(held))
      await chrome.click('#new-tab')
      const behind = await waitFor(async () => (await sentinelState(front)).visibility === 'hidden')
      const released = await waitFor(async () => (await sentinelState(front)).released, 8_000)
      console.log(`PROBE behind-a-tab ${JSON.stringify({ behind, released, state: await sentinelState(front) })}`)
      check('[app:wake-lock-released-when-the-tab-goes-behind] a tab put behind another reads hidden', behind)
      check('[app:wake-lock-released-when-the-tab-goes-behind] and the lock it held is released', released)
      const whileHidden = await front.evaluate(async () => await navigator.wakeLock.request('screen').then(() => 'granted', (error: Error) => `refused:${error.name}`))
      check('[app:wake-lock-released-when-the-tab-goes-behind] a request made by the tab while it is behind is refused', whileHidden === 'refused:NotAllowedError', whileHidden)
      await chrome.click(`.tab[data-id="${String(frontTab)}"]`)
      expect(await waitFor(async () => (await sentinelState(front)).visibility === 'visible')).toBe(true)
      const again = await request(async (fn) => await front.evaluate(fn))
      check('[app:wake-lock-released-when-the-tab-goes-behind] and the page is granted one again once its tab is in front', again.outcome === 'granted' && again.released === false, JSON.stringify(again))
    })
  } finally {
    await closeElectron(app)
    await insecure.close()
  }
}, QA_TEST_TIMEOUT_MS)
