// The permission gate's one allowed Chromium permission, proved against a
// real page rather than against the handler in isolation -- the gate is
// `critical: true`, so an allow that only unit tests have seen is not
// proven at all.
//
// DELIBERATELY AN ORDINARY WEBSITE, not an Orivon app: no manifest, no
// grant, no install. Clipboard write is a web-platform power gated by
// Chromium's own user-activation rule, not an `orivon.*` capability, and
// the regression this file guards broke every site in the browser, not
// only ported apps.
//
// THE CLICK IS THE POINT. `page.evaluate` carries no transient user
// activation, so a write driven from it would fail for a reason that has
// nothing to do with the gate. The fixture below wires a real button to a
// real click handler, exactly as a copy button is written, and Playwright
// clicks it -- which is the only path that exercises what the allow
// actually permits.
//
// Hermetic: one throwaway server on loopback, nothing else.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'

const HOST = '127.0.0.1'
// 8872-8882 are taken by the fixture apps and their servers (freetube-fixture.ts,
// test/apps/*/config.mjs); this file needs one of its own.
const PORT = 8883
// Trailing slash: this is compared against what the address bar and the
// view's own url() report after navigation, and Chromium normalises a bare
// origin to one.
const ORIGIN = `http://${HOST}:${PORT}/`
const TITLE = 'clipboard fixture'

// A copy button, written the way the web platform says to write one. The
// result is stashed on window rather than returned, so the assertion can
// read it after the click without needing the handler's own promise.
const PAGE = `<!doctype html><meta charset="utf-8"><title>${TITLE}</title>
<body>
<button id="copy">Copy</button>
<script>
  window.__writeResult = 'not-run'
  document.getElementById('copy').addEventListener('click', () => {
    navigator.clipboard.writeText('orivon-clipboard-e2e')
      .then(() => { window.__writeResult = 'resolved' })
      .catch((e) => { window.__writeResult = e.name + ': ' + e.message })
  })
</script>
</body>`

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 + APP_CLOSE_RACE_MS + 30_000

it('lets an ordinary website write the clipboard from a real click, and still refuses to let it read', async () => {
  await runPhase('clipboard-write', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let server: Server | undefined
    try {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(PAGE)
      })
      await new Promise<void>((resolve) => { server?.listen(PORT, HOST, resolve) })
      check('a plain page with a copy button is served over loopback HTTP, with no manifest', true)

      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const view = await navigateToFixture(app, ORIGIN, TITLE)

      const secure = await evaluateRetrying(view, () => window.isSecureContext)
      check('127.0.0.1 is a secure context, so navigator.clipboard exists at all', secure === true)

      // A real click: the transient user activation Chromium requires.
      await view.click('#copy')
      await view.waitForFunction(() => (window as unknown as { __writeResult: string }).__writeResult !== 'not-run')
      const writeResult = await evaluateRetrying(view, () => (window as unknown as { __writeResult: string }).__writeResult)
      check(`writeText() resolved from a user gesture (got ${String(writeResult)})`, writeResult === 'resolved')

      // The direction that stays shut. Read is what would hand a page
      // whatever the person last copied somewhere else.
      const readResult = await evaluateRetrying(view, async () => {
        try {
          await navigator.clipboard.readText()
          return 'RESOLVED'
        } catch (e) {
          return (e as Error).name
        }
      })
      check(`readText() is still refused (got ${String(readResult)})`, readResult === 'NotAllowedError')

      expect(secure).toBe(true)
      expect(writeResult).toBe('resolved')
      expect(readResult).toBe('NotAllowedError')
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
    }
  })
}, TEST_TIMEOUT_MS)
