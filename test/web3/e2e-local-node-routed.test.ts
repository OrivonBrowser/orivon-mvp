// With the whole browser on the person's own SOCKS5 tunnel, the real IPFS node starts anyway, through that tunnel: the
// shell opens an ipfs:// address, the node asks main for its route, and every connection it makes, to a peer or to the
// DNS-over-HTTPS endpoint that names one, arrives at the tunnel's fixture, signed in with the node's own name. The
// fixture refuses all of it, so nothing real is reached, and the operating system shows the node's process holding no
// socket that leaves this computer. Skipped when the node's files were not fetched into resources/.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-local-node-routed.test.ts
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { isolationCredentials } from '../../src/broker/route/socks5.js'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

const fetched = existsSync(resolve('resources', 'ipfs-node', 'ipfs-node.js')) && existsSync(resolve('resources', 'ipfs-node', 'ipfs-node.json'))
const CID = 'bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m'
const LOOPBACK = /^(127\.|\[?::1\]?$|\[?::ffff:127\.)/

describe.skipIf(!fetched)('the IPFS node while the whole browser and the nodes are on the tunnel', () => {
  let socks: Socks5Fixture
  let app: ElectronApplication
  let chrome: Page

  beforeAll(async () => {
    socks = await startSocks5Fixture({ preferAuth: true, refuseUnmapped: true })
    const launched = await launchShell({
      env: { ORIVON_IPFS_NODE_LOG: '1' },
      seedProfile: async (userDataDir) => {
        writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.tunnel.everywhere': true, 'network.tunnel.nodes': true, 'network.route.kind': 'socks5', 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
      }
    })
    app = launched.app
    chrome = launched.chrome
  }, 180_000)

  afterAll(async () => {
    await app?.close().catch(() => {})
    await socks?.close()
    expect(await assertNoElectronSurvivors()).toEqual([])
  })

  it('[local-node-through-the-tunnel] starts when an ipfs:// address asks for it, and every connection it makes goes to the tunnel, signed in with a name of its own', async () => {
    await clickAddressBarRetrying(chrome, `ipfs://${CID}/`)
    const own = isolationCredentials()('local-node:ipfs-node').userId
    const nodeRequests = (): typeof socks.requests => socks.requests.filter((request) => request.userId === own)
    expect(await waitFor(() => nodeRequests().length >= 2, 120_000), `the node reached the tunnel under its own name: ${JSON.stringify(socks.requests.slice(0, 6))}`).toBe(true)
    expect(nodeRequests().every((request) => request.password !== undefined), 'every request signed in').toBe(true)
    expect(nodeRequests().some((request) => request.addressType === 'domain'), 'its names went to the tunnel unresolved, the DNS-over-HTTPS endpoint among them').toBe(true)
  }, 180_000)

  it.skipIf(process.platform !== 'linux')('[local-node-through-the-tunnel] holds no socket to anything but loopback while it runs', async () => {
    const pid = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().find((entry) => entry.name === 'Orivon IPFS node' || entry.serviceName === 'Orivon IPFS node')?.pid)
    expect(pid, 'the node runs').toBeDefined()
    const lines = execFileSync('ss', ['-tunapH'], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(`pid=${String(pid)},`))
    const hostOf = (address: string): string => address.slice(0, address.lastIndexOf(':'))
    const stray = lines.map((line) => line.trim().split(/\s+/)).filter((parts) => {
      // A datagram socket bound to an address that is not loopback can reach the network whether or not it is connected.
      if (parts[0] === 'udp' && !LOOPBACK.test(hostOf(parts[4] ?? ''))) return true
      return parts[1] !== 'LISTEN' && !['*:*', '0.0.0.0:*', '[::]:*'].includes(parts[5] ?? '') && !LOOPBACK.test(hostOf(parts[5] ?? ''))
    })
    expect(stray, 'no socket that leaves this computer').toEqual([])
  }, 60_000)
})
