// ONE-OFF PROBE, never committed: which webContents events Electron 44 emits for a failed load before commit and for a body cut short after it.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, type FixtureServer } from '../support/qa-helpers.js'
import { delay } from '../support/smoke-helpers.mjs'

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((req, res) => {
    if (req.url === '/cut') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '4096' })
      res.write('<!doctype html><title>Cut short</title><p>the start of the page</p>')
      setTimeout(() => { res.socket?.destroy() }, 300)
      return
    }
    html(res, '<!doctype html><title>Fine</title><p>fine</p>')
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('records the events', async () => {
  const { app, chrome } = await launchShell()
  try {
    await app.evaluate(({ app: electronApp, webContents }) => {
      const g = globalThis as unknown as { __ev: string[] }
      g.__ev = []
      const names = ['did-start-navigation', 'did-fail-load', 'did-fail-provisional-load', 'did-navigate', 'did-finish-load', 'did-stop-loading']
      const hook = (wc: Electron.WebContents): void => {
        for (const name of names) {
          wc.on(name as 'did-fail-load', (...args: unknown[]) => {
            const shown = args.slice(1, 5).map((a) => (typeof a === 'object' && a !== null ? JSON.stringify({ url: (a as { url?: string }).url, isMainFrame: (a as { isMainFrame?: boolean }).isMainFrame }) : JSON.stringify(a)))
            g.__ev.push(`${String(wc.id)} ${name} ${shown.join(' ')} getURL=${wc.getURL()}`)
          })
        }
      }
      for (const wc of webContents.getAllWebContents()) hook(wc)
      electronApp.on('web-contents-created', (_e, wc) => { hook(wc) })
    })
    for (const url of [`${server.origin}/cut`, 'http://unresolvable.invalid/', `${server.origin}/`]) {
      await clickAddressBarRetrying(chrome, url)
      await delay(3_000)
      const seen = await app.evaluate(() => { const g = globalThis as unknown as { __ev: string[] }; const out = g.__ev; g.__ev = []; return out })
      console.log(`=== ${url}\n${seen.filter((line) => !line.includes('getURL=orivon') && !line.includes('file://')).join('\n')}`)
    }
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
