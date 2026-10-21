// A settings file that is there and cannot be used (here, of a version this build does not read) does not send anything around the tunnel: the whole browser is on it, with
// Nym as the tunnel, Settings says why in one sentence, and the person can turn it off.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-settings-unreadable.test.ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

const SENTENCE = 'This is on because your settings file could not be read, so Orivon does not guess that you wanted your traffic outside the tunnel; turn it off here if you did.'

let app: ElectronApplication
let chrome: Page

beforeAll(async () => {
  const launched = await launchShell({
    // A version this build does not read: the launch's own seeds keep it as it is.
    seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 99, values: {} })) }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openSettings (): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/tunnels') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await settings.waitForSelector('#row-route-everywhere input[type=checkbox]')
  return settings
}

it('[app:tunnel-everywhere-held-by-unreadable-settings] a settings file that cannot be read leaves the whole browser on the tunnel, says why, and can be turned off', async () => {
  const settings = await openSettings()
  expect(await settings.locator('#row-route-everywhere input[type=checkbox]').isChecked(), 'the tunnel is on for the whole browser').toBe(true)
  expect(await app.evaluate(({ session }) => session.defaultSession.resolveProxy('http://example.com/')), 'and the default session is not direct').not.toBe('DIRECT')
  expect(await waitFor(async () => (await settings.locator('#row-route-everywhere').textContent())?.includes(SENTENCE) === true), 'Settings says why in one sentence').toBe(true)

  await settings.locator('#row-route-everywhere input[type=checkbox]').click()
  expect(await waitFor(async () => await app.evaluate(({ session }) => session.defaultSession.resolveProxy('http://example.com/').then((proxy) => proxy === 'DIRECT')))).toBe(true)
  expect((await settings.locator('#row-route-everywhere').textContent())?.includes(SENTENCE), 'the sentence goes once it is off').toBe(false)
  await settings.close()
}, 4 * QA_TEST_TIMEOUT_MS)
