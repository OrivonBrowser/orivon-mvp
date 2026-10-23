// A site opened by its ipfs:// address with no manifest at its root is an ordinary website: the first visit reads the
// root for one, finds none and installs nothing, so a popup the site opens on another such site keeps its link back
// and the two pages exchange postMessage. A wiki whose pen hands its pages to an editor published the same way is the
// shape that needs it (DecentraWiki, in orivon-ports). Driven through the test seam's gateways, so nothing leaves the
// machine.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-ipfs-website-popup.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, findViewShowing, HERMETIC_RESOLVER, tabViews, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000
const PAYLOAD = { pages: ['first', 'second'], size: 3 }

const OPENER_SCRIPT = `window.log = []
document.getElementById('open').addEventListener('click', () => {
  const opened = window.open(document.getElementById('open').dataset.target, '_blank')
  window.log.push({ opened: opened !== null })
  window.addEventListener('message', (event) => {
    if (event.source !== opened) return
    window.log.push({ from: event.origin, type: event.data && event.data.type })
    if (event.data && event.data.type === 'ready') opened.postMessage({ type: 'payload', payload: ${JSON.stringify(PAYLOAD)} }, event.origin)
  })
})
`
const RECEIVER_SCRIPT = `window.received = null
window.hadOpener = window.opener !== null
window.addEventListener('message', (event) => {
  if (event.source !== window.opener || !event.data || event.data.type !== 'payload') return
  window.received = { from: event.origin, payload: event.data.payload }
  window.opener.postMessage({ type: 'received' }, event.origin)
})
if (window.opener) window.opener.postMessage({ type: 'ready' }, '*')
`

/** What `read` finds once it finds something; the suite's `waitFor` answers only true or false. */
async function found<T> (read: () => Promise<T | false | null | undefined> | T | false | null | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== false && value !== null && value !== undefined) return value
    if (Date.now() >= deadline) throw new Error('timed out waiting for the page')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:published-website-popup-keeps-opener] a site published with no manifest stays a website, and its popup on another keeps the link back', async () => {
  await runPhase('published-website-popup', async (check) => {
    const gateway = await startFixtureGateway({
      opener: {
        'index.html': '<!doctype html><meta charset="utf-8"><title>opener fixture</title><body><button id="open">open</button><script src="opener.js"></script></body>',
        'opener.js': OPENER_SCRIPT
      },
      other: {
        'index.html': '<!doctype html><meta charset="utf-8"><title>receiver fixture</title><body>receiver<script src="receiver.js"></script></body>',
        'receiver.js': RECEIVER_SCRIPT
      }
    })
    const openerRoot = gateway.roots['opener']!
    const otherRoot = gateway.roots['other']!
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query` }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `ipfs://${openerRoot}/`)
      check('the opening site loads', (await waitForTab(chrome, { address: `ipfs://${openerRoot}/`, title: 'opener fixture' })).ok)
      const page = findViewShowing(app, chrome, `https://${openerRoot}.ipfs.orivon/`)
      if (page === undefined) throw new Error('no view shows the opening site')
      await page.evaluate((target: string) => { (document.getElementById('open') as HTMLElement).dataset['target'] = target }, `https://${otherRoot}.ipfs.orivon/`)
      await page.click('#open')

      // Re-found on every poll: the receiving tab's page is the one that runs the receiver.
      const receiverOrigin = `https://${otherRoot}.ipfs.orivon`
      const received = await found(async () => {
        const view = (tabViews(running, chrome) as Page[]).find((v) => v.url().startsWith(receiverOrigin))
        if (view === undefined) return null
        return await view.evaluate(() => {
          const w = window as unknown as { received: unknown, hadOpener: boolean }
          return w.received === null || w.received === undefined ? null : { received: w.received, hadOpener: w.hadOpener }
        }).catch(() => null)
      })
      check('[app:published-website-popup-keeps-opener] the popup on the other published site has window.opener', received.hadOpener)
      expect(received.received).toEqual({ from: `https://${openerRoot}.ipfs.orivon`, payload: PAYLOAD })
      const log = await found(async () => {
        const entries: Array<{ type?: string }> = await page.evaluate(() => (window as unknown as { log: Array<{ type?: string }> }).log).catch(() => [])
        return entries.some((entry) => entry.type === 'received') ? entries : null
      })
      expect(log).toEqual([{ opened: true }, { from: receiverOrigin, type: 'ready' }, { from: receiverOrigin, type: 'received' }])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
