// The local nodes through the real Nym tunnel, live and opt-in (ORIVON_NYM_LIVE=1; CI never sets it). Cold launches time the
// same two blocks asked of the IPFS node's own API (a small block the public network holds widely, and the directory of an
// app the project pins on its VPS) and the tab load of that app: the node through the tunnel (the browser-wide setting and "Use tunnel to run network nodes" on),
// the gateways through the tunnel (the node switched off, which is what the browser did before the nodes could run through it)
// and the node directly (the setting off). In the first, the operating system lists the node's sockets at ten-second
// samples: none may leave this computer, and turning the setting off and on restarts the node on the right path. A last
// launch opens a bzz:// site through the Swarm node. The module files are the ones the build pins, or the directories
// ORIVON_NYM_TUNNEL_DIR and ORIVON_IPFS_NODE_DIR name. Needs the e2e build first and the network.
//
//   ORIVON_NYM_LIVE=1 node scripts/build-e2e.mjs && ORIVON_NYM_LIVE=1 node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-local-node-tunnel-live.test.ts
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell } from '../support/qa-helpers.js'
import { shoot } from '../support/auth-support.js'
import { activeTabInfo, delay, evaluateRetrying, findViewShowing, waitFor } from '../support/smoke-helpers.mjs'
import { referenceCid } from '../../src/protocols/swarm/reference.js'

const LIVE = process.env['ORIVON_NYM_LIVE'] === '1'
/** An app the project pins on its VPS (Kubo), about 60 KB: its Kubo advertises QUIC and WebRTC addresses only, which the node cannot dial. And a small block the public network holds widely. */
const PROJECT_CID = process.env['ORIVON_LIVE_CID'] ?? 'bafybeibf332zhpwiknyrjxsd56clbwpeyo5prhv2ajifqlggsejzlt6elq'
/** A site published with DNSLink that the public network holds widely, so the node can find it. */
const SITE = 'ipns://docs.ipfs.tech/'
const WIDE_CID = 'bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m'
const NODE_NAME = process.env['ORIVON_LIVE_NODE'] ?? 'Orivon IPFS node'
/** The manifest chunk of a published Swarm site (test/web3/e2e-swarm-node-live.test.ts). */
const SWARM_CHUNK = '03b80b08353b288c08b161fcf0e904eff3001c88006bcc7087290929197eb69f'
const LOOPBACK = /^(127\.|\[?::1\]?$|\[?::ffff:127\.)/

interface Socket { readonly proto: string, readonly state: string, readonly local: string, readonly peer: string }

/** Every TCP and UDP socket the operating system lists for `pid`. */
function socketsOf (pid: number): Socket[] {
  const lines = execFileSync('ss', ['-tunapH'], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(`pid=${String(pid)},`))
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/)
    return { proto: parts[0] ?? '', state: parts[1] ?? '', local: parts[4] ?? '', peer: parts[5] ?? '' }
  })
}

const hostOf = (address: string): string => address.slice(0, address.lastIndexOf(':'))
const isUnbound = (peer: string): boolean => peer === '*:*' || peer === '0.0.0.0:*' || peer === '[::]:*'

/** The sockets that connect to something other than this computer. */
const leaving = (sockets: readonly Socket[]): Socket[] => sockets.filter((entry) => {
  // A datagram socket bound to an address that is not loopback can reach the network whether or not it is connected.
  if (entry.proto === 'udp' && !LOOPBACK.test(hostOf(entry.local))) return true
  return entry.state !== 'LISTEN' && !isUnbound(entry.peer) && !LOOPBACK.test(hostOf(entry.peer))
})

const summary = (sockets: readonly Socket[]): string => {
  const count = (test: (entry: Socket) => boolean): number => sockets.filter(test).length
  return `${String(sockets.length)} sockets: tcp ${String(count((s) => s.proto === 'tcp'))} (listening ${String(count((s) => s.proto === 'tcp' && s.state === 'LISTEN'))}), udp ${String(count((s) => s.proto === 'udp'))}, leaving this computer ${String(leaving(sockets).length)}`
}

describe.skipIf(!LIVE)('the IPFS node through the real Nym tunnel', () => {
  let app: ElectronApplication | undefined
  let chrome: Page

  afterEach(async () => {
    await app?.close().catch(() => {})
    app = undefined
    expect(await assertNoElectronSurvivors()).toEqual([])
  })

  async function launch (values: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<void> {
    const launched = await launchShell({
      env: {
        ORIVON_IPFS_NODE_LOG: '1',
        ...extraEnv,
        ...(process.env['ORIVON_NYM_TUNNEL_DIR'] === undefined ? {} : { ORIVON_NYM_TUNNEL_DIR: process.env['ORIVON_NYM_TUNNEL_DIR'] }),
        ...(process.env['ORIVON_IPFS_NODE_DIR'] === undefined ? {} : { ORIVON_IPFS_NODE_DIR: process.env['ORIVON_IPFS_NODE_DIR'] })
      },
      seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values })) }
    })
    app = launched.app
    chrome = launched.chrome
  }

  const nodePid = async (name = NODE_NAME): Promise<number | undefined> => await (app as ElectronApplication).evaluate(({ app: electronApp }, wanted) => electronApp.getAppMetrics().find((entry) => entry.name === wanted || entry.serviceName === wanted)?.pid, name)

  /** While `open` waits, lists the node's sockets every ten seconds, so a node that holds none at the end is told from one that never did. */
  async function sampleNode (until: { done: boolean }, leavingSeen: { most: number }): Promise<void> {
    const began = Date.now()
    while (!until.done) {
      await delay(10_000)
      const pid = await nodePid().catch(() => undefined)
      if (pid === undefined || until.done) continue
      const sockets = socketsOf(pid)
      leavingSeen.most = Math.max(leavingSeen.most, leaving(sockets).length)
      console.log(`[live] +${String(Math.round((Date.now() - began) / 1000))} s node ${String(pid)}: ${summary(sockets)}`)
    }
  }

  async function open (url: string, watch = false): Promise<number> {
    const started = Date.now()
    const until = { done: false }
    const seen = { most: 0 }
    const sampling = watch ? sampleNode(until, seen) : Promise.resolve()
    await clickAddressBarRetrying(chrome, url)
    const loaded = await waitFor(async () => {
      const info = await activeTabInfo(chrome)
      const title = info.title ?? ''
      return (info.address ?? '').startsWith(url.slice(0, 20)) && title !== '' && !/^(New Tab|Cannot .*|.*\.(ipfs|ipns)\.orivon)$/.test(title)
    }, 420_000)
    const ms = Date.now() - started
    until.done = true
    await sampling
    console.log(`[live] ${url.slice(0, 24)}... loaded=${String(loaded)} in ${String(ms)} ms, tab ${JSON.stringify(await activeTabInfo(chrome))}`)
    expect(seen.most, 'at no sample did the node hold a socket that leaves this computer').toBe(0)
    return loaded ? ms : -1
  }

  /** Asks the IPFS node's own API for a block and says how long it took (-1: it did not arrive). */
  async function blockMs (cid: string, within = 240_000): Promise<number> {
    const port = /\[ipfs-node\] gateway listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(mainOutput(app as ElectronApplication))?.[1]
    if (port === undefined) return -2
    const started = Date.now()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ipfs/${cid}?format=raw`, { headers: { accept: 'application/vnd.ipld.raw' }, signal: AbortSignal.timeout(within) })
      const bytes = (await response.arrayBuffer()).byteLength
      console.log(`[live] block ${cid.slice(0, 12)}: ${String(response.status)}, ${String(bytes)} bytes in ${String(Date.now() - started)} ms`)
      return response.ok ? Date.now() - started : -1
    } catch (error) {
      console.log(`[live] block ${cid.slice(0, 12)}: no block within ${String(within / 1000)} s (${error instanceof Error ? error.name : 'error'})`)
      return -1
    }
  }

  /** What the Available networks popup says of each node, with a screenshot when ORIVON_UI_SHOTS_DIR is set. */
  async function networkCards (): Promise<unknown> {
    const shell = app as ElectronApplication
    await chrome.locator('#networks-btn').click()
    expect(await waitFor(() => shell.windows().some((w) => w.url().endsWith('/renderer/networks/index.html') && !w.isClosed()))).toBe(true)
    const popup = shell.windows().find((w) => w.url().endsWith('/renderer/networks/index.html') && !w.isClosed()) as Page
    await popup.waitForSelector('.card')
    const read = await evaluateRetrying(popup, () => Array.from(document.querySelectorAll<HTMLElement>('.card')).map((card) => ({
      name: card.querySelector('.card-name')?.textContent ?? '',
      status: card.querySelector('.card-status')?.textContent ?? '',
      note: card.querySelector('.card-note')?.textContent ?? '',
      metrics: Array.from(card.querySelectorAll('.metrics dt, .metrics dd')).map((m) => m.textContent ?? '').join(' ')
    })))
    await shoot(shell, chrome, popup, 'networks-through-nym')
    await chrome.locator('#networks-btn').click()
    return read
  }

  /** Switches the browser-wide tunnel on the Privacy page. */
  async function flipTunnel (): Promise<void> {
    const shell = app as ElectronApplication
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/privacy') })
    expect(await waitFor(() => shell.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = shell.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('#row-route-everywhere input[type=checkbox]')
    await settings.locator('#row-route-everywhere input[type=checkbox]').click()
    await delay(500)
    await settings.close()
  }

  it('[tunnel on, the node] times two blocks and the tab load through the node, holds no socket that leaves this computer, and is restarted on the right path when the setting flips', async () => {
    await launch({ 'network.tunnel.everywhere': true, 'network.tunnel.nodes': true })
    const started = Date.now()
    const loading = open(SITE, true)
    expect(await waitFor(async () => await nodePid() !== undefined, 120_000), 'the node was started by the address').toBe(true)
    expect(await waitFor(() => /\[ipfs-node\] gateway listening/.test(mainOutput(app as ElectronApplication)), 60_000)).toBe(true)
    const wide = await blockMs(WIDE_CID)
    const project = await blockMs(PROJECT_CID, 60_000)
    console.log(`[live] tunnel on, node through Nym: wide block ${String(wide)} ms, project block ${String(project)} ms (after ${String(Date.now() - started)} ms from the address)`)
    const cold = await loading
    console.log(`[live] tunnel on, node through Nym: tab load ${String(cold)} ms`)
    const pid = await nodePid()
    expect(pid, 'the node runs').toBeDefined()
    console.log(`[live] cards: ${JSON.stringify(await networkCards())}`)
    await delay(3000)
    const routed = socketsOf(pid as number)
    console.log(`[live] node ${String(pid)}: ${summary(routed)}`)
    console.log(`[live] sample: ${JSON.stringify(routed.filter((entry) => entry.proto === 'tcp').slice(0, 6))}`)
    expect(routed.length, 'the node holds sockets').toBeGreaterThan(0)
    expect(leaving(routed), 'no socket to anything but loopback').toEqual([])
    const lines = mainOutput(app as ElectronApplication).split('\n').filter((line) => line.includes('[ipfs-node] route '))
    const okMs = lines.flatMap((line) => /dial .* ok in (\d+) ms/.exec(line)?.[1] ?? []).map(Number).sort((a, b) => a - b)
    console.log(`[live] route log: ${String(lines.filter((line) => line.includes(' dial ')).length)} dials, ${String(okMs.length)} ok (median ${String(okMs[Math.floor(okMs.length / 2)])} ms, slowest ${String(okMs.at(-1))} ms), ${String(lines.filter((line) => line.includes(' lookup ')).length)} lookups, ${String(lines.filter((line) => line.includes('datagram channel')).length)} datagram channels`)
    console.log(lines.slice(0, 40).join('\n'))

    await flipTunnel()
    const flippedOff = Date.now()
    expect(await waitFor(async () => { const now = await nodePid(); return now !== undefined && now !== pid }, 240_000), 'the page reloaded and a new node started').toBe(true)
    const direct = await nodePid()
    console.log(`[live] tunnel off: a new node (direct) after ${String(Date.now() - flippedOff)} ms`)
    const userData = await (app as ElectronApplication).evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    await delay(15_000)
    const holders = (): string => { try { return execFileSync('sh', ['-c', `ls -la ${userData}/ipfs-node 2>&1; (lsof ${userData}/ipfs-node/* 2>&1 || true) | head; ps -eo pid,etimes,args | grep -c "[l]ocal-node-host"`], { encoding: 'utf8' }) } catch (error) { return String(error) } }
    console.log(`[live] data dir after the flip: ${holders()}`)
    // What a direct node reaches depends on this network (a resolver or a provider that blocks peers), so it is reported, not asserted.
    await waitFor(() => leaving(socketsOf(direct as number)).length > 0, 90_000)
    console.log(`[live] direct node ${String(direct)}: ${summary(socketsOf(direct as number))}`)

    await flipTunnel()
    const flipped = Date.now()
    expect(await waitFor(async () => { const now = await nodePid(); return now !== undefined && now !== direct }, 240_000), 'a new node started').toBe(true)
    const second = await nodePid()
    console.log(`[live] tunnel on again: a new node (through Nym) after ${String(Date.now() - flipped)} ms`)
    await delay(15_000)
    const secondSockets = socketsOf(second as number)
    console.log(`[live] node ${String(second)} after the tunnel went on again: ${summary(secondSockets)}`)
    expect(leaving(secondSockets)).toEqual([])
  }, 1_500_000)

  it('[tunnel on, the Swarm node] opens a bzz:// site through the Swarm node, or reports how far it got', async () => {
    await launch({ 'network.tunnel.everywhere': true, 'network.tunnel.nodes': true }, { ORIVON_SWARM_NODE_LOG: '1' })
    const started = Date.now()
    await clickAddressBarRetrying(chrome, `bzz://${SWARM_CHUNK}`)
    const cid = referenceCid(SWARM_CHUNK)
    let page: { title: string, words: string } | undefined
    let askedAt = Date.now()
    const loaded = await waitFor(async () => {
      const shell = app as ElectronApplication
      const view = findViewShowing(shell, chrome, `https://${cid}.bzz.orivon/`)
      if (view === undefined) return false
      const seen = await evaluateRetrying(view, () => ({ title: document.title, words: document.body.innerText.slice(0, 200) })).catch(() => ({ title: '', words: '' }))
      if (seen.title === '') return false
      page = seen
      if (!/^Cannot /.test(seen.title)) return true
      if (Date.now() - askedAt > 10_000) {
        askedAt = Date.now()
        await clickAddressBarRetrying(chrome, `bzz://${SWARM_CHUNK}`)
      }
      return false
    }, 420_000)
    const pid = await nodePid('Orivon Swarm node')
    console.log(`[live] swarm node through Nym: loaded=${String(loaded)} after ${String(Date.now() - started)} ms, page ${JSON.stringify(page)}`)
    if (pid !== undefined) {
      const sockets = socketsOf(pid)
      console.log(`[live] swarm node ${String(pid)}: ${summary(sockets)}`)
      expect(leaving(sockets), 'no socket to anything but loopback').toEqual([])
    }
    const lines = mainOutput(app as ElectronApplication).split('\n').filter((line) => line.includes('[swarm-node] route ') || line.includes('[swarm-node]'))
    console.log(`[live] swarm log: ${String(lines.length)} lines; ${lines.filter((line) => line.includes(' dial ') && line.includes(' ok in ')).length} dials ok, ${lines.filter((line) => line.includes(' dial ') && line.includes('failed')).length} failed`)
    console.log(lines.slice(0, 30).join('\n'))
  }, 600_000)

  it('[tunnel on, gateways] times the same tab load from the gateways through the tunnel', async () => {
    await launch({ 'network.tunnel.everywhere': true, 'web3.ipfsSource': 'gateways' })
    console.log(`[live] tunnel on, gateways: tab load ${String(await open(SITE))} ms`)
    expect(await nodePid(), 'no node runs').toBeUndefined()
  }, 600_000)

  it('[tunnel on, the node direct] times the same tab load with the nodes outside the tunnel, which is the default, and asks no gateway', async () => {
    await launch({ 'network.tunnel.everywhere': true })
    const loading = open(SITE)
    expect(await waitFor(() => /\[ipfs-node\] gateway listening/.test(mainOutput(app as ElectronApplication)), 120_000), 'the node started although the whole browser is on the tunnel').toBe(true)
    console.log(`[live] tunnel on, nodes direct: wide block ${String(await blockMs(WIDE_CID))} ms, project block ${String(await blockMs(PROJECT_CID, 60_000))} ms`)
    console.log(`[live] tunnel on, nodes direct: tab load ${String(await loading)} ms`)
    const pid = await nodePid()
    expect(pid, 'the node runs').toBeDefined()
    console.log(`[live] direct node beside the tunnel ${String(pid)}: ${summary(socketsOf(pid as number))}`)
    expect(leaving(socketsOf(pid as number)).length, 'the node connects to its peers itself').toBeGreaterThan(0)
  }, 600_000)

  it('[tunnel on, nodes direct, .eth names] times The Lounge and vitalik.eth with the whole browser on Nym and "Use tunnel to run network nodes" off', async () => {
    await launch({ 'network.tunnel.everywhere': true })
    const openName = async (name: string): Promise<number> => {
      const started = Date.now()
      await clickAddressBarRetrying(chrome, name)
      const loaded = await waitFor(async () => {
        const info = await activeTabInfo(chrome)
        const title = info.title ?? ''
        return (info.address ?? '') !== '' && title !== '' && !/^(New Tab|Cannot .*|.*\.(ipfs|ipns|eth)(\.orivon)?)$/.test(title)
      }, 420_000)
      const ms = Date.now() - started
      console.log(`[live] ${name}: loaded=${String(loaded)} in ${String(ms)} ms, tab ${JSON.stringify(await activeTabInfo(chrome))}`)
      return loaded ? ms : -1
    }
    const lounge = await openName('thelounge.orivonstack.eth')
    const vitalik = await openName('vitalik.eth')
    const pid = await nodePid()
    console.log(`[live] tunnel on, nodes direct: The Lounge ${String(lounge)} ms, vitalik.eth ${String(vitalik)} ms, IPFS node ${String(pid)}${pid === undefined ? '' : `: ${summary(socketsOf(pid))}`}`)
    const log = mainOutput(app as ElectronApplication).split('\n').filter((line) => /\[verifier\]|gateway/i.test(line)).slice(-30)
    console.log(log.join('\n'))
  }, 1_200_000)

  it('[tunnel off, the node] times the same blocks and tab load through the node directly', async () => {
    await launch({})
    const loading = open(SITE)
    expect(await waitFor(() => /\[ipfs-node\] gateway listening/.test(mainOutput(app as ElectronApplication)), 120_000)).toBe(true)
    console.log(`[live] tunnel off, node direct: wide block ${String(await blockMs(WIDE_CID))} ms, project block ${String(await blockMs(PROJECT_CID, 60_000))} ms`)
    console.log(`[live] tunnel off, node direct: tab load ${String(await loading)} ms`)
  }, 600_000)
})
