// Shared plumbing for the e2e-qa-* specs: an ephemeral-port fixture server,
// a launched shell, and navigation that waits on the state it asserts.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { expect } from 'vitest'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { launchElectron } from './launch-electron.mjs'
import { findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'

export const QA_TEST_TIMEOUT_MS = 90_000

export interface FixtureServer { origin: string, close: () => Promise<void> }

/** Port 0 on purpose: fixed fixture ports collide with other processes on the dev machine. */
export async function startServer (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<FixtureServer> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
  }
}

export function html (res: ServerResponse, body: string, status = 200): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(body)
}

export async function launchShell (options: Parameters<typeof launchElectron>[0] = {}): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', ...options, args: [HERMETIC_RESOLVER, ...(options.args ?? [])] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

/** Writes the per-site answers a profile starts with (`site-settings.json`), for a `seedProfile`: `sites` is origin -> kind -> answer. */
export async function seedSiteAnswers (userDataDir: string, sites: Record<string, Record<string, 'allow' | 'block'>>): Promise<void> {
  await mkdir(userDataDir, { recursive: true })
  await writeFile(join(userDataDir, 'site-settings.json'), JSON.stringify({ version: 1, sites }))
}

/** Types `url` into the address bar and waits until the main process holds a web contents committed at it and done loading.
 * For a spec that never uses the tab's own page: it does not need Playwright to have attached that page, which it
 * sometimes never does for a tab opened later on macOS (test/README.md, Known risk). */
export async function visitWithoutPage (app: ElectronApplication, chrome: Page, url: string): Promise<void> {
  await clickAddressBarRetrying(chrome, url)
  expect((await waitForTab(chrome, { address: url })).ok).toBe(true)
  expect(await waitFor(async () => await app.evaluate(({ webContents }, target) =>
    webContents.getAllWebContents().some((wc) => wc.getURL() === target && !wc.isLoading()), url))).toBe(true)
}

/** Moves the pointer onto the middle of the element `selector` in the page whose address is `url`, from the main process, and waits for the element for as long as the page takes to draw it.
 * For a spec that never uses the tab's own page: it does not need Playwright to have attached that page, which it
 * sometimes never does for a tab opened later on macOS (test/README.md, Known risk). */
export async function hoverWithoutPage (app: ElectronApplication, url: string, selector: string): Promise<void> {
  await app.evaluate(async ({ webContents }, [target, css]) => {
    const middle = `(() => { const box = document.querySelector(${JSON.stringify(css)})?.getBoundingClientRect(); return box === undefined ? null : { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } })()`
    const deadline = Date.now() + 10_000
    for (;;) {
      const wc = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed() && candidate.getURL() === target)
      const at = wc === undefined ? null : await wc.executeJavaScript(middle).catch(() => null) as { x: number, y: number } | null
      if (wc !== undefined && at !== null) {
        wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
        return
      }
      if (Date.now() > deadline) throw new Error(`no ${css as string} in a page at ${target as string}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }, [url, selector] as const)
}

/** Types `url` into the address bar, waits for the tab to report it, and returns that tab's own page. */
export async function visit (app: ElectronApplication, chrome: Page, url: string): Promise<Page> {
  await clickAddressBarRetrying(chrome, url)
  expect((await waitForTab(chrome, { address: url })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, url) !== undefined)).toBe(true)
  const view = findViewShowing(app, chrome, url) as Page
  await view.waitForLoadState('load')
  return view
}
