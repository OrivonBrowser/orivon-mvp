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
  return await tabPageAt(app, chrome, url)
}

/** How long a tab may take to reach an app's address after a relaunch before the service workers a debugger holds are let go: far past the 200 ms a start takes, short of `WAIT_TIMEOUT_MS`. */
const WORKER_START_PATIENCE_MS = 1_500

/**
 * Lets go every service worker that a DevTools client holds at its first instruction, and answers how many it asked to go on.
 * Playwright has Chromium hold each worker it can see (`Target.setAutoAttach` with `waitForDebuggerOnStart`) and lets it go with
 * `Runtime.runIfWaitingForDebugger`. When that release is lost the worker waits for ever and the navigation it answers never
 * commits; that playwright-core 1.62 detaches a worker target it meets on a page's session with no such call, and loses the race
 * with the worker's start, is the likely cause and is provisional. Any session may say "go on", so this one asks through a debugger
 * the main process opens for the moment (or borrows from a contents that already has one) and closes it again: no page is left
 * with a client it did not have.
 */
export async function resumePausedWorkers (app: ElectronApplication): Promise<number> {
  return await app.evaluate(async ({ webContents }) => {
    const live = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed())
    const host = live.find((contents) => !contents.debugger.isAttached()) ?? live[0]
    if (host === undefined) return 0
    const own = !host.debugger.isAttached()
    if (own) host.debugger.attach('1.3')
    try {
      const { targetInfos } = await host.debugger.sendCommand('Target.getTargets') as { targetInfos: Array<{ targetId: string, type: string }> }
      let resumed = 0
      for (const target of targetInfos.filter((candidate) => candidate.type === 'service_worker')) {
        const { sessionId } = await host.debugger.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true }) as { sessionId: string }
        await host.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId)
        await host.debugger.sendCommand('Target.detachFromTarget', { sessionId })
        resumed += 1
      }
      return resumed
    } finally {
      if (own) host.debugger.detach()
    }
  })
}

/**
 * `visit` for an address whose app keeps an installed service worker, in a profile started again after the one that
 * installed it. Chromium starts that worker in a process of its own to answer the first navigation, and under Playwright
 * the start is sometimes held for ever by the debugger (`resumePausedWorkers` says how): the tab keeps loading and never
 * commits, and typing the address again moves it on. A person's Orivon has no such client, and nothing in it holds a worker.
 * So when the tab has not reached `url` in `WORKER_START_PATIENCE_MS` the workers are let go and the spec's output says so; a
 * tab that still does not arrive fails the spec.
 */
export async function visitAfterRelaunch (app: ElectronApplication, chrome: Page, url: string): Promise<Page> {
  await clickAddressBarRetrying(chrome, url)
  let arrived = await waitForTab(chrome, { address: url }, WORKER_START_PATIENCE_MS)
  if (!arrived.ok) {
    const resumed = await resumePausedWorkers(app)
    console.warn(`[qa] ${url} had not committed ${String(WORKER_START_PATIENCE_MS)} ms after the relaunch: asked ${String(resumed)} service worker(s) to go on that the test driver may hold at their start`)
    arrived = await waitForTab(chrome, { address: url })
  }
  expect(arrived.ok).toBe(true)
  return await tabPageAt(app, chrome, url)
}

async function tabPageAt (app: ElectronApplication, chrome: Page, url: string): Promise<Page> {
  expect(await waitFor(() => findViewShowing(app, chrome, url) !== undefined)).toBe(true)
  const view = findViewShowing(app, chrome, url) as Page
  await view.waitForLoadState('load')
  return view
}
