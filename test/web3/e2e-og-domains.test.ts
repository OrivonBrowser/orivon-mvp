// A `.og` name opens as a `.eth` name does: the address bar takes it, the verifier serves its content from IPFS over the
// loopback TLS server the shell trusts by the run's certificate fingerprint, the bar shows it under the network its content
// was found on, and History keeps it with its mark. Driven through the test seam, so no light client and no mainnet:
// `fixture.og` maps straight to a root the fixture gateway built. A `.og` name nothing maps fails closed on the verifier's own
// error page, which also proves the name never reached DNS (a name no resolver rule routed would fail as "not found"). A page
// that loaded is kept in History under the address the bar showed it by, `ipfs://<name>`, and an entry kept before a network was
// learned for the name, `https://<name>.og`, carries the OG mark.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { SqliteHistoryStore } from '../../src/main/history/sqlite-history-store.js'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const SITE = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>og fixture</title><body>og<script src="app.js"></script></body>',
  'app.js': 'document.body.dataset.app = "ran"'
}

const SCRIPT_RUN_CEILING_MS = 40_000
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000 + SCRIPT_RUN_CEILING_MS

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('opens a .og name from verified IPFS content, shows it as its name, fails an unmapped one closed, and keeps it in history with its mark', async () => {
  await runPhase('og-domains', async (check) => {
    const gateway = await startFixtureGateway({ site: SITE })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir: string) => {
          await mkdir(dir, { recursive: true })
          const store = new SqliteHistoryStore(join(dir, 'history.db'))
          store.record('https://seeded.og/page', 'seeded og page', Date.now() - 60_000)
          store.close()
        },
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'fixture.og': `ipfs://${gateway.roots['site']!}` }),
          ORIVON_TEST_IPFS_GATEWAYS: gateway.url
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      // navigateToFixture waits for the address bar to show `ipfs://fixture.og/`: the name under the network its content was found on.
      const view = await navigateToFixture(app, 'https://fixture.og/', 'og fixture')
      check('the address bar shows the .og name under the network its content is on', true)
      const readPage = async (): Promise<{ origin: string, protocol: string, secure: boolean, subtle: string, ran: string | null, script: number }> => await evaluateRetrying(view, async () => ({
        origin: location.origin,
        protocol: location.protocol,
        secure: window.isSecureContext,
        subtle: typeof crypto.subtle,
        ran: document.body.dataset['app'] ?? null,
        script: await fetch('/app.js').then((response) => response.status, () => 0)
      }))
      let page = await readPage()
      await waitFor(async () => { page = await readPage(); return page.ran === 'ran' }, SCRIPT_RUN_CEILING_MS)
      check(`fixture.og is served over https at its own origin with no certificate error, as a secure context (${JSON.stringify(page)})`, page.origin === 'https://fixture.og' && page.protocol === 'https:' && page.secure && page.subtle === 'object')
      check('its script ran, and a fetch of its own file over the same connection succeeds', page.ran === 'ran' && page.script === 200)
      check(`the gateway was asked for raw blocks (${String(gateway.requests.length)} requests)`, gateway.requests.some((request) => request.endsWith('?format=raw')))

      // A name nothing maps is the verifier's to refuse: a name no rule sent to it would never have reached a page at all. No network
      // is learned for it, so the bar keeps its plain origin.
      const chrome = findChrome(app)
      await clickAddressBarRetrying(chrome, 'https://nobody.og/')
      const refused = await waitForTab(chrome, { address: 'https://nobody.og/', title: 'Cannot check this site right now' })
      check(`an unmapped .og name opens the verifier's error page (${JSON.stringify(refused.info)})`, refused.ok)
      const unmapped = findViewShowing(app, chrome, 'https://nobody.og/')
      if (unmapped === undefined) throw new Error('no view shows the unmapped name')
      const refusal = (await evaluateRetrying(unmapped, () => document.body.innerText)).replace(/\s+/g, ' ')
      check(`an unmapped .og name shows the verifier's refusal, naming .og (${refusal.slice(0, 300)})`, refusal.includes('.og'))

      await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('history') })
      expect(await waitFor(() => running.windows().some((window) => window.url().startsWith('orivon://history')))).toBe(true)
      const history = running.windows().find((window) => window.url().startsWith('orivon://history')) as Page
      await history.waitForSelector('.page')
      const rowOf = (title: string): ReturnType<Page['locator']> => history.locator('.entry', { hasText: title })
      const listed = await waitFor(async () => (await rowOf('og fixture').count()) > 0 && (await rowOf('seeded og page').count()) > 0, 15_000)
      const visited = listed ? await rowOf('og fixture').first().locator('.url').textContent() : null
      check(`the page that loaded is in History under its name (${String(visited)})`, visited !== null && visited.includes('fixture.og'))
      const mark = listed ? await rowOf('seeded og page').first().locator('.site-mark.protocol').evaluate((element) => ({ text: element.textContent, title: element.getAttribute('title') })) : undefined
      check(`an entry kept at https://seeded.og carries the OG mark (${JSON.stringify(mark)})`, mark?.text === 'OG' && mark.title === 'A .og name')

      expect(page).toMatchObject({ origin: 'https://fixture.og', protocol: 'https:', secure: true, subtle: 'object', ran: 'ran', script: 200 })
      expect(refusal).toContain('.og')
      expect(visited).toContain('fixture.og')
      expect(mark).toEqual({ text: 'OG', title: 'A .og name' })
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
