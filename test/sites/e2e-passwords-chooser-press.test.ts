// A person's press on the sign-in chooser: the popup under a focused box and the one under the password button
// each fill the page when a row is pressed, a saved login or the strong password of a sign-up form. A press in a
// real window moves the keyboard to the view under the pointer; Playwright's click does not, so the spec gives the
// chooser that move before every click (`pressOn`), and gives the page the real focus a person's window has
// (`useRealFocus`). The fixture server listens on port 0.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { pressOn, underVirtualDisplay, useRealFocus, webContentsFocused } from '../support/focus-helpers.js'
import { html, launchShell, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 150_000
const SEAM = { ORIVON_TEST_PASSWORD_KEYRING: '1' }
/** A press on the popup under a box this soon after it appeared is not a choice (`EARLY_CLICK_MS` in the chooser). */
const PAST_EARLY_CLICK_MS = 700

const FIELD = 'style="display:block;margin:12px;width:260px"'
const LOGIN = `<!doctype html><title>Sign in</title><body style="font:16px sans-serif"><form method="post" action="/welcome">
<input id="user" name="user" type="text" autocomplete="username" ${FIELD}><input id="pass" name="pass" type="password" autocomplete="current-password" ${FIELD}>
<button id="go" type="submit" style="margin:12px">Sign in</button></form></body>`
const SIGN_UP = `<!doctype html><title>Create account</title><body style="font:16px sans-serif"><form method="post" action="/welcome">
<input id="user" name="user" type="text" autocomplete="username" ${FIELD}>
<input id="new1" name="p1" type="password" autocomplete="new-password" ${FIELD}>
<input id="new2" name="p2" type="password" autocomplete="new-password" ${FIELD}>
<button type="submit" style="margin:12px">Create account</button></form></body>`
/** One new-password box and no <form>; a script reads the value from the events a typed value would fire. */
const SIGN_UP_BARE = `<!doctype html><title>Create account</title><body style="font:16px sans-serif"><div>
<input id="user" type="text" autocomplete="username" ${FIELD}>
<input id="new1" type="password" autocomplete="new-password" ${FIELD}><p id="seen"></p></div>
<script>document.getElementById('new1').addEventListener('input', (e) => { document.getElementById('seen').textContent = e.target.value })</script></body>`

function handler (request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? '/').split('?')[0]
  if (request.method === 'POST') {
    request.resume()
    request.on('end', () => { html(response, '<!doctype html><title>Welcome</title><h1 id="ok">Welcome</h1>') })
    return
  }
  if (path === '/login') html(response, LOGIN)
  else if (path === '/signup') html(response, SIGN_UP)
  else if (path === '/signup-bare') html(response, SIGN_UP_BARE)
  else html(response, '<!doctype html><title>Other</title><p>Other</p>')
}

let site: FixtureServer
let bare: FixtureServer

beforeAll(async () => {
  site = await startServer(handler)
  bare = await startServer(handler)
})

afterAll(async () => {
  await site.close()
  await bare.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const overlayPage = (app: App, name: string): Page | undefined => app.windows().find((w) => w.url().includes(`overlay=${name}`))
const shown = async (app: App, name: string): Promise<boolean> => await popoverShown(app, `overlay=${name}`)

async function waitShown (app: App, name: string): Promise<Page> {
  expect(await waitFor(async () => await shown(app, name)), `${name} shows`).toBe(true)
  expect(await waitFor(() => overlayPage(app, name) !== undefined)).toBe(true)
  const page = overlayPage(app, name) as Page
  await page.waitForSelector('.listbox-item')
  return page
}

/** The tab's page at `url`, feeling the keyboard come and go as it does for a person. */
async function visitFocused (app: App, chrome: Page, url: string): Promise<Page> {
  const view = await visit(app, chrome, url)
  await useRealFocus(app, view)
  return view
}

/** An answer that closes the overlay ends its page while the click is still being reported: that is the answer arriving, not a failure. */
const closing = async (action: Promise<unknown>): Promise<void> => { await action.catch((error: unknown) => { if (!/closed|detached|destroyed/i.test(String(error))) throw error }) }

const titles = async (overlay: Page): Promise<string[]> => await overlay.locator('.listbox-item .item-title').allTextContents()

/** Saves `user` and `pass` for the site by signing in and answering the prompt. */
async function saveLogin (app: App, chrome: Page, origin: string, user: string, pass: string): Promise<void> {
  const view = await visitFocused(app, chrome, `${origin}/login`)
  await view.click('#user')
  await view.fill('#user', user)
  await view.fill('#pass', pass)
  await view.click('#go')
  await view.waitForSelector('#ok')
  expect(await waitFor(async () => await shown(app, 'password-save'))).toBe(true)
  const prompt = overlayPage(app, 'password-save') as Page
  await prompt.waitForSelector('.btn.primary')
  await closing(prompt.click('.btn.primary'))
  expect(await waitFor(async () => !(await shown(app, 'password-save')))).toBe(true)
}

/** The page's own box ends with the keyboard, and the chooser has gone and stays gone. */
async function expectAnswered (app: App, view: Page, name: string): Promise<void> {
  expect(await waitFor(async () => !(await shown(app, name))), `${name} closes`).toBe(true)
  await delay(ABSENCE_SETTLE_MS)
  expect(await shown(app, 'password-suggest'), 'the chooser does not come back').toBe(false)
  expect(await shown(app, 'password-fill'), 'the chooser does not come back').toBe(false)
  expect(await webContentsFocused(app, view.url()), 'the page has the keyboard').toBe(true)
}

/** Opens the strong-password row of `path` under the focused box and presses it. */
async function pressStrongUnderBox (app: App, chrome: Page, origin: string, path: string, boxes: string[]): Promise<Page> {
  const view = await visitFocused(app, chrome, `${origin}${path}`)
  await view.click('#new1')
  const suggest = await waitShown(app, 'password-suggest')
  const rows = await titles(suggest)
  expect(rows[0]).toBe('Use a strong password')
  const generated = (await suggest.locator('.listbox-item .pf-code').first().textContent()) ?? ''
  expect(generated).toHaveLength(20)
  await delay(PAST_EARLY_CLICK_MS)
  await closing(pressOn(app, suggest, '.listbox-item:first-child'))
  for (const box of boxes) expect(await waitFor(async () => (await view.inputValue(box)) === generated), `${box} holds the generated password`).toBe(true)
  await expectAnswered(app, view, 'password-suggest')
  return view
}

it.skipIf(!underVirtualDisplay())('fills the page when a row of the popup under a box is pressed', async () => {
  const { app, chrome } = await launchShell({ env: SEAM })
  try {
    // A sign-up form with no saved login: the strong password goes into both of its password boxes.
    await pressStrongUnderBox(app, chrome, bare.origin, '/signup', ['#new1', '#new2'])

    // One password box and no <form>: filled, and the page hears the events a typed value fires.
    const bareView = await pressStrongUnderBox(app, chrome, bare.origin, '/signup-bare', ['#new1'])
    expect(await bareView.textContent('#seen')).toBe(await bareView.inputValue('#new1'))

    // A press on the list that is not on a row is not a choice: the list stays up, and a click elsewhere in the page
    // still closes it.
    const early = await visitFocused(app, chrome, `${bare.origin}/signup`)
    await early.click('#new1')
    const waiting = await waitShown(app, 'password-suggest')
    await closing(pressOn(app, waiting, '.pf', { position: { x: 2, y: 2 } }))
    await delay(ABSENCE_SETTLE_MS)
    expect(await shown(app, 'password-suggest'), 'the list stays up under the box').toBe(true)
    expect(await early.inputValue('#new1')).toBe('')
    await early.mouse.click(700, 400)
    expect(await waitFor(async () => !(await shown(app, 'password-suggest'))), 'a click elsewhere in the page closes it').toBe(true)

    // A saved login: its row fills the account and its password.
    await saveLogin(app, chrome, site.origin, 'ada', 'pw-one')
    const login = await visitFocused(app, chrome, `${site.origin}/login`)
    await login.click('#user')
    const suggest = await waitShown(app, 'password-suggest')
    expect(await titles(suggest)).toEqual(['ada'])
    await delay(PAST_EARLY_CLICK_MS)
    await closing(pressOn(app, suggest, '.listbox-item'))
    expect(await waitFor(async () => (await login.inputValue('#pass')) === 'pw-one')).toBe(true)
    expect(await login.inputValue('#user')).toBe('ada')
    await expectAnswered(app, login, 'password-suggest')

    // A sign-up form on a site that has a login: the strong password leads, and the login row below it works too.
    await pressStrongUnderBox(app, chrome, site.origin, '/signup', ['#new1', '#new2'])
    const signUp = await visitFocused(app, chrome, `${site.origin}/signup`)
    await signUp.click('#new1')
    const both = await waitShown(app, 'password-suggest')
    expect(await titles(both)).toEqual(['Use a strong password', 'ada'])
    await delay(PAST_EARLY_CLICK_MS)
    await closing(pressOn(app, both, '.listbox-item:nth-child(2)'))
    expect(await waitFor(async () => (await signUp.inputValue('#new1')) === 'pw-one')).toBe(true)
    expect(await signUp.inputValue('#user')).toBe('ada')
    await expectAnswered(app, signUp, 'password-suggest')

    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(!underVirtualDisplay())('fills the page when a row of the popup under the password button is pressed', async () => {
  const { app, chrome } = await launchShell({ env: SEAM })
  try {
    // The strong password of a sign-up form, chosen from the button's popup with the pointer.
    const signUp = await visitFocused(app, chrome, `${bare.origin}/signup`)
    await signUp.click('#new1')
    expect(await waitFor(async () => await chrome.evaluate(() => { const key = document.querySelector<HTMLElement>('#password-key'); return key !== null && !key.hidden }))).toBe(true)
    await chrome.click('#password-key')
    const strong = await waitShown(app, 'password-fill')
    expect((await titles(strong))[0]).toBe('Use a strong password')
    const generated = (await strong.locator('.listbox-item .pf-code').first().textContent()) ?? ''
    await closing(pressOn(app, strong, '.listbox-item:first-child'))
    expect(await waitFor(async () => (await signUp.inputValue('#new1')) === generated)).toBe(true)
    expect(await signUp.inputValue('#new2')).toBe(generated)
    await expectAnswered(app, signUp, 'password-fill')

    // A saved login, chosen the same way.
    await saveLogin(app, chrome, site.origin, 'ada', 'pw-one')
    const login = await visitFocused(app, chrome, `${site.origin}/login`)
    expect(await waitFor(async () => await chrome.evaluate(() => { const key = document.querySelector<HTMLElement>('#password-key'); return key !== null && !key.hidden }))).toBe(true)
    await chrome.click('#password-key')
    const chooser = await waitShown(app, 'password-fill')
    expect(await titles(chooser)).toEqual(['ada'])
    await closing(pressOn(app, chooser, '.listbox-item'))
    expect(await waitFor(async () => (await login.inputValue('#pass')) === 'pw-one')).toBe(true)
    expect(await login.inputValue('#user')).toBe('ada')
    await expectAnswered(app, login, 'password-fill')

    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
