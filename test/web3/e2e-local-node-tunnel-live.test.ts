// The IPFS node through the real Nym tunnel, live and opt-in (ORIVON_NYM_LIVE=1; CI never sets it). Three cold launches
// load the same ipfs:// site the project pins on its VPS and time it: the node through the tunnel (the browser-wide setting on),
// the gateways through the tunnel (the node switched off, which is what the browser does when the node cannot run), and the node
// directly (the setting off). In the first, the operating system lists the node's sockets: none may leave this computer, and
// turning the setting off and on restarts the node on the right path. The module files are the ones the build pins, or the
// directories ORIVON_NYM_TUNNEL_DIR and ORIVON_IPFS_NODE_DIR name. Needs the e2e build first and the network.
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
import { activeTabInfo, delay, evaluateRetrying, findViewShowing, waitFor } from '../support/smoke-helpers.mjs'
import { referenceCid } from '../../src/protocols/swarm/reference.js'

const LIVE = process.env['ORIVON_NYM_LIVE'] === '1'
/** A site the project pins on its VPS (Kubo). */
const PROJECT_CID = process.env['ORIVON_LIVE_CID'] ?? 'bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q'
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
const leaving = (sockets: readonly Socket[]): Socket[] => sockets.filter((entry) => entry.state !== 'LISTEN' && !isUnbound(entry.peer) && !LOOPBACK.test(hostOf(entry.peer)))

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

  async function open (url: string): Promise<number> {
    const started = Date.now()
    await clickAddressBarRetrying(chrome, url)
    const loaded = await waitFor(async () => {
      const info = await activeTabInfo(chrome)
      const title = info.title ?? ''
      return (info.address ?? '').startsWith(url.slice(0, 20)) && title !== '' && !/^(New tab|Loading|ipfs:)/i.test(title)
    }, 300_000)
    const ms = Date.now() - started
    console.log(`[live] ${url.slice(0, 24)}... loaded=${String(loaded)} in ${String(ms)} ms`)
    expect(loaded).toBe(true)
    return ms
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

  it('[tunnel on, the node] loads the site through the node, holds no socket that leaves this computer, and is restarted on the right path when the setting flips', async () => {
    await launch({ 'network.tunnel.everywhere': true })
    const cold = await open(`ipfs://${PROJECT_CID}/`)
    console.log(`[live] tunnel on, node through Nym: cold load ${String(cold)} ms`)
    const pid = await nodePid()
    expect(pid, 'the node runs').toBeDefined()
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
    const started = Date.now()
    expect(await waitFor(async () => { const now = await nodePid(); return now !== undefined && now !== pid }, 240_000), 'the page reloaded and a new node started').toBe(true)
    const direct = await nodePid()
    console.log(`[live] tunnel off: a new node (direct) after ${String(Date.now() - started)} ms`)
    await delay(5000)
    const directSockets = socketsOf(direct as number)
    console.log(`[live] direct node ${String(direct)}: ${summary(directSockets)}`)
    expect(leaving(directSockets).length, 'with the setting off the node dials directly').toBeGreaterThan(0)

    await flipTunnel()
    const flipped = Date.now()
    expect(await waitFor(async () => { const now = await nodePid(); return now !== undefined && now !== direct }, 240_000), 'a new node started').toBe(true)
    const second = await nodePid()
    console.log(`[live] tunnel on again: a new node (through Nym) after ${String(Date.now() - flipped)} ms`)
    await delay(5000)
    const secondSockets = socketsOf(second as number)
    console.log(`[live] node ${String(second)} after the tunnel went on again: ${summary(secondSockets)}`)
    expect(leaving(secondSockets)).toEqual([])
  }, 900_000)

  it('[tunnel on, the Swarm node] opens a bzz:// site through the Swarm node, or reports how far it got', async () => {
    await launch({ 'network.tunnel.everywhere': true }, { ORIVON_SWARM_NODE_LOG: '1' })
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

  it('[tunnel on, gateways] loads the same site from the gateways through the tunnel', async () => {
    await launch({ 'network.tunnel.everywhere': true, 'web3.ipfsSource': 'gateways' })
    console.log(`[live] tunnel on, gateways: cold load ${String(await open(`ipfs://${PROJECT_CID}/`))} ms`)
    expect(await nodePid(), 'no node runs').toBeUndefined()
  }, 600_000)

  it('[tunnel off, the node] loads the same site through the node directly', async () => {
    await launch({})
    console.log(`[live] tunnel off, node direct: cold load ${String(await open(`ipfs://${PROJECT_CID}/`))} ms`)
  }, 600_000)
})
