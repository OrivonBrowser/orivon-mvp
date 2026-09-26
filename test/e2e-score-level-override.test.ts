// ADR-0037: an L4 site's grants carry no warnings, on every consent surface
// a grant summary reaches -- proven here against the REAL install-consent
// dialog (`createInstallConsentPrompt`), the REAL site-info popup and the
// REAL all-sites panel, driven through a real loopback grant-without-install
// flow (grantableWithoutInstall always allows loopback, dev mode or not),
// with the developer-only Website/Delivery level override
// (`src/main/dev/score-levels.ts`) forcing one origin to Level 4 and leaving
// a second, identical origin as a control at Level 1. THE ONE THING THIS
// SUBSTITUTES is the click: a native `dialog.showMessageBox` cannot be
// pressed by a driver, so it is replaced with one that records what it was
// shown and always answers "Allow" -- the same substitution
// e2e-loopback-grant.test.ts makes, for the identical reason. Everything
// else -- the manifest hint, the grant, the shield, the popup, the panel --
// is the shipped code path.
//
// Hermetic: everything it touches is loopback.
//
// RUN THIS WITH: npm run test:e2e, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-score-level-override.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from './e2e-helpers.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000 + APP_CLOSE_RACE_MS

/** An unlimited declaration, the same manifest shape grant-prompt-connect.test.ts's own exit-criterion tests use -- guaranteed to warn everywhere short of Level 4. */
function manifestFor (id: string): unknown {
  return {
    orivonApiVersion: 0,
    id,
    name: 'Score level override e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { net: { tcp: { connect: ['*:*'] } } }
  }
}

async function startFixture (id: string): Promise<{ server: Server, url: string }> {
  const manifestJson = JSON.stringify(manifestFor(id))
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/orivon.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(manifestJson)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><meta charset="utf-8"><title>fixture</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>fixture</body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return { server, url: `http://127.0.0.1:${String(port)}/` }
}

function findPopup (app: ElectronApplication, path: string): Page | undefined {
  return app.windows().find((w) => w.url().includes(path))
}

interface DialogCall { type: string, message: string, detail: string }

/** Waits for the toolbar shield's own async web3ScoreFor round trip to
 * resolve (it paints the empty "no level yet" state synchronously on
 * navigation first), then reads its level and label -- reading immediately
 * risks catching it mid-flight, the same race readWeb3Page in
 * e2e-eth-website-level.test.ts guards against. */
async function readShield (chrome: Page): Promise<{ level: string | null, text: string }> {
  if (!await waitFor(async () => await chrome.evaluate(() => document.querySelector('#web3-score-btn .web3-shield-fill') !== null), 8_000)) {
    throw new Error('the toolbar shield never painted a level')
  }
  return await chrome.evaluate(() => ({
    level: document.querySelector('#web3-score-btn .web3-shield-fill')?.getAttribute('data-level') ?? null,
    text: document.querySelector('#web3-score-btn .web3-shield-label')?.textContent ?? ''
  }))
}

it(
  'an L4-overridden origin\'s dialog, shield, popup and settings row all read without warning; an identical, un-overridden origin still warns throughout',
  async () => {
    await runPhase('score-level-override', async (check) => {
      const a = await startFixture('app.orivon.fixture.score-level-a')
      const b = await startFixture('app.orivon.fixture.score-level-b')
      const dir = mkdtempSync(join(tmpdir(), 'orivon-score-levels-e2e-'))
      let app: ElectronApplication | undefined
      try {
        const originA = new URL(a.url).origin
        const overridesFile = join(dir, 'overrides.json')
        writeFileSync(overridesFile, JSON.stringify({ [originA]: { website: 4, delivery: 3 } }))

        app = await launchElectron({
          appPath: '.',
          args: [HERMETIC_RESOLVER],
          env: { ORIVON_DEV_ORIGINS: '1', ORIVON_SCORE_LEVELS_FILE: overridesFile }
        })
        const running = app

        // Answer the real consent dialog "Allow", recording every call --
        // everything upstream and downstream of this one method is the
        // shipped path (e2e-loopback-grant.test.ts's own header).
        await running.evaluate(({ dialog }) => {
          const globals = globalThis as unknown as { __dialogCalls?: unknown[] }
          globals.__dialogCalls = []
          dialog.showMessageBox = (async (options: { type?: string, message?: string, detail?: string }) => {
            globals.__dialogCalls!.push({ type: options.type, message: options.message, detail: options.detail })
            return { response: 0, checkboxChecked: false }
          }) as unknown as typeof dialog.showMessageBox
        })

        await waitFor(() => running.windows().length === 2)
        const chrome = findChrome(running)
        await waitForAddressBarStable(chrome)

        // --- Origin A: overridden to Website Level 4 ----------------------
        await clickAddressBarRetrying(chrome, a.url)
        const keyAppearedA = await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null, 15_000)
        check('origin A: the key appeared once the loopback grant-without-install flow granted it', keyAppearedA)
        await chrome.waitForTimeout(500) // past the repartition, same margin e2e-site-info.test.ts's reloadAndSettle uses

        const callsAfterA = await running.evaluate(() => (globalThis as unknown as { __dialogCalls: DialogCall[] }).__dialogCalls)
        const dialogA = callsAfterA[0]
        check(`origin A's dialog is "question", not "warning" (${JSON.stringify(dialogA)})`, dialogA?.type === 'question')
        check('origin A\'s dialog carries the plain "Unlimited network access" line, no ⚠', dialogA?.detail?.includes('Unlimited network access') === true && !(dialogA?.detail?.includes('⚠') ?? true))

        const shieldA = await readShield(chrome)
        check(`origin A's shield paints Level 4, "Web3" (${JSON.stringify(shieldA)})`, shieldA.level === '4' && shieldA.text === 'Web3')

        await chrome.click('#site-permissions-btn')
        await waitFor(() => findPopup(running, '/site-info/') !== undefined, 5_000)
        const popupA = findPopup(running, '/site-info/')
        if (popupA === undefined) throw new Error('origin A: site-info popup did not open')
        await waitFor(async () => (await popupA.$$('.row')).length > 0, 5_000)
        const rowsA = await popupA.evaluate(() => ({
          warned: document.querySelectorAll('.row.warning').length,
          icons: document.querySelectorAll('.row .grant-icon').length,
          total: document.querySelectorAll('.row').length
        }))
        check(`origin A's popup rows carry no warning (${JSON.stringify(rowsA)})`, rowsA.total > 0 && rowsA.warned === 0 && rowsA.icons === rowsA.total)

        await chrome.click('#site-permissions-btn')
        await waitFor(() => findPopup(running, '/site-info/') === undefined, 5_000)
        await chrome.waitForTimeout(400)

        await chrome.click('#permissions-btn')
        await waitFor(() => findPopup(running, '/renderer/settings/') !== undefined, 5_000)
        const settingsA = findPopup(running, '/renderer/settings/')
        if (settingsA === undefined) throw new Error('the all-sites panel did not open')
        await waitFor(async () => (await settingsA.$$(`[data-origin="${originA}"] .permission-row`)).length > 0, 5_000)
        const cardA = await settingsA.evaluate((origin) => {
          const card = document.querySelector(`[data-origin="${origin}"]`)
          return {
            warned: card?.querySelectorAll('.permission-row.warning').length ?? -1,
            icons: card?.querySelectorAll('.permission-row .grant-icon').length ?? -1
          }
        }, originA)
        check(`origin A's settings card carries no warning either (${JSON.stringify(cardA)})`, cardA.warned === 0 && cardA.icons > 0)

        await chrome.click('#permissions-btn')
        await waitFor(() => findPopup(running, '/renderer/settings/') === undefined, 5_000)
        await chrome.waitForTimeout(400)

        // --- Origin B: the control, no override at all ---------------------
        await clickAddressBarRetrying(chrome, b.url)
        const keyAppearedB = await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null, 15_000)
        check('origin B: the key appeared once its own loopback grant landed', keyAppearedB)
        await chrome.waitForTimeout(500)

        const callsAfterB = await running.evaluate(() => (globalThis as unknown as { __dialogCalls: DialogCall[] }).__dialogCalls)
        const dialogB = callsAfterB[1]
        check(`origin B's dialog is still "warning", with ⚠ (${JSON.stringify(dialogB)})`, dialogB?.type === 'warning' && (dialogB?.detail?.includes('⚠') ?? false))

        const shieldB = await readShield(chrome)
        check(`origin B's shield paints Level 1, "Web2" -- an un-overridden loopback origin observes DDOC not-checked (${JSON.stringify(shieldB)})`, shieldB.level === '1' && shieldB.text === 'Web2')

        await chrome.click('#site-permissions-btn')
        await waitFor(() => findPopup(running, '/site-info/') !== undefined, 5_000)
        const popupB = findPopup(running, '/site-info/')
        if (popupB === undefined) throw new Error('origin B: site-info popup did not open')
        await waitFor(async () => (await popupB.$$('.row')).length > 0, 5_000)
        const rowsB = await popupB.evaluate(() => ({
          warned: document.querySelectorAll('.row.warning').length,
          total: document.querySelectorAll('.row').length
        }))
        check(`origin B's popup rows still warn -- the control proves summaryAtLevel is not a no-op (${JSON.stringify(rowsB)})`, rowsB.total > 0 && rowsB.warned === rowsB.total)
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        await new Promise<void>((resolve) => { a.server.close(() => { resolve() }) })
        await new Promise<void>((resolve) => { b.server.close(() => { resolve() }) })
        rmSync(dir, { recursive: true, force: true })
      }
    })
  },
  TEST_TIMEOUT_MS
)
