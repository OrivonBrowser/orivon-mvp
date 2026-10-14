// The first-visit question is one panel of switches (Grant all, Close), and the key says when an app's permissions are
// not all granted: a dot on the key. Close keeps the rows left on (none on is a refusal), Escape is "not now", and the
// key popup of an app that was never let in offers the question back with Review permissions. Driven through the test
// seam's gateway.
import { afterAll, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, readSwitches, stubNativeDialogs, switchRow, waitQuestion } from '../support/question-support.js'
import { pageAt, savedGrants, watchPages, withDeclaredTree } from './first-visit-support.js'

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': 'document.body.dataset.app = "ran"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: { fs: { quotaBytes: 1_048_576 }, id: {} } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 14 + APP_CLOSE_RACE_MS + 300_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-asks-with-switches] [app:first-visit-key-dot] [app:first-visit-review-permissions] asks with a switch per permission, keeps the rows left on at Close, dots the key while any is off, and gives the question back from the key popup', async () => {
  await runPhase('first-visit-switches', async (check) => {
    const gateway = await startFixtureGateway({
      partial: await withDeclaredTree(files('Partial app', 'first.visit.partial')),
      none: await withDeclaredTree(files('None app', 'first.visit.none')),
      later: await withDeclaredTree(files('Later app', 'first.visit.later'))
    })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '600000' }
      })
      const running = app
      await stubNativeDialogs(running)
      await watchPages(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      const dotShown = async (): Promise<boolean> => (await chrome.getAttribute('#site-permissions-btn', 'data-missing')) !== null
      const keyLabel = async (): Promise<string> => (await chrome.getAttribute('#site-permissions-btn', 'aria-label')) ?? ''
      const popupOf = (): Page | undefined => running.windows().find((page) => page.url().includes('/site-info/') && !page.isClosed())
      const openKeyPopup = async (): Promise<Page> => {
        await chrome.click('#site-permissions-btn')
        await waitFor(() => popupOf() !== undefined, 5_000)
        const popup = popupOf() as Page
        await popup.waitForSelector('.site-header')
        return popup
      }
      const closeKeyPopup = async (): Promise<void> => {
        await chrome.click('#site-permissions-btn')
        await waitFor(() => popupOf() === undefined, 5_000)
      }

      // 1. Some rows on, then Close: let in holding only those, and the key is dotted.
      const partialOrigin = `https://${gateway.roots['partial']!}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${gateway.roots['partial']!}`)
      const panel = await waitQuestion(running, 60_000)
      await panel.waitForSelector('.q:not(.arming)')
      const asked = await readQuestion(panel)
      check(`the panel offers Close and Grant all, Close first (${JSON.stringify(asked.buttons)})`, JSON.stringify(asked.buttons) === JSON.stringify(['Close', 'Grant all']))
      check(`it has a row for each permission the app asked for (${JSON.stringify(asked.choices)})`, asked.choices.length === 2 && asked.choices.some((row) => /files/i.test(row)))
      check('every switch starts off', (await readSwitches(panel)).every((row) => !row.on))
      check(`it says the permissions were asked for together while one is off (${JSON.stringify(asked.note)})`, asked.note.includes('asked for these together'))
      check('the origin is named once', [asked.origin, asked.title, asked.message, asked.detail].join('\n').split(asked.origin).length === 2)
      await switchRow(panel, 'id')
      check('switching a row grants nothing by itself', savedGrants(userData, partialOrigin).length === 0)
      await answerQuestion(running, 'Close')
      const entered = await waitForTab(chrome, { address: `ipfs://${gateway.roots['partial']!}/`, title: 'Partial app' }, 60_000)
      check(`the app opened (${JSON.stringify(entered.info)})`, entered.ok)
      check(`it holds only what was switched on (${JSON.stringify(savedGrants(userData, partialOrigin))})`, await waitFor(() => JSON.stringify(savedGrants(userData, partialOrigin)) === '["id"]', 20_000))
      check('the key wears the dot', await waitFor(dotShown, 20_000))
      check(`the key says some permissions are off (${await keyLabel()})`, (await keyLabel()).includes('Some permissions this site asked for are off'))
      const popup = await openKeyPopup()
      const rows = await popup.evaluate(() => Array.from(document.querySelectorAll('.row-list .row')).map((row) => ({ on: row.querySelector('.switch')?.getAttribute('aria-checked') === 'true' })))
      check(`the popup shows one row on and one off (${JSON.stringify(rows)})`, rows.length === 2 && rows.filter((row) => row.on).length === 1)
      check('the popup offers no way back: the app was let in', (await popup.$('#review-permissions')) === null)
      await closeKeyPopup()

      // 2. Nothing on, then Close: a refusal. A plain website, a dotted key, and a way back in the popup.
      const noneRoot = gateway.roots['none']!
      const noneOrigin = `https://${noneRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${noneRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Close')
      const plain = await waitForTab(chrome, { address: `ipfs://${noneRoot}/`, title: 'None app' }, 60_000)
      check(`the refused site opened (${JSON.stringify(plain.info)})`, plain.ok)
      let facts = null as Awaited<ReturnType<typeof pageAt>>
      await waitFor(async () => { facts = await pageAt(running, `${noneOrigin}/`); return facts?.ran === 'ran' }, 20_000)
      check(`it stays a website (${JSON.stringify(facts)})`, facts?.ran === 'ran' && !facts.hasProcess)
      check('nothing is granted', savedGrants(userData, noneOrigin).length === 0)
      check('the key wears the dot', await waitFor(dotShown, 20_000))
      const refused = await openKeyPopup()
      check('the popup says the site is an app whose permissions are not granted', ((await refused.textContent('.review-card')) ?? '').includes('They are not granted'))
      await refused.click('#review-permissions')
      await waitFor(() => popupOf() === undefined, 5_000)
      const again = await waitQuestion(running, 60_000)
      check('Review permissions asks the question again, with every switch off', (await readSwitches(again)).length === 2 && (await readSwitches(again)).every((row) => !row.on))
      await answerQuestion(running, 'Grant all')
      const entering = await waitForTab(chrome, { address: `ipfs://${noneRoot}/`, title: 'None app' }, 60_000)
      check(`Grant all lets the app in (${JSON.stringify(entering.info)})`, entering.ok)
      check(`it holds everything it asked for (${JSON.stringify(savedGrants(userData, noneOrigin))})`, await waitFor(() => JSON.stringify([...savedGrants(userData, noneOrigin)].sort()) === '["fs","id"]', 20_000))
      check('the dot is gone', await waitFor(async () => !(await dotShown()), 20_000))

      // 3. Escape: not now. Nothing is recorded, the key is dotted, and the popup gives the question back.
      const laterRoot = gateway.roots['later']!
      await clickAddressBarRetrying(chrome, `ipfs://${laterRoot}`)
      const escaping = await waitQuestion(running, 60_000)
      await escaping.keyboard.press('Escape').catch((error: unknown) => { if (!/closed|destroyed/.test(String(error))) throw error })
      check('Escape takes the panel away', await waitFor(() => questionGone(running), 10_000))
      check('the key wears the dot', await waitFor(dotShown, 20_000))
      const dismissed = await openKeyPopup()
      check('the popup offers Review permissions', (await dismissed.$('#review-permissions')) !== null)
      await dismissed.click('#review-permissions')
      await waitFor(() => popupOf() === undefined, 5_000)
      await waitQuestion(running, 60_000)
      check('Review permissions asks the question again', true)
      await answerQuestion(running, 'Grant all')
      const laterEntered = await waitForTab(chrome, { address: `ipfs://${laterRoot}/`, title: 'Later app' }, 60_000)
      check(`Grant all lets the app in (${JSON.stringify(laterEntered.info)})`, laterEntered.ok)
      check('the dot is gone', await waitFor(async () => !(await dotShown()), 20_000))

      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
