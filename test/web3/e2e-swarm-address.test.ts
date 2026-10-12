// `bzz://` addresses and `.eth` names on Swarm, in the real shell. The
// address bar shows the address; the page runs at the https origin serving it
// (`https://<cid>.bzz.orivon`), as a secure context, from chunks the verifier
// checked. Driven through the test seam's endpoints, so nothing leaves the
// machine. A `.eth` name is shown under the scheme of the network its content
// is on: `bzz://` for Swarm, `ipfs://` for IPFS.
import { afterAll, expect, it } from 'vitest'
import { referenceCid } from '../../src/protocols/swarm/reference.js'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startSwarmFixture } from '../apps/swarm-gateway/gateway.mjs'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000

/** A key made for this suite; it signs fixture feed updates and nothing else. */
const FEED_KEY = `0x${'22'.repeat(32)}` as const
const FEED_TOPIC = 'cd'.repeat(32)

const page = (title: string, body = title): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:swarm-url-opens] [app:eth-name-shown-by-network] loads a typed bzz:// address, follows a bzz:// link, opens a .eth name through a feed at its newest update shown as bzz://, keeps a .eth name on IPFS shown as ipfs://, and refuses a tampered chunk', async () => {
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
    const ipfsGateway = await startFixtureGateway({ onipfs: { 'index.html': page('ipfs name fixture') } })
    const broken = evilNode.addSite({ 'index.html': page('tampered swarm fixture') })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'feed.eth': `bzz://${feed.manifest}`, 'broken.eth': `bzz://${broken}`, 'onipfs.eth': `ipfs://${ipfsGateway.roots['onipfs']!}` }),
          ORIVON_TEST_IPFS_GATEWAYS: ipfsGateway.url,
          ORIVON_TEST_SWARM_ENDPOINTS: `${node.url},${evilNode.url}`
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

      await clickAddressBarRetrying(chrome, 'bzz://feed.eth/')
      const again = await waitForTab(chrome, { address: 'bzz://feed.eth/', title: 'swarm update two' })
      check(`the address a .eth name is shown as loads that name again (${JSON.stringify(again.info)})`, again.ok)

      await clickAddressBarRetrying(chrome, 'broken.eth')
      const refused = await waitForTab(chrome, { title: 'Cannot verify this site' })
      check(`a node that serves only tampered chunks gives the cannot-verify page (${JSON.stringify(refused.info)})`, refused.ok)

      expect(typed.ok && followed.ok && fed.ok && onIpfs.ok && again.ok && refused.ok).toBe(true)
      expect(loaded).toEqual({ origin: `https://${cid}.bzz.orivon`, secure: true, ran: 'ran' })
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await node.close()
      await evilNode.close()
      await ipfsGateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
