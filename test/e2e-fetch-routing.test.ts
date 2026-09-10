// Queue item 3.4 (docs/planning/unattended-build-queue.md), ADR-0017: the
// page's own `fetch()` is routed through orivon.net for a granted host,
// carrying app-chosen headers a page cannot normally set, and refusing an
// ungranted host without a prompt.
//
// SAME SHAPE AS ./e2e-connect-secure-capability.test.ts's Phase 2: grants
// through src/main/dev-grant.ts's hook, BEFORE navigating rather than after
// -- src/preload/fetch-route.ts's install gate (`orivon.app.manifest()`
// resolving) runs ONCE, synchronously with page load, so the origin must
// already be registered by the time this tab's preload runs, unlike
// net.connect/connectSecure's own per-call check which works either order.
//
// Uses PLAIN HTTP (net.connect), not net.connectSecure: e2e-connect-secure-
// capability.test.ts's own header explains why a real byte round trip over
// TLS cannot be proven hermetically here (no way to make an unmodified
// production build trust a locally generated certificate). Plain HTTP has
// no such gap -- this file proves an actual granted byte round trip, with
// the server's own view of what it received, not just a policy decision.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, forwardOutput, killChild, navigateToFixture, runPhase, waitForTcpReady } from './e2e-helpers.js'
import { HOST, STATIC_PORT } from '../apps/fixture/config.mjs'
import type { DevGrantRequest } from '../src/main/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const FIXTURE_DIR = fileURLToPath(new URL('../apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`

/**
 * Fixed, not ephemeral -- same reasoning as e2e-connect-secure-capability.
 * test.ts's own TLS_PORT: a value closed over from outside an
 * evaluateRetrying/app.evaluate callback does not survive Playwright's
 * serialisation, so every port used inside one below is a literal, which
 * only works if it is known ahead of time. Distinct from every port already
 * in use elsewhere in this suite (8872/8873/8875/8876/8877).
 */
const PROBE_PORT = 8879
/** Nothing ever listens here -- the grant check denies before any dial is attempted, same precedent as every other capability e2e in this repo. */
const DENIED_PORT = 8880

const TEST_TIMEOUT_MS = 120_000

let staticServer: ChildProcess
let probeServer: Server

beforeAll(async () => {
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', staticServer)

  // Echoes back exactly what it received -- method, headers, body -- as
  // JSON, so the PAGE's own fetch() response is the proof of what actually
  // went out on the wire, not a separate server-side capture that could
  // race which request it belongs to.
  probeServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
  })
  await Promise.all([
    new Promise<void>((resolve) => { probeServer.listen(PROBE_PORT, HOST, resolve) }),
    waitForTcpReady(HOST, STATIC_PORT, 10_000)
  ])
}, 15_000)

afterAll(async () => {
  await Promise.all([
    killChild(staticServer),
    new Promise<void>((resolve) => { probeServer.close(() => resolve()) })
  ])
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('a real page\'s fetch() reaches a granted host with an app-set Origin and no ambient credentials, ' +
   'and refuses an ungranted host with no prompt', async () => {
  await runPhase('fetch routing', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
    try {
      // Granted BEFORE navigation -- see this file's own header for why
      // that order matters here, unlike every other capability e2e.
      const grantPattern = `${HOST}:${PROBE_PORT}`
      const manifest: Manifest = {
        orivonApiVersion: 0,
        id: 'app.orivon.fixture.fetch-routing',
        name: 'Orivon Fixture (fetch routing)',
        version: '0.1.0',
        entry: 'index.html',
        capabilities: { net: { tcp: { connect: [grantPattern] } } }
      }
      const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return { installed: false as const }
        return { installed: true as const, grant: await hook(request) }
      }, { origin: FIXTURE_ORIGIN, manifest, capability: 'tcp.connect', patterns: [grantPattern] } satisfies DevGrantRequest)
      check(
        'the developer-only grant hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)',
        grantOutcome.installed,
        grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
      )
      if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

      const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

      // (a) THE GRANTED HOST: an app-set Origin (forbidden on an ordinary
      // page), a plain custom header, and NO Cookie header -- the probe
      // server's own JSON echo is the proof of what actually crossed the
      // wire, not a claim this file makes about its own code.
      const granted = await evaluateRetrying(view, async () => {
        try {
          const response = await fetch('http://127.0.0.1:8879/probe', {
            headers: { Origin: 'https://impersonated.example', 'X-Marker': 'orivon-e2e' }
          })
          const json = await response.json() as { method: string, headers: Record<string, string> }
          return { ok: true as const, status: response.status, ...json }
        } catch (e) {
          return { ok: false as const, message: (e as Error)?.message }
        }
      })
      check('a granted host is reached and answers 200', granted.ok && granted.status === 200, JSON.stringify(granted))
      check(
        'the app-set Origin header -- one an ordinary page may never set -- arrived at the server verbatim',
        granted.ok && granted.headers?.origin === 'https://impersonated.example',
        JSON.stringify(granted)
      )
      check(
        'an ordinary app-set header arrives alongside it',
        granted.ok && granted.headers?.['x-marker'] === 'orivon-e2e',
        JSON.stringify(granted)
      )
      check(
        'no ambient Cookie header was attached -- this partition has never set one, and nothing here would attach it automatically',
        granted.ok && granted.headers?.cookie === undefined,
        JSON.stringify(granted)
      )

      // (b) header freedom covers Cookie specifically too, when the APP
      // supplies it -- proving the earlier absence is "no jar", not "Cookie
      // is filtered like an ordinary page's fetch would filter it".
      const withCookie = await evaluateRetrying(view, async () => {
        const response = await fetch('http://127.0.0.1:8879/probe', { headers: { Cookie: 'session=app-managed' } })
        const json = await response.json() as { headers: Record<string, string> }
        return json.headers?.cookie
      })
      check('an app-supplied Cookie header is sent verbatim, unlike an ordinary page\'s fetch', withCookie === 'session=app-managed', String(withCookie))

      // (c) THE UNGRANTED HOST: denied outright, no prompt, before any dial
      // -- nothing needs to be listening on DENIED_PORT for this to hold.
      const denied = await evaluateRetrying(view, async () => {
        try {
          await fetch('http://127.0.0.1:8880/x')
          return { rejected: false as const }
        } catch (e) {
          return { rejected: true as const, name: (e as Error)?.name, message: (e as Error)?.message }
        }
      })
      check(
        'an ungranted host is refused -- fetch() rejects with a TypeError, matching the Fetch spec\'s own network-error shape, never a resolved Response',
        denied.rejected && denied.name === 'TypeError',
        JSON.stringify(denied)
      )
    } finally {
      await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
