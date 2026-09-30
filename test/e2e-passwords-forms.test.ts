// Saving and filling passwords in the running shell: a sign-in is offered for keeping only once it worked
// (a failed one, or one in a frame, is not), the prompt saves or updates or says never for the site, the
// password button and the chooser list the accounts and fill the page's own fields, a sign-up form gets a
// generated password, and a private window offers nothing. The fixture server listens on port 0. Set
// ORIVON_UI_SHOTS_DIR to also write screenshots of each surface in both colour schemes.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { pressKey } from './e2e-helpers.js'
import { html, launchShell, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, popoverShown, waitFor } from './smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 150_000
const SEAM = { ORIVON_TEST_PASSWORD_KEYRING: '1' }
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR

const LOGIN = (action: string, extra = ''): string => `<!doctype html><title>Sign in</title><body style="font:16px sans-serif">${extra}
<form method="post" action="${action}"><input id="user" name="user" type="text" autocomplete="username" style="display:block;margin:12px;width:260px">
<input id="pass" name="pass" type="password" autocomplete="current-password" style="display:block;margin:12px;width:260px"><button id="go" type="submit" style="margin:12px">Sign in</button></form></body>`

const SPA = `<!doctype html><title>Sign in</title><body style="font:16px sans-serif"><form id="f"><input id="user" type="text" autocomplete="username" style="display:block;margin:12px">
<input id="pass" type="password" style="display:block;margin:12px"><button id="go" type="submit" style="margin:12px">Sign in</button></form>
<script>document.getElementById('f').addEventListener('submit', async (e) => { e.preventDefault(); await fetch('/api/login', { method: 'POST', body: document.getElementById('user').value }); history.pushState({}, '', '/spa/home'); document.body.innerHTML = '<h1 id="ok">Welcome, SPA</h1>' })</script></body>`

const SIGN_UP = `<!doctype html><title>Create account</title><body style="font:16px sans-serif"><form method="post" action="/welcome">
<input id="user" name="user" type="text" autocomplete="username" style="display:block;margin:12px;width:260px">
<input id="new1" name="p1" type="password" autocomplete="new-password" style="display:block;margin:12px;width:260px">
<input id="new2" name="p2" type="password" autocomplete="new-password" style="display:block;margin:12px;width:260px">
<button type="submit" style="margin:12px">Create account</button></form></body>`

function handler (request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? '/').split('?')[0]
  if (request.method === 'POST') {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString())
      if (path === '/api/login') { response.statusCode = 204; response.end(); return }
      // /welcome: a password that starts with "bad" is refused with the form again; "locked" answers 401.
      if ((body.get('pass') ?? '').startsWith('bad')) { html(response, LOGIN('/welcome', '<p id="err">Wrong password</p>')); return }
      if (body.get('user') === 'locked') { html(response, LOGIN('/welcome', '<p id="err">Locked</p>'), 401); return }
      html(response, '<!doctype html><title>Welcome</title><h1 id="ok">Welcome</h1>')
    })
    return
  }
  if (path === '/login') html(response, LOGIN('/welcome'))
  else if (path === '/spa') html(response, SPA)
  else if (path === '/spa/home' || path === '/welcome') html(response, '<!doctype html><title>Welcome</title><h1 id="ok">Welcome</h1>')
  else if (path === '/signup') html(response, SIGN_UP)
  else if (path === '/hostile') html(response, '<!doctype html><title>Hostile</title><input id="user" type="text" autofocus><input id="pass" type="password"><script>setTimeout(() => { for (const id of ["user", "pass"]) document.getElementById(id).dispatchEvent(new FocusEvent("focusin", { bubbles: true })) }, 400)</script>')
  else if (path === '/framed') html(response, '<!doctype html><title>Framed</title><iframe id="frame" src="/login" style="width:420px;height:320px;border:1px solid #888"></iframe>')
  else html(response, '<!doctype html><title>Other</title><p>Other</p>')
}

let site: FixtureServer
let other: FixtureServer

beforeAll(async () => {
  site = await startServer(handler)
  other = await startServer(handler)
})

afterAll(async () => {
  await site.close()
  await other.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const overlayPage = (app: App, name: string): Page | undefined => app.windows().find((w) => w.url().includes(`overlay=${name}`))
const shown = async (app: App, name: string): Promise<boolean> => await popoverShown(app, `overlay=${name}`)
const keyVisible = async (chrome: Page): Promise<boolean> => await chrome.evaluate(() => { const key = document.querySelector<HTMLElement>('#password-key'); return key !== null && !key.hidden })

async function waitShown (app: App, name: string): Promise<Page> {
  expect(await waitFor(async () => await shown(app, name)), `${name} shows`).toBe(true)
  expect(await waitFor(() => overlayPage(app, name) !== undefined)).toBe(true)
  return overlayPage(app, name) as Page
}

async function setScheme (app: App, chrome: Page, scheme: 'light' | 'dark', overlay?: Page): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
  await chrome.emulateMedia({ colorScheme: scheme })
  if (overlay !== undefined) await overlay.emulateMedia({ colorScheme: scheme })
  await delay(250)
}

/** One surface in both colour schemes: the overlay's own page, and the toolbar beside it. A popup closes the moment the window's theme changes or the chrome is touched, so it is shot through its own page alone. */
async function shoot (app: App, chrome: Page, name: string, overlay: Page, popup = false): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    if (popup) {
      await overlay.emulateMedia({ colorScheme: scheme })
      await delay(200)
      await overlay.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
      continue
    }
    await setScheme(app, chrome, scheme, overlay)
    await overlay.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
    await chrome.screenshot({ path: join(SHOTS_DIR, `${name}-toolbar-${scheme}.png`) })
  }
  if (popup) await overlay.emulateMedia({ colorScheme: null })
  else await setScheme(app, chrome, 'light', overlay)
}

/** An answer that closes the overlay ends its page while the press or click is still being reported: that is the answer arriving, not a failure. */
const closing = async (action: Promise<unknown>): Promise<void> => { await action.catch((error: unknown) => { if (!/closed/i.test(String(error))) throw error }) }

/** Types a sign-in into the page the way a person does, and presses the button. */
async function signIn (view: Page, user: string, pass: string): Promise<void> {
  await view.click('#user')
  await view.fill('#user', user)
  await view.fill('#pass', pass)
  await view.click('#go')
}

/** The chooser, opened with the password button and answered with Enter on the first row. */
async function chooseFirst (app: App, chrome: Page): Promise<void> {
  await chrome.click('#password-key')
  const chooser = await waitShown(app, 'password-fill')
  await chooser.waitForSelector('.listbox-item')
  await closing(chooser.keyboard.press('Enter'))
  expect(await waitFor(async () => !(await shown(app, 'password-fill')))).toBe(true)
}

it('offers a sign-in for keeping only once it worked, then saves, fills, updates and forgets per site', async () => {
  const { app, chrome } = await launchShell({ env: SEAM })
  try {
    // A refused sign-in is not offered: the next page asks for the password again.
    let view = await visit(app, chrome, `${site.origin}/login`)
    await signIn(view, 'ada', 'bad-password')
    await view.waitForSelector('#err')
    await delay(ABSENCE_SETTLE_MS * 2)
    expect(await shown(app, 'password-save')).toBe(false)

    // An error status is not offered either.
    await view.fill('#user', 'locked')
    await view.fill('#pass', 'whatever')
    await view.click('#go')
    await delay(ABSENCE_SETTLE_MS * 2)
    expect(await shown(app, 'password-save')).toBe(false)

    // No account is saved yet, so the password button has nothing to offer here.
    view = await visit(app, chrome, `${site.origin}/login`)
    expect(await keyVisible(chrome)).toBe(false)

    // The real sign-in: the prompt appears under the address bar and does not take the keyboard.
    await signIn(view, 'ada', 'pw-one')
    await view.waitForSelector('#ok')
    let prompt = await waitShown(app, 'password-save')
    await prompt.waitForSelector('#ps-username')
    expect(await prompt.textContent('.sheet-title')).toBe('Save password?')
    expect(await prompt.textContent('.origin')).toBe(site.origin)
    expect(await prompt.inputValue('#ps-username')).toBe('ada')
    expect(await prompt.textContent('#ps-secret')).not.toContain('pw-one')
    expect(await keyVisible(chrome)).toBe(true)
    await shoot(app, chrome, 'save-prompt', prompt)

    // The eye shows the password to this prompt only.
    await prompt.click('.ps-eye')
    expect(await prompt.textContent('#ps-secret')).toBe('pw-one')
    await prompt.click('.ps-eye')
    expect(await prompt.textContent('#ps-secret')).not.toContain('pw-one')

    await prompt.click('.btn.primary')
    expect(await prompt.textContent('.toast')).toContain('Password saved')
    expect(await waitFor(async () => !(await shown(app, 'password-save')))).toBe(true)

    // Back on the sign-in page the button lists the account and Enter fills both fields.
    view = await visit(app, chrome, `${site.origin}/login`)
    expect(await waitFor(async () => await keyVisible(chrome))).toBe(true)
    await chrome.click('#password-key')
    const chooser = await waitShown(app, 'password-fill')
    await chooser.waitForSelector('.listbox-item')
    expect(await chooser.locator('.listbox-item .item-title').allTextContents()).toEqual(['ada'])
    expect(await chooser.textContent('.listbox-item .item-sub')).not.toContain('pw-one')
    expect(await chooser.textContent('.pf-foot .link-btn')).toBe('Manage passwords')
    await shoot(app, chrome, 'chooser', chooser, true)
    await closing(chooser.keyboard.press('Enter'))
    expect(await waitFor(async () => (await view.inputValue('#pass')) === 'pw-one')).toBe(true)
    expect(await view.inputValue('#user')).toBe('ada')
    expect(await waitFor(async () => !(await shown(app, 'password-fill')))).toBe(true)

    // The same sign-in again is already kept: no prompt.
    await view.click('#go')
    await view.waitForSelector('#ok')
    await delay(ABSENCE_SETTLE_MS * 2)
    expect(await shown(app, 'password-save')).toBe(false)

    // A focused box opens the chooser under it without taking the keyboard: typing goes on, the arrow keys and
    // Enter are read by main, and Escape closes it for this page.
    view = await visit(app, chrome, `${site.origin}/login`)
    await view.click('#user')
    let suggest = await waitShown(app, 'password-suggest')
    await suggest.waitForSelector('.listbox-item')
    expect(await suggest.locator('.listbox-item .item-title').allTextContents()).toEqual(['ada'])
    expect(await suggest.locator('.listbox-item[aria-selected="true"]').count()).toBe(0)
    await shoot(app, chrome, 'suggest', suggest, true)
    await view.keyboard.type('zed')
    expect(await view.inputValue('#user')).toBe('zed')
    await pressKey(app, `${site.origin}/login`, 'Enter')
    await delay(ABSENCE_SETTLE_MS)
    // Enter with no row chosen was the page's: its form went in, and the chooser followed the focus away.
    view = await visit(app, chrome, `${site.origin}/login`)
    await view.click('#user')
    suggest = await waitShown(app, 'password-suggest')
    await suggest.waitForSelector('.listbox-item')
    await pressKey(app, `${site.origin}/login`, 'Down')
    await suggest.waitForSelector('.listbox-item[aria-selected="true"]')
    await pressKey(app, `${site.origin}/login`, 'Enter')
    expect(await waitFor(async () => (await view.inputValue('#pass')) === 'pw-one')).toBe(true)
    expect(await view.inputValue('#user')).toBe('ada')
    expect(await waitFor(async () => !(await shown(app, 'password-suggest')))).toBe(true)

    // A click on its row fills too, and the page keeps the keyboard.
    view = await visit(app, chrome, `${site.origin}/login`)
    await view.click('#user')
    suggest = await waitShown(app, 'password-suggest')
    await suggest.waitForSelector('.listbox-item')
    await closing(suggest.click('.listbox-item'))
    expect(await waitFor(async () => (await view.inputValue('#pass')) === 'pw-one')).toBe(true)
    expect(await waitFor(async () => !(await shown(app, 'password-suggest')))).toBe(true)

    // Escape says no for this page: it does not come back when the next box is focused.
    view = await visit(app, chrome, `${site.origin}/login`)
    await view.click('#user')
    await waitShown(app, 'password-suggest')
    await pressKey(app, `${site.origin}/login`, 'Escape')
    expect(await waitFor(async () => !(await shown(app, 'password-suggest')))).toBe(true)
    await view.click('#pass')
    await delay(ABSENCE_SETTLE_MS)
    expect(await shown(app, 'password-suggest')).toBe(false)

    // A new password for the same account is an update, and the username is not editable.
    view = await visit(app, chrome, `${site.origin}/login`)
    await signIn(view, 'ada', 'pw-two')
    await view.waitForSelector('#ok')
    prompt = await waitShown(app, 'password-save')
    await prompt.waitForSelector('#ps-username')
    expect(await prompt.textContent('.sheet-title')).toBe('Update password?')
    expect(await prompt.getAttribute('#ps-username', 'readonly')).not.toBeNull()
    expect(await prompt.textContent('.btn.primary')).toBe('Update')
    await shoot(app, chrome, 'update-prompt', prompt)
    await prompt.click('.btn.primary')
    expect(await waitFor(async () => !(await shown(app, 'password-save')))).toBe(true)
    view = await visit(app, chrome, `${site.origin}/login`)
    expect(await waitFor(async () => await keyVisible(chrome))).toBe(true)
    await chooseFirst(app, chrome)
    expect(await waitFor(async () => (await view.inputValue('#pass')) === 'pw-two')).toBe(true)

    // A single-page app that signs in with fetch and pushState is offered too, for its own account.
    view = await visit(app, chrome, `${site.origin}/spa`)
    await signIn(view, 'spa-user', 'spa-pass')
    await view.waitForSelector('#ok')
    prompt = await waitShown(app, 'password-save')
    await prompt.waitForSelector('#ps-username')
    expect(await prompt.inputValue('#ps-username')).toBe('spa-user')
    await closing(prompt.click('.btn-row .btn:not(.primary)'))
    expect(await waitFor(async () => !(await shown(app, 'password-save')))).toBe(true)

    // A page that focuses its own boxes by script, or dispatches focus events, cannot open the chooser.
    view = await visit(app, chrome, `${site.origin}/hostile`)
    await delay(ABSENCE_SETTLE_MS * 2)
    expect(await shown(app, 'password-suggest')).toBe(false)
    expect(await shown(app, 'password-fill')).toBe(false)

    // A sign-in inside a frame is not watched at all.
    view = await visit(app, chrome, `${site.origin}/framed`)
    const frame = view.frameLocator('#frame')
    await frame.locator('#user').fill('framed-user')
    await frame.locator('#pass').fill('framed-pass')
    await frame.locator('#go').click()
    await delay(ABSENCE_SETTLE_MS * 2)
    expect(await shown(app, 'password-save')).toBe(false)

    // A sign-up form: the chooser leads with a strong password, and choosing it fills both fields.
    view = await visit(app, chrome, `${site.origin}/signup`)
    await view.click('#new1')
    expect(await waitFor(async () => await keyVisible(chrome))).toBe(true)
    await chrome.click('#password-key')
    const strong = await waitShown(app, 'password-fill')
    await strong.waitForSelector('.listbox-item')
    expect(await strong.locator('.listbox-item .item-title').first().textContent()).toBe('Use a strong password')
    const generated = (await strong.locator('.listbox-item .pf-code').first().textContent()) ?? ''
    expect(generated).toHaveLength(20)
    await shoot(app, chrome, 'chooser-strong', strong, true)
    await closing(strong.keyboard.press('Enter'))
    expect(await waitFor(async () => (await view.inputValue('#new1')) === generated)).toBe(true)
    expect(await view.inputValue('#new2')).toBe(generated)

    // "Never for this site": the next sign-in there is not offered, and the button stays away.
    view = await visit(app, chrome, `${other.origin}/login`)
    await signIn(view, 'grace', 'pw-g')
    await view.waitForSelector('#ok')
    prompt = await waitShown(app, 'password-save')
    await prompt.waitForSelector('.btn-row .link-btn')
    expect(await prompt.textContent('.btn-row .link-btn')).toBe('Never for this site')
    await closing(prompt.click('.btn-row .link-btn'))
    expect(await waitFor(async () => !(await shown(app, 'password-save')))).toBe(true)
    view = await visit(app, chrome, `${other.origin}/login`)
    await signIn(view, 'grace', 'pw-g2')
    await view.waitForSelector('#ok')
    await delay(ABSENCE_SETTLE_MS * 2)
    expect(await shown(app, 'password-save')).toBe(false)
    expect(await keyVisible(chrome)).toBe(false)

    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers nothing in a private window', async () => {
  const { app, chrome } = await launchShell({ env: SEAM, args: ['--orivon-private'] })
  try {
    const view = await visit(app, chrome, `${site.origin}/login`)
    await signIn(view, 'ada', 'pw-private')
    await view.waitForSelector('#ok')
    await delay(ABSENCE_SETTLE_MS * 3)
    expect(await shown(app, 'password-save')).toBe(false)
    expect(await keyVisible(chrome)).toBe(false)
    const back = await visit(app, chrome, `${site.origin}/login`)
    await delay(ABSENCE_SETTLE_MS)
    expect(await keyVisible(chrome)).toBe(false)
    await back.click('#user')
    await delay(ABSENCE_SETTLE_MS)
    expect(await shown(app, 'password-fill')).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
