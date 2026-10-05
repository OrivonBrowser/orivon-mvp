// Profiles and private windows from the person's side: the Profiles page makes,
// renames, recolours and deletes them, the chip beside the menu says which one a
// window is, a profile that is running cannot be deleted, and a private window
// is a process of its own that starts on a directory of its own.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { privatePeer } from './private-peer.js'
import type { PrivatePeer } from './private-peer.js'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'

const leftBehind: string[] = []
const peerPids: number[] = []

afterAll(async () => {
  for (const pid of peerPids) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
  for (const dir of leftBehind) rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 90_000

async function launched (seed?: (dir: string) => void): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], ...(seed === undefined ? {} : { seedProfile: (dir: string) => { seed(dir) } }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))
const pageAt = (app: ElectronApplication, prefix: string): Page | undefined => app.windows().find((w) => w.url().startsWith(prefix))

async function openPage (app: ElectronApplication, chrome: Page, page: string, path = '/'): Promise<Page> {
  await chrome.evaluate(([name, at]) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal(name as string, at as string) }, [page, path] as const)
  expect(await waitFor(() => pageAt(app, `orivon://${page}`) !== undefined)).toBe(true)
  return pageAt(app, `orivon://${page}`) as Page
}

const chip = async (chrome: Page): Promise<{ hidden: boolean, text: string | null, color: string | undefined }> =>
  await evaluateRetrying(chrome, () => { const el = document.querySelector<HTMLElement>('#profile-chip'); return { hidden: el?.hidden ?? true, text: el?.textContent ?? null, color: el?.dataset['color'] } })

it('makes, renames, recolours and deletes a profile, and shows the chip only while there is more than one', async () => {
  const { app, chrome } = await launched()
  try {
    const userData = await userDataOf(app)
    const page = await openPage(app, chrome, 'profiles')
    await page.waitForSelector('.profile')
    expect(await page.locator('.profile').count()).toBe(1)
    // The create row keeps its button on one line, and the field is as tall as the button.
    const height = async (selector: string): Promise<number> => await page.locator(selector).evaluate((el) => el.getBoundingClientRect().height)
    const oneLine = await height('.top .btn')
    expect(await height('.create .btn')).toBe(oneLine)
    expect(await height('.create .text')).toBe(oneLine)
    expect((await chip(chrome)).hidden).toBe(true)
    expect(await page.locator('.profile .status').textContent()).toBe('This window')
    // The default profile cannot be deleted, and this window's cannot either.
    expect(await page.locator('.profile button.danger').isDisabled()).toBe(true)

    await page.fill('input[placeholder="Name of the new profile"]', 'Work')
    await page.locator('.create .swatch[data-color="green"]').click()
    await page.locator('button', { hasText: 'Create profile' }).click()
    expect(await waitFor(async () => await page.locator('.profile').count() === 2)).toBe(true)
    const id = readdirSync(join(userData, 'profiles'))[0] as string
    expect(JSON.parse(readFileSync(join(userData, 'profiles', id, 'profile.json'), 'utf8'))).toMatchObject({ name: 'Work', color: 'green' })
    expect(await waitFor(async () => (await chip(chrome)).hidden === false)).toBe(true)
    expect(await chip(chrome)).toMatchObject({ text: 'Default', color: 'blue' })

    const card = page.locator(`#profile-${id}`)
    await card.locator('input.name').fill('Office')
    await card.locator('input.name').blur()
    await card.locator('.swatch[data-color="red"]').click()
    expect(await waitFor(() => JSON.parse(readFileSync(join(userData, 'profiles', id, 'profile.json'), 'utf8')).color === 'red')).toBe(true)
    expect(JSON.parse(readFileSync(join(userData, 'profiles', id, 'profile.json'), 'utf8'))).toMatchObject({ name: 'Office', color: 'red' })

    await card.locator('button.danger').click()
    // Another process writing the registry while Delete is armed must not disarm it.
    const file = join(userData, 'profiles', id, 'profile.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), color: 'green' }))
    await new Promise((resolve) => setTimeout(resolve, 800))
    await card.locator('button.danger').click()
    expect(await waitFor(async () => await page.locator('.profile').count() === 1)).toBe(true)
    expect(existsSync(join(userData, 'profiles', id))).toBe(false)
    expect(await waitFor(async () => (await chip(chrome)).hidden)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does not offer to delete a profile that is open, and refuses if it is asked', async () => {
  const running = '0123456789ab'
  const { app, chrome } = await launched((dir) => {
    mkdirSync(join(dir, 'profiles', running), { recursive: true })
    writeFileSync(join(dir, 'profiles', running, 'profile.json'), JSON.stringify({ version: 1, name: 'Busy', color: 'orange', created: 1 }))
    // A process that is certainly alive: this one.
    writeFileSync(join(dir, 'profiles', running, '.orivon-running'), JSON.stringify({ pid: process.pid }))
  })
  try {
    const userData = await userDataOf(app)
    const page = await openPage(app, chrome, 'profiles')
    await page.waitForSelector(`#profile-${running}`)
    const card = page.locator(`#profile-${running}`)
    expect(await card.locator('.status').textContent()).toBe('Open')
    expect(await card.locator('button.danger').isDisabled()).toBe(true)
    expect(await card.locator('button', { hasText: 'Show' }).count()).toBe(1)

    const outcome = await page.evaluate(async (id) => await (window as unknown as { orivonInternal: { request: (d: string, c: unknown) => Promise<unknown> } }).orivonInternal.request('profiles', { type: 'remove', id }), running)
    expect(outcome).toEqual({ ok: false, reason: 'running' })
    expect(existsSync(join(userData, 'profiles', running))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('refuses a path, the default profile, and a profile that is not there, from the page', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await openPage(app, chrome, 'profiles')
    await page.waitForSelector('.profile')
    const ask = async (command: object): Promise<unknown> => await page.evaluate(async (c) => await (window as unknown as { orivonInternal: { request: (d: string, c: unknown) => Promise<unknown> } }).orivonInternal.request('profiles', c), command)
    expect(await ask({ type: 'remove', id: 'default' })).toEqual({ ok: false, reason: 'default-profile' })
    expect(await ask({ type: 'remove', id: '../../..' })).toEqual({ ok: false, reason: 'unknown-profile' })
    expect(await ask({ type: 'remove', id: '0123456789ab' })).toEqual({ ok: false, reason: 'unknown-profile' })
    expect(await ask({ type: 'rename', id: '../../..', name: 'x' })).toEqual({ ok: false, reason: 'unknown-profile' })
    expect(await ask({ type: 'create', name: '', color: 'blue' })).toEqual({ ok: false, reason: 'invalid-name' })
    expect(await ask({ type: 'create', name: 'x', color: 'plaid' })).toEqual({ ok: false, reason: 'invalid-color' })
    expect(await ask({ type: 'open', id: '../../..' })).toEqual({ ok: false })
    expect(await ask({ type: 'open', id: 'default' })).toEqual({ ok: false })
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows the profiles in Settings, and leads to the page that manages them', async () => {
  const { app, chrome } = await launched()
  try {
    const settings = await openPage(app, chrome, 'settings', '/profiles')
    await settings.waitForSelector('#row-profile-current')
    expect(await settings.locator('#row-profile-current .value').textContent()).toBe('Default')
    const before = (await tabIds(chrome)).length
    await settings.locator('#row-profile-manage button').click()
    expect(await waitFor(() => pageAt(app, 'orivon://profiles') !== undefined)).toBe(true)
    expect((await tabIds(chrome)).length).toBe(before + 1)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(process.platform !== 'linux')('starts a private window as a process of its own, on a directory of its own that begins with this profile\'s settings', async () => {
  const { app, chrome } = await launched((dir) => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'appearance.theme': 'dark' } }))
    writeFileSync(join(dir, 'bookmarks.json'), '[]')
  })
  try {
    const userData = await userDataOf(app)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('window.newPrivate') })

    // The directory is read in the same poll that finds the process: a process that is still starting
    // or already gone reads as an empty command line, and that must read as "not yet", never as a directory.
    let peer: PrivatePeer | undefined
    expect(await waitFor(() => { peer = privatePeer(userData); return peer !== undefined })).toBe(true)
    const { pids, dir, command } = peer as PrivatePeer
    peerPids.push(...pids)
    leftBehind.push(dir)
    expect(dir.startsWith(join(tmpdir(), 'orivon-private-')), `the private process's command line was: ${command}`).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toMatchObject({ values: { 'appearance.theme': 'dark' } })
    expect(existsSync(join(dir, 'bookmarks.json'))).toBe(false)
    // It is alive: it marks its directory with its own process id once it has started.
    expect(await waitFor(() => existsSync(join(dir, '.orivon-private.json')), 30_000)).toBe(true)

    // The profile that started it goes on unaffected.
    expect((await tabIds(chrome)).length).toBe(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    for (const pid of peerPids) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
    await delay(500)
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
