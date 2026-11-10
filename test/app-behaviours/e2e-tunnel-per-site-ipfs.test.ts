// An `ipfs://<cid>` address typed for a site that has a tunnel entry of its own loads in the session of that entry, from the
// new-tab page and from a tab that shows a page. The scheme serves the typed address at an endpoint that redirects to the CID's
// own origin, so the redirect is the first request that reaches the origin the entry names: it must be moved to the entry's
// session before it starts, or the main-frame guard of the shared session cancels it (ERR_BLOCKED_BY_CLIENT).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-per-site-ipfs.test.ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { stubNativeDialogs } from '../support/question-support.js'

type Running = Awaited<ReturnType<typeof launchElectron>>

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>cid site</title><body>cid site</body>' }

interface Where { readonly url: string, readonly inEntrySession: boolean, readonly inSharedSession: boolean }

/** Every page at an address under `prefix`, and whether it runs in the direct profile (the session an `off` entry names) or in the shared session. */
async function pagesAt (app: Running, prefix: string): Promise<Where[]> {
  return await app.evaluate(({ session, webContents }, start) => webContents.getAllWebContents()
    .filter((contents) => !contents.isDestroyed() && contents.getURL().startsWith(start))
    .map((contents) => ({ url: contents.getURL(), inEntrySession: contents.session === session.fromPartition('persist:direct-profile'), inSharedSession: contents.session === session.defaultSession })), prefix).catch(() => [])
}

/** Starts a run that reports the main-frame loads that failed, from the first page on. */
async function watchFailedLoads (app: Running): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    const g = globalThis as unknown as { __failedLoads: string[] }
    g.__failedLoads = []
    electronApp.on('web-contents-created', (_event, contents) => {
      contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => { if (isMainFrame) g.__failedLoads.push(`${String(code)} ${description} ${url}`) })
    })
  })
}

const failedLoads = async (app: Running): Promise<string[]> => await app.evaluate(() => (globalThis as unknown as { __failedLoads?: string[] }).__failedLoads ?? [])

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 120_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function open (gateway: Awaited<ReturnType<typeof startFixtureGateway>>): Promise<{ app: Running, chrome: ReturnType<typeof findChrome> }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '600000' },
    seedProfile: async (dir) => {
      // The site's entry keeps it off the tunnel the rest of the browser follows: a session apart from the shared one.
      const origin = `https://${gateway.roots['site']!}.ipfs.orivon`
      writeFileSync(join(dir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [], via: {}, off: [origin], apart: [], apartProxy: [], apartDirect: [] }))
    }
  })
  await stubNativeDialogs(app)
  await watchFailedLoads(app)
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
  if (!listening) throw new Error('the verifier host never reported listening')
  await waitFor(() => app.windows().length >= 2)
  const chrome = findChrome(app)
  await waitForAddressBarStable(chrome)
  return { app, chrome }
}

/** Types `ipfs://<cid>` for a site whose entry keeps it off the shared session, in the new-tab page or after a page is up, and checks where its page runs. */
async function typeAddress (title: string, first: boolean): Promise<void> {
  await runPhase(`typed ipfs address, entry, ${title}`, async (check) => {
    const gateway = await startFixtureGateway({ site: SITE })
    let app: Running | undefined
    try {
      const root = gateway.roots['site']!
      const origin = `https://${root}.ipfs.orivon`
      const opened = await open(gateway)
      app = opened.app
      if (first) {
        await clickAddressBarRetrying(opened.chrome, `${gateway.url}/nothing`)
        check('a page is up before the address is typed', await waitFor(async () => (await pagesAt(opened.app, gateway.url)).length > 0, 30_000))
      }
      await clickAddressBarRetrying(opened.chrome, `ipfs://${root}`)
      let where: Where[] = []
      const landed = await waitFor(async () => { where = await pagesAt(opened.app, origin); return where.some((page) => page.inEntrySession) }, 30_000)
      const failed = (await failedLoads(opened.app)).filter((line) => line.includes(origin))
      check(`the site's page runs in the session of its entry (${JSON.stringify(where)}; its failed loads ${JSON.stringify(failed)})`, landed && failed.length === 0 && where.every((page) => !page.inSharedSession))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}

it('[app:tunnel-per-site] ipfs://<cid> typed in the new-tab page loads a site with a tunnel entry in the session of its entry, not cancelled in the shared one', async () => {
  await typeAddress('the new-tab page', false)
}, TEST_TIMEOUT_MS)

it('[app:tunnel-per-site] ipfs://<cid> typed in a tab that already shows a page loads a site with a tunnel entry in the session of its entry', async () => {
  await typeAddress('a tab that already shows a page', true)
}, TEST_TIMEOUT_MS)
