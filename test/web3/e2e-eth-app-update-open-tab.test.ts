// An app tab left open, with no navigation, hears of a moved name by itself: the name is reached over a
// DNSLink whose record the spec flips while the tab stays where it is, and the person is told within the
// verifier's name cache lifetime (`SITE_TTL_MS`, 2 minutes) plus one look at the open tabs. The look is
// shortened to 5 seconds by `ORIVON_TEST_UPDATE_WATCH_MS`; its ordinary spacing is 30 minutes.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase } from '../support/e2e-helpers.js'
import { BUILTIN_ADDRESSES } from '../../src/protocols/builtin.js'
import { answerAccepting, answerQuestion, noNativeDialogs, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { SITE_TTL_MS } from '../../src/protocols/verifier-host/serve/sites.js'
import { updateApp } from '../apps/app-update/site.mjs'
import { buildsAt, eventually, launchPhase, pinOf, startRig } from './app-update-support.js'

const ORIGIN = 'https://app.eth'
const SHOWN = BUILTIN_ADDRESSES.displayUrl(`${ORIGIN}/`)
const WATCH_MS = 5_000
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS + SITE_TTL_MS * 2 + 120_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('tells the person about a moved DNSLink while the app tab stays where it is', async () => {
  await runPhase('eth-app-update-open-tab', async (check) => {
    const rig = await startRig({
      a: updateApp({ version: '1.0.0', build: 'A', net: true }),
      b: updateApp({ version: '1.0.1', build: 'B', net: true, domain: 'app.eth' })
    }, { a: 3, b: 3 })
    rig.dnslinks['app.example'] = 'a'
    try {
      const app = await launchPhase(rig, { names: { 'app.eth': 'dnslink://app.example' }, env: { ORIVON_TEST_UPDATE_WATCH_MS: String(WATCH_MS) } })
      await stubNativeDialogs(app)
      await clickAddressBarRetrying(findChrome(app), `${ORIGIN}/`)
      await answerAccepting(app)
      check('build A loads', (await waitForTab(findChrome(app), { address: SHOWN, title: 'update fixture A' })).ok)
      check('the first visit pinned build A', await eventually(() => pinOf(app, ORIGIN)?.content?.cid === rig.gateway.roots['a'], 25_000))

      rig.dnslinks['app.example'] = 'b'
      const flippedAt = Date.now()
      const panel = await waitQuestion(app, SITE_TTL_MS + 10 * WATCH_MS + 30_000)
      const notice = await readQuestion(panel)
      const waited = Date.now() - flippedAt
      check(`the notice came without a navigation, ${String(Math.round(waited / 1000))} s after the record moved`, notice.message.includes('has updated the app to a new version') && waited <= SITE_TTL_MS + 10 * WATCH_MS + 30_000)
      check('a DNSLink is never verified, so it is a notice with no Yes', notice.buttons.join(',') === 'OK')
      await answerQuestion(app, 'OK')
      check('the tab stays on build A', (await buildsAt(app, `${ORIGIN}/`)).join() === 'A')
      check('the pin still holds build A', pinOf(app, ORIGIN)?.content?.cid === rig.gateway.roots['a'])
      expect(await noNativeDialogs(app)).toEqual([])
      await closeElectronApp(app)
    } finally {
      await rig.close()
    }
  })
}, TEST_TIMEOUT_MS)
