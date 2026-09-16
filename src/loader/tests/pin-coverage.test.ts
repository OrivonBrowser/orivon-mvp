// Two layers, matching how this directory already splits "real bytes"
// proofs (electron-serve.ts's own header): arithmetic on the tracker alone,
// then the SAME tracker driven through the real createAppRequestHandler
// pipeline -- a stubbed reachDial for the branch coverage (serve.test.ts's
// own convention), and one real node:https server over a real TLS handshake
// (serve-reach.test.ts's own convention) so the content-length reading this
// file adds is proven against genuine network bytes, not just a mock.

import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleTree } from '../../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../broker/policy/pin.js'
import type { ConnectSecureDecision } from '../../broker/policy/connect-secure.js'
import { generateTlsFixture } from '../../broker/adapters/tests/tls-adapter.test-helpers.js'
import { createAppRequestHandler } from '../serve.js'
import type { AuthoriseReach, ReachDial } from '../serve.js'
import { nodeReachDial } from '../serve-reach.js'
import { createPinCoverageTracker } from '../pin-coverage.js'
import { manifestJson, memoryStorage, ORIGIN, utf8 } from './test-helpers.js'

describe('createPinCoverageTracker -- arithmetic', () => {
  it('starts at zero, with bytes complete', () => {
    const tracker = createPinCoverageTracker()
    expect(tracker.snapshot()).toEqual({
      pinnedRequests: 0, thirdPartyRequests: 0, deniedRequests: 0, pinnedBytes: 0, thirdPartyBytes: 0, bytesIncomplete: false
    })
  })

  it('sums bytes onto the right side, and counts requests separately from bytes', () => {
    const tracker = createPinCoverageTracker()
    tracker.record('pinned', 100)
    tracker.record('pinned', 50)
    tracker.record('third-party', 900)
    tracker.record('denied')

    expect(tracker.snapshot()).toEqual({
      pinnedRequests: 2, thirdPartyRequests: 1, deniedRequests: 1, pinnedBytes: 150, thirdPartyBytes: 900, bytesIncomplete: false
    })
  })

  it('a request with an unmeasured size still counts as a request, and marks bytesIncomplete rather than guessing zero', () => {
    const tracker = createPinCoverageTracker()
    tracker.record('pinned', 100)
    tracker.record('third-party', undefined)

    const snapshot = tracker.snapshot()
    expect(snapshot.thirdPartyRequests).toBe(1)
    expect(snapshot.thirdPartyBytes).toBe(0)
    expect(snapshot.bytesIncomplete).toBe(true)
    // The one MEASURED total stays exact -- an unmeasured THIRD-PARTY byte
    // count must never taint the separately-measured PINNED total.
    expect(snapshot.pinnedBytes).toBe(100)
  })

  it('a denied request is counted but never touches bytes at all', () => {
    const tracker = createPinCoverageTracker()
    tracker.record('denied', 12345) // a caller should never pass bytes here, but the tracker must not misfile it if one does
    expect(tracker.snapshot()).toEqual({
      pinnedRequests: 0, thirdPartyRequests: 0, deniedRequests: 1, pinnedBytes: 0, thirdPartyBytes: 0, bytesIncomplete: false
    })
  })

  it('snapshot() returns an independent object each call -- mutating one does not corrupt the tracker\'s own state', () => {
    const tracker = createPinCoverageTracker()
    tracker.record('pinned', 10)
    const first = tracker.snapshot() as { pinnedBytes: number }
    first.pinnedBytes = 999999
    tracker.record('pinned', 10)
    expect(tracker.snapshot().pinnedBytes).toBe(20)
  })
})

const INDEX_HTML = '<h1>hello orivon</h1>'
const APP_JS = 'console.log("hi")'.padEnd(300, ' /* padding, matching serve.test.ts\'s own fixture shape */ ')

async function installedStorage (): Promise<ReturnType<typeof memoryStorage>> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson()) },
    { path: '/index.html', content: utf8(INDEX_HTML) },
    { path: '/app.js', content: utf8(APP_JS) }
  ]
  const tree = await bundleTree(entries)
  const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)
  const storage = memoryStorage()
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, pin)
  return storage
}

function allow (host: string): ConnectSecureDecision {
  return { allowed: true, host }
}

describe('createAppRequestHandler -- pin coverage, through the real request pipeline', () => {
  it('two pinned requests: both counted, bytes exactly the served content lengths', async () => {
    const tracker = createPinCoverageTracker()
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, undefined, undefined, tracker.record
    )

    await handler(new Request(`${ORIGIN}/`))
    await handler(new Request(`${ORIGIN}/app.js`))

    expect(tracker.snapshot()).toEqual({
      pinnedRequests: 2,
      thirdPartyRequests: 0,
      deniedRequests: 0,
      pinnedBytes: INDEX_HTML.length + APP_JS.length,
      thirdPartyBytes: 0,
      bytesIncomplete: false
    })
  })

  it('A175: a satisfiable Range request counts only the sliced bytes actually served, never the whole pinned asset', async () => {
    const tracker = createPinCoverageTracker()
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, undefined, undefined, tracker.record
    )

    const total = utf8(APP_JS).length
    const response = await handler(new Request(`${ORIGIN}/app.js`, { headers: { range: 'bytes=0-4' } }))

    expect(response.status).toBe(206)
    const snapshot = tracker.snapshot()
    expect(snapshot.pinnedBytes).toBe(5) // bytes 0-4 inclusive
    expect(snapshot.pinnedBytes).not.toBe(total)
  })

  it('A175: many range requests against the same asset sum to the bytes actually served, not the asset size repeated per request', async () => {
    const tracker = createPinCoverageTracker()
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, undefined, undefined, tracker.record
    )

    for (let i = 0; i < 50; i++) {
      const response = await handler(new Request(`${ORIGIN}/app.js`, { headers: { range: 'bytes=0-9' } }))
      expect(response.status).toBe(206)
    }

    const snapshot = tracker.snapshot()
    expect(snapshot.pinnedRequests).toBe(50)
    expect(snapshot.pinnedBytes).toBe(50 * 10) // 10 bytes per request, never 50 * the whole asset
  })

  it('A175: an unsatisfiable Range (416) records zero bytes served, not the full asset size, and does not mark bytesIncomplete', async () => {
    const tracker = createPinCoverageTracker()
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, undefined, undefined, tracker.record
    )

    const total = utf8(APP_JS).length
    const response = await handler(new Request(`${ORIGIN}/app.js`, { headers: { range: `bytes=${total + 10}-${total + 20}` } }))

    expect(response.status).toBe(416)
    const snapshot = tracker.snapshot()
    expect(snapshot.pinnedBytes).toBe(0)
    expect(snapshot.bytesIncomplete).toBe(false)
  })

  it('A175: a denied request never adds bytes, even when the underlying asset has a real size', async () => {
    const tracker = createPinCoverageTracker()
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, undefined, undefined, tracker.record
    )

    const response = await handler(new Request(`${ORIGIN}/not-pinned.js`))

    expect(response.status).toBe(404)
    const snapshot = tracker.snapshot()
    expect(snapshot.pinnedBytes).toBe(0)
    expect(snapshot.deniedRequests).toBe(1)
  })

  it('a same-origin request outside the pinned set counts as denied, not pinned', async () => {
    const tracker = createPinCoverageTracker()
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, undefined, undefined, tracker.record
    )

    const response = await handler(new Request(`${ORIGIN}/not-pinned.js`))

    expect(response.status).toBe(404)
    expect(tracker.snapshot().deniedRequests).toBe(1)
    expect(tracker.snapshot().pinnedRequests).toBe(0)
  })

  it('a granted third-party request that succeeds counts its content-length as thirdPartyBytes', async () => {
    const tracker = createPinCoverageTracker()
    const reachDial: ReachDial = async () => new Response('0123456789', { status: 200, headers: { 'content-length': '10' } })
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, async () => allow('granted.example'), reachDial, tracker.record
    )

    await handler(new Request('https://granted.example/font.woff2'))

    expect(tracker.snapshot()).toMatchObject({ thirdPartyRequests: 1, thirdPartyBytes: 10, bytesIncomplete: false })
  })

  it('a granted third-party request whose response carries no content-length still counts as a request, marked incomplete rather than sized zero', async () => {
    const tracker = createPinCoverageTracker()
    const reachDial: ReachDial = async () => new Response('some bytes with no declared length')
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, async () => allow('granted.example'), reachDial, tracker.record
    )

    await handler(new Request('https://granted.example/font.woff2'))

    expect(tracker.snapshot()).toMatchObject({ thirdPartyRequests: 1, thirdPartyBytes: 0, bytesIncomplete: true })
  })

  it('an ungranted third-party request counts as denied, and reaches reachDial never', async () => {
    const tracker = createPinCoverageTracker()
    const reachDial: ReachDial = async () => new Response('should never be seen')
    const authoriseReach: AuthoriseReach = async () => ({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, authoriseReach, reachDial, tracker.record
    )

    await handler(new Request('https://not-granted.example/font.woff2'))

    expect(tracker.snapshot().deniedRequests).toBe(1)
    expect(tracker.snapshot().thirdPartyRequests).toBe(0)
  })

  it('reachDial throwing (a real connection failure) counts as denied, not a silently dropped observation', async () => {
    const tracker = createPinCoverageTracker()
    const reachDial: ReachDial = async () => { throw new Error('ECONNREFUSED') }
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, async () => allow('granted.example'), reachDial, tracker.record
    )

    await handler(new Request('https://granted.example/font.woff2'))

    expect(tracker.snapshot().deniedRequests).toBe(1)
  })

  it('with no recorder given, nothing throws -- every existing caller of createAppRequestHandler keeps working unmodified', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/`))
    expect(response.status).toBe(200)
  })

  it(
    'THE OWNER\'S OWN CONTRAST: an app shipping only index.html and loading everything else remotely measures ' +
    'almost entirely as third-party bytes; an app that ships its whole bundle measures almost entirely as pinned bytes',
    async () => {
      const remoteScript = 'x'.repeat(50_000) // the "everything else" a slim index.html pulls in

      // Case 1: ships only index.html, one large remote script.
      const thinTracker = createPinCoverageTracker()
      const thinReachDial: ReachDial = async () => new Response(remoteScript, { headers: { 'content-length': String(remoteScript.length) } })
      const thinHandler = await createAppRequestHandler(
        await installedStorage(), ORIGIN, undefined, undefined, async () => allow('cdn.example'), thinReachDial, thinTracker.record
      )
      await thinHandler(new Request(`${ORIGIN}/`))
      await thinHandler(new Request('https://cdn.example/app.js'))
      const thin = thinTracker.snapshot()

      // Case 2: ships its whole bundle, no remote fetch at all.
      const wholeTracker = createPinCoverageTracker()
      const wholeHandler = await createAppRequestHandler(
        await installedStorage(), ORIGIN, undefined, undefined, undefined, undefined, wholeTracker.record
      )
      await wholeHandler(new Request(`${ORIGIN}/`))
      await wholeHandler(new Request(`${ORIGIN}/app.js`))
      const whole = wholeTracker.snapshot()

      const thinFraction = thin.pinnedBytes / (thin.pinnedBytes + thin.thirdPartyBytes)
      const wholeFraction = whole.pinnedBytes / (whole.pinnedBytes + whole.thirdPartyBytes)

      expect(thinFraction).toBeLessThan(0.01) // almost everything this session ran was unpinned
      expect(wholeFraction).toBe(1) // nothing this session ran came from anywhere but the pin
    }
  )
})

describe('a real third-party fetch over a real TLS handshake -- content-length read from genuine network bytes', () => {
  let server: HttpsServer
  let port: number
  let ca: string

  beforeAll(async () => {
    const fixture = generateTlsFixture()
    ca = fixture.caCert
    server = createHttpsServer({ key: fixture.leafKey, cert: fixture.leafCert }, (req, res) => {
      if (req.url === '/known') {
        const body = 'exactly forty-two real network bytes here!'
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(body)) })
        res.end(body)
        return
      }
      // No content-length set, and two separate writes -- Node answers this
      // with chunked transfer-encoding, the ordinary shape for a response
      // whose size the peer never declares up front.
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('first chunk, ')
      res.end('second chunk')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not report a port')
    port = address.port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  it('a response with a real content-length header is counted exactly', async () => {
    const tracker = createPinCoverageTracker()
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, async () => allow('localhost'), nodeReachDial({ ca }), tracker.record
    )

    const response = await handler(new Request(`https://localhost:${String(port)}/known`))

    expect(response.status).toBe(200)
    expect(tracker.snapshot()).toMatchObject({ thirdPartyRequests: 1, thirdPartyBytes: 42, bytesIncomplete: false })
  })

  it('a real chunked response (no content-length at all) still counts the request, marked incomplete', async () => {
    const tracker = createPinCoverageTracker()
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, async () => allow('localhost'), nodeReachDial({ ca }), tracker.record
    )

    const response = await handler(new Request(`https://localhost:${String(port)}/chunked`))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('first chunk, second chunk')
    expect(tracker.snapshot()).toMatchObject({ thirdPartyRequests: 1, thirdPartyBytes: 0, bytesIncomplete: true })
  })
})
