// Visual QA of the tunnel list the tunnel button opens on a website, in the same way as e2e-qa-visual: each state is reached
// through the real UI, audited, compared with a machine-local baseline and written to qa-artifacts/latest/states/ for reading.
// The states: the first panel with "Always use for this site" off and on, and the question asked before a tunnel is set
// browser-wide while ten tabs keep their own, whose list must scroll inside the notice with the buttons in view.
//
// Run: npm run qa:visual      First run on a machine records baselines;
//      ORIVON_QA_UPDATE_BASELINES=1 re-records after an intended change.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { EMPTY_WASM, FAKE_NYM_MODULE } from '../app-behaviours/nym-stand-in.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from '../support/qa-helpers.js'
import { captureState, checkState, popupSized, prepareWindow, SCHEMES, type Check, type Rect, type StateSpec } from '../support/qa-visual.js'
import { popoverShown, waitFor } from '../support/smoke-helpers.mjs'

/** The address text of a fixture page in the toolbar: its port changes on every run. */
const FIXTURE_ADDRESS: Rect = { x: 240, y: 44, width: 260, height: 24 }

async function state (check: Check, app: ElectronApplication, name: string, spec: StateSpec): Promise<void> {
  await prepareWindow(app)
  checkState(check, await captureState(app, name, spec))
}

/** The website's address under the heading of the list, in window coordinates: its port changes on every run, so a baseline skips it. */
async function claimRect (app: ElectronApplication, list: Page): Promise<Rect> {
  const box = await list.locator('.site-claim').boundingBox() as Rect
  const view = await app.evaluate(({ BaseWindow }) => {
    const [win] = BaseWindow.getAllWindows()
    const views = (win?.contentView.children ?? []) as unknown as Array<{ getBounds: () => { x: number, y: number }, webContents?: { getURL: () => string } }>
    return views.find((v) => (v.webContents?.getURL() ?? '').includes('/site-info/'))?.getBounds() ?? { x: 0, y: 0 }
  })
  return { x: view.x + box.x, y: view.y + box.y, width: box.width, height: box.height }
}

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

for (const scheme of SCHEMES) {
  it(`the tunnel list of a website shows "Always use for this site" off and on, and the question about tabs that keep their own tunnel scrolls its list (${scheme})`, async () => {
    const titled = await startServer((req, res) => { html(res, `<!doctype html><meta charset="utf-8"><title>Tab ${req.url ?? ''}: a page whose title is long enough to need an ellipsis in the list</title><body>page`) })
    const site = `http://site.qa.test:${new URL(titled.origin).port}/`
    const dir = mkdtempSync(join(tmpdir(), 'orivon-qa-tunnels-'))
    mkdirSync(join(dir, 'module'))
    writeFileSync(join(dir, 'module', 'smolmix_wasm.js'), FAKE_NYM_MODULE)
    writeFileSync(join(dir, 'module', 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
    writeFileSync(join(dir, 'fake.json'), JSON.stringify({ failStart: false, log: join(dir, 'fake.log'), targets: {} }))
    writeFileSync(join(dir, 'fake.log'), '')
    const { app, chrome } = await launchShell({
      scheme,
      env: { ORIVON_TEST_NYM_MODULE: join(dir, 'module'), ORIVON_TEST_NYM_FAKE: join(dir, 'fake.json') },
      args: ['--host-resolver-rules=MAP site.qa.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
      seedProfile: (userDataDir: string) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.tunnel.everywhere': true } })) }
    })
    const listOf = async (): Promise<Page> => {
      expect(await waitFor(async () => await chrome.locator('#tunnel-btn').isVisible())).toBe(true)
      if (!await popoverShown(app, '/site-info/')) await chrome.click('#tunnel-btn')
      expect(await waitFor(async () => await popoverShown(app, '/site-info/'))).toBe(true)
      return app.windows().find((w) => w.url().includes('/site-info/')) as Page
    }
    const closeList = async (): Promise<void> => {
      await chrome.click('#tunnel-btn')
      expect(await waitFor(async () => !(await popoverShown(app, '/site-info/')))).toBe(true)
    }
    // A tab that follows the browser's tunnel keeps a direct choice of its own once its lit row is turned off on the first panel.
    const keepDirect = async (): Promise<void> => {
      const list = await listOf()
      await list.click('#tunnel-tab-first')
      await list.click('#tunnel-switch-nym')
      await list.waitForSelector('#tunnel-switch-nym[aria-checked="false"]')
      await closeList()
    }
    try {
      await runPhase('visual states of the tunnel list on a website and of the question about tabs', async (check) => {
        await keepDirect()
        await visit(app, chrome, site)
        const list = await listOf()
        await list.waitForSelector('#tunnel-switch-always:not([disabled])')
        expect(await popupSized(app, '/site-info/')).toBe(true)
        check('the list is the tab\'s, names the website, and "Always use for this site" is off', await list.locator('#tunnel-tab-first').textContent() === 'This tab' && (await list.locator('.site-claim').textContent())?.includes('site.qa.test') === true && await list.locator('#tunnel-switch-always').getAttribute('aria-checked') === 'false')
        const claim = await claimRect(app, list)
        await state(check, app, `tunnel-list-website-always-off-${scheme}`, {
          expected: 'The popup under the tunnel button on a website, headed "Tunnels" with the website\'s address under the heading, a two-part control "This tab" (selected) and "Browser-wide", two tunnels "Nym" and "Your proxy" with switches that are off, a row "Always use for this site" with a switch that is off and the line "Keeps this choice after the tab closes.", and a sentence saying that the sites opened in this tab go direct. Nothing is cut off and the popup sits inside the window.',
          action: 'Sent a new tab direct under a tunnelled browser, opened a website in it and pressed the tunnel button.',
          ignore: [FIXTURE_ADDRESS, claim]
        })
        await list.click('#tunnel-switch-always')
        await list.waitForSelector('#tunnel-switch-always[aria-checked="true"]')
        expect(await popupSized(app, '/site-info/')).toBe(true)
        await state(check, app, `tunnel-list-website-always-on-${scheme}`, {
          expected: 'The same popup with the "Always use for this site" switch on and the line "Saved for this site, in this tab and every other."; everything else as before, the two tunnels still off.',
          action: 'Pressed "Always use for this site".',
          ignore: [FIXTURE_ADDRESS, claim]
        })
        await closeList()

        // Nine more tabs keep their own direct choice, so the question that follows has more rows than its list shows at once.
        for (let n = 1; n <= 9; n++) {
          await chrome.click('#new-tab')
          await keepDirect()
          await visit(app, chrome, `${titled.origin}/${String(n)}`)
        }
        await chrome.click('#new-tab')
        const browserWide = await listOf()
        await browserWide.click('#tunnel-switch-nym')
        await browserWide.waitForSelector('#tunnel-switch-nym[aria-checked="false"]')
        await browserWide.click('#tunnel-switch-nym')
        await browserWide.waitForSelector('#tunnel-prompt-cancel')
        expect(await popupSized(app, '/site-info/')).toBe(true)
        const seen = await browserWide.evaluate(() => {
          const kept = document.querySelector('.tunnel-kept') as HTMLElement
          const text = (document.querySelector('.tunnel-notice-text') as HTMLElement).getBoundingClientRect()
          const proceed = (document.querySelector('#tunnel-prompt-proceed') as HTMLElement).getBoundingClientRect()
          return { rows: kept.children.length, scrolls: kept.scrollHeight > kept.clientHeight, textTop: text.top, proceedBottom: proceed.bottom, height: window.innerHeight }
        })
        check('ten tabs are listed, the list scrolls inside the notice, and the question and its buttons stay in view', seen.rows === 10 && seen.scrolls && seen.textTop >= 0 && seen.proceedBottom <= seen.height, JSON.stringify(seen))
        await state(check, app, `browser-wide-prompt-${scheme}`, {
          expected: 'The popup\'s Browser-wide panel with a question in a tinted box: "You are setting this tunnel browser-wide, but some tabs will keep using their tab-specific tunnel." over a list of tabs, each a page title cut with an ellipsis at the left and "Direct" at the right; the list shows about five rows and scrolls inside the box, and under it the buttons "Cancel" and "Proceed" are fully visible. The box and the popup sit inside the window and nothing is cut off.',
          action: 'Kept ten tabs direct under a tunnelled browser, turned the browser-wide tunnel off and on again from a tab that follows it.'
        })
        await browserWide.click('#tunnel-prompt-cancel')
      })
    } finally {
      await closeElectron(app)
      await titled.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 4 * QA_TEST_TIMEOUT_MS)
}
