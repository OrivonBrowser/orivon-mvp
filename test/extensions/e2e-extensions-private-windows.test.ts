// "Run in private windows" end to end, on one profile that is launched three times:
//   1. a normal launch: both marker extensions run on a page, and the details page switch for the one not yet allowed
//      turns on and off and reaches prefs.json; the allowed storage extension writes a chrome.storage.local value;
//   2. a private launch (`--orivon-private`) on the same profile: the allowed extensions run and the one not allowed
//      does not, the storage value of the normal launch is there, the Extensions button shows, the extensions page lists
//      only what runs with its read-only banner and no switch, and a value written here is written in a copy only;
//   3. a normal launch again: the value written in the private launch is not there, and the normal one is.
// Fixtures: test/apps/extensions/content-marker/ (marks the page it runs on; never allowed here) and api-sweep/ (allowed;
// publishes its sweep on the page it runs on, and its page and worker read and write chrome.storage).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-private-windows.test.ts
import { afterAll, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, closeElectron, launchElectron, profileDirOf } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { navigateToFixture } from '../support/e2e-helpers.js'
import { startFixtureServer } from '../support/extensions-fixtures.js'
import { normalizePrefs, parsePrefsFile, serializePrefs } from '../../src/main/extensions/extension-prefs.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 360_000
const SWEEP_NAME = 'Orivon E2E API Sweep'

const extensionsPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://extensions'))

async function launched (options: { args?: string[], seed?: (dir: string) => void, reuseProfile?: string }): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...(options.args ?? [])],
    sandbox: true,
    ...(options.reuseProfile === undefined ? {} : { reuseProfile: options.reuseProfile }),
    ...(options.seed === undefined ? {} : { seedProfile: async (dir: string) => { options.seed?.(dir) } })
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

async function openInternal (app: ElectronApplication, chrome: Page, path?: string): Promise<Page> {
  await chrome.evaluate((where) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('extensions', where) }, path)
  expect(await waitFor(() => extensionsPage(app) !== undefined)).toBe(true)
  return extensionsPage(app) as Page
}

async function markers (view: Page): Promise<{ sweep: boolean, content: boolean }> {
  return await evaluateRetrying(view, () => ({
    sweep: document.documentElement.dataset['orivonSweep'] !== undefined,
    content: document.documentElement.dataset['orivonExtensionMarker'] === 'ran'
  }))
}

async function storageOf (app: ElectronApplication, id: string): Promise<unknown> {
  await waitRecovered(app)
  const page = await openExtensionPage(app, id, 'page.html')
  const reply = await rpc(app, page, 'chrome.storage.local.get', [['kept', 'leak']])
  if (!reply.ok) throw new Error(reply.error)
  return reply.result
}

const buttonShown = async (chrome: Page): Promise<boolean> => await evaluateRetrying(chrome, () => {
  const button = document.getElementById('extensions-menu-btn')
  return button !== null && !button.hidden && button.getBoundingClientRect().width > 0
})

it('[app:extensions-run-in-private-windows] runs an extension in a private window as a copy with its own data, and saves nothing back', async () => {
  const started = await startFixtureServer()
  server = started.server
  const fixtureUrl = `${started.origin}/`
  let notAllowedId = ''
  let storageId = ''
  let profile = ''

  // ---- 1. a normal launch ----
  const first = await launched({
    seed: (dir) => {
      notAllowedId = seedFixture(dir, 'content-marker')
      storageId = seedFixture(dir, 'api-sweep')
      writeFileSync(join(dir, 'extensions', 'prefs.json'), serializePrefs(new Map([[storageId, normalizePrefs({ privateWindows: true })]])))
    }
  })
  try {
    profile = profileDirOf(first.app) as string
    expect(await waitFor(async () => (await first.app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 2)).toBe(true)

    // Both extensions run in a normal window: the one left out below is not a fixture that never runs.
    const view = await navigateToFixture(first.app, fixtureUrl, 'extensions-load-fixture')
    expect(await waitFor(async () => (await markers(view)).content && (await markers(view)).sweep)).toBe(true)

    // The switch on the details page: off until turned on, kept in prefs.json, and off again.
    const details = await openInternal(first.app, first.chrome, `/details?id=${notAllowedId}`)
    const toggle = details.locator('#section-private-windows input[type="checkbox"]')
    await toggle.waitFor()
    expect(await details.locator('#section-private-windows .private-windows-note').textContent()).toBe(
      'It also runs in private windows, starting with a copy of its data from this profile. Nothing it does there is saved back. Orivon cannot stop an extension from recording what you visit in a private window.')
    expect(await toggle.isChecked()).toBe(false)
    const allowed = (): boolean => parsePrefsFile(readFileSync(join(profile, 'extensions', 'prefs.json'), 'utf8')).get(notAllowedId)?.privateWindows === true
    await toggle.click()
    expect(await waitFor(allowed)).toBe(true)
    await details.waitForSelector('#section-private-windows input:checked')
    await details.locator('#section-private-windows input[type="checkbox"]').click()
    expect(await waitFor(() => !allowed())).toBe(true)

    // The storage extension keeps a value.
    await waitRecovered(first.app)
    const page = await openExtensionPage(first.app, storageId, 'page.html')
    expect(await rpc(first.app, page, 'chrome.storage.local.set', [{ kept: 'normal' }])).toEqual({ ok: true, result: null })
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }

  // ---- 2. a private launch on the same profile ----
  const second = await launched({ args: ['--orivon-private'], reuseProfile: profile })
  try {
    const names = async (): Promise<string[]> => (await second.app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().map((extension) => extension.name))).sort()
    expect(await waitFor(async () => (await names()).length === 1)).toBe(true)
    expect(await names()).toEqual([SWEEP_NAME])

    const view = await navigateToFixture(second.app, fixtureUrl, 'extensions-load-fixture')
    expect(await waitFor(async () => (await markers(view)).sweep)).toBe(true)
    expect((await markers(view)).content).toBe(false)

    // Its data was copied in, and what it writes here stays here.
    expect(await storageOf(second.app, storageId)).toEqual({ kept: 'normal' })
    const page = await openExtensionPage(second.app, storageId, 'page.html')
    expect(await rpc(second.app, page, 'chrome.storage.local.set', [{ leak: 'private' }])).toEqual({ ok: true, result: null })

    // The button shows because extensions run here.
    expect(await waitFor(async () => await buttonShown(second.chrome))).toBe(true)

    // The page lists what runs, says the rest is done in a normal window, and offers no switch, no removal and no install.
    const list = await openInternal(second.app, second.chrome)
    await list.waitForSelector('.ext-card')
    expect(await list.locator('.banner.info').textContent()).toBe('Only the extensions you allowed in private windows run here. Change this in a normal window.')
    expect(await list.locator('.ext-name').allTextContents()).toEqual([SWEEP_NAME])
    expect(await list.locator('.ext-card .switch, .ext-card button').count()).toBe(0)
    expect(await list.locator('button', { hasText: 'Install from file' }).count()).toBe(0)
    await list.locator('.ext-card', { has: list.locator('.ext-name', { hasText: SWEEP_NAME }) }).locator('a', { hasText: 'Details' }).click()
    await list.waitForSelector('.d-head')
    expect(await list.locator('#section-private-windows').count()).toBe(0)
    expect(await list.locator('.d-actions .switch, .d-actions button').count()).toBe(0)
  } finally {
    await closeElectron(second.app, { keepProfile: true })
  }

  // ---- 3. a normal launch again ----
  const third = await launched({ reuseProfile: profile })
  try {
    expect(await storageOf(third.app, storageId)).toEqual({ kept: 'normal' })
  } finally {
    await closeElectron(third.app)
  }
}, TEST_TIMEOUT_MS)
