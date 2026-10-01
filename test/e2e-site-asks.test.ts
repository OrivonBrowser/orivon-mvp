// A website that asks for the camera, a location, the clipboard, MIDI, idle state or window placement, answered
// once per site in a prompt under the address bar, and the chip that says what happened on the page: the
// prompt's words, the keys that cannot answer it, Allow and Block remembered across a reload, Escape and a new
// page deciding nothing, a frame never asking, a private window remembering nothing on disk, and the bubble under
// the chip changing an answer. Fake devices only (never the flag that skips the request handler); no native dialog
// may be asked for. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { html, launchShell, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { nativeDialogsAsked as dialogsAsked, stubNativeDialogs as stubDialogs } from './question-support.js'
import { delay, popoverShown, waitFor } from './smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const E2E_TIMEOUT_MS = 240_000
const FAKE_DEVICES = '--use-fake-device-for-media-stream'

const PAGE = (frame: string | null): string => `<!doctype html><title>site asks</title><body style="font:16px sans-serif">
<button id="cam">cam</button><button id="both">both</button><button id="geo">geo</button><button id="clip">clip</button>
<button id="midi">midi</button><button id="idle">idle</button><button id="win">win</button><button id="notify">notify</button><button id="push">push</button>
${frame === null ? '' : `<iframe id="frame" allow="camera; microphone; geolocation" src="${frame}" style="width:300px;height:80px"></iframe>`}
<script>
window.__r = {}
const done = (key, promise) => promise.then((value) => { window.__r[key] = value }, (error) => { window.__r[key] = 'ERR:' + error.name })
const first = (stream) => stream.getTracks().map((t) => t.readyState).join(',')
const on = (id, run) => document.getElementById(id).addEventListener('click', run)
on('cam', () => done('cam', navigator.mediaDevices.getUserMedia({ video: true }).then(first)))
on('both', () => done('both', navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(first)))
on('geo', () => done('geo', new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('position'), (e) => resolve('code' + e.code)))))
on('clip', () => done('clip', Promise.race([navigator.clipboard.readText().then(() => 'read'), new Promise((r) => setTimeout(() => r('pending'), 4000))])))
on('midi', () => done('midi', navigator.requestMIDIAccess({ sysex: true }).then(() => 'midi')))
on('idle', () => done('idle', IdleDetector.requestPermission()))
on('win', () => done('win', window.getScreenDetails().then((d) => 'screens:' + d.screens.length)))
on('notify', () => done('notify', Notification.requestPermission()))
on('push', () => history.pushState({}, '', '/pushed'))
window.addEventListener('message', (event) => { if (String(event.data).startsWith('labels:')) window.__r.labels = event.data; else window.__r.frame = event.data })
</script></body>`

const FRAME = `<!doctype html><title>frame</title><script>
navigator.mediaDevices.getUserMedia({ video: true }).then(() => parent.postMessage('video:live', '*'), (e) => parent.postMessage('video:' + e.name, '*'))
navigator.mediaDevices.enumerateDevices().then((devices) => parent.postMessage('labels:' + devices.filter((d) => d.label !== '').length, '*'))
</script>`

const servers: FixtureServer[] = []
const origins: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' }

async function serve (frame: () => string | null): Promise<FixtureServer> {
  const server = await startServer((request, response) => { html(response, request.url === '/frame' ? FRAME : PAGE(frame())) })
  servers.push(server)
  return server
}

beforeAll(async () => {
  origins.c = (await serve(() => null)).origin
  origins.b = (await serve(() => null)).origin
  origins.a = (await serve(() => `${origins.c}/frame`)).origin
})

afterAll(async () => {
  for (const server of servers) await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const promptPage = (app: App): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=site-prompt') && !w.isClosed()).at(-1)
const promptShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=site-prompt')

/** The newest prompt page that is on screen and has drawn: a closed overlay's page stays listed for a moment, so one that dies under the wait is skipped. */
async function waitPrompt (app: App): Promise<Page> {
  let found: Page | undefined
  const ok = await waitFor(async () => {
    if (!(await promptShown(app))) return false
    const candidate = promptPage(app)
    if (candidate === undefined) return false
    try {
      await candidate.waitForSelector('.site-prompt .btn-row, .site-prompt .sp-rows', { timeout: 2_000 })
      found = candidate
      return true
    } catch {
      return false
    }
  }, 15_000)
  expect(ok).toBe(true)
  return found as Page
}

async function expectNoPrompt (app: App): Promise<void> {
  await delay(1_200)
  expect(await promptShown(app)).toBe(false)
}

/** Waits out the half second the buttons ignore presses, then presses one. The page may already be gone by the time the click settles. */
async function answer (page: Page, label: 'Allow' | 'Block'): Promise<void> {
  await page.waitForSelector('.site-prompt:not(.arming)')
  try { await page.click(`.btn-row .btn:text-is("${label}")`) } catch (error) { if (!/closed|destroyed/.test(String(error))) throw error }
}

const textOf = async (page: Page, selector: string): Promise<string[]> => await page.locator(selector).allTextContents()
const result = async (view: Page, key: string): Promise<unknown> => {
  let last: unknown
  await waitFor(async () => { last = await view.evaluate((k) => (window as unknown as { __r: Record<string, unknown> }).__r[k], key); return last !== undefined }, 12_000)
  return last
}
const clear = async (view: Page, key: string): Promise<void> => { await view.evaluate((k) => { delete (window as unknown as { __r: Record<string, unknown> }).__r[k] }, key) }

interface Chip { hidden: boolean, label: string, className: string }
const chipOf = async (chrome: Page): Promise<Chip> => await chrome.evaluate(() => {
  const chip = document.querySelector<HTMLButtonElement>('#site-access-chip')
  return { hidden: chip === null || chip.hidden === true, label: chip?.getAttribute('aria-label') ?? '', className: chip?.className ?? '' }
})
async function waitChip (chrome: Page, hidden: boolean, label?: string): Promise<Chip> {
  let last: Chip = { hidden: true, label: '', className: '' }
  const ok = await waitFor(async () => { last = await chipOf(chrome); return last.hidden === hidden && (label === undefined || last.label === label) })
  expect({ ok, last }).toEqual({ ok: true, last })
  return last
}

const userDataOf = async (app: App): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))

async function setScheme (app: App, pages: Page[], scheme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
  for (const page of pages) await page.emulateMedia({ colorScheme: scheme })
  await delay(400)
}

async function shoot (name: string, scheme: string, target: Page | null): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  if (target !== null) await target.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  else execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-${scheme}.png`)])
}

/** The prompt and the window around it, in both schemes. */
async function shootBoth (app: App, chrome: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  const page = promptPage(app) as Page
  // A question's buttons are dimmed for their first half second; the picture is of the ready prompt.
  await page.waitForSelector('.site-prompt:not(.arming)')
  for (const scheme of ['light', 'dark'] as const) {
    await setScheme(app, [chrome, page], scheme)
    await shoot(name, scheme, page)
    await shoot(`${name}-window`, scheme, null)
  }
  await setScheme(app, [chrome, page], 'light')
}

it('asks once per site, remembers the answer across a page load, and the chip changes it', async () => {
  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES] })
  try {
    await stubDialogs(app)
    const view = await visit(app, chrome, `${origins.a}/`)
    await waitChip(chrome, true)

    // Nothing shows, and nothing is asked, until the page asks.
    expect(await promptShown(app)).toBe(false)
    await view.click('#cam')
    let prompt = await waitPrompt(app)
    expect(await textOf(prompt, '.origin')).toEqual([origins.a])
    expect(await textOf(prompt, '.sp-text')).toEqual(['wants to use your camera'])
    expect(await textOf(prompt, '.btn-row .btn')).toEqual(['Block', 'Allow'])
    expect(await prompt.locator('.banner').count()).toBe(0)
    expect(await prompt.getAttribute('.site-prompt', 'role')).toBe('dialog')
    // Focus is on the dialog, never a button, so a key meant for the page cannot answer.
    expect(await prompt.evaluate(() => document.activeElement?.classList.contains('site-prompt'))).toBe(true)
    expect(await prompt.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent))).toEqual(['Block', 'Allow', 'Not now'])

    // Buttons ignore a press for half a second; a press that lands early does nothing.
    if (await prompt.evaluate(() => document.querySelector('.site-prompt')?.classList.contains('arming') === true)) {
      await prompt.evaluate(() => { document.querySelector<HTMLButtonElement>('.btn-row .btn.primary')?.click() })
      expect(await promptShown(app)).toBe(true)
    }
    await shootBoth(app, chrome, 'ask-camera')
    await prompt.waitForSelector('.site-prompt:not(.arming)')
    await prompt.keyboard.press('Enter')
    await prompt.keyboard.press('Space')
    await delay(300)
    expect(await promptShown(app)).toBe(true)
    await answer(prompt, 'Allow')
    expect(await result(view, 'cam')).toBe('live')
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    await waitChip(chrome, false, 'Camera allowed on this page')

    // The same site, asked again after a reload, is not asked: the answer is remembered.
    await view.reload()
    await waitChip(chrome, true)
    await view.click('#cam')
    expect(await result(view, 'cam')).toBe('live')
    expect(await promptShown(app)).toBe(false)

    // A second site: Block is remembered too, the page is refused, and the chip says so.
    const second = await visit(app, chrome, `${origins.b}/`)
    await second.click('#cam')
    prompt = await waitPrompt(app)
    await answer(prompt, 'Block')
    expect(await result(second, 'cam')).toBe('ERR:NotAllowedError')
    await waitChip(chrome, false, 'Camera blocked on this page')
    expect((await chipOf(chrome)).className).toContain('blocked')

    // The bubble under the chip lists what this page was asked and changes it.
    await chrome.click('#site-access-chip')
    const bubble = await waitPrompt(app)
    expect(await textOf(bubble, '.sheet-title')).toEqual(['Permissions on this page'])
    expect(await textOf(bubble, '.origin')).toEqual([origins.b])
    expect(await textOf(bubble, '.sp-label')).toEqual(['Camera'])
    expect(await bubble.getAttribute('.segmented button[aria-pressed="true"]', 'data-value')).toBe('block')
    await shootBoth(app, chrome, 'review')
    await bubble.click('.segmented button[data-value="allow"]')
    await bubble.waitForSelector('.sp-reload')
    expect(await textOf(bubble, '.sp-reload')).toEqual(['Reload the page to apply your changes.Reload'])
    await shootBoth(app, chrome, 'review-changed')
    await waitChip(chrome, false, 'Camera allowed on this page')
    await bubble.click('.sp-reload .btn')
    await waitChip(chrome, true)
    await second.waitForLoadState('load')
    await second.click('#cam')
    expect(await result(second, 'cam')).toBe('live')
    expect(await promptShown(app)).toBe(false)

    // On disk, per site and kind.
    const file = join(await userDataOf(app), 'site-settings.json')
    expect(await waitFor(() => existsSync(file))).toBe(true)
    const onDisk = (): unknown => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
    const expected = { version: 1, sites: { [origins.a]: { camera: 'allow' }, [origins.b]: { camera: 'allow' } } }
    // The store writes after a short delay, so the second answer reaches the file a moment after the first.
    expect(await waitFor(() => JSON.stringify(onDisk()) === JSON.stringify(expected))).toBe(true)
    expect(onDisk()).toEqual(expected)

    expect(await dialogsAsked(app)).toEqual([])
    expect(mainOutput(app)).not.toMatch(/\[site-asks\]/)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('says what each kind wants, asks for camera and microphone once, and decides nothing on Escape or a new page', async () => {
  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES] })
  try {
    await stubDialogs(app)
    const view = await visit(app, chrome, `${origins.c}/`)

    // Camera and microphone together: one prompt, one line.
    await view.click('#both')
    let prompt = await waitPrompt(app)
    expect(await textOf(prompt, '.sp-text')).toEqual(['wants to use your camera and microphone'])
    await shootBoth(app, chrome, 'ask-both')
    // A long site name wraps: it is the line the person judges the question by, so it is never cut.
    const long = 'https://a-very-long-subdomain.of-some-host.example.org:8443/and-a-long-path-after-it'
    await prompt.evaluate((text) => { const origin = document.querySelector('.origin'); if (origin !== null) origin.textContent = text }, long)
    await delay(300)
    expect(await prompt.evaluate(() => { const o = document.querySelector<HTMLElement>('.origin'); return o !== null && o.scrollWidth <= o.clientWidth })).toBe(true)
    await shootBoth(app, chrome, 'ask-long-origin')
    await answer(prompt, 'Allow')
    expect(await result(view, 'both')).toBe('live,live')

    // Location: told before Allow what the person gets: the choice is kept and the page is still told no.
    await view.click('#geo')
    prompt = await waitPrompt(app)
    expect(await textOf(prompt, '.sp-text')).toEqual(['wants to know your location'])
    expect(await textOf(prompt, '.banner')).toEqual(['Orivon has no location service yet. If you allow this, your choice is kept, but the site is still told it cannot have your position.'])
    await shootBoth(app, chrome, 'ask-location')
    // Escape decides nothing: the page is refused this time, and is not asked again on this load.
    // Escape closes the page under the key: the press may end with the page already gone.
    try { await prompt.keyboard.press('Escape') } catch (error) { if (!/closed/.test(String(error))) throw error }
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    expect(await result(view, 'geo')).toBe('code1')
    await clear(view, 'geo')
    await view.click('#geo')
    expect(await result(view, 'geo')).toBe('code1')
    await expectNoPrompt(app)
    const file = join(await userDataOf(app), 'site-settings.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).sites[origins.c]).toEqual({ camera: 'allow', microphone: 'allow' })

    // A new page asks again, and this time the question is answered.
    await view.reload()
    await clear(view, 'geo')
    await view.click('#geo')
    prompt = await waitPrompt(app)
    await answer(prompt, 'Allow')
    expect(await result(view, 'geo')).toBe('code1')

    // Closing the question with its own button decides nothing either, and a navigation closes it.
    await view.reload()
    await view.click('#clip')
    prompt = await waitPrompt(app)
    expect(await textOf(prompt, '.sp-text')).toEqual(['wants to see text and images you copied'])
    await shootBoth(app, chrome, 'ask-clipboard')
    await prompt.waitForSelector('.site-prompt:not(.arming)')
    await prompt.click('.sp-close')
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    await clear(view, 'clip')
    await view.click('#clip')
    await expectNoPrompt(app)
    await view.reload()
    await view.click('#clip')
    prompt = await waitPrompt(app)
    await view.evaluate(() => { location.href = location.href })
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    await view.waitForLoadState('load')
    await view.click('#clip')
    prompt = await waitPrompt(app)
    await answer(prompt, 'Block')
    expect(await result(view, 'clip')).toBe('ERR:NotAllowedError')

    // The other kinds, each in its own words. A machine with no MIDI service answers an allowed request with
    // the platform's InvalidStateError; a refusal by the permission would be NotAllowedError or SecurityError.
    for (const [button, key, text, expected] of [
      ['#midi', 'midi', 'wants to control and reprogram your MIDI devices', /^(midi|ERR:InvalidStateError)$/],
      ['#idle', 'idle', 'wants to know when you are away from this computer', 'granted'],
      ['#win', 'win', 'wants to place windows across your screens', /^screens:\d+$/]
    ] as const) {
      await view.click(button)
      prompt = await waitPrompt(app)
      expect(await textOf(prompt, '.sp-text')).toEqual([text])
      await answer(prompt, 'Allow')
      const got = await result(view, key)
      if (expected instanceof RegExp) expect(String(got)).toMatch(expected)
      else expect(got).toBe(expected)
    }
    await waitFor(() => JSON.parse(readFileSync(file, 'utf8')).sites[origins.c]?.windowManagement === 'allow')
    expect(JSON.parse(readFileSync(file, 'utf8')).sites[origins.c]).toEqual({
      camera: 'allow', microphone: 'allow', location: 'allow', clipboardRead: 'block', midi: 'allow', idle: 'allow', windowManagement: 'allow'
    })
    expect(await dialogsAsked(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('never lets a frame ask, keeps a question with its tab, and refuses a background tab', async () => {
  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES] })
  try {
    await stubDialogs(app)
    // Site A allows its camera; the cross-origin frame (site C, undecided) asks from inside it.
    const first = await visit(app, chrome, `${origins.a}/`)
    await first.click('#cam')
    await answer(await waitPrompt(app), 'Allow')
    expect(await result(first, 'cam')).toBe('live')
    await first.reload()
    expect(await result(first, 'frame')).toBe('video:NotAllowedError')
    // The page's own allow is not the frame's: the frame learns no device names either.
    expect(await result(first, 'labels')).toBe('labels:0')
    await expectNoPrompt(app)

    // A question waits with its tab: switching away hides it, coming back shows it, and answering works.
    const third = await visit(app, chrome, `${origins.b}/`)
    await third.click('#geo')
    await waitPrompt(app)
    await chrome.click('#new-tab')
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    await chrome.click('.tab:not(.active)')
    const back = await waitPrompt(app)
    await answer(back, 'Block')
    expect(await result(third, 'geo')).toBe('code1')
    expect(await dialogsAsked(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('keeps a question open and answerable when the page only rewrites its address, and the chip opens and closes the bubble', async () => {
  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES] })
  try {
    await stubDialogs(app)
    const view = await visit(app, chrome, `${origins.b}/`)
    await view.click('#cam')
    await waitPrompt(app)
    // An app that updates its address while it waits is still the page that asked.
    await view.evaluate(() => { document.getElementById('push')?.click() })
    await delay(1_200)
    expect(await promptShown(app)).toBe(true)
    await answer(await waitPrompt(app), 'Allow')
    expect(await result(view, 'cam')).toBe('live')

    // The chip opens the bubble and a second press closes it: closing on blur and then reopening on the click is a flicker, not a toggle.
    await waitChip(chrome, false)
    await chrome.click('#site-access-chip')
    await waitPrompt(app)
    await chrome.click('#site-access-chip')
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    await delay(800)
    expect(await promptShown(app)).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('keeps a private window\'s answers in memory, and says so', async () => {
  const { app, chrome } = await launchShell({ args: ['--orivon-private', FAKE_DEVICES] })
  try {
    await stubDialogs(app)
    const view = await visit(app, chrome, `${origins.b}/`)
    await view.click('#cam')
    const prompt = await waitPrompt(app)
    expect(await textOf(prompt, '.sp-note')).toEqual(['Forgotten when this private window closes.'])
    await shootBoth(app, chrome, 'ask-private')
    await answer(prompt, 'Allow')
    expect(await result(view, 'cam')).toBe('live')
    await view.reload()
    await view.click('#cam')
    expect(await result(view, 'cam')).toBe('live')
    expect(await promptShown(app)).toBe(false)
    await delay(800)
    expect(existsSync(join(await userDataOf(app), 'site-settings.json'))).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

async function seedValues (dir: string, values: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values }))
}

it('refuses without asking where the default is block, and asks about notifications in the same prompt', async () => {
  // No desktop bus: nothing this page does could reach the desktop's notification daemon.
  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/orivon-e2e-bus' }
  const blocked = await launchShell({ args: [FAKE_DEVICES], env, seedProfile: async (dir: string) => { await seedValues(dir, { 'sites.camera': 'block', 'sites.notifications': 'block' }) } })
  try {
    await stubDialogs(blocked.app)
    const view = await visit(blocked.app, blocked.chrome, `${origins.a}/`)
    await view.click('#cam')
    expect(await result(view, 'cam')).toBe('ERR:NotAllowedError')
    await view.click('#notify')
    expect(await result(view, 'notify')).toBe('denied')
    await expectNoPrompt(blocked.app)
    await waitChip(blocked.chrome, false, 'Camera blocked on this page')
    expect(await dialogsAsked(blocked.app)).toEqual([])
  } finally {
    await closeElectron(blocked.app)
  }

  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES], env })
  try {
    await stubDialogs(app)
    const view = await visit(app, chrome, `${origins.a}/`)
    expect(await view.evaluate(() => Notification.permission)).not.toBe('granted')
    await view.click('#notify')
    const prompt = await waitPrompt(app)
    expect(await textOf(prompt, '.sp-text')).toEqual(['wants to show notifications'])
    await answer(prompt, 'Allow')
    expect(await result(view, 'notify')).toBe('granted')
    expect(await view.evaluate(() => Notification.permission)).toBe('granted')
    const saved = JSON.parse(readFileSync(join(await userDataOf(app), 'notification-decisions.json'), 'utf8')) as { origins: Record<string, string> }
    expect(saved.origins[origins.a]).toBe('allow')
    expect(await dialogsAsked(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('records what the page gets for the APIs with no prompt, under the real gate', async () => {
  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES] })
  try {
    const view = await visit(app, chrome, `${origins.b}/`)
    await view.click('#cam')
    await answer(await waitPrompt(app), 'Allow')
    await result(view, 'cam')
    const probe = await view.evaluate(async () => {
      const settle = async (run: () => unknown): Promise<string> => {
        try { return String(await Promise.race([Promise.resolve(run()), new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 3000))])) } catch (error) { return `ERR:${(error as Error).name}` }
      }
      const out: Record<string, string> = {}
      out['storage.persist'] = await settle(async () => await navigator.storage.persist())
      out['wakeLock'] = await settle(async () => { const lock = await navigator.wakeLock.request('screen'); await lock.release(); return 'granted' })
      out['accelerometer'] = await settle(async () => { const sensor = new (globalThis as unknown as { Accelerometer: new () => { start: () => void, stop: () => void, onerror: ((e: { error: { name: string } }) => void) | null, onreading: (() => void) | null } }).Accelerometer(); return await new Promise((resolve) => { sensor.onerror = (event) => { resolve(`ERR:${event.error.name}`) }; sensor.onreading = () => { resolve('reading') }; sensor.start() }) })
      out['deviceMotion'] = await settle(async () => await new Promise((resolve) => { const t = setTimeout(() => { resolve('none') }, 1500); window.addEventListener('devicemotion', () => { clearTimeout(t); resolve('event') }, { once: true }) }))
      out['localFonts'] = await settle(async () => (await (window as unknown as { queryLocalFonts: () => Promise<unknown[]> }).queryLocalFonts()).length > 0)
      for (const name of ['camera', 'microphone', 'geolocation', 'midi', 'clipboard-read', 'notifications', 'idle-detection', 'window-management', 'persistent-storage', 'screen-wake-lock']) {
        out[`query:${name}`] = await settle(async () => (await navigator.permissions.query({ name } as never)).state)
      }
      out['h264'] = String(MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'))
      out['hevc'] = String(MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"'))
      return out
    })
    console.log(`PROBE ${JSON.stringify(probe)}`)
    expect(probe['h264']).toBe('true')
    expect(probe['query:camera']).toBe('granted')
    expect(probe['query:geolocation']).not.toBe('granted')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
