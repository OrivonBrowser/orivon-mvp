// A page an app shows in a <webview> runs in a session of its own, whose web-request listener is the app's alone, so it
// waits for Chromium's network service to get its settings back through that listener. The service is ended with the
// settings held back for a while, the shown page is asked to load another page inside that wait, and the server of that
// page is watched: it must not be asked for it until the wait is over.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { delay, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, forwardOutput, killChild, navigateToFixture, waitForTcpReady } from '../support/e2e-helpers.js'
import { networkServicePid, seamOf, startCountedPage } from '../support/network-service-restart.js'
import type { CountedPage } from '../support/network-service-restart.js'
import { QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { HOST, STATIC_PORT } from '../apps/fixture/config.mjs'
import type { DevGrantRequest } from '../../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../../src/contracts/index.js'

const FIXTURE_DIR = fileURLToPath(new URL('../apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${String(STATIC_PORT)}`
/** How long the new service's settings are held back, and the bound far above it, so that only the wait itself ends the hold. */
const PAD_MS = 6_000
const BOUND_MS = 20_000
/** Well inside the wait, long enough for a request that is not held to have reached the server. */
const INSIDE_THE_WAIT_MS = 2_000

let fixtureServer: ChildProcess
let shown: CountedPage

beforeAll(async () => {
  fixtureServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', fixtureServer)
  shown = await startCountedPage((path) => (path === '/' ? 'embedded' : `embedded ${path.slice(1)}`))
  await waitForTcpReady(HOST, STATIC_PORT, 10_000)
}, 30_000)

afterAll(async () => {
  await killChild(fixtureServer)
  await shown.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** The element's surface this file drives. */
interface WebviewLike extends HTMLElement {
  src: string
  loadURL: (url: string) => Promise<void>
  getTitle: () => string
}

function manifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.embed-network-service-e2e',
    name: 'Orivon embed network service e2e fixture',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: { web: { embed: { origins: [`http://${HOST}:${String(shown.port)}`] } } }
  }
}

it('holds a request of a page shown in a <webview> until the network service has its settings back', async () => {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_TEST_NETWORK_SERVICE_REAPPLY_DELAY_MS: String(PAD_MS), ORIVON_TEST_NETWORK_SERVICE_HOLD_BOUND_MS: String(BOUND_MS) }
  })
  try {
    const granted = await app.evaluate(async (_electron, request: DevGrantRequest) => {
      const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
      return typeof hook === 'function' ? { installed: true as const, grant: await hook(request) } : { installed: false as const }
    }, { origin: FIXTURE_ORIGIN, manifest: manifest(), capability: 'web.embed', patterns: [`http://${HOST}:${String(shown.port)}`] } satisfies DevGrantRequest)
    expect(granted.installed, 'the developer-only grant hook is installed in this build').toBe(true)

    const view = await navigateToFixture(app, `${FIXTURE_ORIGIN}/`, 'Orivon fixture app')
    const first = await view.evaluate(async (url: string) => {
      const el = document.createElement('webview') as WebviewLike
      const done = new Promise<string>((resolve) => {
        el.addEventListener('did-finish-load', () => { resolve('finished') })
        el.addEventListener('did-fail-load', () => { resolve('failed') })
        setTimeout(() => { resolve('timeout') }, 15_000)
      })
      el.src = url
      el.style.width = '400px'
      el.style.height = '300px'
      document.body.appendChild(el)
      ;(window as unknown as { __shownView: WebviewLike }).__shownView = el
      return await done
    }, shown.url)
    expect(first).toBe('finished')
    expect(shown.hits('/')).toBeGreaterThan(0)

    const pid = await networkServicePid(app)
    expect(pid).toBeGreaterThan(0)
    process.kill(pid, 'SIGKILL')
    expect(await waitFor(async () => (await seamOf(app)).ended === 1, 15_000)).toBe(true)

    await view.evaluate((url: string) => {
      const el = (window as unknown as { __shownView: WebviewLike }).__shownView
      ;(window as unknown as { __secondLoad: Promise<string> }).__secondLoad = el.loadURL(url).then(() => 'finished', (error: unknown) => `failed: ${String(error)}`)
    }, `http://127.0.0.1:${String(shown.port)}/second`)
    await delay(INSIDE_THE_WAIT_MS)
    expect(shown.hits('/second'), 'the request waits instead of reaching the server').toBe(0)
    expect((await seamOf(app)).resent, 'the settings are still held back').toBe(0)

    expect(await view.evaluate(async () => await (window as unknown as { __secondLoad: Promise<string> }).__secondLoad)).toBe('finished')
    expect(shown.hits('/second')).toBeGreaterThan(0)
    expect(await view.evaluate(() => (window as unknown as { __shownView: WebviewLike }).__shownView.getTitle())).toBe('embedded second')
    const after = await seamOf(app)
    expect(after.resent).toBe(1)
    expect(after.holds).toEqual([{ outcome: 'reapplied', requests: expect.any(Number) as number }])
    expect(after.holds[0]!.requests).toBeGreaterThanOrEqual(1)
  } finally {
    await closeElectronApp(app)
  }
}, QA_TEST_TIMEOUT_MS)
