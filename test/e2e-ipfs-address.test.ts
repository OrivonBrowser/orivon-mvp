// `ipfs://` and `ipns://` addresses, typed and linked, in the real shell. The
// address bar shows the address; the page runs at the https origin serving
// it (`https://<cid>.ipfs.orivon`), as a secure context, from blocks the
// verifier checked. Driven through the test seam's gateways, so nothing
// leaves the machine.
import { afterAll, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { startFixtureGateway } from './apps/ipfs-gateway/gateway.mjs'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:ipfs-url-opens] loads a typed ipfs:// address, follows an ipfs:// link, and opens an ipns:// DNSLink name, each shown as its address', async () => {
  await runPhase('ipfs-address', async (check) => {
    const linkedGateway = await startFixtureGateway({
      linked: { 'index.html': '<!doctype html><meta charset="utf-8"><title>linked fixture</title><body>linked</body>' }
    })
    const linked = linkedGateway.roots['linked']!
    const gateway = await startFixtureGateway({
      site: {
        'index.html': `<!doctype html><meta charset="utf-8"><title>ipfs fixture</title><body><a id="next" href="ipfs://${linked}/">next</a><script src="app.js"></script></body>`,
        'app.js': 'document.body.dataset.app = "ran"'
      }
    }, { dnslinks: { 'docs.example': 'site' } })
    const site = gateway.roots['site']!
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'site.eth': `ipfs://${site}` }),
          ORIVON_TEST_IPFS_GATEWAYS: `${gateway.url},${linkedGateway.url}`,
          ORIVON_TEST_DOH: `${gateway.url}/dns-query`
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      // A CIDv0 as typed: the scheme endpoint redirects it to its one canonical origin.
      await clickAddressBarRetrying(chrome, `ipfs://${CID.parse(site).toV0().toString()}`)
      const typed = await waitForTab(chrome, { address: `ipfs://${site}/`, title: 'ipfs fixture' })
      check(`a typed ipfs:// address is shown as its canonical address (${JSON.stringify(typed.info)})`, typed.ok)
      const view = findViewShowing(app, chrome, `https://${site}.ipfs.orivon/`)
      check('the page runs at the https origin serving it', view !== undefined)
      if (view === undefined) throw new Error('no view shows the served origin')
      const readPage = async (): Promise<{ origin: string, secure: boolean, ran: string | null }> => await evaluateRetrying(view, () => ({ origin: location.origin, secure: window.isSecureContext, ran: document.body.dataset['app'] ?? null }))
      // The title is up once the head is parsed; the script is its own verified fetch at the end of the body, so it may not have run yet.
      let page = await readPage()
      await waitFor(async () => { page = await readPage(); return page.ran === 'ran' })
      check(`it is a secure context, and its verified script ran (${JSON.stringify(page)})`, page.secure && page.ran === 'ran')
      check(`the gateway was asked for raw blocks (${String(gateway.requests.length)} requests)`, gateway.requests.some((r) => r.endsWith('?format=raw')))

      await view.click('#next')
      const followed = await waitForTab(chrome, { address: `ipfs://${linked}/`, title: 'linked fixture' })
      check(`an ipfs:// link in the page loads in the tab, shown as its address (${JSON.stringify(followed.info)})`, followed.ok)

      await clickAddressBarRetrying(chrome, 'ipns://docs.example')
      const named = await waitForTab(chrome, { address: 'ipns://docs.example/', title: 'ipfs fixture' })
      check(`an ipns:// DNSLink name is shown as its address (${JSON.stringify(named.info)})`, named.ok)

      await clickAddressBarRetrying(chrome, 'ipns://site.eth')
      const viaIpns = await waitForTab(chrome, { address: 'ipfs://site.eth/', title: 'ipfs fixture' })
      check(`ipns://site.eth opens the .eth name's own origin, shown as ipfs://site.eth/ (${JSON.stringify(viaIpns.info)})`, viaIpns.ok)
      check('the page runs at https://site.eth/, the name\'s own unchanged origin', findViewShowing(app, chrome, 'https://site.eth/') !== undefined)

      await clickAddressBarRetrying(chrome, 'ipfs://site.eth/')
      const viaIpfs = await waitForTab(chrome, { address: 'ipfs://site.eth/', title: 'ipfs fixture' })
      check(`ipfs://site.eth/ does the same (${JSON.stringify(viaIpfs.info)})`, viaIpfs.ok)

      expect(typed.ok && followed.ok && named.ok && viaIpns.ok && viaIpfs.ok).toBe(true)
      expect(page).toEqual({ origin: `https://${site}.ipfs.orivon`, secure: true, ran: 'ran' })
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      await linkedGateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
