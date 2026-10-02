// The main menu lists every row, and opens again after each way of closing it, whatever kind of tab is in front: a
// registered app's, a pinned one, one in a split, one whose page has died. A menu whose rows could not be worked out
// for the tab in front would still open, as an empty card, so each open reads the rows the page really holds.
//
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-menu-states.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, closeElectron } from './launch-electron.mjs'
import { pressKey } from './e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'
import { popoverShown, waitFor } from './smoke-helpers.mjs'

/** The menu lists nineteen rows today; this is only the point below which the card is plainly not the menu. */
const AT_LEAST_ROWS = 15
/** Past the host's own debounce after a close that was a blur. */
const PAST_DEBOUNCE_MS = 450

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>menu states</title><body>hello</body>')
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const menuShown = async (app: ElectronApplication): Promise<boolean> => await popoverShown(app, 'overlay=menu')
const pause = async (ms: number): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, ms) }) }

async function rowsOnScreen (app: ElectronApplication): Promise<number> {
  const page = app.windows().find((w) => w.url().includes('overlay=menu'))
  if (page === undefined) return -1
  await page.waitForSelector('.menu-row').catch(() => {})
  return await page.evaluate(() => document.querySelectorAll('.menu-row').length).catch(() => -1)
}

/** Registers `origin` with an empty grant, so its tab is an app tab and still holds no capability. */
async function register (app: ElectronApplication, origin: string): Promise<boolean> {
  const manifest: Manifest = {
    orivonApiVersion: 0, id: 'app.orivon.menu-states-e2e', name: 'Menu states e2e fixture', version: '1.0.0', entry: 'index.html',
    capabilities: { net: { tcp: { connect: ['127.0.0.1:9'] } } }
  }
  return await app.evaluate(async (_electron, request: DevGrantRequest) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    await hook(request)
    return true
  }, { origin: server.origin, manifest, capability: 'tcp.connect', patterns: [] } satisfies DevGrantRequest)
}

async function runCommand (chrome: Page, id: string): Promise<void> {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
  await pause(800)
}

it('lists its rows, and reopens after Escape and after the button, with each kind of tab in front', async () => {
  const { app, chrome } = await launchShell({ scheme: 'dark' })
  const seen: Record<string, number[]> = {}
  /** Opens the menu, closes it by Escape, opens it, closes it by the button, opens it: three opens, three row counts. */
  const through = async (kind: string): Promise<void> => {
    const rows: number[] = []
    for (const closeFirstBy of ['nothing', 'Escape', 'the button']) {
      if (closeFirstBy === 'Escape') await pressKey(app, 'overlay=menu', 'Escape')
      if (closeFirstBy === 'the button') await chrome.click('#menu')
      if (closeFirstBy !== 'nothing') {
        expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
        await pause(PAST_DEBOUNCE_MS)
      }
      await chrome.click('#menu')
      expect(await waitFor(async () => await menuShown(app))).toBe(true)
      rows.push(await rowsOnScreen(app))
    }
    await pressKey(app, 'overlay=menu', 'Escape')
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
    await pause(PAST_DEBOUNCE_MS)
    seen[kind] = rows
  }
  try {
    expect(await register(app, server.origin)).toBe(true)
    await visit(app, chrome, `${server.origin}/app`)
    await through('an app tab')

    await runCommand(chrome, 'tab.pin')
    await through('a pinned tab')

    await chrome.click('#new-tab')
    await pause(800)
    await runCommand(chrome, 'split.toggle')
    await through('a split view')

    await app.evaluate(({ webContents }) => {
      const tab = webContents.getAllWebContents().find((wc) => wc.getType() === 'window' && /^http:\/\/127\.0\.0\.1:\d+\/app/.test(wc.getURL()))
      if (tab !== undefined) process.kill(tab.getOSProcessId(), 'SIGKILL')
    })
    await pause(1500)
    await through('a tab whose page has died')

    for (const [kind, counts] of Object.entries(seen)) {
      expect({ kind, counts: counts.map((count) => count >= AT_LEAST_ROWS) }).toEqual({ kind, counts: [true, true, true] })
    }
    expect(Object.keys(seen)).toHaveLength(4)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
