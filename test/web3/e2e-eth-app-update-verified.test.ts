// An installed app at a `.eth` name whose name moves to a verified version: the person is asked, Yes
// pins the new content and every tab on the origin shows it, and a relaunch asks nothing. The old
// version runs, from its pin, until the answer. The provider judges every build Level 3, and the new
// build names the name it is reached at as its home, so all five conditions of "verified" hold.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase } from '../support/e2e-helpers.js'
import { findChrome } from '../support/smoke-helpers.mjs'
import { BUILTIN_ADDRESSES } from '../../src/protocols/builtin.js'
import { answerAccepting, answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { updateApp } from '../apps/app-update/site.mjs'
import { buildsAt, eventually, launchPhase, openTab, pinOf, profileOf, startRig } from './app-update-support.js'

const ORIGIN = 'https://app.eth'
const SHOWN = BUILTIN_ADDRESSES.displayUrl(`${ORIGIN}/`)
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS * 3 + 120_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:installed-app-moves-only-when-accepted] asks before a moved name changes an installed app, takes the new version on Yes in every tab, and asks nothing on the next start', async () => {
  await runPhase('eth-app-update-verified', async (check) => {
    const rig = await startRig({
      a: updateApp({ version: '1.0.0', build: 'A', net: true }),
      b: updateApp({ version: '1.0.1', build: 'B', net: true, domain: 'app.eth' })
    }, { a: 3, b: 3 })
    const rootA = rig.gateway.roots['a']!
    const rootB = rig.gateway.roots['b']!
    try {
      // Phase 1: the first visit installs build A, with the person's consent to what it asks for.
      let app = await launchPhase(rig, { names: { 'app.eth': 'a' } })
      await stubNativeDialogs(app)
      let chrome = findChrome(app)
      await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
      check('build A loads', (await waitForTab(chrome, { address: SHOWN, title: 'update fixture A' })).ok)
      await answerAccepting(app)
      check('the first visit pinned build A', await eventually(() => pinOf(app, ORIGIN)?.content?.cid === rootA, 25_000))
      const profile = profileOf(app)
      await closeElectronApp(app, APP_CLOSE_RACE_MS, { keepProfile: true })

      // Phase 2: the name now points at build B. The page opened from the pin is still A.
      app = await launchPhase(rig, { names: { 'app.eth': 'b' }, reuse: profile })
      await stubNativeDialogs(app)
      chrome = findChrome(app)
      await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
      const panel = await waitQuestion(app, 40_000)
      const asked = await readQuestion(panel)
      check(`the panel asks whether to switch (${asked.message})`, asked.message.endsWith('has updated the app to a new version. Do you want to switch to the new version?'))
      check(`it offers Yes and Not now (${asked.buttons.join(', ')})`, [...asked.buttons].sort().join(',') === 'Not now,Yes')
      check('it gives both versions and the level', asked.detail.includes('Version 1.0.0 to 1.0.1') && asked.detail.includes('Level 3'))
      check('the pin still holds build A while the question is open', pinOf(app, ORIGIN)?.content?.cid === rootA)
      await openTab(app, `${ORIGIN}/`)
      check('a second tab runs build A from the pin', await eventually(async () => (await buildsAt(app, `${ORIGIN}/`)).filter((build) => build === 'A').length === 2))

      // The question belongs to the first tab: a tab switch hides it, and going back shows it again.
      await chrome.locator('.tab').first().click()
      await waitQuestion(app)
      await answerQuestion(app, 'Yes')
      check('Yes pinned build B', await eventually(() => pinOf(app, ORIGIN)?.content?.cid === rootB, 30_000))
      check('both tabs show build B', await eventually(async () => {
        const builds = await buildsAt(app, `${ORIGIN}/`)
        return builds.length === 2 && builds.every((build) => build === 'B')
      }, 30_000))
      check('the pin records the new version', pinOf(app, ORIGIN)?.version === '1.0.1')
      await closeElectronApp(app, APP_CLOSE_RACE_MS, { keepProfile: true })

      // Phase 3: a relaunch finds nothing to ask.
      app = await launchPhase(rig, { names: { 'app.eth': 'b' }, reuse: profile })
      await stubNativeDialogs(app)
      chrome = findChrome(app)
      await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
      check('build B opens', (await waitForTab(chrome, { address: SHOWN, title: 'update fixture B' })).ok)
      check('nothing is asked about the app', await questionGone(app))
      expect(await noNativeDialogs(app)).toEqual([])
      await closeElectronApp(app)
    } finally {
      await rig.close()
    }
  })
}, TEST_TIMEOUT_MS)
