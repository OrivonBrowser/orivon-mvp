// A person's press on the sign-in chooser: the popup under a focused box and the one under the password button
// each fill the page when a row is pressed, a saved login or the strong password of a sign-up form. A press in a
// real window moves the keyboard to the view under the pointer; Playwright's click does not, so most cases give the
// chooser that move before the click (`pressOn`), and give the page the real focus a person's window has
// (`useRealFocus`). One case presses with the window system's own pointer (`pointerPressOn`), so the page's blur and the
// chooser's focus arrive in whatever order the browser delivers them. The fixture server listens on port 0.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { pressOn, underVirtualDisplay, useRealFocus, webContentsFocused } from '../support/focus-helpers.js'
import { html, launchShell, startServer, visit } from '../support/qa-helpers.js'
import { pointerPressOn } from '../support/native-pointer.js'
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

/** No <form> and no account box: each password box is wrapped in layers of its own, as a framework's field components leave it. */
const wrapped = (hint: string): string => `<!doctype html><title>Create account</title><body style="font:16px sans-serif"><div>
<div><label>Password<div><div><input id="new1" type="password" ${hint} ${FIELD}></div></div></label></div>
<div><label>Confirm password<div><div><input id="new2" type="password" ${hint} ${FIELD}></div></div></label></div></div></body>`
/** The account box and the first password share a step; the confirmation is in a step of its own, one layer further out. */
const SIGN_UP_STEPS = `<!doctype html><title>Create account</title><body style="font:16px sans-serif"><div>
<div><input id="user" type="text" autocomplete="username" ${FIELD}><div><input id="new1" type="password" autocomplete="new-password" ${FIELD}></div></div>
<div><div><input id="new2" type="password" ${FIELD}></div></div></div></body>`
/** The current password, then the new one twice: the generated password belongs in the last two. */
const CHANGE = `<!doctype html><title>Change password</title><body style="font:16px sans-serif"><form method="post" action="/welcome">
<input id="old" type="password" autocomplete="current-password" ${FIELD}>
<input id="new1" type="password" autocomplete="new-password" ${FIELD}>
<input id="new2" type="password" autocomplete="new-password" ${FIELD}></form></body>`

/** A password, its confirmation and a box that is neither, such as a PIN. */
const WITH_PIN = `<!doctype html><title>Create account</title><body style="font:16px sans-serif"><form method="post" action="/welcome">
<input id="new1" type="password" autocomplete="new-password" ${FIELD}><input id="new2" type="password" autocomplete="new-password" ${FIELD}>
<input id="pin" type="password" autocomplete="off" ${FIELD}></form></body>`
/** A login in the page's header beside a sign-up that has no <form> and an account box of its own: the strong password is for the sign-up. */
const HEADER_LOGIN = `<!doctype html><title>Create account</title><body style="font:16px sans-serif"><div id="hdr"><input id="hu" type="text" ${FIELD}><input id="hp" type="password" ${FIELD}></div>
<input id="user" type="text" ${FIELD}><div><input id="new1" type="password" ${FIELD}></div><div><input id="new2" type="password" ${FIELD}></div></body>`

/** The boxes grow over a quarter of a second as they take the focus, as the fields of many sign-up pages do: a box is not where it was first reported by the time the keyboard comes back from a press. */
const GROWING = `<!doctype html><title>Create account</title><style>input{display:block;box-sizing:border-box;margin:12px;width:260px;height:30px;transition:width .25s,height .25s}input:focus{width:320px;height:46px}</style>
<body style="font:16px sans-serif"><form method="post" action="/welcome"><input id="user" type="text" autocomplete="username">
<input id="new1" type="password" autocomplete="new-password"><input id="new2" type="password" autocomplete="new-password"></form></body>`

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
  else if (path === '/wrapped-hinted') html(response, wrapped('autocomplete="new-password"'))
  else if (path === '/wrapped-bare') html(response, wrapped(''))
  else if (path === '/signup-steps') html(response, SIGN_UP_STEPS)
  else if (path === '/change') html(response, CHANGE)
  else if (path === '/growing') html(response, GROWING)
  else if (path === '/with-pin') html(response, WITH_PIN)
  else if (path === '/header-login') html(response, HEADER_LOGIN)
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

/** Who presses: Playwright's click after giving the chooser the keyboard first, or the window system's pointer, which moves the keyboard as a person's press does. */
type Pointer = 'playwright' | 'real'

const clickBox = async (app: App, view: Page, selector: string, pointer: Pointer): Promise<void> => {
  if (pointer === 'real') await pointerPressOn(app, view, selector)
  else await view.click(selector)
}

const pressRow = async (app: App, overlay: Page, selector: string, pointer: Pointer): Promise<void> => {
  await closing(pointer === 'real' ? pointerPressOn(app, overlay, selector) : pressOn(app, overlay, selector))
}

/** Opens the strong-password row of `path` under the focused box and presses it. */
async function pressStrongUnderBox (app: App, chrome: Page, origin: string, path: string, boxes: string[], pointer: Pointer = 'playwright', start = '#new1'): Promise<Page> {
  const view = await visitFocused(app, chrome, `${origin}${path}`)
  await clickBox(app, view, start, pointer)
  const suggest = await waitShown(app, 'password-suggest')
  const rows = await titles(suggest)
  expect(rows[0]).toBe('Use a strong password')
  const generated = (await suggest.locator('.listbox-item .pf-code').first().textContent()) ?? ''
  expect(generated).toHaveLength(20)
  await delay(PAST_EARLY_CLICK_MS)
  await pressRow(app, suggest, '.listbox-item:first-child', pointer)
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

it.skipIf(!underVirtualDisplay())('fills the page when the popup under a box is pressed with the window system\'s pointer', async () => {
  const { app, chrome } = await launchShell({ env: SEAM })
  try {
    await pressStrongUnderBox(app, chrome, bare.origin, '/signup', ['#new1', '#new2'], 'real')
    await pressStrongUnderBox(app, chrome, bare.origin, '/signup-bare', ['#new1'], 'real')

    await saveLogin(app, chrome, site.origin, 'ada', 'pw-one')
    const login = await visitFocused(app, chrome, `${site.origin}/login`)
    await clickBox(app, login, '#user', 'real')
    const suggest = await waitShown(app, 'password-suggest')
    expect(await titles(suggest)).toEqual(['ada'])
    await delay(PAST_EARLY_CLICK_MS)
    await pressRow(app, suggest, '.listbox-item', 'real')
    expect(await waitFor(async () => (await login.inputValue('#pass')) === 'pw-one')).toBe(true)
    expect(await login.inputValue('#user')).toBe('ada')
    await expectAnswered(app, login, 'password-suggest')

    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(!underVirtualDisplay())('fills the page when the box has grown by the time the keyboard comes back from the press', async () => {
  const { app, chrome } = await launchShell({ env: SEAM })
  try {
    await pressStrongUnderBox(app, chrome, bare.origin, '/growing', ['#new1', '#new2'], 'real')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

/** Layouts of a sign-up that has no <form> or puts its boxes at different depths: the strong password goes into the password and its confirmation. */
const LAYOUTS: Array<[string, string]> = [
  ['no form, no account box and nothing the page calls new', '/wrapped-bare'],
  ['no form, both boxes called new', '/wrapped-hinted'],
  ['the account box and the first password in one step, the confirmation in the next', '/signup-steps']
]

for (const [layout, path] of LAYOUTS) {
  it.skipIf(!underVirtualDisplay())(`fills the password and its confirmation: ${layout}`, async () => {
    const { app, chrome } = await launchShell({ env: SEAM })
    try {
      await pressStrongUnderBox(app, chrome, bare.origin, path, ['#new1', '#new2'])
      expect(mainOutput(app)).not.toContain('uncaught exception')
    } finally {
      await closeElectron(app)
    }
  }, TEST_TIMEOUT_MS)
}

it.skipIf(!underVirtualDisplay())('fills the password and its confirmation and nothing past them, whichever of the two the person starts in', async () => {
  const { app, chrome } = await launchShell({ env: SEAM })
  try {
    for (const start of ['#new1', '#new2']) {
      const view = await pressStrongUnderBox(app, chrome, bare.origin, '/with-pin', ['#new1', '#new2'], 'playwright', start)
      expect(await view.inputValue('#pin'), `a press started in ${start} leaves the PIN box`).toBe('')
    }
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(!underVirtualDisplay())('fills the sign-up and leaves a login in the page\'s header', async () => {
  const { app, chrome } = await launchShell({ env: SEAM })
  try {
    for (const start of ['#new1', '#new2']) {
      const view = await pressStrongUnderBox(app, chrome, bare.origin, '/header-login', ['#new1', '#new2'], 'playwright', start)
      expect(await view.inputValue('#hp'), `a press started in ${start} leaves the header's password`).toBe('')
    }
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(!underVirtualDisplay())('fills the new password and its repeat from the password button with nothing focused, and leaves the current one', async () => {
  const { app, chrome } = await launchShell({ env: SEAM })
  try {
    const change = await visitFocused(app, chrome, `${bare.origin}/change`)
    expect(await waitFor(async () => await chrome.evaluate(() => { const key = document.querySelector<HTMLElement>('#password-key'); return key !== null && !key.hidden }))).toBe(true)
    await chrome.click('#password-key')
    const strong = await waitShown(app, 'password-fill')
    const generated = (await strong.locator('.listbox-item .pf-code').first().textContent()) ?? ''
    await closing(pressOn(app, strong, '.listbox-item:first-child'))
    for (const box of ['#new1', '#new2']) expect(await waitFor(async () => (await change.inputValue(box)) === generated), `${box} holds the generated password`).toBe(true)
    expect(await change.inputValue('#old')).toBe('')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(!underVirtualDisplay())('fills the new password and its repeat of a change-password form, and leaves the current one', async () => {
  const { app, chrome } = await launchShell({ env: SEAM })
  try {
    const change = await visitFocused(app, chrome, `${bare.origin}/change`)
    await change.fill('#old', 'old-secret')
    await change.click('#new1')
    const suggest = await waitShown(app, 'password-suggest')
    const generated = (await suggest.locator('.listbox-item .pf-code').first().textContent()) ?? ''
    await delay(PAST_EARLY_CLICK_MS)
    await closing(pressOn(app, suggest, '.listbox-item:first-child'))
    for (const box of ['#new1', '#new2']) expect(await waitFor(async () => (await change.inputValue(box)) === generated), `${box} holds the generated password`).toBe(true)
    expect(await change.inputValue('#old')).toBe('old-secret')
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
