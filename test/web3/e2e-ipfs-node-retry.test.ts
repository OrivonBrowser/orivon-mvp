// An ipfs:// page read from the node Orivon runs loads whole in one go when the node cannot give some of its
// files at first: its stylesheet and image answer 404, its script 504, as the real node does for a lookup it
// remembers as empty. The verifier asks the node again once the wait has passed (a fixture stands in for the
// node, and the test seam shortens the wait), so the page has its style, its script and its image without a
// reload, and not one request went to a public gateway.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const RETRY_WAIT_MS = 1_500
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const SITE = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>node retry fixture</title><link rel="stylesheet" href="style.css"><body><h1>retry</h1><img id="logo" src="logo.png"><script src="app.js"></script></body>',
  'style.css': 'body { background-color: rgb(1, 2, 3) }',
  'app.js': 'document.body.dataset.script = "ran"',
  'logo.png': PNG
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('loads a page whole when the node first cannot give some of its files, without asking a public gateway', async () => {
  await runPhase('ipfs-node-retry', async (check) => {
    const node = await startFixtureGateway({ site: SITE })
    const publicGateway = await startFixtureGateway({ site: SITE })
    const root = node.roots['site']!
    node.failNext('site', 'style.css', 404, 1)
    node.failNext('site', 'app.js', 504, 1)
    node.failNext('site', 'logo.png', 404, 1)
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}),
          ORIVON_TEST_IPFS_GATEWAYS: publicGateway.url,
          ORIVON_TEST_DOH: `${publicGateway.url}/dns-query`,
          ORIVON_TEST_IPFS_NODE: node.url,
          ORIVON_TEST_IPFS_NODE_RETRY_WAIT_MS: String(RETRY_WAIT_MS)
        }
      })
      const running = app
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      const loaded = await waitForTab(chrome, { address: `ipfs://${root}/`, title: 'node retry fixture' }, 30_000)
      check(`the page loaded (${JSON.stringify(loaded.info)})`, loaded.ok)
      const view = findViewShowing(app, chrome, `https://${root}.ipfs.orivon/`)
      check('it runs at the https origin serving it', view !== undefined)
      if (view === undefined) throw new Error('no view shows the served origin')

      const whole = async (): Promise<{ style: string, script: string | undefined, image: number }> => await evaluateRetrying(view, () => ({
        style: getComputedStyle(document.body).backgroundColor,
        script: document.body.dataset['script'],
        image: (document.getElementById('logo') as HTMLImageElement).naturalWidth
      }))
      let state = await whole()
      await waitFor(async () => {
        state = await whole()
        return state.style === 'rgb(1, 2, 3)' && state.script === 'ran' && state.image === 1
      }, RETRY_WAIT_MS + 20_000)
      check(`the stylesheet applied (${state.style})`, state.style === 'rgb(1, 2, 3)')
      check(`the script ran (${String(state.script)})`, state.script === 'ran')
      check(`the image decoded (${String(state.image)} px wide)`, state.image === 1)

      const asked = (file: string): number => node.requests.filter((request) => request.startsWith(`/ipfs/${node.blockOf('site', file)}`)).length
      check('the node was asked again for each file it first could not give', asked('style.css') >= 2 && asked('app.js') >= 2 && asked('logo.png') >= 2)
      check(`no public gateway was asked (${JSON.stringify(publicGateway.requests)})`, publicGateway.requests.length === 0)
      expect(state).toEqual({ style: 'rgb(1, 2, 3)', script: 'ran', image: 1 })
      expect(publicGateway.requests).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await node.close()
      await publicGateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
