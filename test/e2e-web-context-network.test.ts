// NON-HERMETIC: this file needs the real internet, and is deliberately kept
// out of ./e2e-web-context.test.ts (which is hermetic-by-construction --
// see that file's own header) for exactly that reason. It exists to prove
// ADR-0019's network path end to end, past the point every other test in
// this stream can reach without a real remote server: a context whose
// opener holds a real `https.connect` grant for the context's own host can
// `fetch()` it and get back a REAL response, through
// src/loader/electron/serve.ts's `reachOnlyHandlerFor` and the REAL
// `nodeReachDial()` -- the same "there is no hermetic way to prove a
// granted byte round trip without either weakening trust or reaching a
// real public host" position ./e2e-connect-secure-capability.test.ts's own
// header already states for net.connectSecure, applied here instead of
// accepting the same "authorised, but not fetched" consolation prize that
// file settles for -- ADR-0019's own capability is worthless if this exact
// path silently never resolves the promise it makes to a real site's own
// bot-check, so this one case pays the non-hermetic cost rather than
// leaving it unproven.
//
// Everything else about this file's shape -- launch, the dev-grant hook,
// teardown -- is identical to its hermetic sibling; only the launch args
// (no HERMETIC_RESOLVER) and the grant (adds https.connect) differ.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-web-context-network.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying } from './smoke-helpers.mjs'
import { closeElectronApp, forwardOutput, killChild, navigateToFixture, runPhase, waitForTcpReady } from './e2e-helpers.js'
import { HOST, STATIC_PORT } from './apps/fixture/config.mjs'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`
const CONTEXT_ORIGIN = 'https://example.com'

const TEST_TIMEOUT_MS = 60_000

let staticServer: ChildProcess

beforeAll(async () => {
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', staticServer)
  await waitForTcpReady(HOST, STATIC_PORT, 10_000)
}, 15_000)

afterAll(async () => {
  await killChild(staticServer)
  expect(await assertNoElectronSurvivors()).toEqual([])
})

function testManifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.web-context-network-e2e',
    name: 'Orivon web-context network e2e fixture',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: {
      web: { contexts: [CONTEXT_ORIGIN] },
      net: { https: { connect: ['example.com:443'] } }
    }
  }
}

it('a context whose opener holds https.connect for example.com:443 can fetch its own origin and get a real response', async () => {
  await runPhase('web.context network e2e', async (check) => {
    // Deliberately NO HERMETIC_RESOLVER -- this launch needs real DNS.
    const app = await launchElectron({ appPath: '.' })
    try {
      const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return { installed: false as const }
        return { installed: true as const, grant: await hook(request) }
      }, {
        origin: FIXTURE_ORIGIN, manifest: testManifest(), capability: 'web.context', patterns: [CONTEXT_ORIGIN]
      } satisfies DevGrantRequest)
      check(
        'the developer-only grant hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)',
        grantOutcome.installed,
        grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
      )
      if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

      const secureGrantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return { installed: false as const }
        return { installed: true as const, grant: await hook(request) }
      }, {
        origin: FIXTURE_ORIGIN, manifest: testManifest(), capability: 'https.connect', patterns: ['example.com:443']
      } satisfies DevGrantRequest)
      check('the https.connect grant landed too', secureGrantOutcome.installed, JSON.stringify(secureGrantOutcome))

      const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

      const result = await evaluateRetrying(view, async () => {
        const orivon = (window as unknown as {
          orivon: { web: { openContext: (origin: string, options?: { width?: number, height?: number }) => Promise<{
            evaluate: (script: string) => Promise<unknown>
            close: () => Promise<void>
          }> } }
        }).orivon
        const context = await orivon.web.openContext('https://example.com')
        try {
          return await context.evaluate(
            'fetch(\'https://example.com/\').then(r => ({ok: r.ok, status: r.status})).catch(e => ({threw: String(e && e.message)}))'
          )
        } finally {
          await context.close()
        }
      }, 30_000)

      check(
        'a granted context reaches its own real, live origin and gets back an ok response',
        (result as { ok?: boolean }).ok === true,
        JSON.stringify(result)
      )
    } finally {
      await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)

// A context "has no network of its own" (ADR-0019), and WebRTC's ICE/STUN/
// TURN dial is the one path docs/open-questions.md A41 already names as not
// passing through protocol.handle/webRequest -- src/main/web-context-host.ts's
// own two belts (setWebRTCIPHandlingPolicy + a session proxy pointed at the
// loopback discard port) are what closes it. Proven here against a REAL
// STUN server, not a fake one: a server-reflexive or relay candidate would
// mean the context reached the real internet over UDP/TCP outside every
// grant this app holds.
it('a context gathers no srflx or relay ICE candidate against a real STUN server -- WebRTC has no path out', async () => {
  await runPhase('web.context WebRTC e2e', async (check) => {
    const app = await launchElectron({ appPath: '.' })
    try {
      const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return { installed: false as const }
        return { installed: true as const, grant: await hook(request) }
      }, {
        origin: FIXTURE_ORIGIN, manifest: testManifest(), capability: 'web.context', patterns: [CONTEXT_ORIGIN]
      } satisfies DevGrantRequest)
      check(
        'the developer-only grant hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)',
        grantOutcome.installed,
        grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
      )
      if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

      const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

      const result = await evaluateRetrying(view, async () => {
        const orivon = (window as unknown as {
          orivon: { web: { openContext: (origin: string, options?: { width?: number, height?: number }) => Promise<{
            evaluate: (script: string) => Promise<unknown>
            close: () => Promise<void>
          }> } }
        }).orivon
        const context = await orivon.web.openContext('https://example.com')
        try {
          // Gathers for ~5s against a real public STUN server, then reports
          // every DISTINCT ICE candidate `.type` seen ('host', 'srflx',
          // 'prflx', 'relay') -- a plain array of strings, so the result
          // stays JSON-compatible per WebContext.evaluate's own contract.
          return await context.evaluate(`
            new Promise((resolve) => {
              const types = new Set();
              const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
              pc.onicecandidate = (event) => {
                if (event.candidate && event.candidate.type) types.add(event.candidate.type);
              };
              pc.createDataChannel('probe');
              pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
              setTimeout(() => {
                try { pc.close() } catch (e) {}
                resolve({ types: Array.from(types) });
              }, 5000);
            })
          `)
        } finally {
          await context.close()
        }
      }, 20_000)

      const types = (result as { types?: string[] }).types ?? []
      check(
        'no server-reflexive or relay candidate was gathered -- WebRTC never reached the real internet',
        !types.includes('srflx') && !types.includes('relay'),
        `candidate types observed: ${JSON.stringify(types)}`
      )
    } finally {
      await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
