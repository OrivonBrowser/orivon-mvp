// Settings > Passwords in the running shell. With the test keyring (a reversible stand-in the test build offers
// when ORIVON_TEST_PASSWORD_KEYRING=1) a seeded `passwords.json` is listed, searched, shown after two clicks and
// hidden again, copied, deleted, imported from and exported to CSV, and a password can be generated. Without it, as a
// machine with no system keyring is, the page says nothing is kept and writes no file; a private window says the
// same in its own words. Every native dialog is stubbed.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-passwords-page.test.ts
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createFakeKeyring } from '../src/main/passwords/dev-password-storage.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from './launch-electron.mjs'
import { delay, findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'

const SHOTS = process.env['ORIVON_SHOTS_DIR']
const TEST_TIMEOUT_MS = 120_000
const SEAM = { ORIVON_TEST_PASSWORD_KEYRING: '1' }
const SHOP = 'https://shop.example'
const MAIL = 'https://mail.example'
let scratch = ''

beforeAll(async () => { scratch = await mkdtemp(join(tmpdir(), 'orivon-passwords-e2e-')) })
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** A `passwords.json` whose passwords are sealed with the test keyring, as the running app would seal them. */
async function seedPasswords (dir: string): Promise<void> {
  const keyring = createFakeKeyring()
  const seal = async (password: string): Promise<string> => (await keyring.encryptStringAsync(password)).toString('base64')
  const login = async (id: string, origin: string, username: string, password: string): Promise<object> =>
    ({ id, origin, username, secret: await seal(password), created: 1_700_000_000_000, used: 0 })
  await writeFile(join(dir, 'passwords.json'), JSON.stringify({
    version: 1,
    logins: [await login('l1', SHOP, 'ada', 'correct-horse-7'), await login('l2', MAIL, 'grace', 'battery-staple-9'), await login('l3', 'http://127.0.0.1:8080', '', 'plain-http-pw')],
    never: ['https://never.example']
  }))
}

async function launched (options: { seed?: boolean, env?: Record<string, string>, args?: string[] } = {}): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...(options.args ?? [])],
    env: options.env ?? {},
    ...(options.seed === true ? { seedProfile: seedPasswords } : {})
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const settingsPage = (app: ElectronApplication, known: readonly Page[]): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://settings') && !known.includes(w))

/** Opens Settings at Passwords through the command the main menu runs; `known` are Settings pages already open. */
async function openPasswords (app: ElectronApplication, chrome: Page, known: readonly Page[] = []): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('passwords.open') })
  expect(await waitFor(() => settingsPage(app, known) !== undefined)).toBe(true)
  const page = settingsPage(app, known) as Page
  await page.waitForSelector('#row-saved-passwords')
  // Until main has answered the list is two grey rows; everything below waits for it.
  await page.waitForSelector('#row-saved-passwords .pw-list:not([aria-busy="true"])')
  return page
}

async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await delay(400)
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
  }
}

const userData = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
const item = (page: Page, text: string): ReturnType<Page['locator']> => page.locator('.pw-item', { hasText: text })
const storedLogins = async (dir: string): Promise<Array<{ username: string, secret: string }>> => JSON.parse(await readFile(join(dir, 'passwords.json'), 'utf8')).logins as Array<{ username: string, secret: string }>

/** Replaces the two native pickers: each answers from a global the test sets right before the click that opens it. */
async function stubDialogs (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const answers = globalThis as unknown as { __openPath?: string, __savePath?: string }
    dialog.showOpenDialog = (async () => answers.__openPath === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [answers.__openPath] }) as unknown as typeof dialog.showOpenDialog
    dialog.showSaveDialog = (async () => answers.__savePath === undefined ? { canceled: true, filePath: '' } : { canceled: false, filePath: answers.__savePath }) as unknown as typeof dialog.showSaveDialog
  })
}

async function answerWith (app: ElectronApplication, key: '__openPath' | '__savePath', path: string): Promise<void> {
  await app.evaluate((_electron, [name, value]) => { (globalThis as unknown as Record<string, string>)[name as string] = value as string }, [key, path])
}

it('lists saved passwords, searches, shows one after two clicks, copies, deletes, moves them as CSV and generates one', async () => {
  const { app, chrome } = await launched({ seed: true, env: SEAM })
  try {
    const dir = await userData(app)
    await stubDialogs(app)
    const page = await openPasswords(app, chrome)
    expect(page.url()).toContain('/passwords')

    // The list: sorted by site, each row named, nothing shown, the banner absent and the toggles live.
    expect(await page.locator('.pw-item .item-title').allTextContents()).toEqual(['http://127.0.0.1:8080', 'mail.example', 'shop.example'])
    await expect(item(page, 'grace').locator('.item-sub').textContent()).resolves.toBe('grace')
    await expect(item(page, '127.0.0.1').locator('.item-sub').textContent()).resolves.toBe('No username')
    expect(await page.locator('.pw-code').count()).toBe(0)
    expect(await page.locator('#row-password-storage').count()).toBe(0)
    expect(await page.locator('#row-passwords-offer-to-save input').isDisabled()).toBe(false)
    expect(await page.locator('#row-passwords-never .pw-never-site').allTextContents()).toEqual(['never.example'])
    await shoot(page, 'passwords-list')

    // Search narrows by site or username and marks the match; Escape in the box clears it.
    const search = page.getByRole('searchbox', { name: 'Search passwords' })
    await search.fill('gra')
    expect(await page.locator('.pw-item').count()).toBe(1)
    expect(await page.locator('.pw-item mark').allTextContents()).toEqual(['gra'])
    await search.fill('nothing like this')
    await expect(page.locator('.pw-list .empty-state').textContent()).resolves.toBe('No passwords match "nothing like this".')
    await shoot(page, 'passwords-no-match')
    await search.press('Escape')
    expect(await page.locator('.pw-item').count()).toBe(3)

    // Two clicks show the exact password; the first only arms. It hides itself after the shortened delay.
    const eye = item(page, 'ada').locator('[data-action="reveal"]')
    await eye.click()
    expect(await eye.getAttribute('aria-pressed')).toBe('mixed')
    expect(await eye.getAttribute('title')).toBe('Click again to show')
    expect(await page.locator('.pw-code').count()).toBe(0)
    await shoot(page, 'passwords-reveal-armed')
    await eye.click()
    await page.waitForSelector('.pw-code')
    expect(await page.locator('.pw-code').textContent()).toBe('correct-horse-7')
    expect(await eye.getAttribute('aria-label')).toBe('Hide password for ada on shop.example')
    await shoot(page, 'passwords-revealed')
    await waitFor(async () => await page.locator('.pw-code').count() === 0, 6000)
    expect(await page.locator('.pw-code').count()).toBe(0)

    // A third click hides it at once, and the whole thing works from the keyboard, which stays on the button.
    await eye.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.pw-code')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-action'))).toBe('reveal')
    await page.keyboard.press('Enter')
    await waitFor(async () => await page.locator('.pw-code').count() === 0)

    // Copy goes through main and says so; the password never shows.
    await item(page, 'grace').locator('[data-action="copy"]').click()
    await page.waitForSelector('.pw-toast .toast')
    expect(await page.locator('.pw-toast .toast').textContent()).toBe('Password copied')
    expect(await page.locator('.pw-code').count()).toBe(0)
    await shoot(page, 'passwords-copied')

    // Delete takes two clicks, and the file loses the entry.
    await item(page, 'grace').locator('[data-action="delete"]').click()
    const armed = item(page, 'grace').locator('.btn.danger.armed')
    expect(await armed.textContent()).toBe('Click again to delete')
    expect(await page.locator('.pw-item').count()).toBe(3)
    await shoot(page, 'passwords-delete-armed')
    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setSize(640, 800) })
    await delay(600)
    await shoot(page, 'passwords-narrow')
    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setSize(1280, 800) })
    await delay(600)
    await armed.click()
    await waitFor(async () => await page.locator('.pw-item').count() === 2)
    expect((await storedLogins(dir)).map((entry) => entry.username).sort()).toEqual(['', 'ada'])
    expect(readFileSync(join(dir, 'passwords.json'), 'utf8')).not.toContain('battery-staple-9')

    // The never-saved list gives a site back.
    await page.locator('#row-passwords-never').getByRole('button', { name: /again/ }).click()
    await waitFor(async () => await page.locator('#row-passwords-never').count() === 0)
    expect(JSON.parse(await readFile(join(dir, 'passwords.json'), 'utf8')).never).toEqual([])

    // A generated password is 20 characters, can be made again and copied.
    await page.getByRole('button', { name: 'Generate', exact: true }).click()
    await page.waitForSelector('.pw-generated')
    const first = await page.locator('.pw-generated').textContent()
    expect(first).toHaveLength(20)
    await page.getByRole('button', { name: 'Again' }).click()
    await waitFor(async () => await page.locator('.pw-generated').textContent() !== first)
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await page.waitForSelector('#row-password-generator .toast')
    await shoot(page, 'passwords-generated')

    // Import: a CSV with a new login, a changed password, an identical one, and two rows that cannot be kept.
    const csvIn = join(scratch, 'in.csv')
    await writeFile(csvIn, ['name,url,username,password,note', `Shop,${SHOP}/login,ada,changed-pw,`, 'Bank,https://bank.example/,"zed, the ""one""",päss,', `Same,http://127.0.0.1:8080,,plain-http-pw,`, 'Phone,android://abc@com.app,x,y,', 'Empty,https://empty.example,x,,'].join('\r\n'))
    await answerWith(app, '__openPath', csvIn)
    await page.getByRole('button', { name: 'Import or export passwords' }).click()
    await shoot(page, 'passwords-tools')
    await page.getByRole('button', { name: 'Import…' }).click()
    await page.waitForSelector('.pw-saved .banner.ok')
    expect(await page.locator('.pw-saved .banner.ok').textContent()).toBe('Imported 2 passwords, 1 of them updated. 1 was already saved. 2 rows were skipped. Dismiss')
    await shoot(page, 'passwords-imported')
    const imported = await storedLogins(dir)
    expect(imported.map((entry) => entry.username).sort()).toEqual(['', 'ada', 'zed, the "one"'])
    await page.locator('.pw-saved .banner .link-btn').click()
    expect(await page.locator('.pw-saved .banner').isHidden()).toBe(true)

    // Export: the first click arms and says the file is not encrypted; the second writes it, readable by its owner alone.
    const csvOut = join(scratch, 'out.csv')
    await answerWith(app, '__savePath', csvOut)
    await page.getByRole('button', { name: 'Export…' }).click()
    expect(await page.locator('.pw-tools .btn.armed').textContent()).toBe('Click again: the file is not encrypted')
    expect(existsSync(csvOut)).toBe(false)
    await shoot(page, 'passwords-export-armed')
    await page.locator('.pw-tools .btn.armed').click()
    await page.waitForSelector('.pw-saved .banner.warn')
    expect(await page.locator('.pw-saved .banner.warn').textContent()).toBe('Exported 3 passwords to a file anyone can read. Delete it when you are done. Dismiss')
    await shoot(page, 'passwords-exported')
    const exported = await readFile(csvOut, 'utf8')
    expect(exported).toBe(['name,url,username,password,note', '127.0.0.1,http://127.0.0.1:8080,,plain-http-pw,', 'bank.example,https://bank.example,"zed, the ""one""",päss,', 'shop.example,https://shop.example,ada,changed-pw,'].join('\r\n') + '\r\n')
    if (process.platform !== 'win32') expect(statSync(csvOut).mode & 0o777).toBe(0o600)

    // The file on disk still holds no password in the clear.
    const onDisk = readFileSync(join(dir, 'passwords.json'), 'utf8')
    for (const secret of ['correct-horse-7', 'changed-pw', 'plain-http-pw', 'päss']) expect(onDisk).not.toContain(secret)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'passwords.json')).mode & 0o777).toBe(0o600)

    // Cancelled dialogs change nothing and say nothing.
    await app.evaluate(() => { delete (globalThis as unknown as { __openPath?: string }).__openPath })
    await page.getByRole('button', { name: 'Import…' }).click()
    await delay(500)
    expect(await page.locator('.pw-saved .banner').isHidden()).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows an empty list when nothing is saved, with the toggles live', async () => {
  const { app, chrome } = await launched({ env: SEAM })
  try {
    const dir = await userData(app)
    const page = await openPasswords(app, chrome)
    await expect(page.locator('.pw-list .empty-state p').textContent()).resolves.toBe('No saved passwords yet. Orivon offers to save one after you sign in to a site.')
    expect(await page.locator('#row-passwords-never').count()).toBe(0)
    expect(await page.locator('#row-password-storage').count()).toBe(0)
    expect(await page.locator('#row-passwords-offer-to-save input').isDisabled()).toBe(false)
    // With nothing saved there is nothing to search; importing is offered where the list would be.
    expect(await page.getByRole('searchbox', { name: 'Search passwords' }).count()).toBe(0)
    expect(await page.locator('.pw-list .empty-state .btn').textContent()).toBe('Import passwords…')
    await shoot(page, 'passwords-empty')
    // Looking at an empty store creates no file.
    expect(existsSync(join(dir, 'passwords.json'))).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('updates an open Passwords page when a password is deleted from another window', async () => {
  const { app, chrome } = await launched({ seed: true, env: SEAM })
  try {
    const first = await openPasswords(app, chrome)
    expect(await first.locator('.pw-item').count()).toBe(3)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('window.new') })
    const chromes = (): Page[] => app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))
    expect(await waitFor(() => chromes().length === 2)).toBe(true)
    const second = await openPasswords(app, chromes().find((candidate) => candidate !== chrome) as Page, [first])
    await item(second, 'mail.example').locator('[data-action="delete"]').click()
    await item(second, 'mail.example').locator('.btn.armed').click()
    await waitFor(async () => await second.locator('.pw-item').count() === 2)
    // Nothing is done on the first page: main pushed the change.
    expect(await waitFor(async () => await first.locator('.pw-item').count() === 2, 6000)).toBe(true)
    expect(await first.locator('.pw-item .item-title').allTextContents()).toEqual(['http://127.0.0.1:8080', 'shop.example'])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says nothing is kept, disables the toggles and writes no file when there is no system keyring', async () => {
  const { app, chrome } = await launched()
  try {
    const dir = await userData(app)
    const page = await openPasswords(app, chrome)
    const banner = page.locator('#row-password-storage .banner.warn')
    await banner.waitFor()
    expect(await banner.textContent()).toBe('Orivon cannot reach a system keyring, so it does not save passwords. Install or unlock GNOME Keyring or KWallet, then restart Orivon.')
    expect(await page.locator('#row-passwords-offer-to-save input').isDisabled()).toBe(true)
    expect(await page.locator('#row-passwords-autofill input').isDisabled()).toBe(true)
    // Nothing to search, so the box is not drawn at all.
    expect(await page.getByRole('searchbox', { name: 'Search passwords' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Import or export passwords' }).isDisabled()).toBe(true)
    await expect(page.locator('.pw-list .empty-state p').textContent()).resolves.toBe('No saved passwords.')
    expect(await page.locator('#row-passwords-offer-to-save input').isChecked()).toBe(false)
    await shoot(page, 'passwords-no-keyring')
    await delay(500)
    expect(existsSync(join(dir, 'passwords.json'))).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says nothing is saved in a private window', async () => {
  const { app, chrome } = await launched({ env: SEAM, args: ['--orivon-private'] })
  try {
    const dir = await userData(app)
    await mkdir(dir, { recursive: true })
    const page = await openPasswords(app, chrome)
    const banner = page.locator('#row-password-storage .banner.info')
    await banner.waitFor()
    expect(await banner.textContent()).toBe('Passwords are not saved or filled in a private window.')
    expect(await page.locator('#row-passwords-autofill input').isDisabled()).toBe(true)
    await shoot(page, 'passwords-private')
    await delay(500)
    expect(existsSync(join(dir, 'passwords.json'))).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
