// A bzz:// address in a build that serves Swarm from the node Orivon runs, when that node's files are not
// there: the page says in plain words that Swarm is off and why, and nothing is loaded from anywhere else.
// No test endpoint is named, so the shell takes its ordinary path; ORIVON_SWARM_NODE_DIR names an empty
// directory so the answer does not depend on whether this checkout has fetched the node.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { referenceCid } from '../../src/protocols/swarm/reference.js'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 4 + APP_CLOSE_RACE_MS + 60_000
const REFERENCE = 'ab'.repeat(32)

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('says Swarm is off, and why, when the node it loads from is not installed', async () => {
  await runPhase('swarm-node-unavailable', async (check) => {
    const empty = await mkdtemp(join(tmpdir(), 'orivon-no-swarm-node-'))
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_SWARM_NODE_DIR: empty } })
      const running = app
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `bzz://${REFERENCE}`)
      const shown = await waitForTab(chrome, { title: 'Cannot check this site right now' })
      check(`the tab shows the unavailable page (${JSON.stringify(shown.info)})`, shown.ok)
      const view = findViewShowing(app, chrome, `https://${referenceCid(REFERENCE)}.bzz.orivon/`)
      check('the page is the verifier\'s own, at the address\'s origin', view !== undefined)
      if (view === undefined) throw new Error('no view shows the served origin')
      let words = ''
      await waitFor(async () => { words = await evaluateRetrying(view, () => document.body.innerText); return words.includes('Swarm') })
      check(`it says Swarm loads only from the node Orivon runs and that it is off (${JSON.stringify(words.slice(0, 400))})`, words.includes('Swarm node Orivon runs on this computer, and it is off'))
      check('it names the missing file', words.includes('swarm-node.js is missing'))
      expect(shown.ok && words.includes('and it is off') && words.includes('swarm-node.js is missing')).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await rm(empty, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS)
