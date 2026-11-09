// What the verifier's loopback server does for a host the shell serves from a copy it keeps: a request of the shared
// session for an allowed app's own host is answered by the handler of that app's partition, not by the network. Driven
// through the default session's own fetch, with no tab of the app in the shared session.
import { afterAll, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { pageAt, pinPath, savedGrants, withDeclaredTree } from './first-visit-support.js'

type Running = Awaited<ReturnType<typeof launchElectron>>

const SCRIPT = 'document.body.dataset.app = "ran"'

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': SCRIPT,
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 180_000

interface Answer {
  readonly status?: number
  readonly type?: string | null
  readonly csp?: string | null
  readonly range?: string | null
  readonly length?: string | null
  readonly text?: string
  readonly error?: string
}

/** One request of the shared session, made from main: no page, no partition of an app, so only the network or the shell's own handler can answer. */
async function fetchShared (app: Running, url: string, init: { readonly method?: string, readonly range?: string } = {}): Promise<Answer> {
  return await app.evaluate(async ({ session }, [address, method, range]) => {
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, 20_000)
    try {
      const headers: Record<string, string> = range === undefined ? {} : { range }
      const response = await session.defaultSession.fetch(address as string, { method: method as string, headers, cache: 'no-store', signal: abort.signal })
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        csp: response.headers.get('content-security-policy'),
        range: response.headers.get('content-range'),
        length: response.headers.get('content-length'),
        text: await response.text()
      }
    } catch (error) {
      return { error: String(error) }
    } finally {
      clearTimeout(timer)
    }
  }, [url, init.method ?? 'GET', init.range] as const)
}

async function startVerifier (running: Running): Promise<void> {
  const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
  if (!listening) throw new Error('the verifier host never reported listening')
}

/** Opens the app at `root`, answers the question with Grant all and waits for the app to run as an app tab. */
async function allowApp (running: Running, root: string, title: string): Promise<{ readonly userData: string }> {
  await stubNativeDialogs(running)
  await startVerifier(running)
  const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  await waitFor(() => running.windows().length === 2)
  const chrome = findChrome(running)
  await waitForAddressBarStable(chrome)
  await clickAddressBarRetrying(chrome, `ipfs://${root}`)
  await waitQuestion(running, 60_000)
  await answerQuestion(running, 'Grant all')
  const entered = await waitForTab(chrome, { address: `ipfs://${root}/`, title }, 60_000)
  expect(entered.ok).toBe(true)
  await waitFor(async () => (await pageAt(running, `https://${root}.ipfs.orivon/`))?.ran === 'ran', 60_000)
  return { userData }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('answers a request of the shared session for an allowed app from the pinned copy, after a restart with the gateway gone', async () => {
  await runPhase('verifier-serves-pinned-copy', async (check) => {
    const gateway = await startFixtureGateway({ good: await withDeclaredTree(files('Kept app', 'kept.copy.pinned')) })
    let gatewayOpen = true
    let app: Running | undefined
    let profile: string | undefined
    const env = { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '500' }
    try {
      const root = gateway.roots['good']!
      const origin = `https://${root}.ipfs.orivon`

      // 1. Allowed, and the whole app is pinned. Then the browser is closed and the gateway with it, so the next run has nothing the verifier could read or remember.
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env })
      const first = app
      const { userData } = await allowApp(first, root, 'Kept app')
      profile = userData
      check('it is pinned', await waitFor(() => existsSync(pinPath(userData, origin)), 60_000))
      check('its grants are saved', savedGrants(userData, origin).includes('fs'))
      app = undefined
      await closeElectronApp(first, APP_CLOSE_RACE_MS, { keepProfile: true })
      await gateway.close()
      gatewayOpen = false

      // 2. No tab of the app is open anywhere: only the shared session's own request can show whose answer it is.
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env, reuseProfile: profile })
      const second = app
      await stubNativeDialogs(second)
      await startVerifier(second)
      await waitFor(() => second.windows().length === 2)
      let script: Answer = {}
      await waitFor(async () => { script = await fetchShared(second, `${origin}/app.js`); return script.status === 200 && script.text === SCRIPT }, 40_000)
      check(`the shared session reads the pinned bytes of a file (${JSON.stringify(script)})`, script.status === 200 && script.text === SCRIPT)
      check('the answer carries the app\'s own policy', script.csp?.includes("default-src 'self'") === true)
      check('and says it came from the public internet and may be framed only by itself, as every answer of this server does', script.csp?.includes('treat-as-public-address') === true && script.csp.includes("frame-ancestors 'self'"))
      const part = await fetchShared(second, `${origin}/app.js`, { range: 'bytes=0-7' })
      check(`a range is answered as the handler answers it (${JSON.stringify(part)})`, part.status === 206 && part.text === SCRIPT.slice(0, 8) && part.range === `bytes 0-7/${String(SCRIPT.length)}`)
      const head = await fetchShared(second, `${origin}/app.js`, { method: 'HEAD' })
      check(`a HEAD gets the headers alone (${JSON.stringify(head)})`, head.status === 200 && head.text === '' && head.length === String(SCRIPT.length))
      const stranger = await fetchShared(second, `${origin}/not-in-the-app.js`)
      check(`a path the app does not list is refused by the handler, not looked up (${JSON.stringify(stranger)})`, stranger.status === 404 && stranger.type?.startsWith('text/plain') === true && stranger.text?.startsWith('Orivon:') === true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (gatewayOpen) await gateway.close()
      if (profile !== undefined) await rm(profile, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS)

it('answers a request of the shared session for an allowed app not yet pinned through the verifier, without sending it back to itself', async () => {
  await runPhase('verifier-serves-live-copy', async (check) => {
    const gateway = await startFixtureGateway({ good: await withDeclaredTree(files('Live app', 'kept.copy.live')) })
    let app: Running | undefined
    try {
      const root = gateway.roots['good']!
      const origin = `https://${root}.ipfs.orivon`
      // The download is held back for the whole run, so the app is served live: its handler reads the verifier's own server.
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '600000' } })
      const running = app
      const { userData } = await allowApp(running, root, 'Live app')
      check('it is not pinned', !existsSync(pinPath(userData, origin)))

      const script = await fetchShared(running, `${origin}/app.js`)
      check(`the shared session reads the file through the app's handler (${JSON.stringify(script)})`, script.status === 200 && script.text === SCRIPT)
      check('the answer carries the app\'s own policy', script.csp?.includes("default-src 'self'") === true)
      const stranger = await fetchShared(running, `${origin}/not-in-the-app.js`)
      check(`a path the app does not list is refused by the handler (${JSON.stringify(stranger)})`, stranger.status === 404 && stranger.type?.startsWith('text/plain') === true && stranger.text?.startsWith('Orivon:') === true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
