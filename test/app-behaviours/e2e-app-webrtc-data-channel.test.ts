// A page of an app that holds a network grant opens a WebRTC data channel to another page of the same app, with no
// STUN or TURN server, and binary messages cross it both ways with their bytes intact. Two tabs of one app origin,
// the test carrying the offer and the answer between them (a signalling server is not the behaviour). Every check
// carries the id of the behaviour it protects (test/app-behaviours/catalogue.md).
//
// Chromium hides each host candidate behind a `<uuid>.local` name that the other peer resolves by multicast DNS.
// The suite's resolver answers no name, so the test puts this computer's own addresses where those names are in the
// offer and the answer, which is where the candidates' sockets are bound. Nothing leaves the machine: no STUN
// server, no relay, host candidates only.
//
// The page is a bare loopback origin made an app by the developer-only grant, so the e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-webrtc-data-channel.test.ts
import { networkInterfaces } from 'node:os'
import type { Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { findViewShowing, waitFor } from '../support/smoke-helpers.mjs'

const HTML = 'text/html; charset=utf-8'
const JS = 'text/javascript'
// A registered app's own policy admits no inline script: every script is a file.
const MAIN_JS = "document.querySelector('#open-peer').addEventListener('click', () => { window.open('/peer', '_blank') })"
const MAIN_PAGE = '<!doctype html><title>caller</title><button id="open-peer">peer</button><script src="/main.js"></script>'
const PEER_PAGE = '<!doctype html><title>peer</title><body>peer</body>'

/** What the page keeps of its channel: how many messages came in, and the size and digest of each, in arrival order. */
interface Received { readonly size: number, readonly sha256: string }
interface RtcState {
  pc: RTCPeerConnection
  channel: RTCDataChannel | null
  got: Array<Received | undefined>
  count: number
  echo: boolean
}
type RtcWindow = Window & { __rtc?: RtcState }

const SIZES = [1, 256, 1024, 16_384, 65_536]

/** This computer's non-loopback IPv4 addresses, where the peers' candidate sockets are bound. */
function ownAddresses (): string[] {
  const found: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address)
  return found
}

/** Replaces every `<uuid>.local` candidate address in `sdp` with this computer's addresses, one candidate line for each. */
function resolveMdnsNames (sdp: string, addresses: readonly string[]): string {
  return sdp.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('a=candidate:')) return [line]
    const fields = line.split(' ')
    if (!(fields[4] ?? '').endsWith('.local')) return [line]
    return addresses.map((address) => [...fields.slice(0, 4), address, ...fields.slice(5)].join(' '))
  }).join('\r\n')
}

let server: AppServer
beforeAll(async () => {
  server = await startAppServer({
    '/': { type: HTML, body: MAIN_PAGE },
    '/main.js': { type: JS, body: MAIN_JS },
    '/peer': { type: HTML, body: PEER_PAGE }
  })
})
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:app-webrtc-data-channel-exchanges-bytes] two pages of an app that holds a network grant open a data channel with no STUN server, and binary messages cross it both ways with their bytes intact', async () => {
  const addresses = ownAddresses()
  expect(addresses, 'WebRTC gathers host candidates only from a non-loopback interface; this computer has none').not.toEqual([])
  const { app, chrome } = await launchShell()
  try {
    await grantApp(app, server.origin, appManifest('webrtc-data-channel', { net: { https: { connect: ['*:443'] } } }), [{ capability: 'https.connect', patterns: ['*:443'] }])
    const caller = await visit(app, chrome, `${server.origin}/`)
    await caller.click('#open-peer')
    const peerUrl = `${server.origin}/peer`
    expect(await waitFor(() => findViewShowing(app, chrome, peerUrl) !== undefined)).toBe(true)
    const peer = findViewShowing(app, chrome, peerUrl) as Page
    await peer.waitForLoadState('load')

    const offer = await caller.evaluate(async () => {
      const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
      const pc = new RTCPeerConnection({ iceServers: [] })
      const channel = pc.createDataChannel('bytes', { ordered: true })
      channel.binaryType = 'arraybuffer'
      const state: RtcState = { pc, channel, got: [], count: 0, echo: false }
      channel.onmessage = (event) => {
        const slot = state.count++
        const data = event.data as unknown
        if (!(data instanceof ArrayBuffer)) { state.got[slot] = { size: -1, sha256: `not binary: ${typeof data}` }; return }
        void crypto.subtle.digest('SHA-256', data).then((digest) => { state.got[slot] = { size: data.byteLength, sha256: hex(digest) } })
      }
      ;(window as RtcWindow).__rtc = state
      await pc.setLocalDescription(await pc.createOffer())
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(); return }
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve() })
      })
      return pc.localDescription?.sdp ?? ''
    })
    expect(offer, 'the caller\'s offer carries ICE candidates: the page gathered them from this computer\'s interfaces').toContain('a=candidate:')

    const answer = await peer.evaluate(async (remote) => {
      const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
      const pc = new RTCPeerConnection({ iceServers: [] })
      const state: RtcState = { pc, channel: null, got: [], count: 0, echo: true }
      ;(window as RtcWindow).__rtc = state
      pc.ondatachannel = (event) => {
        const channel = event.channel
        channel.binaryType = 'arraybuffer'
        state.channel = channel
        channel.onmessage = (message) => {
          const slot = state.count++
          const data = message.data as unknown
          if (!(data instanceof ArrayBuffer)) { state.got[slot] = { size: -1, sha256: `not binary: ${typeof data}` }; return }
          void crypto.subtle.digest('SHA-256', data).then((digest) => { state.got[slot] = { size: data.byteLength, sha256: hex(digest) } })
          if (state.echo) channel.send(data)
        }
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: remote })
      await pc.setLocalDescription(await pc.createAnswer())
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(); return }
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve() })
      })
      return pc.localDescription?.sdp ?? ''
    }, resolveMdnsNames(offer, addresses))
    expect(answer, 'the peer\'s answer carries ICE candidates: the page gathered them from this computer\'s interfaces').toContain('a=candidate:')
    expect(`${offer}${answer}`, 'no candidate came from a STUN or TURN server').not.toMatch(/ typ (srflx|relay|prflx)/)

    await caller.evaluate(async (remote) => { await (window as RtcWindow).__rtc?.pc.setRemoteDescription({ type: 'answer', sdp: remote }) }, resolveMdnsNames(answer, addresses))
    const opened = await waitFor(async () => await Promise.all([caller, peer].map(async (page) => await page.evaluate(() => (window as RtcWindow).__rtc?.channel?.readyState === 'open'))).then((states) => states.every(Boolean)), 40_000)
    const states = await Promise.all([caller, peer].map(async (page) => await page.evaluate(() => { const rtc = (window as RtcWindow).__rtc; return `${rtc?.pc.connectionState ?? 'no connection'}/${rtc?.pc.iceConnectionState ?? '-'}/${rtc?.channel?.readyState ?? 'no channel'}` })))
    expect(opened, `the data channel opened on both pages (caller and peer: ${states.join(' and ')})`).toBe(true)

    const sent = await caller.evaluate(async (sizes) => {
      const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
      const channel = (window as RtcWindow).__rtc?.channel
      const out: Received[] = []
      for (const size of sizes) {
        const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 7 + size) & 255)
        out.push({ size, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) })
        channel?.send(bytes)
      }
      return out
    }, SIZES)
    const everyoneGot = async (page: Page): Promise<Array<Received | undefined>> => await page.evaluate(() => (window as RtcWindow).__rtc?.got ?? [])
    const done = await waitFor(async () => (await everyoneGot(peer)).filter(Boolean).length === SIZES.length && (await everyoneGot(caller)).filter(Boolean).length === SIZES.length, 30_000)
    const atPeer = await everyoneGot(peer)
    const atCaller = await everyoneGot(caller)
    expect(done, `every message arrived (peer ${JSON.stringify(atPeer)}, caller ${JSON.stringify(atCaller)})`).toBe(true)
    expect(atPeer, 'the peer received each message the caller sent, byte for byte').toEqual(sent)
    expect(atCaller, 'and the caller received each one back from the peer, byte for byte').toEqual(sent)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
