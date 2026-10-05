// What a page can ask for beyond the page itself, proved against the real
// shell and an ordinary loopback website: pointer lock, and keyboard lock in
// fullscreen, pass with a notice saying how to leave; an external link opens
// only once the person allows it, and exactly the URL they were shown; a
// site's notification answer is listed in the permissions panel, where Reset
// forgets it; and it is asked once, remembered across a restart, and read
// back by Notification.permission.
//
// NOTHING IS SHOWN AND NOTHING LAUNCHES. The external-link question is the
// question panel under the address bar, read and answered by clicking its
// real buttons; the native dialog methods are replaced with recorders only
// to prove none was opened. The notification question is the prompt under
// the address bar, an overlay the test answers by clicking it. Answering
// yes to an external link makes Electron itself run the OS handler, so the
// launched app finds `xdg-open` (and every sibling opener) on PATH as a stub
// that records its argument and launches nothing.
//
// NOTIFICATIONS RUN ONLY ON A PRIVATE SESSION BUS. A notification this page
// never shows would still reach the desktop over D-Bus if one were shown, so
// that phase is skipped unless the runner says the bus is private
// (ORIVON_E2E_PRIVATE_BUS=1 with a session bus that is not this user's own):
//   ORIVON_PRIVATE_BUS=1 node scripts/run-headless.mjs npx vitest run \
//     --config test/vitest.e2e.config.ts test/e2e-site-permissions.test.ts
// It never constructs a Notification: it reads permission state only.
//
// THE CLICKS ARE THE POINT: pointer lock and the second external link each
// need the person to have acted in the page, and Playwright's `evaluate`
// runs as a gesture, so each is driven by a real click on a real button.
import { afterAll, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, HERMETIC_RESOLVER, delay, evaluateRetrying, findChrome, popoverShown, waitFor } from './support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase, waitForAddressBarStable } from './support/e2e-helpers.js'
import { focusWebContents, underVirtualDisplay, webContentsFocused } from './support/focus-helpers.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from './support/question-support.js'

const HOST = '127.0.0.1'
// 8872-8885, 8893-8895 and 8897 belong to other suites' fixtures.
const PORT = 8898
const ORIGIN = `http://${HOST}:${PORT}`
const PAGE_URL = `${ORIGIN}/`
const QUIET_URL = `${ORIGIN}/?quiet`
const TITLE = 'site permissions fixture'
const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=probe%20file'

const PAGE = `<!doctype html><meta charset="utf-8"><title>${TITLE}</title>
<body style="height:600px">
<button id="pl">Lock pointer</button>
<button id="fskl">Full screen and lock keyboard</button>
<button id="mail">Mail</button>
<a id="magnet" href="${MAGNET}">Magnet</a>
<button id="notify">Ask to notify</button>
<script>
  window.__r = { keys: [] }
  document.addEventListener('keydown', (e) => { window.__r.keys.push(e.key) })
  document.addEventListener('pointerlockchange', () => { window.__r.locked = document.pointerLockElement !== null })
  // Asked before anyone has touched the page: links at load, the pointer as
  // soon as the page has focus, which pointer lock needs.
  // The notification phase loads this page with ?quiet: a prompt that hands focus back would otherwise let the
  // page take the pointer, which is what the pointer-lock phase above is about.
  const untilFocused = location.search === '?quiet' ? 0 : setInterval(() => {
    if (!document.hasFocus()) return
    clearInterval(untilFocused)
    document.body.requestPointerLock().then(() => { window.__r.unprompted = 'resolved' }, (e) => { window.__r.unprompted = e.name })
  }, 50)
  setTimeout(() => { location.href = 'tel:+15555550100' }, 400)
  setTimeout(() => { location.href = 'tel:+15555550111'; window.__r.secondTel = true }, 1200)
  document.getElementById('pl').addEventListener('click', () => {
    document.body.requestPointerLock().then(() => { window.__r.pl = 'resolved' }, (e) => { window.__r.pl = e.name })
  })
  document.getElementById('fskl').addEventListener('click', () => {
    document.documentElement.requestFullscreen().then(() => navigator.keyboard.lock(['Escape']))
      .then(() => { window.__r.fskl = 'resolved' }, (e) => { window.__r.fskl = e.name })
  })
  document.getElementById('mail').addEventListener('click', () => { location.href = 'mailto:someone@example.com' })
  // Permission state only: this page never constructs a Notification.
  document.getElementById('notify').addEventListener('click', () => {
    Notification.requestPermission().then((result) => { window.__r.notify = result })
  })
</script>
</body>`

/** The notification question is the prompt under the address bar, an Orivon overlay no native dialog stands in for. */
async function waitForPrompt (app: ElectronApplication): Promise<Page> {
  let found: Page | undefined
  const shown = await waitFor(async () => {
    if (!(await popoverShown(app, 'overlay=site-prompt'))) return false
    const candidate = app.windows().filter((w) => w.url().includes('overlay=site-prompt') && !w.isClosed()).at(-1)
    if (candidate === undefined) return false
    try { await candidate.waitForSelector('.site-prompt .btn-row', { timeout: 2_000 }); found = candidate; return true } catch { return false }
  }, 15_000)
  if (!shown || found === undefined) throw new Error('the notification prompt did not appear')
  return found
}

/** Waits out the half second the buttons ignore presses, then presses one. */
async function answerPrompt (prompt: Page, label: 'Allow' | 'Block'): Promise<void> {
  await prompt.waitForSelector('.site-prompt:not(.arming)')
  try { await prompt.click(`.btn-row .btn:text-is("${label}")`) } catch (error) { if (!/closed|destroyed/.test(String(error))) throw error }
}

/** Every notice text on screen: a notice view's page is a data: URL. */
async function noticesShown (app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0]
    if (win === undefined) return []
    return win.contentView.children
      .map((child) => (child as unknown as { webContents?: Electron.WebContents }).webContents?.getURL() ?? '')
      .filter((url) => url.startsWith('data:text/html'))
      .map((url) => decodeURIComponent(url.slice(url.indexOf(',') + 1)).replace(/<[^>]+>/g, ''))
  })
}

async function sendEscape (app: ElectronApplication, type: 'keyDown' | 'keyUp', autoRepeat = false): Promise<void> {
  await app.evaluate(({ webContents }, [target, t, repeat]) => {
    const wc = webContents.getAllWebContents().find((c) => c.getURL() === target)
    wc?.sendInputEvent({ type: t as 'keyDown' | 'keyUp', keyCode: 'Escape', ...(repeat === true ? { modifiers: ['isautorepeat' as const] } : {}) })
  }, [PAGE_URL, type, autoRepeat])
}

interface PageState { keys: string[], unprompted?: string, locked?: boolean, pl?: string, fskl?: string, secondTel?: boolean, notify?: string }
const pageState = async (view: Page): Promise<PageState> =>
  await evaluateRetrying(view, () => (window as unknown as { __r: PageState }).__r)
const inFullscreen = async (view: Page): Promise<boolean> =>
  await evaluateRetrying(view, () => document.fullscreenElement !== null)

/** A PATH directory whose openers record their argument and launch nothing. */
function stubOpeners (): { dir: string, log: string, launched: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-e2e-openers-'))
  const log = join(dir, 'launched.log')
  for (const name of ['xdg-open', 'gio', 'gnome-open', 'kde-open', 'kde-open5', 'exo-open', 'gvfs-open']) {
    writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`)
    chmodSync(join(dir, name), 0o755)
  }
  return { dir, log, launched: () => { try { return readFileSync(log, 'utf8') } catch { return '' } } }
}

async function serveFixture (): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((resolve) => { server.listen(PORT, HOST, resolve) })
  return server
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS * 2 + 60_000

it('lets a page lock the pointer and keyboard with a notice, and open an external link only when the person allows it', async () => {
  await runPhase('site-permissions', async (check) => {
    let app: ElectronApplication | undefined
    let server: Server | undefined
    const openers = stubOpeners()
    try {
      server = await serveFixture()
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { PATH: `${openers.dir}:${process.env['PATH'] ?? ''}` } })
      await stubNativeDialogs(app)
      const view = await navigateToFixture(app, PAGE_URL, TITLE)

      // --- External links, before any click --------------------------------
      const atLoad = await readQuestion(await waitQuestion(app))
      await waitFor(async () => (await pageState(view)).secondTel === true)
      await delay(ABSENCE_SETTLE_MS)
      check('a tel: link opened at load is asked about, naming the scheme, the site and the URL',
        atLoad.message === 'Open tel link with your system\'s default app?' &&
        atLoad.detail === `${ORIGIN} wants to open:\ntel:+15555550100` &&
        JSON.stringify([...atLoad.buttons].sort()) === '["Allow","Cancel"]', JSON.stringify(atLoad))
      await answerQuestion(app, 'Cancel')
      await delay(ABSENCE_SETTLE_MS)
      check('a second link with no click in between is refused without asking', await questionGone(app))

      // --- Pointer lock -----------------------------------------------------
      if (underVirtualDisplay()) {
        // The page asks as soon as it has focus, before any click.
        await focusWebContents(app, PAGE_URL)
        await waitFor(async () => (await pageState(view)).unprompted !== undefined)
        const unprompted = (await pageState(view)).unprompted
        check(`requestPointerLock() before any click is refused (got ${String(unprompted)})`, unprompted !== undefined && unprompted !== 'resolved')
        await view.click('#pl')
        const locked = await waitFor(async () => (await pageState(view)).locked === true)
        check('requestPointerLock() from a click locks the pointer', locked, JSON.stringify(await pageState(view)))
        const pointerNotice = await waitFor(async () => (await noticesShown(app as ElectronApplication)).includes('Press Esc to show your cursor'))
        check('the "Press Esc to show your cursor" notice is on screen', pointerNotice, JSON.stringify(await noticesShown(app)))
        await delay(ABSENCE_SETTLE_MS)
        check('the notice leaves the page its focus and its lock', (await pageState(view)).locked === true && await webContentsFocused(app, PAGE_URL))
        await sendEscape(app, 'keyDown')
        await sendEscape(app, 'keyUp')
        const released = await waitFor(async () => (await pageState(view)).locked === false)
        check('Escape releases the pointer, and the page never sees the key', released && !(await pageState(view)).keys.includes('Escape'))
      } else {
        console.log('[site-permissions] pointer lock not checked: it needs a focused window, which only the virtual display may take')
      }

      // --- Keyboard lock in fullscreen --------------------------------------
      await view.click('#fskl')
      const lockedInFullscreen = await waitFor(async () => (await pageState(view)).fskl === 'resolved' && await inFullscreen(view))
      check('a page in fullscreen can lock the keyboard, Escape included', lockedInFullscreen, JSON.stringify(await pageState(view)))
      const holdNotice = await waitFor(async () => (await noticesShown(app as ElectronApplication)).includes('Press and hold Esc to exit full screen'))
      check('the "Press and hold Esc to exit full screen" notice is on screen', holdNotice, JSON.stringify(await noticesShown(app)))
      await sendEscape(app, 'keyDown')
      await sendEscape(app, 'keyUp')
      await delay(ABSENCE_SETTLE_MS)
      check('one Escape press goes to the page, which stays in fullscreen', await inFullscreen(view) && (await pageState(view)).keys.includes('Escape'))
      await sendEscape(app, 'keyDown')
      for (let i = 0; i < 30 && await inFullscreen(view); i++) {
        await delay(100)
        await sendEscape(app, 'keyDown', true)
      }
      await sendEscape(app, 'keyUp')
      check('holding Escape leaves fullscreen', await waitFor(async () => !(await inFullscreen(view))))

      // --- External links, from clicks --------------------------------------
      await view.click('#mail')
      const mail = await readQuestion(await waitQuestion(app))
      check('a clicked mailto: link is asked about', mail.message === 'Open mailto link with your system\'s default app?', JSON.stringify(mail))
      await answerQuestion(app, 'Cancel')
      await delay(ABSENCE_SETTLE_MS)
      check('Cancel launches nothing', openers.launched() === '', openers.launched())

      await view.click('#magnet')
      const magnet = await readQuestion(await waitQuestion(app))
      await answerQuestion(app, 'Allow')
      const launched = await waitFor(() => openers.launched() !== '')
      check('Allow hands exactly the URL the person was shown to the OS handler',
        launched && openers.launched() === `${MAGNET}\n` && magnet.detail === `${ORIGIN} wants to open:\n${MAGNET}`,
        `${openers.launched()} / ${JSON.stringify(magnet)}`)
      check('no native message box was opened for any of them', (await noNativeDialogs(app)).length === 0)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
      rmSync(openers.dir, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS)

// Reads and resets stored answers only: no page here touches the
// Notification API, so this runs on any runner.
it('lists each site\'s notification answer in the permissions panel, and Reset forgets it on disk', async () => {
  await runPhase('site-notification-panel', async (check) => {
    const decisions = { version: 1, origins: { [ORIGIN]: 'allow', 'https://ads.example': 'block' } }
    const app = await launchElectron({
      appPath: '.',
      args: [HERMETIC_RESOLVER],
      seedProfile: async (dir: string) => { writeFileSync(join(dir, 'notification-decisions.json'), JSON.stringify(decisions)) }
    })
    try {
      await waitFor(() => app.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)
      await chrome.click('#permissions-btn')
      let panel: Page | undefined
      await waitFor(() => { panel = app.windows().find((w) => w.url().endsWith('/renderer/permissions/index.html')); return panel !== undefined })
      if (panel === undefined) throw new Error('the permissions panel did not open')
      const settings = panel
      const cards = async (): Promise<Array<{ origin: string, message: string }>> => await evaluateRetrying(settings, () =>
        Array.from(document.querySelectorAll<HTMLElement>('.app-card')).map((card) => ({
          origin: card.dataset['origin'] ?? '',
          message: card.querySelector('.permission-message')?.textContent ?? ''
        })))
      const listed = await waitFor(async () => (await cards()).length === 2)
      check('each decided site has a card saying what it may do', listed && JSON.stringify(await cards()) === JSON.stringify([
        { origin: ORIGIN, message: 'Can show notifications.' },
        { origin: 'https://ads.example', message: 'Blocked from showing notifications.' }
      ]), JSON.stringify(await cards()))

      await settings.click('[data-origin="https://ads.example"] .revoke-btn')
      const reset = await waitFor(async () => (await cards()).length === 1)
      check('Reset removes that site\'s card, and only that one', reset && (await cards())[0]?.origin === ORIGIN, JSON.stringify(await cards()))
      const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      const saved = JSON.parse(readFileSync(join(userData, 'notification-decisions.json'), 'utf8')) as { origins: Record<string, string> }
      check('and forgets its answer on disk', JSON.stringify(saved.origins) === JSON.stringify({ [ORIGIN]: 'allow' }), JSON.stringify(saved))
    } finally {
      await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)

/** The runner declared a private session bus, and it is not this user's. */
function sessionBusIsPrivate (): boolean {
  const bus = process.env['DBUS_SESSION_BUS_ADDRESS']
  const own = `unix:path=/run/user/${process.getuid?.() ?? -1}/bus`
  return process.env['ORIVON_E2E_PRIVATE_BUS'] === '1' && bus !== undefined && bus !== own
}

it.skipIf(!sessionBusIsPrivate())('asks a site once about notifications, remembers the answer across a restart, and Notification.permission agrees', async () => {
  await runPhase('site-notifications', async (check) => {
    let server: Server | undefined
    let saved = ''
    // Belt on top of the private bus: the shell gets a bus address nothing
    // listens on, so no notification could reach any desktop.
    const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/orivon-e2e-bus' }
    try {
      server = await serveFixture()

      const first = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env })
      try {
        // The fixture opens external links at load; those questions are native boxes and stay stubbed.
        await stubNativeDialogs(first)
        const view = await navigateToFixture(first, QUIET_URL, TITLE)
        const before = await evaluateRetrying(view, async () => [Notification.permission, (await navigator.permissions.query({ name: 'notifications' })).state])
        check(`a site nobody has answered for does not read as granted (Notification.permission, Permissions API: ${before.join(', ')})`, !before.includes('granted'))

        await view.click('#notify')
        const prompt = await waitForPrompt(first)
        const lines = await prompt.evaluate(() => [document.querySelector('.origin')?.textContent, document.querySelector('.sp-text')?.textContent, ...Array.from(document.querySelectorAll('.btn-row .btn')).map((b) => b.textContent)])
        check('the site is asked, and named first', JSON.stringify(lines) === JSON.stringify([ORIGIN, 'wants to show notifications', 'Block', 'Allow']), JSON.stringify(lines))
        // Escape is "not now": it decides nothing.
        try { await prompt.keyboard.press('Escape') } catch (error) { if (!/closed/.test(String(error))) throw error }
        await waitFor(async () => (await pageState(view)).notify !== undefined)
        check(`"Not now" grants nothing (got ${String((await pageState(view)).notify)})`, (await pageState(view)).notify !== 'granted')
        await evaluateRetrying(view, () => { delete (window as unknown as { __r: PageState }).__r.notify })
        await view.click('#notify')
        await waitFor(async () => (await pageState(view)).notify !== undefined)
        await delay(ABSENCE_SETTLE_MS)
        check('the same page load is not asked twice', !(await popoverShown(first, 'overlay=site-prompt')))

        await view.reload()
        await view.click('#notify')
        await answerPrompt(await waitForPrompt(first), 'Allow')
        const granted = await waitFor(async () => (await pageState(view)).notify === 'granted')
        check('after a reload the site is asked again, and Allow grants', granted)
        const state = await evaluateRetrying(view, async () => [Notification.permission, (await navigator.permissions.query({ name: 'notifications' })).state])
        check(`Notification.permission and the Permissions API agree (got ${state.join(', ')})`, state[0] === 'granted' && state[1] === 'granted')

        const userData = await first.evaluate(({ app }) => app.getPath('userData'))
        saved = readFileSync(join(userData, 'notification-decisions.json'), 'utf8')
        check('the answer is saved in the profile', JSON.parse(saved).origins?.[ORIGIN] === 'allow', saved)
      } finally {
        await closeElectronApp(first)
      }

      const second = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env,
        seedProfile: async (dir: string) => { writeFileSync(join(dir, 'notification-decisions.json'), saved) }
      })
      try {
        await stubNativeDialogs(second)
        const view = await navigateToFixture(second, QUIET_URL, TITLE)
        check('after a restart the site reads as granted', await evaluateRetrying(view, () => Notification.permission) === 'granted')
        await view.click('#notify')
        await waitFor(async () => (await pageState(view)).notify !== undefined)
        await delay(ABSENCE_SETTLE_MS)
        check('and is not asked again', (await pageState(view)).notify === 'granted' && !(await popoverShown(second, 'overlay=site-prompt')))
      } finally {
        await closeElectronApp(second)
      }
    } finally {
      if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
    }
  })
}, TEST_TIMEOUT_MS)
