// In developer mode a local origin that serves a DDOC hash tree is Website
// Level 2 (src/main/dev/local-ddoc.ts): no domain record can anchor a local
// address's tree, so the tree it serves is assumed to hold. Proven for both
// kinds of local origin, a loopback URL and a developer `.eth` name mapped
// to loopback by the names file (one label, and an ENS subname as
// orivon-ports names its apps), against the real shield, mark and Web3 Score
// page, which must say the level counts only in developer mode. A local
// origin that serves no tree stays Level 1.
//
// NO HERMETIC_RESOLVER HERE, for the reason e2e-eth-secure-context.test.ts
// gives: the names file's own --host-resolver-rules is the only mapping this
// test needs, and every name in it points at loopback.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, readShield, runPhase } from '../support/e2e-helpers.js'

const ETH_NAME = 'ddocprobe.eth'
const ETH_SUBNAME = 'ddocprobe.orivonstack.eth'
const TREE = JSON.stringify({ bundleHash: 'sha256:' + 'a'.repeat(64), leaves: { '/index.html': 'sha256:' + 'b'.repeat(64) } })

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function startSite (title: string, servesTree: boolean): Promise<{ server: Server, port: number }> {
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/orivon-ddoc.json' && servesTree) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(TREE)
      return
    }
    // Every other path answers with the page, as a dev server does: a
    // missing tree must read as not published, not as a malformed one.
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body>${title}</body>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, port: (server.address() as AddressInfo).port }
}

function findPopup (app: ElectronApplication): Page | undefined {
  return app.windows().find((w) => w.url().includes('/site-info/'))
}

interface Reading { level: string | null, mark: string, heading: string, devNote: string, text: string }

async function readScore (app: ElectronApplication): Promise<Reading> {
  const chrome = findChrome(app)
  const { level, mark } = await readShield(chrome)
  await chrome.click('#web3-score-btn')
  if (!await waitFor(() => findPopup(app) !== undefined, 5_000)) throw new Error('the Web3 Score popup did not open')
  const popup = findPopup(app)!
  if (!await waitFor(async () => (await popup.$$('.level-list')).length > 0, 5_000)) throw new Error('the Web3 Score page shows no level')
  const page = await popup.evaluate(() => ({
    heading: document.querySelector('.level-list')?.previousElementSibling?.textContent ?? '',
    devNote: document.querySelector('.dev-note')?.textContent ?? '',
    text: document.body.innerText
  }))
  await chrome.click('#web3-score-btn')
  await waitFor(() => findPopup(app) === undefined, 5_000)
  // Past popover-view.ts's reopen debounce, so the next click reads as a fresh open.
  await chrome.waitForTimeout(400)
  return { level, mark, ...page }
}

it('in developer mode, a loopback URL and dev .eth names (a subname too) that serve a DDOC tree are Level 2, named as developer mode; one serving none stays Level 1', async () => {
  await runPhase('local-dev-ddoc', async (check) => {
    const withTree = await startSite('ddoc fixture', true)
    const withoutTree = await startSite('plain fixture', false)
    const dir = mkdtempSync(join(tmpdir(), 'orivon-local-ddoc-e2e-'))
    let app: ElectronApplication | undefined
    try {
      const namesFile = join(dir, 'names.json')
      writeFileSync(namesFile, JSON.stringify({ [ETH_NAME]: withTree.port, [ETH_SUBNAME]: withTree.port }))
      app = await launchElectron({ appPath: '.', env: { ORIVON_DEV_ORIGINS: '1', ORIVON_ETH_NAMES_FILE: namesFile } })

      for (const url of [`http://127.0.0.1:${String(withTree.port)}/`, `http://${ETH_NAME}/`, `http://${ETH_SUBNAME}/`]) {
        await navigateToFixture(app, url, 'ddoc fixture')
        const reading = await readScore(app)
        check(`${url}: the shield paints Level 2, marked "Web2.5" (${reading.level}/${reading.mark})`, reading.level === '2' && reading.mark === 'Web2.5')
        check(`${url}: the Web3 Score page leads with Website level 2 (${reading.heading})`, reading.heading === 'Website level 2')
        check(`${url}: it says DDOC is marked only because of developer mode (${reading.devNote})`, reading.devNote.includes('only because Orivon is running in developer mode'))
        check(`${url}: its DDOC row names the local origin`, reading.text.includes('Served by this local origin, counted in developer mode only'))
      }

      await navigateToFixture(app, `http://127.0.0.1:${String(withoutTree.port)}/`, 'plain fixture')
      const plain = await readScore(app)
      check(`a local origin serving no tree stays Level 1, marked "Web2" (${plain.level}/${plain.mark})`, plain.level === '1' && plain.mark === 'Web2')
      check(`its page carries no developer-mode note (${plain.heading})`, plain.heading === 'Website level 1' && plain.devNote === '')
      expect([plain.level, plain.mark]).toEqual(['1', 'Web2'])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await new Promise<void>((resolve) => { withTree.server.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { withoutTree.server.close(() => { resolve() }) })
      rmSync(dir, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS)
