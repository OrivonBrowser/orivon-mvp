// Shared plumbing for the e2e-qa-* specs: an ephemeral-port fixture server,
// a launched shell, and navigation that waits on the state it asserts.

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

/** Types `url` into the address bar and waits until the main process holds a web contents committed at it and done loading.
 * For a spec that never uses the tab's own page: it does not need Playwright to have attached that page, which it
 * sometimes never does for a tab opened later on macOS (test/README.md, Known risk). */
export async function visitWithoutPage (app: ElectronApplication, chrome: Page, url: string): Promise<void> {
  await clickAddressBarRetrying(chrome, url)
  expect((await waitForTab(chrome, { address: url })).ok).toBe(true)
  expect(await waitFor(async () => await app.evaluate(({ webContents }, target) =>
    webContents.getAllWebContents().some((wc) => wc.getURL() === target && !wc.isLoading()), url))).toBe(true)
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
