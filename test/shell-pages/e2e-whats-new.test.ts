// What's new: the first start of a newer version opens the About page's What's new tab once, a new profile and a
// repeat start do not, and Settings > About links to the same tab. The notes and the running version come from
// ORIVON_TEST_RELEASE_NOTES (a test build only); the profile's state is seeded inside this file, not in the shared seeds.
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, profileDirOf } from '../support/launch-electron.mjs'
import { delay, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

const TEST_TIMEOUT_MS = 90_000
const SHOTS_DIR = process.env['ORIVON_UI_SHOTS_DIR']

const NOTES = JSON.stringify({
  version: '0.2.0',
  sections: [
    { heading: 'Added', items: ['**Look for updates**: asks once a day and installs nothing.', '**Secure DNS** has a `Quad9` fallback.'] },
    { heading: 'Fixed', items: ['Tabs no longer jump when a page loads.'] }
  ]
})

const seedIntro = (state: object) => async (dir: string): Promise<void> => {
  await writeFile(join(dir, 'intro.json'), JSON.stringify(state), 'utf8')
}

async function launch (seed?: (dir: string) => Promise<void>, notes: string | null = NOTES, reuseProfile?: string): Promise<ElectronApplication> {
  return await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: notes === null ? {} : { ORIVON_TEST_RELEASE_NOTES: notes },
    ...(seed === undefined ? {} : { seedProfile: seed }),
    ...(reuseProfile === undefined ? {} : { reuseProfile })
  })
}

const newsPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url() === 'orivon://about/whats-new' && !w.isClosed())
const introFile = async (app: ElectronApplication): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(profileDirOf(app) ?? '', 'intro.json'), 'utf8')) as Record<string, unknown>

async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await delay(400)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

it('opens What is new once on the first start of a newer version, and not again on the next start', async () => {
  const first = await launch(seedIntro({ seen: true, lastRunVersion: '0.1.0' }))
  let second: ElectronApplication | undefined
  try {
    expect(await waitFor(() => newsPage(first) !== undefined)).toBe(true)
    const page = newsPage(first) as Page
    await page.waitForSelector('.note')
    expect(await page.locator('.group-label').allTextContents()).toEqual(['Added', 'Fixed'])
    expect(await page.locator('.notes-lead').textContent()).toBe('What changed in version 0.2.0')
    expect(await page.locator('.note strong').first().textContent()).toBe('Look for updates')
    expect(await page.locator('.note code').textContent()).toBe('Quad9')
    expect(await page.getByRole('tab', { name: 'What\'s new' }).getAttribute('aria-selected')).toBe('true')
    await shoot(page, 'whats-new')

    expect(await waitFor(async () => (await introFile(first))['lastRunVersion'] === '0.2.0')).toBe(true)
    expect((await introFile(first))['seen']).toBe(true)

    const profile = profileDirOf(first) as string
    await closeElectron(first, { keepProfile: true })
    second = await launch(undefined, NOTES, profile)
    expect(await waitFor(() => { try { findChrome(second as ElectronApplication); return true } catch { return false } })).toBe(true)
    await delay(1500)
    expect(newsPage(second)).toBeUndefined()
  } finally {
    await closeElectron(first)
    if (second !== undefined) await closeElectron(second)
  }
}, TEST_TIMEOUT_MS)

it('opens nothing on a new profile, and records the version for the next start', async () => {
  const app = await launch()
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    expect(await waitFor(async () => (await introFile(app).catch(() => ({})))['lastRunVersion'] === '0.2.0')).toBe(true)
    expect(newsPage(app)).toBeUndefined()
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens nothing on a downgrade or for a version with no notes, and leaves the remembered version alone after a downgrade', async () => {
  const down = await launch(seedIntro({ seen: true, lastRunVersion: '0.3.0' }))
  try {
    expect(await waitFor(() => { try { findChrome(down); return true } catch { return false } })).toBe(true)
    await delay(1500)
    expect(newsPage(down)).toBeUndefined()
    expect((await introFile(down))['lastRunVersion']).toBe('0.3.0')
  } finally {
    await closeElectron(down)
  }
  const bare = await launch(seedIntro({ seen: true, lastRunVersion: '0.1.0' }), JSON.stringify({ version: '0.2.0', sections: [] }))
  try {
    expect(await waitFor(() => { try { findChrome(bare); return true } catch { return false } })).toBe(true)
    expect(await waitFor(async () => (await introFile(bare))['lastRunVersion'] === '0.2.0')).toBe(true)
    expect(newsPage(bare)).toBeUndefined()
  } finally {
    await closeElectron(bare)
  }
}, TEST_TIMEOUT_MS)

it('is reached from Settings > About, and says so when the build has no list of changes', async () => {
  const app = await launch(undefined, null)
  try {
    const chrome = findChrome(app)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/about') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('.layout')
    await settings.getByRole('button', { name: 'Show what\'s new' }).click()
    expect(await waitFor(() => newsPage(app) !== undefined)).toBe(true)
    const page = newsPage(app) as Page
    await page.waitForSelector('.banner')
    expect(await page.locator('.banner').textContent()).toContain('has no list of changes')
    await shoot(page, 'whats-new-empty')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
