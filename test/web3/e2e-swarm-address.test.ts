// `bzz://` addresses and `.eth` names on Swarm, in the real shell. The
// address bar shows the address; the page runs at the https origin serving it
// (`https://<cid>.bzz.orivon`), as a secure context, from chunks the verifier
// checked. Driven through the test seam's endpoints, so nothing leaves the
// machine. A `.eth` name is shown under the scheme of the network its content
// is on: `bzz://` for Swarm, `ipfs://` for IPFS. On a first visit the loading
// screen and the address bar never name a network the name is not on.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { referenceCid } from '../../src/protocols/swarm/reference.js'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { activeTabInfo, evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { overlayShown, waitOverlay } from '../support/auth-support.js'
import { QA_ROOT } from '../support/qa-evidence.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startSwarmFixture } from '../apps/swarm-gateway/gateway.mjs'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const BLOCK_DELAY_MS = 800
const LOAD_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000 + 2 * LOAD_TIMEOUT_MS

/** A key made for this suite; it signs fixture feed updates and nothing else. */
const FEED_KEY = `0x${'22'.repeat(32)}` as const
const FEED_TOPIC = 'cd'.repeat(32)

const page = (title: string, body = title): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`

interface LoadingWatch { readonly screens: string[], readonly bars: string[], readonly titles: string[], readonly loaded: boolean }

/** Reads the loading screen and the address bar every poll until the page's title shows, so a wrong network named for even a moment is seen. `shownBefore` is the address of the page being left. */
async function watchLoading (running: Awaited<ReturnType<typeof launchElectron>>, chrome: Parameters<typeof activeTabInfo>[0], loadedTitle: string, shownBefore: string, whenNamed?: { readonly address: string, readonly then: (screen: Page) => Promise<void> }): Promise<LoadingWatch> {
  const screen = await waitOverlay(running, 'loading-screen')
  const screens: string[] = []
  const bars: string[] = []
  const titles: string[] = []
  let named = false
  const loaded = await waitFor(async () => {
    if (await overlayShown(running, 'loading-screen')) {
      const address = await screen.locator('.loading-screen-address').getAttribute('title', { timeout: 500 }).catch(() => null)
      const title = await screen.locator('.loading-screen-title').textContent({ timeout: 500 }).catch(() => null)
      if (address !== null) screens.push(address)
      if (address !== null && address === whenNamed?.address && !named) { named = true; await whenNamed.then(screen) }
      if (title !== null) titles.push(title)
    }
    const info = await activeTabInfo(chrome)
    // The page being left keeps its address in the bar until the new one commits; only a different address is about the new page.
    if (info.address !== shownBefore) bars.push(String(info.address))
    return info.title === loadedTitle
  }, LOAD_TIMEOUT_MS)
  return { screens, bars, titles, loaded }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:swarm-url-opens] [app:eth-name-shown-by-network] loads a typed bzz:// address, follows a bzz:// link, opens a .eth name through a feed at its newest update shown as bzz://, keeps a .eth name on IPFS shown as ipfs://, never names the wrong network on a first visit, and refuses a tampered chunk', async () => {
  await runPhase('swarm-address', async (check) => {
    const node = await startSwarmFixture()
    const evilNode = await startSwarmFixture({ tamperAll: true })
    const linked = node.addSite({ 'index.html': page('linked swarm fixture') })
    const site = node.addSite({
      'index.html': `<!doctype html><meta charset="utf-8"><title>swarm fixture</title><body><a id="next" href="bzz://${linked}/">next</a><script src="app.js"></script></body>`,
      'app.js': 'document.body.dataset.app = "ran"'
    })
    const feed = node.addFeed({ privateKey: FEED_KEY, topic: FEED_TOPIC })
    await feed.publish(node.addSite({ 'index.html': page('swarm update one') }))
    await feed.publish(node.addSite({ 'index.html': page('swarm update two') }))
    const ipfsGateway = await startFixtureGateway({ onipfs: { 'index.html': page('ipfs name fixture') }, slowipfs: { 'index.html': page('slow ipfs name') } }, { blockDelayMs: BLOCK_DELAY_MS })
    // A node that answers no chunk until released, and a gateway that answers each block late, keep the loading screen up long enough to read it.
    const slowNode = await startSwarmFixture({ holdChunks: true })
    const slow = slowNode.addSite({ 'index.html': page('slow swarm name') })
    const broken = evilNode.addSite({ 'index.html': page('tampered swarm fixture') })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'feed.eth': `bzz://${feed.manifest}`, 'broken.eth': `bzz://${broken}`, 'onipfs.eth': `ipfs://${ipfsGateway.roots['onipfs']!}`, 'slow.eth': `bzz://${slow}`, 'slowipfs.eth': `ipfs://${ipfsGateway.roots['slowipfs']!}` }),
          ORIVON_TEST_IPFS_GATEWAYS: ipfsGateway.url,
          ORIVON_TEST_SWARM_ENDPOINTS: `${node.url},${evilNode.url},${slowNode.url}`
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      // 64 hex as typed: the address resolves to its one canonical spelling, a CID that fits a host label.
      const cid = referenceCid(site)
      await clickAddressBarRetrying(chrome, `bzz://${site.toUpperCase()}`)
      const typed = await waitForTab(chrome, { address: `bzz://${cid}/`, title: 'swarm fixture' })
      check(`a typed bzz:// address is shown as its canonical address (${JSON.stringify(typed.info)})`, typed.ok)
      const view = findViewShowing(app, chrome, `https://${cid}.bzz.orivon/`)
      check('the page runs at the https origin serving it', view !== undefined)
      if (view === undefined) throw new Error('no view shows the served origin')
      const readPage = async (): Promise<{ origin: string, secure: boolean, ran: string | null }> => await evaluateRetrying(view, () => ({ origin: location.origin, secure: window.isSecureContext, ran: document.body.dataset['app'] ?? null }))
      let loaded = await readPage()
      await waitFor(async () => { loaded = await readPage(); return loaded.ran === 'ran' })
      check(`it is a secure context, and its verified script ran (${JSON.stringify(loaded)})`, loaded.secure && loaded.ran === 'ran')
      check(`the node was asked for chunks (${String(node.requests.length)} requests)`, node.requests.some((r) => r.startsWith('/chunks/')))

      await view.click('#next')
      const followed = await waitForTab(chrome, { address: `bzz://${referenceCid(linked)}/`, title: 'linked swarm fixture' })
      check(`a bzz:// link in the page loads in the tab, shown as its address (${JSON.stringify(followed.info)})`, followed.ok)

      // The node answers 501 to /feeds: the newest update is found by asking for chunks alone.
      await clickAddressBarRetrying(chrome, 'feed.eth')
      const fed = await waitForTab(chrome, { address: 'bzz://feed.eth/', title: 'swarm update two' })
      check(`a .eth name on a Swarm feed shows its newest update, shown as bzz://feed.eth/ (${JSON.stringify(fed.info)})`, fed.ok)
      check('the page runs at the name\'s own origin', findViewShowing(app, chrome, 'https://feed.eth/') !== undefined)

      await clickAddressBarRetrying(chrome, 'onipfs.eth')
      const onIpfs = await waitForTab(chrome, { address: 'ipfs://onipfs.eth/', title: 'ipfs name fixture' })
      check(`a .eth name on IPFS stays shown as ipfs://onipfs.eth/ (${JSON.stringify(onIpfs.info)})`, onIpfs.ok)

      // A first visit: the screen and the address bar name Swarm as soon as the records resolve, and never IPFS.
      await clickAddressBarRetrying(chrome, 'slow.eth')
      let answeredWhenNamed = -1
      const slowSwarm = await watchLoading(running, chrome, 'slow swarm name', 'ipfs://onipfs.eth/', {
        address: 'bzz://slow.eth/',
        then: async (screen) => {
          answeredWhenNamed = slowNode.answeredChunks()
          mkdirSync(join(QA_ROOT, 'latest'), { recursive: true })
          await screen.screenshot({ path: join(QA_ROOT, 'latest', 'swarm-name-loading-screen-light.png') })
          slowNode.releaseChunks()
        }
      })
      const swarmNeverIpfs = [...slowSwarm.screens, ...slowSwarm.bars].every((shown) => !shown.startsWith('ipfs://'))
      check(`a .eth name on Swarm never reads ipfs:// while it loads (${JSON.stringify(slowSwarm)})`, slowSwarm.loaded && swarmNeverIpfs)
      check(`its loading screen reads bzz://slow.eth/ and names Swarm before the node has answered a single chunk (${String(answeredWhenNamed)} answered)`, answeredWhenNamed === 0 && slowSwarm.titles.includes('Loading from Swarm'))
      check('its address bar reads bzz://slow.eth/ once the page is ready', slowSwarm.bars.at(-1) === 'bzz://slow.eth/')

      await clickAddressBarRetrying(chrome, 'slowipfs.eth')
      const slowIpfs = await watchLoading(running, chrome, 'slow ipfs name', 'bzz://slow.eth/')
      const ipfsNeverSwarm = [...slowIpfs.screens, ...slowIpfs.bars].every((shown) => !shown.startsWith('bzz://'))
      check(`a .eth name on IPFS never reads bzz:// while it loads (${JSON.stringify(slowIpfs)})`, slowIpfs.loaded && ipfsNeverSwarm)
      check('its loading screen reads ipfs://slowipfs.eth/ and names IPFS while it is still up', slowIpfs.screens.includes('ipfs://slowipfs.eth/') && slowIpfs.titles.includes('Loading from IPFS'))

      await clickAddressBarRetrying(chrome, 'bzz://feed.eth/')
      const again = await waitForTab(chrome, { address: 'bzz://feed.eth/', title: 'swarm update two' })
      check(`the address a .eth name is shown as loads that name again (${JSON.stringify(again.info)})`, again.ok)

      await clickAddressBarRetrying(chrome, 'broken.eth')
      const refused = await waitForTab(chrome, { title: 'Cannot verify this site' })
      check(`a node that serves only tampered chunks gives the cannot-verify page (${JSON.stringify(refused.info)})`, refused.ok)

      expect(typed.ok && followed.ok && fed.ok && onIpfs.ok && again.ok && refused.ok).toBe(true)
      expect(slowSwarm.loaded && swarmNeverIpfs && answeredWhenNamed === 0, JSON.stringify({ answeredWhenNamed, ...slowSwarm })).toBe(true)
      expect(slowIpfs.loaded && ipfsNeverSwarm && slowIpfs.screens.includes('ipfs://slowipfs.eth/'), JSON.stringify(slowIpfs)).toBe(true)
      expect(loaded).toEqual({ origin: `https://${cid}.bzz.orivon`, secure: true, ran: 'ran' })
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await node.close()
      await evilNode.close()
      await slowNode.close()
      await ipfsGateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
