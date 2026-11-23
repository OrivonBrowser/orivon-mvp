// A window that ends without its `close` event (the display server dropped the connection, `destroy()`, `app.exit()`)
// takes its tabs down with it: the main process must not throw while it does. With an extension loaded the library
// tracks every tab, so a tab's page ending after its window used to activate a neighbour in a window that no longer
// existed, and the library read the id of that destroyed window.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/tabs/e2e-window-destroyed.test.ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { parseRecords } from '../../src/main/diagnostics/crash-records.js'
import { seedFixture, waitRecovered } from '../extensions/extensions-e2e-helpers.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput, profileDirOf } from '../support/launch-electron.mjs'
import { html, launchShell, startServer } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 180_000
const EXIT_WAIT_MS = 30_000

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((request, response) => {
    html(response, `<!doctype html><title>${request.url ?? '/'}</title><body>${request.url ?? '/'}</body>`)
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('ends without an error in the main process when a window is destroyed with no close and a tab\'s page ends after it', async () => {
  await runPhase('a window destroyed with no close', async (check) => {
    const { app, chrome } = await launchShell({
      sandbox: true,
      seedProfile: async (dir) => { seedFixture(dir, 'content-marker') }
    })
    try {
      expect(await waitFor(async () => (await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 1)).toBe(true)
      await waitRecovered(app)

      const first = `${server.origin}/first`
      const second = `${server.origin}/second`
      const opened = async (url: string): Promise<boolean> => await waitFor(async () => await app.evaluate(({ webContents }, target) =>
        webContents.getAllWebContents().some((wc) => wc.getURL() === target && !wc.isLoading()), url))
      for (const url of [first, second]) {
        await chrome.evaluate((address: string) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(address) }, url)
        check(`the tab at ${url.slice(server.origin.length)} is open`, await opened(url))
      }

      const exited = new Promise<number | null>((resolve) => { app.process().once('exit', (code) => { resolve(code) }) })
      // The window goes with no `close`; the page in front ends right after it, as every page does when the browser's
      // connection to the display is gone. Its neighbour is the tab that would be put in front.
      await app.evaluate(({ BaseWindow, webContents }, target) => {
        const page = webContents.getAllWebContents().find((wc) => wc.getURL() === target)
        if (page === undefined) throw new Error(`no webContents at ${target}`)
        const holdsPage = (view: { children?: unknown[], webContents?: unknown }): boolean =>
          view.webContents === page || (view.children ?? []).some((child) => holdsPage(child as { children?: unknown[], webContents?: unknown }))
        const window = BaseWindow.getAllWindows().find((candidate) => holdsPage(candidate.contentView as unknown as { children?: unknown[] }))
        if (window === undefined) throw new Error('no window holds the page')
        window.destroy()
        page.close()
      }, second).catch(() => { /* the browser may end before the call answers */ })

      const code = await Promise.race([exited, new Promise<'still running'>((resolve) => { setTimeout(() => { resolve('still running') }, EXIT_WAIT_MS) })])
      const log = mainOutput(app)
      check('the browser ended on its own, not by an error', code !== 'still running' && code !== 1, `exit code ${String(code)}`)
      check('the main process logged no uncaught exception', !log.includes('uncaught exception in the main process'),
        log.split('\n').filter((line) => line.includes('uncaught exception') || line.includes('TypeError') || line.includes('    at ')).slice(0, 14).join('\n'))
      check('no state push read the destroyed window', !log.includes('state part fullScreen failed'))

      const dir = profileDirOf(app)
      const crashes = dir === undefined || !existsSync(join(dir, 'diagnostics', 'crashes.json'))
        ? []
        : parseRecords(readFileSync(join(dir, 'diagnostics', 'crashes.json'), 'utf8'))
      check('no main-process crash was recorded', !crashes.some((record) => record.kind === 'main-error'), JSON.stringify(crashes.map((record) => `${record.kind}: ${record.message}`)))
    } finally {
      await closeElectron(app)
    }
  })
}, TEST_TIMEOUT_MS)
