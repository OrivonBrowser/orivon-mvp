// A link scheme an app declares in its manifest's `protocols` can open in that app, with the person choosing and the
// URL delivered to the app's page (catalogue: Links). The scheme is `magnet:`; nothing here names an app. An ordinary
// loopback website holds the links, and each is a real click or a real `window.open`. NOTHING LAUNCHES: the OS openers
// (`xdg-open` and its siblings) are stubs on PATH that record their argument, and every question is the panel under
// the address bar, read and answered by its real buttons.
//
// Set ORIVON_UI_SHOTS_DIR to also write screenshots of the questions and the Settings card in both colour schemes.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-scheme-links.test.ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion, type QuestionText } from '../support/question-support.js'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, findViewShowing, tabIds, waitFor } from '../support/smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const HTML = 'text/html; charset=utf-8'
const JS = 'text/javascript'
const hash = (digit: string): string => digit.repeat(40)
const magnet = (digit: string): string => `magnet:?xt=urn:btih:${hash(digit)}`
const FIRST = magnet('a')
const SECOND = magnet('b')
const THIRD = magnet('c')
const FOURTH = magnet('d')
const MALFORMED = 'magnet:?xt=urn:btih:not-a-hash'
const SYSTEM = 'Open with your system\'s app'

/** What an app page does with the API: keeps each link it is sent, and records what its requests settle to. */
const APP_SCRIPT = `
window.__links = []
window.__settled = []
orivon.app.onOpenUrl(function (url) { window.__links.push(url) })
function ask (scheme) {
  orivon.app.requestSchemeHandler(scheme).then(function (r) { window.__settled.push(scheme + ':' + r) }, function (e) { window.__settled.push(scheme + ':error:' + e.code) })
}
document.getElementById('magnet').onclick = function () { ask('magnet') }
document.getElementById('mailto').onclick = function () { ask('mailto') }
document.getElementById('https').onclick = function () { ask('https') }
document.getElementById('check').onclick = function () { orivon.app.isSchemeHandler('magnet').then(function (r) { window.__settled.push('is:' + r) }) }
`
const APP_PAGE = '<!doctype html><title>link app</title><body><button id="magnet">m</button><button id="mailto">t</button><button id="https">h</button><button id="check">c</button><script src="/app.js"></script></body>'

const SITE_PAGE = `<!doctype html><title>links</title><body>
<a id="first" href="${FIRST}">first</a>
<a id="second" href="${SECOND}">second</a>
<a id="third" href="${THIRD}">third</a>
<a id="fourth" href="${FOURTH}">fourth</a>
<a id="malformed" href="${MALFORMED}">malformed</a>
<button id="open" onclick="window.open('${FOURTH}')">open</button></body>`

let torrent: AppServer
let other: AppServer
let site: AppServer
const scratch: string[] = []

beforeAll(async () => {
  torrent = await startAppServer({ '/': { type: HTML, body: APP_PAGE }, '/app.js': { type: JS, body: APP_SCRIPT } })
  other = await startAppServer({ '/': { type: HTML, body: '<!doctype html><title>other app</title><body>other</body>' } })
  site = await startAppServer({ '/': { type: HTML, body: SITE_PAGE } })
})
afterAll(async () => {
  for (const server of [torrent, other, site]) await server.close()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** `xdg-open` and its siblings on PATH, recording what they are given and launching nothing. */
function stubOpeners (): { dir: string, launched: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-e2e-openers-'))
  scratch.push(dir)
  const log = join(dir, 'launched.log')
  for (const name of ['xdg-open', 'gio', 'gnome-open', 'kde-open', 'kde-open5', 'exo-open', 'gvfs-open']) {
    writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`)
    chmodSync(join(dir, name), 0o755)
  }
  return { dir, launched: () => { try { return readFileSync(log, 'utf8') } catch { return '' } } }
}

async function launchWithApps (): Promise<{ app: ElectronApplication, chrome: Page, launched: () => string }> {
  const openers = stubOpeners()
  const { app, chrome } = await launchShell({ env: { PATH: `${openers.dir}:${process.env['PATH'] ?? ''}` } })
  await stubNativeDialogs(app)
  await grantApp(app, torrent.origin, appManifest('links-torrent', { fs: { quotaBytes: 1024 }, protocols: ['magnet'] }), [{ capability: 'fs', patterns: [] }])
  await grantApp(app, other.origin, appManifest('links-other', { fs: { quotaBytes: 1024 }, protocols: ['mailto'] }), [{ capability: 'fs', patterns: [] }])
  return { app, chrome, launched: openers.launched }
}

const linksOf = async (view: Page): Promise<string[]> => await view.evaluate(() => (window as unknown as { __links: string[] }).__links)
const settledOf = async (view: Page): Promise<string[]> => await view.evaluate(() => (window as unknown as { __settled: string[] }).__settled)
const appView = (app: ElectronApplication, chrome: Page): Page | undefined => findViewShowing(app, chrome, `${torrent.origin}/`)

/** The button that opens the link in an app, whatever the panel calls the app's origin. */
const appButton = (question: QuestionText): string => question.buttons.find((label) => label.startsWith('Open in ')) ?? ''

/** The page in both colour schemes, written only when a directory was asked for. */
async function shoot (app: ElectronApplication, chrome: Page, page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await page.emulateMedia({ colorScheme: scheme })
    await delay(300)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await chrome.emulateMedia({ colorScheme: null })
  await page.emulateMedia({ colorScheme: null })
}

async function selectTab (chrome: Page, id: string | undefined): Promise<void> {
  await chrome.click(`.tab[data-id="${String(id)}"]`)
}

it('[app:scheme-link-offers-declared-apps] [app:scheme-link-opens-in-chosen-app] [app:scheme-link-held-until-the-app-listens] a magnet link offers the app that declares it beside the system\'s app, and the app chosen gets exactly that link', async () => {
  const { app, chrome, launched } = await launchWithApps()
  try {
    await runPhase('scheme link opens in the chosen app', async (check) => {
      const siteView = await visit(app, chrome, `${site.origin}/`)
      const siteTab = (await tabIds(chrome))[0]
      const before = await tabIds(chrome)

      await siteView.click('#first')
      const panel = await waitQuestion(app)
      const question = await readQuestion(panel)
      await shoot(app, chrome, panel, 'scheme-link-question')
      check('[app:scheme-link-offers-declared-apps] the question offers the app that declares magnet, the system\'s app and Cancel',
        question.buttons.filter((label) => label.startsWith('Open in ')).length === 1 && question.buttons.includes(SYSTEM) && question.buttons.includes('Cancel'), JSON.stringify(question))
      check('[app:scheme-link-offers-declared-apps] the app that did not declare the scheme is not offered', !question.buttons.some((label) => label.includes(new URL(other.origin).port)) && !question.detail.includes(new URL(other.origin).port), JSON.stringify(question))
      check('[app:scheme-link-offers-declared-apps] the question names the page asking and the whole link', question.detail.includes(new URL(site.origin).port) && question.detail.includes(FIRST), JSON.stringify(question))

      await answerQuestion(app, appButton(question))
      const opened = await waitFor(() => appView(app, chrome) !== undefined)
      check('[app:scheme-link-opens-in-chosen-app] choosing the app opens a tab on the app', opened)
      const view = appView(app, chrome) as Page
      check('[app:scheme-link-held-until-the-app-listens] the app was not running, and its page, once it listens, receives exactly the link', await waitFor(async () => (await linksOf(view)).length === 1) && (await linksOf(view))[0] === FIRST, JSON.stringify(await linksOf(view)))
      check('[app:scheme-link-opens-in-chosen-app] one tab was added', (await tabIds(chrome)).length === before.length + 1)
      await delay(ABSENCE_SETTLE_MS)
      check('[app:scheme-link-opens-in-chosen-app] the link reached the app alone: the system\'s opener launched nothing and no second copy arrived', launched() === '' && (await linksOf(view)).length === 1)

      // Without Always the next link asks again; the system's app is a choice of its own.
      await selectTab(chrome, siteTab)
      await waitFor(async () => (await siteView.evaluate(() => document.visibilityState)) === 'visible')
      await siteView.click('#second')
      const again = await readQuestion(await waitQuestion(app))
      check('[app:scheme-link-opens-in-chosen-app] with no Always chosen, the next link asks again', again.buttons.includes(SYSTEM) && again.detail.includes(SECOND), JSON.stringify(again))
      await answerQuestion(app, SYSTEM)
      check('[app:scheme-link-opens-in-chosen-app] choosing the system\'s app launches the link there and the app is sent nothing', await waitFor(() => launched().includes(SECOND)) && (await linksOf(view)).length === 1, launched())
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 3)

it('[app:scheme-link-always-skips-the-question] [app:scheme-link-malformed-is-refused] with Always the app takes every later link with no question, a malformed link is refused first, and Settings takes the choice back', async () => {
  const { app, chrome, launched } = await launchWithApps()
  try {
    await runPhase('scheme link default app', async (check) => {
      const siteView = await visit(app, chrome, `${site.origin}/`)
      const siteTab = (await tabIds(chrome))[0]

      await siteView.click('#malformed')
      await delay(ABSENCE_SETTLE_MS)
      check('[app:scheme-link-malformed-is-refused] a magnet link that is not a BitTorrent one raises no question and opens nothing', await questionGone(app) && appView(app, chrome) === undefined && launched() === '')

      await siteView.click('#first')
      const question = await readQuestion(await waitQuestion(app))
      const page = await waitQuestion(app)
      await page.waitForSelector('.q:not(.arming)')
      await page.check('.q-check input')
      check('[app:scheme-link-always-skips-the-question] the question offers to remember the choice for the scheme', /magnet/.test(await page.locator('.q-check').innerText()), JSON.stringify(question))
      await page.click(`.q .btn-row .btn:text-is("${appButton(question)}")`)
      check('the app opened and was sent the link', await waitFor(() => appView(app, chrome) !== undefined))
      const view = appView(app, chrome) as Page
      await waitFor(async () => (await linksOf(view)).length === 1)

      await selectTab(chrome, siteTab)
      await waitFor(async () => (await siteView.evaluate(() => document.visibilityState)) === 'visible')
      const tabsBefore = (await tabIds(chrome)).length
      await siteView.click('#second')
      const delivered = await waitFor(async () => (await linksOf(view)).length === 2)
      check('[app:scheme-link-always-skips-the-question] after Always the next link goes to the app with no question, in the tab it already has', delivered && (await linksOf(view))[1] === SECOND && await questionGone(app) && (await tabIds(chrome)).length === tabsBefore, JSON.stringify(await linksOf(view)))

      // A page's own window.open(magnet) is the same link as a click.
      await selectTab(chrome, siteTab)
      await waitFor(async () => (await siteView.evaluate(() => document.visibilityState)) === 'visible')
      await siteView.click('#open')
      check('[app:scheme-link-always-skips-the-question] window.open of a magnet link goes to the default app too', await waitFor(async () => (await linksOf(view)).length === 3) && (await linksOf(view))[2] === FOURTH && launched() === '', JSON.stringify(await linksOf(view)))

      // Settings lists the choice on the app's card and takes it back.
      await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/apps') })
      expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
      const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
      const card = settings.locator('.app-card', { hasText: new URL(torrent.origin).port })
      await card.waitFor()
      await shoot(app, chrome, settings, 'scheme-link-settings-card')
      check('[app:scheme-link-always-skips-the-question] Settings lists the default on the app\'s card', /Opens magnet links/.test(await card.innerText()), await card.innerText())
      await card.locator('li', { hasText: 'Opens magnet links' }).locator('button', { hasText: 'Stop' }).click()
      check('[app:scheme-link-always-skips-the-question] Stop in Settings takes the choice back', await waitFor(async () => !/Opens magnet links/.test(await card.innerText())))

      await selectTab(chrome, siteTab)
      await waitFor(async () => (await siteView.evaluate(() => document.visibilityState)) === 'visible')
      await siteView.click('#third')
      const asked = await readQuestion(await waitQuestion(app))
      check('[app:scheme-link-always-skips-the-question] after Stop the next link asks again', asked.buttons.includes(SYSTEM) && asked.detail.includes(THIRD) && (await linksOf(view)).length === 3, JSON.stringify(asked))
      await answerQuestion(app, 'Cancel')
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 3)

it('[app:scheme-app-asks-to-be-default] an app asks to be the default for a scheme it declares; the person decides, and a scheme it did not declare or the browser keeps is refused with no question', async () => {
  const { app, chrome, launched } = await launchWithApps()
  try {
    await runPhase('app asks to be the default', async (check) => {
      const appPage = await visit(app, chrome, `${torrent.origin}/`)
      const settledCount = async (): Promise<number> => (await settledOf(appPage)).length

      await appPage.click('#mailto')
      await appPage.click('#https')
      await waitFor(async () => (await settledCount()) === 2)
      check('[app:scheme-app-asks-to-be-default] a scheme the manifest did not list, and one the browser never routes, resolve false', (await settledOf(appPage)).join() === 'mailto:false,https:false' && await questionGone(app), JSON.stringify(await settledOf(appPage)))

      await appPage.click('#magnet')
      const defaultPanel = await waitQuestion(app)
      const question = await readQuestion(defaultPanel)
      await shoot(app, chrome, defaultPanel, 'scheme-default-question')
      check('[app:scheme-app-asks-to-be-default] asking for a listed scheme raises a question that names the scheme and the app\'s origin', /magnet/.test(question.message) && question.origin.includes(new URL(torrent.origin).port) && question.buttons.includes('Make default') && question.buttons.includes('Cancel'), JSON.stringify(question))
      await answerQuestion(app, 'Cancel')
      await waitFor(async () => (await settledCount()) === 3)
      check('[app:scheme-app-asks-to-be-default] on Cancel the request resolves false and the app is not the default', (await settledOf(appPage))[2] === 'magnet:false')
      await appPage.click('#check')
      await waitFor(async () => (await settledCount()) === 4)
      check('[app:scheme-app-asks-to-be-default] isSchemeHandler agrees', (await settledOf(appPage))[3] === 'is:false')

      await appPage.click('#magnet')
      await answerQuestion(app, 'Make default')
      await waitFor(async () => (await settledCount()) === 5)
      check('[app:scheme-app-asks-to-be-default] on Make default the request resolves true', (await settledOf(appPage))[4] === 'magnet:true')
      await appPage.click('#check')
      await waitFor(async () => (await settledCount()) === 6)
      check('[app:scheme-app-asks-to-be-default] isSchemeHandler now says so', (await settledOf(appPage))[5] === 'is:true')

      // The default now takes a link with no question: from a second tab.
      const appTab = (await tabIds(chrome))[0]
      await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('tab.new') })
      expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
      const siteView = await visit(app, chrome, `${site.origin}/`)
      await siteView.click('#first')
      const received = await waitFor(async () => (await linksOf(appPage)).length === 1)
      check('[app:scheme-app-asks-to-be-default] a link now goes to the app with no question, in the tab already on it', received && (await linksOf(appPage))[0] === FIRST && await questionGone(app) && launched() === '' && appTab !== undefined, JSON.stringify(await linksOf(appPage)))
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 3)
