// With the whole browser on the person's own SOCKS5 tunnel and "Use tunnel to run network nodes" left off (its default), the
// real IPFS node starts anyway and connects directly: the shell opens an ipfs:// address, the node runs, and not one of its
// connections reaches the tunnel's fixture, which refuses everything. The website's own requests still go to the tunnel.
// Skipped when the node's files were not fetched into resources/.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-local-node-direct.test.ts
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
import { delay, waitFor } from '../support/smoke-helpers.mjs'

const fetched = existsSync(resolve('resources', 'ipfs-node', 'ipfs-node.js')) && existsSync(resolve('resources', 'ipfs-node', 'ipfs-node.json'))
const CID = 'bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m'

describe.skipIf(!fetched)('the IPFS node while the whole browser is on the tunnel and the nodes are not', () => {
  let socks: Socks5Fixture
  let app: ElectronApplication
  let chrome: Page

  beforeAll(async () => {
    socks = await startSocks5Fixture({ preferAuth: true, refuseUnmapped: true })
    const launched = await launchShell({
      seedProfile: async (userDataDir) => {
        writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.tunnel.everywhere': true, 'network.route.kind': 'socks5', 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
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

  it('[local-node-direct-beside-the-tunnel] starts when an ipfs:// address asks for it, and none of its connections goes to the tunnel', async () => {
    await clickAddressBarRetrying(chrome, `ipfs://${CID}/`)
    const nodePid = async (): Promise<number | undefined> => await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().find((entry) => entry.name === 'Orivon IPFS node' || entry.serviceName === 'Orivon IPFS node')?.pid)
    expect(await waitFor(async () => await nodePid() !== undefined, 120_000), 'the node started although the whole browser is on the tunnel').toBe(true)
    // Long enough for a node that was going to dial through the tunnel to have done so.
    await delay(20_000)
    const own = isolationCredentials()('local-node:ipfs-node').userId
    expect(socks.requests.filter((request) => request.userId === own), 'the node did not use the tunnel').toEqual([])
  }, 240_000)
})
