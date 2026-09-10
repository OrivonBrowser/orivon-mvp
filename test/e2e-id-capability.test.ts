// The end-to-end test for orivon.id.publicKey/sign (queue item 2.5), same
// two-phase shape as ./e2e-capability-boundary.test.ts and for the same
// reason -- see that file's own header before changing this one's shape.
//
// Phase 1 proves the real pipe: window.orivon.id.publicKey/sign exist on a
// real page in the real launched shell, reached over real Electron IPC and
// the real broker's real grant check -- and, because nothing in production
// calls broker.grant() for any origin yet (id.publicKey/sign's own doc,
// ../src/broker/broker-contracts.ts), correctly come back 'denied', not a
// timeout, a crash, or a silent success. Exactly Phase 1's own precedent for
// net.connect, applied to id.
//
// Phase 2 is what Phase 1 cannot show: a REAL grant. It builds its own
// Broker directly (real WebCrypto derivation, a keychain stub standing in
// for ADR-0003's safeStorage-backed one -- production's own keychain still
// throws 'internal', see ../src/broker/transport/ipc.ts, but that is
// unreachable in Phase 1 because the 'denied' grant check answers first),
// grants 'id' for one curve, and proves publicKey/sign work under it, that a
// different (ungranted) curve is still denied, and that revoking the grant
// denies a subsequent call.
//
// UPDATED (docs/planning/unattended-build-queue.md item 0.3): the grant
// itself now goes through src/main/dev-grant.ts's hook rather than this file
// calling broker.registerApp()/grant() directly. revoke() and app.grants()
// below stay direct broker calls -- neither has a page-facing equivalent (a
// page must never revoke its own grant), so there is no "test-only API"
// question for them to raise the way there was for the grant itself.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts
//
// NOT RUN AS PART OF THIS LANE'S OWN VERIFICATION -- see the PR body's
// verification section. The conductor holds the Electron launch token.

import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { DEFAULT_ACTION_TIMEOUT_MS, launchElectron } from './launch-electron.mjs'
import {
  evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, WAIT_TIMEOUT_MS, waitFor, waitForTab
} from './smoke-helpers.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, clickAddressBarRetrying, forwardOutput, killChild, runPhase,
  waitForAddressBarStable, waitForTcpReady
} from './e2e-helpers.js'
import { HOST, STATIC_PORT } from '../apps/fixture/config.mjs'
import { createBroker } from '../src/broker/index.js'
import type { BrokerFs, CreateBrokerOptions, Keychain } from '../src/broker/broker-contracts.js'
import { dialTcp, listenTcp, resolveHost } from '../src/broker/adapters/node-adapters.js'
import { dialTls } from '../src/broker/adapters/tls-adapter.js'
import { bindUdp } from '../src/broker/adapters/udp-adapter.js'
import { isOrivonErrorLike } from '../src/broker/errors.js'
import { installDevGrantHook } from '../src/main/dev-grant.js'
import type { Manifest } from '../src/contracts/index.js'

// Trailing separator stripped -- fileURLToPath on a directory URL keeps it
// (apps/fixture/serve.mjs's own header documents this), which would make
// join() below point at apps/fixture//serve.mjs instead of inside it.
const FIXTURE_DIR = fileURLToPath(new URL('../apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`

/** Ceiling on the teardown-time `app.close()` race in Phase 1's `finally` block -- same figure and reason as e2e-capability-boundary.test.ts's own. */
const APP_CLOSE_RACE_MS = 8_000

/** Same walk as e2e-capability-boundary.test.ts's PHASE1_WAIT_BUDGET_MS, for the same real waits this file's Phase 1 makes. */
const PHASE1_WAIT_BUDGET_MS =
  WAIT_TIMEOUT_MS +
  ADDRESS_BAR_STABLE_TIMEOUT_MS +
  DEFAULT_ACTION_TIMEOUT_MS + ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 +
  WAIT_TIMEOUT_MS +
  WAIT_TIMEOUT_MS +
  WAIT_TIMEOUT_MS +
  APP_CLOSE_RACE_MS

const TEST_TIMEOUT_MS = PHASE1_WAIT_BUDGET_MS + 12_000

let staticServer: ChildProcess

beforeAll(async () => {
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', staticServer)
  await waitForTcpReady(HOST, STATIC_PORT, 10_000)
}, 15_000)

afterAll(async () => {
  await killChild(staticServer)
})

it('Phase 1: the real shell launches, and a real id.publicKey/sign through the full IPC pipe are correctly denied (no grant exists)', async () => {
  await runPhase('Phase 1', async (check) => {
    try {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const windowsReady = await waitFor(() => app.windows().length === 2)
        check(
          'the real shell reaches its launch-time window count (chrome + one default tab)',
          windowsReady,
          windowsReady ? undefined : `saw ${app.windows().length} window(s)`
        )

        const chrome = findChrome(app)
        const addressBarStable = await waitForAddressBarStable(chrome)
        check(
          "the address bar's own layout settles before the click (C6 CI-runner layout race)",
          addressBarStable,
          addressBarStable ? undefined : `did not read stable within ${ADDRESS_BAR_STABLE_TIMEOUT_MS}ms`
        )
        await clickAddressBarRetrying(chrome, FIXTURE_URL)

        const navigated = await waitForTab(chrome, { address: FIXTURE_URL, title: 'Orivon fixture app' })
        check(
          'the real shell navigates a real tab to the fixture app over real localhost HTTP',
          navigated.ok,
          navigated.ok ? undefined : `saw ${JSON.stringify(navigated.info)}`
        )

        const view = findViewShowing(app, chrome, FIXTURE_URL)
        check('the fixture tab is identifiable by its own URL', view !== undefined)

        if (view !== undefined) {
          await evaluateRetrying(view, async () => {
            const deadline = Date.now() + 5_000
            while (document.getElementById('status')?.textContent === 'Loading...' && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 50))
            }
          })

          const state = await evaluateRetrying(view, async () => {
            const orivon = (window as unknown as {
              orivon: {
                id: {
                  publicKey: (opts: { curve: string }) => Promise<Uint8Array>
                  sign: (opts: { curve: string, payload: Uint8Array }) => Promise<Uint8Array>
                }
              }
            }).orivon

            let publicKeyIsThenable = false
            let publicKeyError
            try {
              const pending = orivon.id.publicKey({ curve: 'P-256' })
              publicKeyIsThenable = typeof (pending as unknown as { then?: unknown })?.then === 'function'
              await pending
            } catch (e) {
              const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
              publicKeyError = { code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode }
            }

            let signError
            try {
              await orivon.id.sign({ curve: 'P-256', payload: new Uint8Array([1, 2, 3]) })
            } catch (e) {
              const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
              signError = { code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode }
            }

            return {
              hasOrivonId: typeof (window as unknown as { orivon?: { id?: unknown } }).orivon?.id,
              hasPublicKey: typeof (window as unknown as { orivon?: { id?: { publicKey?: unknown } } }).orivon?.id?.publicKey,
              hasSign: typeof (window as unknown as { orivon?: { id?: { sign?: unknown } } }).orivon?.id?.sign,
              publicKeyIsThenable,
              publicKeyError,
              signError
            }
          })

          check(
            'window.orivon.id IS present -- the preload wiring this lane added',
            state.hasOrivonId === 'object',
            JSON.stringify(state)
          )
          check(
            'window.orivon.id.publicKey and .sign ARE callable functions, not merely truthy placeholders',
            state.hasPublicKey === 'function' && state.hasSign === 'function',
            JSON.stringify(state)
          )
          check(
            'orivon.id.publicKey() returns a real thenable synchronously, before any rejection',
            state.publicKeyIsThenable,
            JSON.stringify(state)
          )
          check(
            'a real id.publicKey call through the full IPC pipe is denied with a real, correctly-shaped ' +
            'OrivonError -- not a timeout, a crash, or a malformed response (nothing grants id in production yet)',
            state.publicKeyError?.name === 'OrivonError' &&
            state.publicKeyError?.code === 'denied' &&
            state.publicKeyError?.platformCode === undefined,
            JSON.stringify(state)
          )
          check(
            'a real id.sign call through the full IPC pipe is denied the same way',
            state.signError?.name === 'OrivonError' &&
            state.signError?.code === 'denied' &&
            state.signError?.platformCode === undefined,
            JSON.stringify(state)
          )
        }
      } finally {
        const chromeForTeardown = app.windows().find((w) => w.url().endsWith('/renderer/index.html'))
        if (chromeForTeardown !== undefined) {
          const ids: string[] = await evaluateRetrying(chromeForTeardown, () =>
            Array.from(document.querySelectorAll('.tab')).map((el) => (el as HTMLElement).dataset.id ?? '')
          ).catch(() => [])
          for (const id of ids) {
            await chromeForTeardown.click(`[data-id="${id}"] .close`).catch(() => {})
          }
        }
        await waitFor(() => app.windows().length === 0)
        const closed = await Promise.race([
          app.close().then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), APP_CLOSE_RACE_MS))
        ])
        if (!closed) app.process().kill()
      }
    } catch (e) {
      check(
        'Phase 1 (real shell launch + navigation) ran without the known _electron attach issue ' +
        'reproducing (docs/open-questions.md C6) or any other uncaught failure',
        false,
        String((e as Error)?.stack ?? e)
      )
    }
  })
}, TEST_TIMEOUT_MS)

/** 32 varying, non-secret bytes -- an all-repeated seed trips derive.ts's own degenerate-seed guard. */
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1)

function testManifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'org.orivon.fixture',
    name: 'Orivon fixture app',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: { id: { curves: ['P-256', 'secp256k1'] } }
  }
}

it('Phase 2: the real broker signs under a real id grant, and denies an ungranted curve', async () => {
  await runPhase('Phase 2', async (check) => {
    try {
      const fsStub: BrokerFs = {
        rootFor: () => { throw new Error('fs is not exercised by this test') },
        realpathSync: () => { throw new Error('fs is not exercised by this test') },
        readFile: async () => { throw new Error('fs is not exercised by this test') },
        writeFile: async () => { throw new Error('fs is not exercised by this test') }
      }
      // Stands in for ADR-0003's safeStorage-backed seed. Production's own
      // keychain (../src/broker/transport/ipc.ts) still throws 'internal' --
      // unreachable there today because the grant check answers 'denied'
      // first, which Phase 1 above proves directly. Wiring a real
      // safeStorage-backed keychain is separate work, not this lane's (see
      // this file's own header and the PR body).
      const keychain: Keychain = { getSeed: async () => TEST_SEED }
      const deps: CreateBrokerOptions = {
        dial: dialTcp,
        dialSecure: dialTls,
        bind: bindUdp,
        listen: listenTcp,
        resolve: resolveHost,
        now: () => Date.now(),
        fs: fsStub,
        keychain
      }
      const broker = createBroker(deps)

      // THE GRANT ITSELF, through src/main/dev-grant.ts's hook rather than
      // this test calling registerApp()/grant() directly -- see this file's
      // header. installDevGrantHook installs onto whatever Broker it is
      // given; here that is this test's own locally-constructed one.
      installDevGrantHook(broker)
      const grant = globalThis.__orivonDevGrant
      if (grant === undefined) throw new Error('installDevGrantHook did not install globalThis.__orivonDevGrant')
      await grant({ origin: FIXTURE_ORIGIN, manifest: testManifest(), capability: 'id', patterns: ['P-256'] })

      // (a) THE GRANTED PATH. A real WebCrypto-derived key, and a real
      // ECDSA signature over it, verified with WebCrypto's own subtle.verify
      // -- not merely "it did not throw".
      try {
        const publicKey = await broker.id.publicKey(FIXTURE_ORIGIN, { curve: 'P-256' })
        const payload = new TextEncoder().encode(`e2e sign ${new Date().toISOString()}`)
        const signature = await broker.id.sign(FIXTURE_ORIGIN, { curve: 'P-256', payload })

        const verifyKey = await crypto.subtle.importKey(
          'raw', publicKey as Uint8Array<ArrayBuffer>, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
        )
        const verified = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' }, verifyKey,
          signature as Uint8Array<ArrayBuffer>, payload as Uint8Array<ArrayBuffer>
        )
        check(
          'the granted id.publicKey/sign produce a real, independently verifiable P-256 signature',
          publicKey.length === 65 && publicKey[0] === 0x04 && verified,
          `publicKey.length=${String(publicKey.length)}, verified=${String(verified)}`
        )
      } catch (e) {
        check('the granted id.publicKey/sign succeed', false, String((e as Error)?.stack ?? e))
      }

      // (b) THE UNGRANTED CURVE. The manifest declares secp256k1 too, but
      // only P-256 was ever granted -- capability-api.md's "declare
      // statically, grant dynamically" rule, exercised for real.
      try {
        await broker.id.publicKey(FIXTURE_ORIGIN, { curve: 'secp256k1' })
        check('an ungranted curve is rejected', false, 'the call resolved instead of rejecting')
      } catch (e) {
        const denied = isOrivonErrorLike(e) && e.code === 'denied'
        check(
          'a curve declared but never granted is denied with a real \'denied\'-coded OrivonError',
          denied,
          denied ? undefined : String((e as Error)?.stack ?? e)
        )
        if (denied && isOrivonErrorLike(e)) {
          check('the denial carries no platformCode', e.platformCode === undefined, JSON.stringify(e))
        }
      }

      // (c) REVOCATION. The same grant, withdrawn, denies the next call --
      // handle-contracts.md's revocation rule, exercised against a real
      // GrantLedger rather than assumed from the unit tests alone.
      const grants = await broker.app.grants(FIXTURE_ORIGIN)
      const idGrant = grants.find((g) => g.capability === 'id')
      check('the id grant is visible via app.grants() before revocation', idGrant !== undefined, JSON.stringify(grants))
      if (idGrant !== undefined) {
        await broker.revoke(FIXTURE_ORIGIN, idGrant.id)
        try {
          await broker.id.sign(FIXTURE_ORIGIN, { curve: 'P-256', payload: new Uint8Array(1) })
          check('sign is denied after revocation', false, 'the call resolved instead of rejecting')
        } catch (e) {
          const denied = isOrivonErrorLike(e) && e.code === 'denied'
          check('sign is denied after the id grant is revoked', denied, denied ? undefined : String((e as Error)?.stack ?? e))
        }
      }
    } catch (e) {
      check('Phase 2 (real broker exercise) ran without an unexpected failure', false, String((e as Error)?.stack ?? e))
    }
  })
}, TEST_TIMEOUT_MS)
