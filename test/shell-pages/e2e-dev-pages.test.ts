// The shell's own pages under `npm run dev`: Settings, History, Profiles and a
// private window's first page load from the dev server. Starts a real Vite dev
// server for the renderer (electron.vite.config.ts's own `renderer` section,
// on a free port, never 5173, which a developer's own `npm run dev` may hold),
// launches Electron against it with `ELECTRON_RENDERER_URL` exactly as
// `electron-vite dev` does, and asserts every shell page renders real
// content rather than an empty `#app`. e2e-internal-pages.test.ts covers the
// same pages' behaviour in a built launch; route.ts's and serve.ts's own
// unit tests cover the routing refusals a dev launch exercises live.
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { rendererAlias, rendererHmr, rendererHost, rendererRoot } from '../../electron.vite.config.js'
import { INTERNAL_PAGES } from '../../src/main/pages/internal-pages.js'
import type { InternalPageId } from '../../src/main/pages/internal-pages.js'

const TEST_TIMEOUT_MS = 60_000

let devServer: ViteDevServer
let devUrl: string

/** A free port, chosen by the OS then released, so this suite never
 * collides with a developer's own `npm run dev` on 5173 or another suite's
 * fixture ports. Not `server.port: 0` on the Vite server itself: Vite's own
 * HMR-client injection falls back to its literal default port (5173) rather
 * than the one actually bound when the declared port is the falsy `0`, which
 * would tell the client the wrong place to connect regardless of `hmr.host`. */
async function freePort (): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createNetServer()
    probe.on('error', reject)
    probe.listen(0, rendererHost, () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => { resolvePort(port) })
    })
  })
}

beforeAll(async () => {
  // The very settings electron.vite.config.ts's own `renderer` section gives
  // electron-vite, so the two can never drift apart: same root, same
  // module-shim aliases, same host, same HMR host (rendererHost's own doc
  // says why the host is pinned at all, and why to this value) -- pinned to
  // the same concrete port too, so the HMR client is told the place this
  // server actually listens on rather than Vite's own default.
  const port = await freePort()
  devServer = await createServer({
    root: rendererRoot,
    server: { port, strictPort: true, host: rendererHost, hmr: { ...rendererHmr, port } },
    logLevel: 'silent',
    resolve: { alias: rendererAlias }
  })
  await devServer.listen()
  devUrl = `http://${rendererHost}:${String(port)}`
})

afterAll(async () => {
  await devServer.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type ShellBridge = { orivonShell: { openInternal: (page: string, path?: string) => void } }

/** In dev mode the chrome view's own URL is the dev server's root, not a
 * built `.../renderer/index.html` path (smoke-helpers.mjs's `findChrome`
 * assumes the latter). */
function findDevChrome (app: ElectronApplication): Page {
  const chrome = app.windows().find((w) => new RegExp(`^${devUrl}/?$`).test(w.url()))
  if (chrome === undefined) throw new Error(`chrome view not found among ${JSON.stringify(app.windows().map((w) => w.url()))}`)
  return chrome
}

/** Watches every window this app ever opens, from the instant Playwright
 * knows about it (`app.on('window', ...)`) rather than from whenever a test
 * later gets a `Page` for it -- a console message from the dev server's HMR
 * client fires during that page's very first load, before any URL-matching
 * `waitFor` here would otherwise have a handle to listen through. */
/** Only an `orivon://` page's own violations: the dashboard (`/newtab/`)
 * carries a deliberate `connect-src 'none'` of its own (no network of its
 * own, by design) that also refuses the dev server's HMR client Vite
 * injects into every page regardless -- a pre-existing, intentional limit
 * on an ordinary tab, unrelated to what this suite is asserting about the
 * shell's own pages. */
function watchForCspViolations (app: ElectronApplication, violations: string[]): void {
  app.on('window', (page) => {
    page.on('console', (msg) => {
      if (page.url().startsWith('orivon://') && /Content Security Policy/i.test(msg.text())) violations.push(`${page.url()}: ${msg.text()}`)
    })
  })
}

async function launched (extraArgs: readonly string[] = []): Promise<{ app: ElectronApplication, chrome: Page, cspViolations: string[] }> {
  const cspViolations: string[] = []
  const app = await launchElectron({
    args: [HERMETIC_RESOLVER, ...extraArgs],
    env: { ELECTRON_RENDERER_URL: devUrl, ORIVON_DEV_ORIGINS: '1' },
    // From the app's first window on: the launch no longer returns before the chrome has drawn.
    onLaunch: (launchedApp) => { watchForCspViolations(launchedApp, cspViolations) }
  })
  expect(await waitFor(() => { try { findDevChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findDevChrome(app), cspViolations }
}

async function openInternal (chrome: Page, page: string, path?: string): Promise<void> {
  await chrome.evaluate(([p, sub]) => { (window as unknown as ShellBridge).orivonShell.openInternal(p, sub) }, [page, path] as const)
}

/** Real content, not an empty `#app` left by a failed script or stylesheet
 * load: a handful of rendered characters, well
 * short of a real page's but well past "nothing ran". */
const MIN_RENDERED_CHARS = 100

async function rendersRealContent (page: Page): Promise<boolean> {
  return await waitFor(async () => {
    const html = await page.evaluate(() => document.getElementById('app')?.innerHTML.trim() ?? '').catch(() => '')
    return html.length > MIN_RENDERED_CHARS
  })
}

it('opens each of settings, history and profiles with real content, in dev mode, with no CSP violation from the dev server\'s HMR socket', async () => {
  const { app, chrome, cspViolations } = await launched()
  try {
    const pages = INTERNAL_PAGES.filter((id): id is Exclude<InternalPageId, 'private'> => id !== 'private')
    for (const page of pages) {
      await openInternal(chrome, page)
      expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(`orivon://${page}`))), `${page} did not open`).toBe(true)
      const opened = app.windows().find((w) => w.url().startsWith(`orivon://${page}`)) as Page
      expect(await rendersRealContent(opened), `${page} rendered no real content`).toBe(true)
    }
    // The HMR client's own connect attempt is async right after load; give
    // it a moment to either succeed or log the violation this asserts against.
    await new Promise((r) => setTimeout(r, 500))
    expect(cspViolations).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('renders a deep link into settings (orivon://settings/privacy), not a blank page', async () => {
  const { app, chrome } = await launched()
  try {
    await openInternal(chrome, 'settings', '/privacy')
    expect(await waitFor(() => app.windows().some((w) => w.url() === 'orivon://settings/privacy'))).toBe(true)
    const settings = app.windows().find((w) => w.url() === 'orivon://settings/privacy') as Page
    expect(await rendersRealContent(settings)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('a private window\'s first page renders real content, in dev mode', async () => {
  const cspViolations: string[] = []
  const app = await launchElectron({
    args: [HERMETIC_RESOLVER, '--orivon-private'],
    env: { ELECTRON_RENDERER_URL: devUrl, ORIVON_DEV_ORIGINS: '1' },
    onLaunch: (launchedApp) => { watchForCspViolations(launchedApp, cspViolations) }
  })
  try {
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://private')))).toBe(true)
    const priv = app.windows().find((w) => w.url().startsWith('orivon://private')) as Page
    expect(await rendersRealContent(priv)).toBe(true)
    await new Promise((r) => setTimeout(r, 500))
    expect(cspViolations).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
