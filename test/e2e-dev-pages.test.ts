// The owner's dev-mode reports: opening Settings, History or a private
// window's first page was blank -- dev mode only. Starts a real Vite dev
// server for the renderer (electron.vite.config.ts's own `renderer` section,
// on a free port, never 5173, which the owner's own `npm run dev` may hold),
// launches Electron against it with `ELECTRON_RENDERER_URL` exactly as
// `electron-vite dev` does, and asserts every shell page renders real
// content rather than an empty `#app`. e2e-internal-pages.test.ts covers the
// same pages' behaviour in a built launch; route.ts's and serve.ts's own
// unit tests cover the routing refusals a dev launch exercises live.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { aliasPattern, buildAliasEntries } from '../src/shim/module-map.js'
import { INTERNAL_PAGES } from '../src/main/pages/internal-pages.js'
import type { InternalPageId } from '../src/main/pages/internal-pages.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const TEST_TIMEOUT_MS = 60_000

let devServer: ViteDevServer
let devUrl: string

beforeAll(async () => {
  // Mirrors electron.vite.config.ts's `renderer` section closely enough for
  // these pages: same root, same module-shim aliases (a page reaches a
  // shimmed built-in the same way the real dev server lets it). `port: 0`:
  // whatever the OS hands out, so this never collides with the owner's own
  // `npm run dev` on 5173 or another suite's fixture ports.
  devServer = await createServer({
    root: resolve(repoRoot, 'src/renderer'),
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'silent',
    resolve: {
      alias: buildAliasEntries().map(({ specifier, kind, implementation }) => ({
        find: aliasPattern(specifier),
        replacement: kind === 'package' ? implementation : resolve(repoRoot, 'src/shim', implementation)
      }))
    }
  })
  await devServer.listen()
  const address = devServer.httpServer?.address() as AddressInfo | null
  if (address === null || address === undefined) throw new Error('the dev server for this suite has no address')
  devUrl = `http://127.0.0.1:${String(address.port)}`
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

async function launched (extraArgs: readonly string[] = []): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({
    args: [HERMETIC_RESOLVER, ...extraArgs],
    env: { ELECTRON_RENDERER_URL: devUrl, ORIVON_DEV_ORIGINS: '1' }
  })
  expect(await waitFor(() => { try { findDevChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findDevChrome(app) }
}

async function openInternal (chrome: Page, page: string, path?: string): Promise<void> {
  await chrome.evaluate(([p, sub]) => { (window as unknown as ShellBridge).orivonShell.openInternal(p, sub) }, [page, path] as const)
}

/** Real content, not an empty `#app` left by a failed script or stylesheet
 * load (the owner's own report): a handful of rendered characters, well
 * short of a real page's but well past "nothing ran". */
const MIN_RENDERED_CHARS = 100

async function rendersRealContent (page: Page): Promise<boolean> {
  return await waitFor(async () => {
    const html = await page.evaluate(() => document.getElementById('app')?.innerHTML.trim() ?? '').catch(() => '')
    return html.length > MIN_RENDERED_CHARS
  })
}

it('opens each of settings, history and profiles with real content, in dev mode', async () => {
  const { app, chrome } = await launched()
  try {
    const pages = INTERNAL_PAGES.filter((id): id is Exclude<InternalPageId, 'private'> => id !== 'private')
    for (const page of pages) {
      await openInternal(chrome, page)
      expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(`orivon://${page}`))), `${page} did not open`).toBe(true)
      const opened = app.windows().find((w) => w.url().startsWith(`orivon://${page}`)) as Page
      expect(await rendersRealContent(opened), `${page} rendered no real content`).toBe(true)
    }
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
  const app = await launchElectron({
    args: [HERMETIC_RESOLVER, '--orivon-private'],
    env: { ELECTRON_RENDERER_URL: devUrl, ORIVON_DEV_ORIGINS: '1' }
  })
  try {
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://private')))).toBe(true)
    const priv = app.windows().find((w) => w.url().startsWith('orivon://private')) as Page
    expect(await rendersRealContent(priv)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
