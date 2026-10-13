// An ipfs:// address when the person reads IPFS from the node Orivon runs and the node's files are not there:
// IPFS is not blocked on the node. The mount reads from the public gateways (none is reachable in this hermetic
// run, so the page ends in the ordinary unavailable page, which never says the content loads only from the node),
// and Settings says in plain words why the node is not in use. ORIVON_IPFS_NODE_DIR names an empty directory so
// the answer does not depend on whether this checkout has fetched the node.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import type { Page } from 'playwright'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000
/** The CID of an empty directory: valid, and held by no one this run can reach. */
const CONTENT = 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('reads from the gateways, never blocking on the node, and tells Settings why the node is not in use', async () => {
  await runPhase('ipfs-node-unavailable', async (check) => {
    const empty = await mkdtemp(join(tmpdir(), 'orivon-no-ipfs-node-'))
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_IPFS_NODE_DIR: empty } })
      const running = app
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `ipfs://${CONTENT}`)
      const shown = await waitForTab(chrome, { title: 'Cannot check this site right now' })
      check(`the tab shows the unavailable page, not a wait on the node (${JSON.stringify(shown.info)})`, shown.ok)
      const view = findViewShowing(app, chrome, `https://${CONTENT}.ipfs.orivon/`)
      check('the page is the verifier\'s own, at the address\'s origin', view !== undefined)
      if (view === undefined) throw new Error('no view shows the served origin')
      const words = await evaluateRetrying(view, () => document.body.innerText)
      check(`the page does not say the content loads only from the node (${JSON.stringify(words.slice(0, 300))})`, !words.includes('loads only from the IPFS node'))

      await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/web3') })
      let settings: Page | undefined
      await waitFor(() => { settings = running.windows().find((w) => w.url().startsWith('orivon://settings')); return settings !== undefined })
      if (settings === undefined) throw new Error('Settings did not open')
      const row = settings.locator('#row-web3-ipfs-node .value')
      let text = ''
      const said = await waitFor(async () => { text = (await row.textContent().catch(() => '')) ?? ''; return text.startsWith('Not in use:') }, 15_000)
      check(`Settings says why the node is not in use, and that gateways serve instead (${JSON.stringify(text)})`, said && text.includes('ipfs-node.js is missing') && text.includes('IPFS content loads from public gateways instead'))
      expect(shown.ok && said && !words.includes('loads only from the IPFS node')).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await rm(empty, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS)
