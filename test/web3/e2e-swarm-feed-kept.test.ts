// A `.eth` name on a Swarm feed, visited before, opens in the real shell from the update it was last followed to with a node
// that answers nothing, a newer update the background look then finds is used only from the next page load, and the page being
// read never changes under its reader. Driven through the test seam's endpoints, so nothing leaves the machine.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { activeTabInfo, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startSwarmFixture } from '../apps/swarm-gateway/gateway.mjs'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS * 2 + 120_000

/** A key made for this suite; it signs fixture feed updates and nothing else. */
const FEED_KEY = `0x${'44'.repeat(32)}` as const
const FEED_TOPIC = 'ef'.repeat(32)

const page = (title: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${title}</body>`

/** The index of the feed update the verifier host has kept in its Swarm chunk file in `dir`; undefined while there is none. */
function keptIndex (dir: string): string | undefined {
  try {
    const file = readdirSync(dir).find((name) => /^swarm-chunks-[0-9a-f]{16}\.db$/.test(name))
    if (file === undefined) return undefined
    const database = new DatabaseSync(join(dir, file), { readOnly: true })
    try {
      return (database.prepare('SELECT position FROM feed_update').get() as { position: string } | undefined)?.position
    } finally {
      database.close()
    }
  } catch {
    return undefined
  }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:swarm-url-opens] opens a visited Swarm feed site with a node that answers nothing, and shows a newer update from the next page load only', async () => {
  await runPhase('swarm-feed-kept', async (check) => {
    // The same feed twice: the first node holds the first update only, and the second holds both but answers no chunk until released.
    const first = await startSwarmFixture()
    const second = await startSwarmFixture({ holdChunks: true })
    const one = first.addSite({ 'index.html': page('feed update one') })
    const two = second.addSite({ 'index.html': page('feed update two') })
    const feed = first.addFeed({ privateKey: FEED_KEY, topic: FEED_TOPIC })
    await feed.publish(one)
    const later = second.addFeed({ privateKey: FEED_KEY, topic: FEED_TOPIC })
    expect(later.manifest).toBe(feed.manifest)
    await later.publish(one)
    await later.publish(two)
    const env = (url: string): Record<string, string> => ({
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'kept.eth': `bzz://${feed.manifest}` }),
      ORIVON_TEST_SWARM_ENDPOINTS: url
    })
    let profile = ''
    let verifierDir = ''
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: env(first.url) })
      const running = app
      await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, 'kept.eth')
      const visited = await waitForTab(chrome, { address: 'bzz://kept.eth/', title: 'feed update one' }, 60_000)
      check(`a first visit follows the feed to its only update (${JSON.stringify(visited.info)})`, visited.ok)
      profile = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      verifierDir = join(profile, 'verifier')
      const kept = await waitFor(() => keptIndex(verifierDir) === '0')
      check(`the verifier host kept the update it followed (${String(keptIndex(verifierDir))})`, kept)
      expect(visited.ok && kept).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app, APP_CLOSE_RACE_MS, { keepProfile: true })
      await first.close()
    }

    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: env(second.url), reuseProfile: profile })
      const running = app
      await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, 'kept.eth')
      const reopened = await waitForTab(chrome, { address: 'bzz://kept.eth/', title: 'feed update one' }, 60_000)
      check(`a visited feed site opens from its kept update while the node has answered no chunk (${String(second.answeredChunks())} answered; ${JSON.stringify(reopened.info)})`, reopened.ok && second.answeredChunks() === 0)

      // The look for a newer update is held with the rest of the node's answers: it asks, and waits.
      const asked = await waitFor(() => second.requests.some((path) => path.startsWith('/chunks/')))
      check('the look for a newer update asks the node in the background', asked)
      second.releaseChunks()
      const found = await waitFor(() => keptIndex(verifierDir) === '1', 30_000)
      check(`the newer update is kept once it is found (${String(keptIndex(verifierDir))})`, found)

      // Found, but not shown: the page being read keeps the version it opened with.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      const stillOne = (await activeTabInfo(chrome)).title === 'feed update one'
      check('the page being read still shows the update it opened with', stillOne)

      await clickAddressBarRetrying(chrome, 'kept.eth')
      const next = await waitForTab(chrome, { address: 'bzz://kept.eth/', title: 'feed update two' }, 60_000)
      check(`the next page load shows the newer update (${JSON.stringify(next.info)})`, next.ok)
      expect(reopened.ok && second.answeredChunks() > 0 && found && stillOne && next.ok).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await second.close()
    }
  })
}, TEST_TIMEOUT_MS)
