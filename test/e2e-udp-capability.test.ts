// The UDP half of the end-to-end capability test, in its own file because
// ./e2e-capability-boundary.test.ts is a whole suite already and Rule 2 caps a
// test at 800 lines. The shared harness lives in ./e2e-helpers.ts.
//
// WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT. Phase 1 drives the REAL
// shell: window.orivon.net.udpBind exists on a real page, a real call reaches
// the real broker's real policy check over real Electron IPC, and comes back
// 'denied' -- not a timeout, not a crash, not a malformed error, not a silent
// success. It is denied because NOTHING GRANTS A PRODUCTION ORIGIN ANYTHING
// until build step 4's permission prompt exists; that is the same honest
// position ./e2e-capability-boundary.test.ts's Phase 1 is in, not a defect
// here. Phase 2 takes the granted path as far as it can go: the real broker,
// the real node:dgram adapter, a real separate echo-server process, real
// datagrams -- just not carried over Electron IPC, because nothing grants the
// fixture's origin anything on that path either.
//
// THE FIXTURE IS NOT EXTENDED FOR THIS. apps/fixture/.well-known/orivon.json
// declares only tcp.connect, and apps/fixture/ belongs to the `fixture-app`
// stream (parallel-work.md's ownership map). It does not need to change:
// GrantLedger.grant does not check the manifest declaration -- the subset check
// is the permission prompt's job -- so Phase 2's test-only grant works without
// it, and Phase 1's denial does not depend on what the manifest says.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { launchElectron } from './launch-electron.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, clickAddressBarRetrying, forwardOutput, killChild, runPhase,
  waitForAddressBarStable, waitForTcpReady
} from './e2e-helpers.js'
import {
  evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab
} from './smoke-helpers.mjs'
import { HOST, STATIC_PORT } from '../apps/fixture/config.mjs'
import { createBroker } from '../src/broker/index.js'
import type { BrokerFs, CreateBrokerOptions, Keychain } from '../src/broker/broker-contracts.js'
import { dialTcp, listenTcp, resolveHost } from '../src/broker/adapters/node-adapters.js'
import { bindUdp } from '../src/broker/adapters/udp-adapter.js'
import type { Datagram } from '../src/contracts/index.js'

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_DIR = fileURLToPath(new URL('../apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`

/** The echo server's port. Distinct from apps/fixture/config.mjs's TCP ports so a stray process from either suite cannot be mistaken for the other. */
const UDP_ECHO_PORT = 8875
/** A second port nothing listens on. Used only as a destination the grant does not cover -- it never has to answer. */
const UNGRANTED_PORT = 8876
/** Unprivileged, and deliberately not a range any unit test in this repo binds. */
const BIND_RANGE = '45000-45100'

const APP_CLOSE_RACE_MS = 8_000
const READY_TIMEOUT_MS = 10_000

let udpEcho: ChildProcess
let staticServer: ChildProcess

/**
 * Resolves when `child` prints a line containing `needle`.
 *
 * A UDP server cannot be probed the way waitForTcpReady probes a TCP one: a
 * datagram sent to an unbound port is silently discarded, so a probe cannot
 * distinguish "not listening yet" from "listening and not answering". The
 * server's own ready line is the only unambiguous signal, and waiting for a
 * condition rather than sleeping is still testing.md's rule.
 */
async function waitForLine (child: ChildProcess, needle: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`no line containing ${JSON.stringify(needle)} within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const onData = (buffer: Buffer): void => {
      if (!buffer.toString().includes(needle)) return
      cleanup()
      resolve()
    }
    function cleanup (): void {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
    }
    child.stdout?.on('data', onData)
  })
}

beforeAll(async () => {
  udpEcho = spawn(process.execPath, [join(TEST_DIR, 'udp-echo-server.mjs'), String(UDP_ECHO_PORT), HOST], { stdio: 'pipe' })
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  const ready = waitForLine(udpEcho, 'listening on', READY_TIMEOUT_MS)
  forwardOutput('udp-echo', udpEcho)
  forwardOutput('fixture-server', staticServer)
  await Promise.all([ready, waitForTcpReady(HOST, STATIC_PORT, READY_TIMEOUT_MS)])
}, 20_000)

afterAll(async () => {
  await Promise.all([killChild(udpEcho), killChild(staticServer)])
})

/** Reads exactly one datagram off `readable`, or resolves undefined past the deadline. */
async function readOneDatagram (
  readable: ReadableStream<Datagram>,
  timeoutMs = 5_000
): Promise<Datagram | undefined> {
  const reader = readable.getReader()
  try {
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs))
    const read = reader.read().then((r) => r.value)
    return await Promise.race([read, timeout])
  } finally {
    reader.releaseLock()
  }
}

it('Phase 1: window.orivon.net.udpBind exists on a real page and is correctly denied (no grant exists)', async () => {
  await runPhase('Phase 1 (udp)', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
    try {
      const windowsReady = await waitFor(() => app.windows().length === 2)
      check('the real shell reaches its launch-time window count', windowsReady,
        windowsReady ? undefined : `saw ${String(app.windows().length)} window(s)`)

      const chrome = findChrome(app)
      const addressBarStable = await waitForAddressBarStable(chrome)
      check('the address bar settles before the click', addressBarStable,
        addressBarStable ? undefined : `not stable within ${String(ADDRESS_BAR_STABLE_TIMEOUT_MS)}ms`)
      await clickAddressBarRetrying(chrome, FIXTURE_URL)

      const navigated = await waitForTab(chrome, { address: FIXTURE_URL, title: 'Orivon fixture app' })
      check('the shell navigates a real tab to the fixture app', navigated.ok,
        navigated.ok ? undefined : `saw ${JSON.stringify(navigated.info)}`)

      const view = findViewShowing(app, chrome, FIXTURE_URL)
      check('the fixture tab is identifiable by its own URL', view !== undefined)
      if (view === undefined) return

      const surface = await evaluateRetrying(view, () => {
        const net = (window as unknown as { orivon?: { net?: Record<string, unknown> } }).orivon?.net
        return { hasUdpBind: typeof net?.udpBind === 'function', hasConnect: typeof net?.connect === 'function' }
      })
      check('window.orivon.net.udpBind is a real function on a real page', surface.hasUdpBind,
        surface.hasUdpBind ? undefined : JSON.stringify(surface))
      check('net.connect is still there beside it', surface.hasConnect)

      // THE ASSERTION THIS PHASE EXISTS FOR. A real call, through the real
      // preload and main-world wiring, over real Electron IPC, into the real
      // broker's real checkBind -- answered 'denied' because no grant exists.
      // A timeout, a crash, a malformed error or a silent success would each
      // read differently here, and each would be a genuine regression.
      const outcome = await evaluateRetrying(view, async () => {
        const orivon = (window as unknown as {
          orivon: { net: { udpBind: (o: { port: number }) => Promise<unknown> } }
        }).orivon
        try {
          await orivon.net.udpBind({ port: 45000 })
          return { kind: 'resolved' }
        } catch (error) {
          const e = error as { name?: string, code?: string, platformCode?: string }
          return { kind: 'rejected', name: e?.name, code: e?.code, platformCode: e?.platformCode }
        }
      })

      check("a real udpBind call is REJECTED, not silently resolved", outcome.kind === 'rejected',
        JSON.stringify(outcome))
      check("the rejection is a real OrivonError coded 'denied'",
        outcome.kind === 'rejected' && outcome.name === 'OrivonError' && outcome.code === 'denied',
        JSON.stringify(outcome))
      check('the denial carries no platformCode (errors.ts uniformity rule)',
        outcome.platformCode === undefined, JSON.stringify(outcome))
    } finally {
      const closed = await Promise.race([
        app.close().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), APP_CLOSE_RACE_MS))
      ])
      if (!closed) console.error('[e2e-udp] app.close() did not settle; the run continues')
    }
  })
}, 140_000)

it('Phase 2: the real broker binds a real UDP socket, round-trips a datagram, and refuses an ungranted destination', async () => {
  await runPhase('Phase 2 (udp)', async (check) => {
    const fsStub: BrokerFs = {
      rootFor: () => { throw new Error('fs is not exercised by this test') },
      realpathSync: () => { throw new Error('fs is not exercised by this test') },
      readFile: async () => { throw new Error('fs is not exercised by this test') },
      writeFile: async () => { throw new Error('fs is not exercised by this test') }
    }
    const keychainStub: Keychain = {
      getSeed: async () => { throw new Error('identity is not exercised by this test') }
    }
    const deps: CreateBrokerOptions = {
      dial: dialTcp,
      bind: bindUdp,
      listen: listenTcp,
      resolve: resolveHost,
      now: () => Date.now(),
      fs: fsStub,
      keychain: keychainStub
    }
    const broker = createBroker(deps)
    await broker.registerApp(FIXTURE_ORIGIN, {
      orivonApiVersion: 0,
      id: 'app.orivon.fixture.udp',
      name: 'Orivon Fixture (udp)',
      version: '0.1.0',
      entry: 'index.html',
      capabilities: { net: { udp: { bind: [BIND_RANGE], send: [`${HOST}:${String(UDP_ECHO_PORT)}`] } } }
    })
    await broker.grant(FIXTURE_ORIGIN, 'udp.bind', [BIND_RANGE])
    await broker.grant(FIXTURE_ORIGIN, 'udp.send', [`${HOST}:${String(UDP_ECHO_PORT)}`])

    // ---- the bind lands inside what was granted
    const socket = await broker.net.udpBind(FIXTURE_ORIGIN, { port: 0 })
    try {
      check('an ephemeral bind lands inside the granted range, not wherever the OS chose (A88)',
        socket.localPort >= 45000 && socket.localPort <= 45100, `bound ${String(socket.localPort)}`)

      // ---- the granted destination round-trips real bytes
      const payload = `udp e2e ${new Date().toISOString()}`
      const outcome = await socket.send({
        data: new TextEncoder().encode(payload), address: HOST, port: UDP_ECHO_PORT, family: 'IPv4'
      })
      check('a datagram to the granted destination is accepted', outcome.sent, JSON.stringify(outcome))

      const echoed = await readOneDatagram(socket.readable)
      const text = echoed === undefined ? undefined : new TextDecoder().decode(echoed.data)
      check('the real echo server returns the exact bytes sent', text === payload,
        `sent ${JSON.stringify(payload)}, received ${JSON.stringify(text)}`)
      check('the reply carries the real source address and port',
        echoed?.address === HOST && echoed?.port === UDP_ECHO_PORT, JSON.stringify(echoed?.address))

      // ---- THE ASSERTION THE WHOLE FILE EXISTS FOR
      const refused = await socket.send({
        data: new TextEncoder().encode('should never leave'),
        address: HOST,
        port: UNGRANTED_PORT,
        family: 'IPv4'
      })
      check("a datagram outside the granted pattern is refused with a real 'denied'",
        !refused.sent && refused.code === 'denied', JSON.stringify(refused))
      check('the refusal carries no platformCode (errors.ts uniformity rule)',
        refused.sent || refused.platformCode === undefined, JSON.stringify(refused))

      // ---- and the refusal did NOT kill the socket (A87)
      const afterRefusal = await socket.send({
        data: new TextEncoder().encode(payload), address: HOST, port: UDP_ECHO_PORT, family: 'IPv4'
      })
      check('the socket still works after a refused datagram -- one excluded peer must not end a swarm (A87)',
        afterRefusal.sent, JSON.stringify(afterRefusal))
      const echoedAgain = await readOneDatagram(socket.readable)
      check('and it still round-trips real bytes afterwards',
        echoedAgain !== undefined && new TextDecoder().decode(echoedAgain.data) === payload)

      // ---- revocation reaches an already-bound socket
      const [sendGrant] = (await broker.app.grants(FIXTURE_ORIGIN))
        .filter((g) => g.capability === 'udp.send')
      // Unconditional on purpose: silently skipping the revoke when this comes back
      // empty would still fail the check below (the socket keeps sending), but at
      // the wrong place, blaming revocation for what is actually a broken grant
      // lookup. Fail here, at the real cause.
      if (sendGrant === undefined) throw new Error('expected FIXTURE_ORIGIN to hold a udp.send grant to revoke, but grants() returned none')
      await broker.revoke(FIXTURE_ORIGIN, sendGrant.id)
      const afterRevoke = await socket.send({
        data: new TextEncoder().encode(payload), address: HOST, port: UDP_ECHO_PORT, family: 'IPv4'
      })
      check('revoking udp.send stops the NEXT datagram on an already-bound socket (A70\'s lesson)',
        !afterRevoke.sent && afterRevoke.code === 'denied', JSON.stringify(afterRevoke))
    } finally {
      await socket.close().catch(() => {})
    }
  })
}, 60_000)
