// What a chosen setting does in the running shell: a settings.json on disk at
// launch changes the theme, the bookmarks bar, where the address bar searches
// and what closing the last tab does.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './support/launch-electron.mjs'
import { clickAddressBarRetrying } from './support/e2e-helpers.js'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './support/smoke-helpers.mjs'

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>results</title><p>results</p>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 45_000

async function seed (dir: string, values: Record<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values }))
}

it('applies the theme, the bookmarks bar, the search engine and the last-tab rule that were chosen', async () => {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    seedProfile: async (dir) => {
      await seed(dir, {
        'appearance.theme': 'dark',
        'appearance.bookmarksBar': 'always',
        'search.engine': 'custom',
        'search.customUrl': `${origin}/find?text=%s`,
        'tabs.lastTabClosed': 'newTab'
      })
    }
  })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)

    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')

    // Shown with no bookmark in it, and the chrome view sized to include it.
    // The first state push may not have reached the page yet: waited for, not read once.
    expect(await waitFor(async () => await evaluateRetrying(chrome, () => document.documentElement.dataset['bookmarks']) === 'some')).toBe(true)
    expect(await evaluateRetrying(chrome, () => getComputedStyle(document.querySelector('#bookmarks-bar') as Element).display)).not.toBe('none')

    await clickAddressBarRetrying(chrome, 'hello world')
    expect((await waitForTab(chrome, { address: `${origin}/find?text=hello+world` })).ok).toBe(true)

    // Closing the only tab opens a new one instead of closing the window.
    const [before] = await tabIds(chrome)
    await chrome.click('.tab .close')
    expect(await waitFor(async () => {
      const ids = await tabIds(chrome)
      return ids.length === 1 && ids[0] !== before
    })).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps the defaults for a settings file with values the schema refuses', async () => {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    seedProfile: async (dir) => {
      await seed(dir, { 'appearance.theme': 'purple', 'appearance.bookmarksBar': 'sideways', 'search.customUrl': 'http://insecure.example/?q=%s' })
    }
  })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)

    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
    expect(await waitFor(async () => await evaluateRetrying(chrome, () => document.documentElement.dataset['bookmarks']) === 'none')).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
