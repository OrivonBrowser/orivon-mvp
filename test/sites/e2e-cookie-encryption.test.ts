// A run from source keeps its cookies as an installed package does: its binary has cookie encryption on
// (scripts/install-electron.mjs sets it, as electron-builder.yml does for a package; ADR-0057). A binary without the
// fuse reads none of the cookies an encrypting one wrote, and every site the profile was signed in to is signed out. Two launches on one profile: the first stores a persistent cookie, the
// second reads it back; between them the row is on disk and its value is not. Run `npm run install:electron` when
// this fails on a checkout whose binary was never flipped.
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses'
import type { ElectronApplication } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const COOKIE = {
  url: 'https://cookie-encryption.test/',
  name: 'orivon-kept-cookie',
  // Unlike anything else in the database, so finding it on disk can only mean it was stored in the clear.
  value: 'plain-value-0b6f3c1e9a7d4b25'
}

it('stores cookies encrypted, as a package does, and reads them back after a restart', async () => {
  const first = await launchShell()
  const profile = profileDirOf(first.app)
  if (profile === undefined) throw new Error('the launcher did not report a profile directory')
  let live: ElectronApplication | undefined = first.app
  try {
    const executable = await first.app.evaluate(() => process.execPath)
    expect((await getCurrentFuseWire(executable))[FuseV1Options.EnableCookieEncryption], 'the cookie-encryption fuse (npm run install:electron sets it)').toBe(49)

    await first.app.evaluate(async ({ session }, cookie) => {
      await session.defaultSession.cookies.set({ ...cookie, expirationDate: Date.now() / 1000 + 3600 })
      await session.defaultSession.cookies.flushStore()
    }, COOKIE)
    live = undefined
    await closeElectron(first.app, { keepProfile: true })

    // Chromium keeps the store in the profile's Network folder on Windows, at the top of the profile elsewhere.
    const store = [join(profile, 'Network', 'Cookies'), join(profile, 'Cookies')].find((path) => existsSync(path))
    if (store === undefined) throw new Error(`no cookie store in ${profile}`)
    const stored = await readFile(store)
    expect(stored.includes(COOKIE.name), 'the cookie row is on disk').toBe(true)
    expect(stored.includes(COOKIE.value), 'the cookie value is stored in the clear').toBe(false)

    const second = await launchShell({ reuseProfile: profile })
    live = second.app
    const values = await second.app.evaluate(async ({ session }, name) =>
      (await session.defaultSession.cookies.get({ name })).map((cookie) => cookie.value), COOKIE.name)
    expect(values).toEqual([COOKIE.value])
  } finally {
    if (live !== undefined) await closeElectron(live)
    await rm(profile, { recursive: true, force: true })
  }
}, QA_TEST_TIMEOUT_MS)
