// An allowed web3 site runs where websites run, and a service worker of its own can answer its navigations (an
// offline-first app does, on every start after the first). The page such a worker answers is the app's, so it holds the
// app's grants; a worker the shell did not serve is the network's, and neither installs nor gives grants:
//
//   1. The app registers its worker on the first page, and from then on a reload, another address, Back, a reload with the gateway
//      gone and the first page after a restart are answered by the worker and still show `window.orivon` working (a grant-backed call
//      succeeds).
//   2. In the moment between the shell serving an app and the verifier host learning it, the host answers from the network:
//      a worker script it hands out has no mark of the shell's, so the worker is refused and never installs. The page it
//      answered has no grants. Once the host knows, the reload is the shell's, holds its grants, registers the app's own
//      worker, and the reload after that is the worker's and keeps them.
//
// What a page can see of this is `window.orivon.app.grants()`: a document attributed to the origin gets the list, any other
// is denied, and `performance.getEntriesByType('navigation')[0].workerStart`, which is above zero when a worker answered.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-allowed-app-worker-answers.test.ts
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { pageValue, pinPath, withDeclaredTree } from './first-visit-support.js'

type Running = Awaited<ReturnType<typeof launchElectron>>

/** The page records how it was answered, whether a worker controls it, what its grants call said and how its own worker's registration ended. */
const APP_SCRIPT = [
  'const note = (name, value) => { document.body.dataset[name] = value }',
  'const nav = performance.getEntriesByType("navigation")[0]',
  'note("app", "ran")',
  'note("via", nav && nav.workerStart > 0 ? "worker" : "network")',
  'note("controlled", navigator.serviceWorker.controller ? "yes" : "no")',
  'if (window.orivon && window.orivon.app) window.orivon.app.grants().then((grants) => { note("grants", "granted:" + grants.map((grant) => grant.capability).join(",")) }, (error) => { note("grants", "rejected:" + (error && error.code)) })',
  'else note("grants", "no-orivon")',
  'navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).then(() => { note("sw", "ready") }, (error) => { note("sw", "failed: " + error) })'
].join('\n')

/** An offline-first worker: it keeps the first page and answers every navigation with it. */
const WORKER_SCRIPT = [
  'self.addEventListener("install", (event) => { event.waitUntil(caches.open("pages").then((cache) => cache.addAll(["/index.html", "/app.js"])).then(() => self.skipWaiting())) })',
  'self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()) })',
  'self.addEventListener("fetch", (event) => { if (event.request.mode === "navigate") event.respondWith(caches.match("/index.html").then((kept) => kept || fetch(event.request))) })'
].join('\n')

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': APP_SCRIPT,
  'sw.js': WORKER_SCRIPT,
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js', 'sw.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

interface Facts { readonly marked: boolean, readonly appTab: boolean, readonly app: string | null, readonly via: string | null, readonly controlled: string | null, readonly grants: string | null, readonly sw: string | null, readonly registrations: number | null }

/** What the newest page at `url` recorded about itself, and how many worker registrations its origin holds; null until one answers. */
async function factsOf (app: Running, url: string): Promise<Facts | null> {
  const value = await pageValue(app, url, '(async () => { const d = document.body ? document.body.dataset : {}; return JSON.stringify({ marked: window.__beforeReload === true, appTab: typeof process !== "undefined", app: d.app ?? null, via: d.via ?? null, controlled: d.controlled ?? null, grants: d.grants ?? null, sw: d.sw ?? null, registrations: (await navigator.serviceWorker.getRegistrations()).length }) })()')
  return typeof value === 'string' ? JSON.parse(value) as Facts : null
}

/** Marks the newest page at `url`, so a later read can tell a reloaded page from this one. */
async function markPage (app: Running, url: string): Promise<boolean> {
  return (await pageValue(app, url, 'window.__beforeReload = true; true')) === true
}

async function reloadTab (chrome: ReturnType<typeof findChrome>): Promise<void> {
  const [tab] = await tabIds(chrome) as string[]
  await chrome.evaluate((id: string) => { (window as unknown as { orivonShell: { reload: (tab: string) => void } }).orivonShell.reload(id) }, tab as string)
}

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 240_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openFixtureApp (gateway: Awaited<ReturnType<typeof startFixtureGateway>>, reuseProfile?: string): Promise<{ app: Running, chrome: ReturnType<typeof findChrome>, userData: string }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '500' },
    ...(reuseProfile === undefined ? {} : { reuseProfile })
  })
  await stubNativeDialogs(app)
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
  if (!listening) throw new Error('the verifier host never reported listening')
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  await waitFor(() => app.windows().length >= 2)
  const chrome = findChrome(app)
  await waitForAddressBarStable(chrome)
  return { app, chrome, userData }
}

it('[app:allowed-app-worker-keeps-grants] keeps the grants of an allowed site on a page its own service worker answers, on a reload, with the gateway gone and after a restart', async () => {
  await runPhase('allowed app worker keeps grants', async (check) => {
    const gateway = await startFixtureGateway({ worker: await withDeclaredTree(files('Worker app', 'allowed.app.worker')) })
    let app: Running | undefined
    let gatewayOpen = true
    let profile: string | undefined
    try {
      const opened = await openFixtureApp(gateway)
      app = opened.app
      const running = app
      const { chrome, userData } = opened
      profile = userData
      const root = gateway.roots['worker']!
      const origin = `https://${root}.ipfs.orivon`
      const url = `${origin}/`

      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Grant all')
      let first = null as Facts | null
      await waitFor(async () => { first = await factsOf(running, url); return first?.app === 'ran' && first.grants === 'granted:fs' && first.sw === 'ready' }, 60_000)
      check(`the first page holds its grants and registers the app's worker (${JSON.stringify(first)})`, first?.grants === 'granted:fs' && first.sw === 'ready' && first.registrations === 1)
      check('the app is pinned', await waitFor(() => existsSync(pinPath(userData, origin)), 60_000))

      check('the page to reload is marked', await markPage(running, url))
      await reloadTab(chrome)
      let second = null as Facts | null
      const answered = await waitFor(async () => { second = await factsOf(running, url); return second !== null && !second.marked && second.app === 'ran' && second.grants !== null }, 60_000)
      check(`the worker answers the reload (${JSON.stringify(second)})`, answered && second?.via === 'worker' && second.controlled === 'yes')
      check(`and the page it answered still holds the app's grants (${JSON.stringify(second)})`, second?.grants === 'granted:fs')

      // Another address the worker answers, and Back to the first: a history navigation builds a new document, which the worker answers too.
      check('the page to leave is marked', await markPage(running, url))
      await pageValue(running, url, 'setTimeout(() => { location.assign("/?next=1") }, 50); true')
      let next = null as Facts | null
      const moved = await waitFor(async () => { next = await factsOf(running, `${url}?next=1`); return next !== null && next.app === 'ran' && next.grants !== null }, 60_000)
      check(`another page the worker answers holds the grants (${JSON.stringify(next)})`, moved && next?.via === 'worker' && next.grants === 'granted:fs')
      await pageValue(running, `${url}?next=1`, 'setTimeout(() => { history.back() }, 50); true')
      let previous = null as Facts | null
      const returned = await waitFor(async () => { previous = await factsOf(running, url); return previous !== null && !previous.marked && previous.app === 'ran' && previous.grants !== null }, 60_000)
      check(`and Back to the first page holds them too (${JSON.stringify(previous)})`, returned && previous?.via === 'worker' && previous.grants === 'granted:fs')

      await gateway.close()
      gatewayOpen = false
      check('the page to reload is marked again', await markPage(running, url))
      await reloadTab(chrome)
      let offline = null as Facts | null
      const again = await waitFor(async () => { offline = await factsOf(running, url); return offline !== null && !offline.marked && offline.app === 'ran' && offline.grants !== null }, 60_000)
      check(`with the gateway gone the worker answers again, with the grants (${JSON.stringify(offline)})`, again && offline?.via === 'worker' && offline.grants === 'granted:fs')

      // A start: the pinned app is served again before any page asks, and the worker the profile kept answers its first page.
      app = undefined
      await closeElectronApp(running, APP_CLOSE_RACE_MS, { keepProfile: true })
      const restarted = await openFixtureApp(gateway, userData)
      app = restarted.app
      await clickAddressBarRetrying(restarted.chrome, `ipfs://${root}`)
      let started = null as Facts | null
      const back = await waitFor(async () => { started = await factsOf(restarted.app, url); return started !== null && started.app === 'ran' && started.grants !== null }, 60_000)
      check(`after a restart the worker answers the first page, with the grants (${JSON.stringify(started)})`, back && started?.via === 'worker' && started.controlled === 'yes' && started.grants === 'granted:fs')
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (gatewayOpen) await gateway.close()
      if (profile !== undefined) await rm(profile, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS * 2)

it('[app:allowed-app-unchecked-worker-never-installs] refuses a service worker script the shell did not answer, so a page the host answered holds no grants through it', async () => {
  await runPhase('allowed app unchecked worker', async (check) => {
    const gateway = await startFixtureGateway({ held: await withDeclaredTree(files('Held worker app', 'allowed.app.held.worker')) })
    let app: Running | undefined
    try {
      const opened = await openFixtureApp(gateway)
      app = opened.app
      const running = app
      const { chrome } = opened
      const root = gateway.roots['held']!
      const url = `https://${root}.ipfs.orivon/`

      // The verifier host does not yet know the shell serves the app: what it answers comes from the network, with no mark of the shell's.
      await running.evaluate(() => { (globalThis as { __orivonDevEthFixtures?: { holdServed?: (hold: boolean) => void } }).__orivonDevEthFixtures?.holdServed?.(true) })
      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Grant all')
      let held = null as Facts | null
      await waitFor(async () => { held = await factsOf(running, url); return held?.appTab === true && held.app === 'ran' && held.grants !== null && held.sw !== null }, 60_000)
      check(`the page the host answered, in the app's tab, holds no grants (${JSON.stringify(held)})`, held?.appTab === true && held.grants !== 'granted:fs')
      check(`and the worker script it handed out is refused, so no worker is registered (${JSON.stringify(held)})`, held?.sw?.startsWith('failed') === true && held.registrations === 0)

      // The host is told: the next load is the shell's, holds its grants and registers the app's own worker.
      await running.evaluate(() => { (globalThis as { __orivonDevEthFixtures?: { holdServed?: (hold: boolean) => void } }).__orivonDevEthFixtures?.holdServed?.(false) })
      check('the page to reload is marked', await markPage(running, url))
      await reloadTab(chrome)
      let shells = null as Facts | null
      const entered = await waitFor(async () => { shells = await factsOf(running, url); return shells !== null && !shells.marked && shells.app === 'ran' && shells.grants !== null && shells.sw === 'ready' }, 60_000)
      check(`once the host knows, the reloaded page is the shell's: it holds its grants and registers the app's worker (${JSON.stringify(shells)})`, entered && shells?.via === 'network' && shells.grants === 'granted:fs' && shells.registrations === 1)

      check('the page to reload is marked again', await markPage(running, url))
      await reloadTab(chrome)
      let worker = null as Facts | null
      const answered = await waitFor(async () => { worker = await factsOf(running, url); return worker !== null && !worker.marked && worker.app === 'ran' && worker.grants !== null }, 60_000)
      check(`and the reload after that is the app's own worker's, with the grants (${JSON.stringify(worker)})`, answered && worker?.via === 'worker' && worker.grants === 'granted:fs')
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
