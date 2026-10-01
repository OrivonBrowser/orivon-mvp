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
// THE CLICK IS THE POINT. `page.evaluate` runs as a user gesture
// (measured: `requestFullscreen()` called from it resolves), so a write
// driven from there proves nothing about what a page's own code may do.
// The fixture below wires a real button to a real click handler, exactly
// as a copy button is written, and Playwright clicks it -- the path a real
// page's copy takes, and the one the allow actually permits.
//
// Hermetic: one throwaway server on loopback, nothing else.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying, popoverShown, waitFor } from './smoke-helpers.mjs'
import type { ElectronApplication, Page } from 'playwright'
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
<button id="copy">Copy</button><button id="paste">Paste</button>
<script>
  window.__writeResult = 'not-run'
  window.__readResult = 'not-run'
  document.getElementById('paste').addEventListener('click', () => {
    navigator.clipboard.readText()
      .then(() => { window.__readResult = 'RESOLVED' })
      .catch((e) => { window.__readResult = e.name })
  })
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

/** The site's question under the address bar: an Orivon overlay, no native dialog. */
async function waitForPrompt (app: ElectronApplication): Promise<Page> {
  let found: Page | undefined
  const shown = await waitFor(async () => {
    if (!(await popoverShown(app, 'overlay=site-prompt'))) return false
    const candidate = app.windows().filter((w) => w.url().includes('overlay=site-prompt') && !w.isClosed()).at(-1)
    if (candidate === undefined) return false
    try { await candidate.waitForSelector('.site-prompt .btn-row', { timeout: 2_000 }); found = candidate; return true } catch { return false }
  }, 15_000)
  expect(shown).toBe(true)
  return found as Page
}

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 + APP_CLOSE_RACE_MS + 30_000

it('lets an ordinary website write the clipboard from a real click, and cannot read it without being asked', async () => {
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

      // The direction that stays shut until the person says otherwise. Read is what would hand a page
      // whatever the person last copied somewhere else, so by default it raises the site's question and
      // is granted nothing on its own.
      await view.click('#paste')
      const prompt = await waitForPrompt(app)
      const question = await prompt.locator('.sp-text').allTextContents()
      check(`readText() raises the question instead of being granted (got ${JSON.stringify(question)})`, question.join(' ').includes('wants to see text and images you copied'))
      const beforeAnswer = await evaluateRetrying(view, () => (window as unknown as { __readResult: string }).__readResult)
      check(`readText() is still pending while the question is open (got ${String(beforeAnswer)})`, beforeAnswer === 'not-run')
      await prompt.waitForSelector('.site-prompt:not(.arming)')
      try { await prompt.click('.btn-row .btn:text-is("Block")') } catch (error) { if (!/closed|destroyed/.test(String(error))) throw error }
      await view.waitForFunction(() => (window as unknown as { __readResult: string }).__readResult !== 'not-run')
      const readResult = await evaluateRetrying(view, () => (window as unknown as { __readResult: string }).__readResult)
      check(`readText() is refused once the person blocks it (got ${String(readResult)})`, readResult === 'NotAllowedError')

      expect(secure).toBe(true)
      expect(writeResult).toBe('resolved')
      expect(question.join(' ')).toContain('wants to see text and images you copied')
      expect(beforeAnswer).toBe('not-run')
      expect(readResult).toBe('NotAllowedError')
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
    }
  })
}, TEST_TIMEOUT_MS)
