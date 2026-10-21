// A person who set up their own proxy before each site could pick its tunnel keeps every login. The websites that went
// through the proxy had their storage in the one tunnel profile; the first start after the change moves that folder to the
// proxy profile before any session opens it. Two launches on one profile: the first writes a cookie in the tunnel
// profile, a routes file in the old shape is put beside it, the second reads the cookie back where it now belongs. A
// person who had chosen Nym is left exactly as they were.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'

const SITE = 'https://migrated.example'
afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

async function cookieIn (app: ElectronApplication, partition: string): Promise<string[]> {
  return await app.evaluate(async ({ session }, name) => {
    const found = await session.fromPartition(name).cookies.get({ url: 'https://migrated.example' })
    return found.map((cookie) => `${cookie.name}=${cookie.value}`)
  }, partition)
}

async function writeCookie (app: ElectronApplication, partition: string): Promise<void> {
  await app.evaluate(async ({ session }, name) => {
    const target = session.fromPartition(name)
    await target.cookies.set({ url: 'https://migrated.example', name: 'sid', value: 'kept', expirationDate: Math.floor(Date.now() / 1000) + 86_400 })
    await target.cookies.flushStore()
  }, partition)
}

/** Two launches on one profile: the first writes the cookie, the old-shaped routes file is put down, the second is returned. */
async function relaunched (settings: Record<string, unknown>): Promise<{ app: ElectronApplication, profile: string }> {
  const first = await launchShell({ seedProfile: (dir) => { writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: settings })) } })
  const profile = profileDirOf(first.app)
  if (profile === undefined) throw new Error('the launcher did not report a profile directory')
  await writeCookie(first.app, 'persist:tunnel-profile')
  await closeElectron(first.app, { keepProfile: true })
  writeFileSync(join(profile, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, origins: [SITE], off: [], apart: [SITE], apartDirect: [] }))
  const second = await launchShell({ reuseProfile: profile })
  return { app: second.app, profile }
}

it('moves the tunnel profile\'s storage to the proxy profile when the proxy was the tunnel, so the cookie is still there', async () => {
  const { app, profile } = await relaunched({ 'network.route.proxy': '127.0.0.1:9' })
  try {
    expect(await cookieIn(app, 'persist:proxy-profile'), 'the cookie is read from the proxy profile').toEqual(['sid=kept'])
    expect(await cookieIn(app, 'persist:tunnel-profile'), 'and Nym\'s profile starts empty').toEqual([])
    const routes = JSON.parse(readFileSync(join(profile, 'routes.json'), 'utf8')) as Record<string, unknown>
    expect(routes).toMatchObject({ version: 1, kinds: 1, origins: [SITE], via: { [SITE]: 'socks5' }, apart: [], apartProxy: [SITE] })
  } finally {
    await closeElectron(app)
  }
}, 4 * QA_TEST_TIMEOUT_MS)

it('leaves the tunnel profile where it was when Nym was the tunnel, and marks the routes file', async () => {
  const { app, profile } = await relaunched({})
  try {
    expect(await cookieIn(app, 'persist:tunnel-profile'), 'the cookie stays in Nym\'s profile').toEqual(['sid=kept'])
    expect(await cookieIn(app, 'persist:proxy-profile'), 'the proxy profile starts empty').toEqual([])
    const routes = JSON.parse(readFileSync(join(profile, 'routes.json'), 'utf8')) as Record<string, unknown>
    expect(routes).toMatchObject({ version: 1, kinds: 1, origins: [SITE], via: {}, apart: [SITE], apartProxy: [] })
  } finally {
    await closeElectron(app)
  }
}, 4 * QA_TEST_TIMEOUT_MS)
