// What a page can ask for beyond the page itself, proved against the real
// shell and an ordinary loopback website: pointer lock, and keyboard lock in
// fullscreen, pass with a notice saying how to leave; an external link opens
// only once the person allows it, and exactly the URL they were shown; a
// site's notification answer is asked once, remembered across a restart,
// and read back by Notification.permission.
//
// NOTHING IS SHOWN AND NOTHING LAUNCHES. Both questions are native message
// boxes no driver can press, so `dialog.showMessageBox` is replaced in the
// main process with one that records what it was asked and answers from a
// variable -- the privilege Playwright's `evaluate` already has. Answering
// yes to an external link makes Electron itself run the OS handler, so the
// launched app finds `xdg-open` (and every sibling opener) on PATH as a stub
// that records its argument and launches nothing.
//
// NOTIFICATIONS RUN ONLY ON A PRIVATE SESSION BUS. A notification this page
// never shows would still reach the desktop over D-Bus if one were shown,
// and scripts/run-headless.mjs does not isolate the bus. That phase is
// skipped unless the runner says the bus is private (ORIVON_E2E_PRIVATE_BUS=1
// with a session bus that is not this user's own), and it never constructs a
// Notification: it reads permission state only.
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
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { ABSENCE_SETTLE_MS, HERMETIC_RESOLVER, delay, evaluateRetrying, waitFor } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'

const HOST = '127.0.0.1'
// 8872-8885, 8893-8895 and 8897 belong to other suites' fixtures.
const PORT = 8898
const ORIGIN = `http://${HOST}:${PORT}`
const PAGE_URL = `${ORIGIN}/`
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
  const untilFocused = setInterval(() => {
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

interface Asked { message: string, detail: string, buttons: string[] }

/** Replaces the message box in the main process: records each question and
 * answers with the button index the test last set for that question. */
async function stubDialogs (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __asked: Asked[], __answers: Record<string, number> }
    g.__asked = []
    g.__answers = { external: 1, notifications: 2 }
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string, detail?: string, buttons?: string[] }
      g.__asked.push({ message: options.message, detail: options.detail ?? '', buttons: options.buttons ?? [] })
      const response = options.message.startsWith('Open ') ? g.__answers['external'] : g.__answers['notifications']
      return { response, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
}

async function asked (app: ElectronApplication): Promise<Asked[]> {
  return await app.evaluate(() => (globalThis as unknown as { __asked: Asked[] }).__asked)
}

async function answer (app: ElectronApplication, question: 'external' | 'notifications', button: number): Promise<void> {
  await app.evaluate((_electron, [q, b]) => {
    (globalThis as unknown as { __answers: Record<string, number> }).__answers[q as string] = b as number
  }, [question, button])
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

/** Pointer lock needs the page focused, and the shell's test launches show
 * the window without activating it. Under the virtual display nothing else
 * can hold focus, so the tab takes it there; anywhere else a test must not
 * take focus, and the pointer-lock checks are left out. */
function underVirtualDisplay (): boolean {
  return process.platform === 'linux' && process.env['WAYLAND_DISPLAY'] === undefined && (process.env['XAUTHORITY'] ?? '').includes('xvfb-run')
}

async function focusTab (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }, target) => {
    webContents.getAllWebContents().find((c) => c.getURL() === target)?.focus()
  }, PAGE_URL)
}

async function tabFocused (app: ElectronApplication): Promise<boolean> {
  return await app.evaluate(({ webContents }, target) =>
    webContents.getAllWebContents().find((c) => c.getURL() === target)?.isFocused() === true, PAGE_URL)
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
      await stubDialogs(app)
      const view = await navigateToFixture(app, PAGE_URL, TITLE)

      // --- External links, before any click --------------------------------
      await waitFor(async () => (await asked(app as ElectronApplication)).length > 0)
      await waitFor(async () => (await pageState(view)).secondTel === true)
      await delay(ABSENCE_SETTLE_MS)
      const atLoad = await asked(app)
      check('a tel: link opened at load is asked about, naming the scheme, the site and the URL',
        atLoad[0]?.message === 'Open tel link with your system\'s default app?' &&
        atLoad[0]?.detail === `${ORIGIN} wants to open:\ntel:+15555550100` &&
        JSON.stringify(atLoad[0]?.buttons) === '["Allow","Cancel"]', JSON.stringify(atLoad))
      check('a second link with no click in between is refused without asking', atLoad.length === 1, JSON.stringify(atLoad))

      // --- Pointer lock -----------------------------------------------------
      if (underVirtualDisplay()) {
        // The page asks as soon as it has focus, before any click.
        await focusTab(app)
        await waitFor(async () => (await pageState(view)).unprompted !== undefined)
        const unprompted = (await pageState(view)).unprompted
        check(`requestPointerLock() before any click is refused (got ${String(unprompted)})`, unprompted !== undefined && unprompted !== 'resolved')
        await view.click('#pl')
        const locked = await waitFor(async () => (await pageState(view)).locked === true)
        check('requestPointerLock() from a click locks the pointer', locked, JSON.stringify(await pageState(view)))
        const pointerNotice = await waitFor(async () => (await noticesShown(app as ElectronApplication)).includes('Press Esc to show your cursor'))
        check('the "Press Esc to show your cursor" notice is on screen', pointerNotice, JSON.stringify(await noticesShown(app)))
        await delay(ABSENCE_SETTLE_MS)
        check('the notice leaves the page its focus and its lock', (await pageState(view)).locked === true && await tabFocused(app))
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
      await waitFor(async () => (await asked(app as ElectronApplication)).length === 2)
      await delay(ABSENCE_SETTLE_MS)
      const mail = (await asked(app))[1]
      check('a clicked mailto: link is asked about', mail?.message === 'Open mailto link with your system\'s default app?', JSON.stringify(mail))
      check('Cancel launches nothing', openers.launched() === '', openers.launched())

      await answer(app, 'external', 0)
      await view.click('#magnet')
      const launched = await waitFor(() => openers.launched() !== '')
      check('Allow hands exactly the URL the person was shown to the OS handler',
        launched && openers.launched() === `${MAGNET}\n` && (await asked(app))[2]?.detail === `${ORIGIN} wants to open:\n${MAGNET}`,
        `${openers.launched()} / ${JSON.stringify((await asked(app))[2])}`)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
      rmSync(openers.dir, { recursive: true, force: true })
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
        await stubDialogs(first)
        const view = await navigateToFixture(first, PAGE_URL, TITLE)
        const before = await evaluateRetrying(view, () => Notification.permission)
        check(`a site nobody has answered for does not read as granted (got ${before})`, before !== 'granted')

        await view.click('#notify')
        await waitFor(async () => (await pageState(view)).notify !== undefined)
        const notNow = await asked(first)
        check('the site is asked, and named first', notNow.length === 1 && notNow[0]?.message === `${ORIGIN} wants to show notifications` &&
          JSON.stringify(notNow[0]?.buttons) === '["Allow","Block","Not now"]', JSON.stringify(notNow))
        check(`"Not now" grants nothing (got ${String((await pageState(view)).notify)})`, (await pageState(view)).notify !== 'granted')
        await evaluateRetrying(view, () => { delete (window as unknown as { __r: PageState }).__r.notify })
        await view.click('#notify')
        await waitFor(async () => (await pageState(view)).notify !== undefined)
        check('the same page load is not asked twice', (await asked(first)).length === 1)

        await view.reload()
        await answer(first, 'notifications', 0)
        await view.click('#notify')
        const granted = await waitFor(async () => (await pageState(view)).notify === 'granted')
        check('after a reload the site is asked again, and Allow grants', granted && (await asked(first)).length === 2)
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
        await stubDialogs(second)
        const view = await navigateToFixture(second, PAGE_URL, TITLE)
        check('after a restart the site reads as granted', await evaluateRetrying(view, () => Notification.permission) === 'granted')
        await view.click('#notify')
        await waitFor(async () => (await pageState(view)).notify !== undefined)
        check('and is not asked again', (await pageState(view)).notify === 'granted' && (await asked(second)).length === 0)
      } finally {
        await closeElectronApp(second)
      }
    } finally {
      if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
    }
  })
}, TEST_TIMEOUT_MS)
