// An installed app at a `.eth` name whose name moves to a version nothing vouches for: the person is
// told, never asked to switch, and the version in use keeps running. Only the key icon's Trust & Force
// update, after its confirmation, takes it. The tick "Don't ask again for this version" is kept, and the
// key keeps offering. The same content under another name shows Level 2 and the home it names.
import { afterAll, expect, it } from 'vitest'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, findChrome, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, readShield, runPhase } from '../support/e2e-helpers.js'
import { BUILTIN_ADDRESSES } from '../../src/protocols/builtin.js'
import { answerAccepting, answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { updateApp } from '../apps/app-update/site.mjs'
import { buildsAt, eventually, launchPhase, pinOf, profileOf, quietOf, startRig } from './app-update-support.js'

const ORIGIN = 'https://app.eth'
const SHOWN = BUILTIN_ADDRESSES.displayUrl(`${ORIGIN}/`)
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 6 + DEFAULT_ACTION_TIMEOUT_MS * 20 + APP_CLOSE_RACE_MS * 4 + 180_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const popupOf = (app: ElectronApplication) => app.windows().find((w) => w.url().includes('/site-info/'))

/** A click that lands while the tab is still reloading after an install opens nothing, so the click is repeated once before the popover counts as not opening. */
async function openKey (app: ElectronApplication) {
  let opened = false
  for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
    await findChrome(app).click('#site-permissions-btn')
    opened = await waitFor(() => popupOf(app) !== undefined, 5_000)
  }
  if (!opened) throw new Error('the site popover did not open')
  const popup = popupOf(app)!
  await popup.waitForSelector('.site-header')
  return popup
}

async function closeKey (app: ElectronApplication): Promise<void> {
  await findChrome(app).click('#site-permissions-btn')
  await waitFor(() => popupOf(app) === undefined, 5_000)
  await findChrome(app).waitForTimeout(400)
}

it('tells the person about an unverified version and keeps the old one, takes it only through Trust & Force, and remembers a tick', async () => {
  await runPhase('eth-app-update-unverified', async (check) => {
    const rig = await startRig({
      b: updateApp({ version: '1.0.1', build: 'B', net: true, domain: 'app.eth' }),
      c: updateApp({ version: '2.0.0', build: 'C', net: true, domain: 'other.eth' }),
      a2: updateApp({ version: '1.0.0', build: 'A2', net: true, extra: '// a second file' })
    }, { b: 3, c: 3, a2: 3 })
    const root = (site: string): string => rig.gateway.roots[site]!
    const visit = async (app: ElectronApplication, url: string): Promise<void> => {
      await clickAddressBarRetrying(findChrome(app), url)
    }
    try {
      // Phase 1: build B is installed.
      let app = await launchPhase(rig, { names: { 'app.eth': 'b' } })
      await stubNativeDialogs(app)
      await visit(app, `${ORIGIN}/`)
      check('build B loads', (await waitForTab(findChrome(app), { address: SHOWN, title: 'update fixture B' })).ok)
      await answerAccepting(app)
      check('the first visit pinned build B', await eventually(() => pinOf(app, ORIGIN)?.content?.cid === root('b'), 25_000))
      const profile = profileOf(app)
      await closeElectronApp(app, APP_CLOSE_RACE_MS, { keepProfile: true })

      // Phase 2: the name moves to build C, which names another home.
      app = await launchPhase(rig, { names: { 'app.eth': 'c' }, reuse: profile })
      await stubNativeDialogs(app)
      await visit(app, `${ORIGIN}/`)
      const notice = await readQuestion(await waitQuestion(app, 40_000))
      check(`a notice says the Web3 Score is not verified and where to switch (${notice.message})`, notice.message.includes('Its Web3 Score has not been verified yet. To switch, open the key icon and choose Trust & Force update.'))
      check(`it has no Yes (${notice.buttons.join(', ')})`, notice.buttons.join(',') === 'OK')
      check('it gives the reason', notice.detail.includes('names other.eth as its home'))
      await answerQuestion(app, 'OK')
      check('the tab stays on build B', await eventually(async () => (await buildsAt(app, `${ORIGIN}/`)).join() === 'B'))
      check('the pin still holds build B', pinOf(app, ORIGIN)?.content?.cid === root('b'))
      check('the key carries the offer dot', await eventually(async () => await findChrome(app).evaluate(() => document.querySelector('#site-permissions-btn')?.hasAttribute('data-update-offered') === true)))

      let popup = await openKey(app)
      const card = await popup.evaluate(() => ({ text: document.querySelector('.update-card')?.textContent ?? '', button: document.querySelector('.update-card button')?.textContent ?? '' }))
      check(`the key offers Trust & Force update, not Update (${card.button})`, card.button === 'Trust & Force update')
      check('the card names both versions', card.text.includes('Version 2.0.0 is available (you have 1.0.1)'))
      await popup.click('.update-card button')
      const confirm = await waitQuestion(app, 20_000)
      const asked = await readQuestion(confirm)
      check(`Trust & Force is confirmed first, in the warning style, listing what carries over (${asked.message})`, asked.warning && asked.detail.includes('api.example.com') && /its data/i.test(asked.detail))
      await answerQuestion(app, 'Switch anyway')
      check('the pin now holds build C', await eventually(() => pinOf(app, ORIGIN)?.content?.cid === root('c'), 30_000))
      check('the tab shows build C', await eventually(async () => (await buildsAt(app, `${ORIGIN}/`)).join() === 'C', 30_000))
      check('the dot is gone', await eventually(async () => await findChrome(app).evaluate(() => document.querySelector('#site-permissions-btn')?.hasAttribute('data-update-offered') === false)))
      await closeElectronApp(app, APP_CLOSE_RACE_MS, { keepProfile: true })

      // Phase 3: the name moves to a same-version older build with another file. Ticking the notice is kept.
      app = await launchPhase(rig, { names: { 'app.eth': 'a2' }, reuse: profile })
      await stubNativeDialogs(app)
      await visit(app, `${ORIGIN}/`)
      const older = await waitQuestion(app, 40_000)
      const olderSaid = await readQuestion(older)
      check(`an older build is a notice too (${olderSaid.message})`, olderSaid.message.includes('has not been verified yet') && olderSaid.detail.includes('not newer'))
      await older.check('.q-check input')
      await answerQuestion(app, 'OK')
      check('the tick is kept for that build, as an unverified offer', await eventually(() => JSON.stringify(quietOf(app, ORIGIN)) === JSON.stringify({ quiet: [{ cid: root('a2'), verified: false }] })))
      await closeElectronApp(app, APP_CLOSE_RACE_MS, { keepProfile: true })

      // Phase 4: no panel any more, the key still offers; the same content under another name is Level 2.
      app = await launchPhase(rig, { names: { 'app.eth': 'a2', 'evil.eth': 'b' }, reuse: profile })
      await stubNativeDialogs(app)
      await visit(app, `${ORIGIN}/`)
      check('the app opens', (await waitForTab(findChrome(app), { address: SHOWN, title: 'update fixture C' })).ok)
      await delay(ABSENCE_SETTLE_MS * 4)
      check('after the tick nothing is asked', await questionGone(app))
      check('the key still carries the offer dot', await eventually(async () => await findChrome(app).evaluate(() => document.querySelector('#site-permissions-btn')?.hasAttribute('data-update-offered') === true)))
      popup = await openKey(app)
      check('and still offers Trust & Force update', (await popup.textContent('.update-card button')) === 'Trust & Force update')
      await closeKey(app)

      await visit(app, 'https://evil.eth/')
      const home = await readQuestion(await waitQuestion(app, 40_000))
      check(`the install question says where the app says it lives (${home.detail})`, home.detail.includes('This app names app.eth as its home.'))
      const shield = await readShield(findChrome(app))
      check(`build B under another name shows Level 2, not the judged 3 (${String(shield.level)})`, shield.level === '2')
      await answerAccepting(app)
      await eventually(async () => await findChrome(app).evaluate(() => document.querySelector('#site-permissions-btn')?.getAttribute('aria-label') !== null))
      popup = await openKey(app)
      check('the key says so too', (await popup.textContent('.site-home'))?.includes('This app names app.eth as its home.') === true)
      check('and offers to open it', (await popup.textContent('.link-button'))?.includes('Open app.eth') === true)
      await closeKey(app)
      expect(await noNativeDialogs(app)).toEqual([])
      await closeElectronApp(app)
    } finally {
      await rig.close()
    }
  })
}, TEST_TIMEOUT_MS)
