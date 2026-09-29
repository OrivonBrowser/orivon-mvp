// Opening a link from inside a page: a middle click, a plain ctrl+click, a
// shift+click, a ctrl+shift+click, a target=_blank link (left- or middle-
// clicked) and a target=_blank form submit. All but a plain click on
// target=_blank reach popups.ts's windowOpenHandler through Chromium's own
// browser-side open (OpenURLFromTab), never through window.open() -- and
// Electron 44 hands `createWindow` no guest webContents to adopt for any of
// them (window.open() and a plain target=_blank click are the only opens
// that do; e2e-shell-fidelity.test.ts covers window.open()). Each case is
// checked for: the app survives, a tab appears, and whether it takes over
// (as Chrome activates a foreground open) or stays behind (a background
// open, never taking focus).
import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { activeTabInfo, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab, tabIds } from './smoke-helpers.mjs'

const HOST = '127.0.0.1'
const PORT_A = 8931
const PORT_B = 8932
const ORIGIN_A = `http://${HOST}:${PORT_A}`
const ORIGIN_B = `http://${HOST}:${PORT_B}`

let serverA: Server
let serverB: Server

const PAGE_A = `<!doctype html><meta charset="utf-8"><title>link-open fixture</title><body>
<a id="same-origin" href="${ORIGIN_A}/other">same origin</a><br>
<a id="cross-origin" href="${ORIGIN_B}/">cross origin</a><br>
<a id="blank" href="${ORIGIN_B}/" target="_blank">target blank</a><br>
<a id="shift" href="${ORIGIN_B}/">shift-click plain link</a><br>
<a id="ctrlshift" href="${ORIGIN_B}/">ctrl+shift-click plain link</a><br>
<a id="blank-middle" href="${ORIGIN_B}/" target="_blank">middle-click on target=_blank</a><br>
<form id="form-blank-shift" action="${ORIGIN_B}/" target="_blank" method="get">
  <button id="submit-blank-shift" type="submit">shift-click submit, form target=_blank</button>
</form>
</body>`
const OTHER_A = '<!doctype html><meta charset="utf-8"><title>link-open fixture other</title><body>other</body>'
const PAGE_B = '<!doctype html><meta charset="utf-8"><title>link-open fixture B</title><body>B</body>'

beforeAll(async () => {
  serverA = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(req.url === '/other' ? OTHER_A : PAGE_A)
  })
  serverB = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(PAGE_B)
  })
  await new Promise<void>((resolve) => { serverA.listen(PORT_A, HOST, resolve) })
  await new Promise<void>((resolve) => { serverB.listen(PORT_B, HOST, resolve) })
})

afterAll(async () => {
  await new Promise<void>((resolve) => { serverA.close(() => { resolve() }) })
  await new Promise<void>((resolve) => { serverB.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Launched { app: ElectronApplication, chrome: Page, exited: () => number | null }

async function launched (): Promise<Launched> {
  // PULSE_SERVER/--alsa-output-device=null: nothing this launches may make sound on the owner's speakers.
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, '--alsa-output-device=null'],
    env: { PULSE_SERVER: 'unix:/nonexistent' }
  })
  let code: number | null = null
  app.process().on('exit', (c) => { code = c })
  await waitFor(() => { try { findChrome(app); return true } catch { return false } })
  const chrome = findChrome(app)
  return { app, chrome, exited: () => code }
}

interface Scenario {
  label: string
  sel: string
  clickOptions: Parameters<Page['click']>[1]
  /** Chrome's own convention: a middle click or a plain ctrl+click never takes focus. */
  expectActivates: boolean
}

const SCENARIOS: Scenario[] = [
  { label: 'middle-click a plain same-origin link', sel: '#same-origin', clickOptions: { button: 'middle' }, expectActivates: false },
  { label: 'ctrl-click a plain cross-origin link', sel: '#cross-origin', clickOptions: { modifiers: ['Control'] }, expectActivates: false },
  { label: 'left-click a target=_blank link', sel: '#blank', clickOptions: {}, expectActivates: true },
  { label: 'shift-click a plain link', sel: '#shift', clickOptions: { modifiers: ['Shift'] }, expectActivates: true },
  { label: 'ctrl+shift-click a plain link', sel: '#ctrlshift', clickOptions: { modifiers: ['Control', 'Shift'] }, expectActivates: true },
  { label: 'middle-click a target=_blank link', sel: '#blank-middle', clickOptions: { button: 'middle' }, expectActivates: false },
  { label: 'shift-click a submit button on a form with target=_blank', sel: '#submit-blank-shift', clickOptions: { modifiers: ['Shift'] }, expectActivates: true }
]

for (const scenario of SCENARIOS) {
  it(`${scenario.label} opens a tab without crashing, ${scenario.expectActivates ? 'activating' : 'staying in the background'}`, async () => {
    const { app, chrome, exited } = await launched()
    let crashed = false
    try {
      await clickAddressBarRetrying(chrome, `${ORIGIN_A}/`)
      expect((await waitForTab(chrome, { address: `${ORIGIN_A}/` })).ok).toBe(true)
      const view = findViewShowing(app, chrome, `${ORIGIN_A}/`)
      if (view === undefined) throw new Error('no view showing the fixture page')
      const before = await tabIds(chrome)
      const activeBefore = (await activeTabInfo(chrome)).activeId

      await view.click(scenario.sel, scenario.clickOptions)
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const code = exited()
      if (code !== null) {
        crashed = true
        console.error(`${scenario.label}: main process exited with code ${code}\n` + mainOutput(app))
      } else {
        const newTab = await waitFor(async () => (await tabIds(chrome)).length > before.length, 3000).catch(() => false)
        expect(newTab, `${scenario.label}: expected a new tab to open`).toBe(true)
        const activeAfter = (await activeTabInfo(chrome)).activeId
        expect(activeAfter !== activeBefore, `${scenario.label}: expected activates=${String(scenario.expectActivates)}`).toBe(scenario.expectActivates)
      }
    } finally {
      if (!crashed) await closeElectron(app)
    }
    expect(crashed, `${scenario.label}: main process should not have exited`).toBe(false)
  }, 60_000)
}
