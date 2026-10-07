// A Web3 Score provider that lives on IPFS, as a static build of web3-score-manager does: its `score/` tree is served
// through the verifier, at `ipfs://<root>/score`, under a DNSLink name typed bare as `ipns://<name>`, or under a signed
// IPNS key at `ipns://<key>/score`, as the default provider is. The shield and the Web3 Score page show the level it
// judges and name it, as they do for a provider on http (e2e-score-provider). Driven through the test seam's
// gateways, so nothing leaves the machine.
import { afterAll, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { bucketOf, readScore, startSite } from './score-provider-support.js'

const SCORED = 'sha256:' + '1a'.repeat(32)
const UNSCORED = 'sha256:' + '2b'.repeat(32)
const PROVIDER_NAME = 'IPFS provider'
const DNSLINK_NAME = 'scores.example'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** The provider's tree in the layout web3-score-manager builds: `score/provider.json` and `score/website/<bucket>.json`. */
const PROVIDER_TREE = {
  'score/provider.json': JSON.stringify({ standard: 'orivon-web3-score/1', name: PROVIDER_NAME, bucketHexChars: 2 }),
  [`score/website/${bucketOf(SCORED)}.json`]: JSON.stringify({
    standard: 'orivon-web3-score/1',
    subject: 'website',
    bucket: bucketOf(SCORED),
    entries: [{
      id: SCORED,
      name: 'Scored app',
      evaluated: '2026-10-03',
      trustlessity: { level: 3, privacy: false },
      summary: 'Open source, and runs only its own code.',
      operations: [{ name: 'Sign a transfer', trustlessity: { level: 4, privacy: true }, note: 'Signed locally.' }],
      connections: [{ name: 'Price API', trustlessity: { level: 1 }, note: 'One centralised source.' }]
    }]
  })
}

type FixtureGateway = Awaited<ReturnType<typeof startFixtureGateway>>

/** `deadFirst` lists a gateway that never answers ahead of the one holding the provider, as a public gateway that went down stays listed. */
async function judgedThrough (address: (gateway: FixtureGateway) => string, phase: string, { deadFirst = false } = {}): Promise<void> {
  await runPhase(phase, async (check) => {
    const gateway = await startFixtureGateway({ provider: PROVIDER_TREE }, { dnslinks: { [DNSLINK_NAME]: 'provider' }, ipnsKeys: ['provider'] })
    const dead = deadFirst ? await startFixtureGateway({}, { hang: true }) : undefined
    const providerAddress = address(gateway)
    const scored = await startSite('scored fixture', SCORED)
    const unscored = await startSite('unscored fixture', UNSCORED)
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        env: {
          ORIVON_DEV_ORIGINS: '1',
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}),
          ORIVON_TEST_IPFS_GATEWAYS: [...(dead === undefined ? [] : [dead.url]), gateway.url].join(','),
          ORIVON_TEST_DOH: `${gateway.url}/dns-query`
        },
        seedProfile: async (dir: string) => {
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'web3.scoreProvider': providerAddress } }))
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      await navigateToFixture(app, `http://127.0.0.1:${String(scored.port)}/`, 'scored fixture')
      const judged = await readScore(app, '3')
      check(`the shield paints the Level 3 the provider judges (${judged.level}/${judged.mark})`, judged.level === '3' && judged.mark === 'Web2.5')
      check(`its label names the provider (${judged.label})`, judged.label === `Website level 3 (Web2.5), judged by ${PROVIDER_NAME} (developer mode)`)
      check(`the Web3 Score page leads with Website level 3 (${judged.heading})`, judged.heading === 'Website level 3')
      check('the page names the provider and its address as the judge', judged.text.includes(`judged by ${PROVIDER_NAME} (${providerAddress})`))
      check('the page shows the provider\'s summary, operations and connections', judged.text.includes('Open source, and runs only its own code.') && judged.text.includes('Sign a transfer + Privacy') && judged.text.includes('Price API'))

      await navigateToFixture(app, `http://127.0.0.1:${String(unscored.port)}/`, 'unscored fixture')
      const plain = await readScore(app, '2')
      check(`a page the provider has no score for keeps Level 2 (${plain.level})`, plain.level === '2')
      check('its page says the provider has no score for it', plain.text.includes(`${PROVIDER_NAME} has no score for this page`))

      const asked = gateway.requests.filter((url) => url.endsWith('?format=raw'))
      check(`the gateway was asked for raw blocks, and nothing else but name lookups (${gateway.requests.join(', ')})`, asked.length > 0 && gateway.requests.every((url) => url.endsWith('?format=raw') || url.endsWith('?format=ipns-record') || url.startsWith('/dns-query')))
      if (dead !== undefined) check(`the dead gateway was asked first, and the lookup went on without it (${dead.requests.join(', ')})`, dead.requests[0]?.endsWith('?format=ipns-record') === true)
      expect([judged.level, plain.level]).toEqual(['3', '2'])
      expect(judged.label).toBe(`Website level 3 (Web2.5), judged by ${PROVIDER_NAME} (developer mode)`)
      expect(plain.text).toContain(`${PROVIDER_NAME} has no score for this page`)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      for (const { server } of [scored, unscored] as Array<{ server: Server }>) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      await gateway.close()
      await dead?.close()
    }
  })
}

it('an ipfs:// provider judges a checked page, and its level shows on the shield and the Web3 Score page', async () => {
  await judgedThrough((gateway) => `ipfs://${gateway.roots['provider']!}/score`, 'score-provider-ipfs')
}, TEST_TIMEOUT_MS)

it('an ipns:// provider under a DNSLink name does the same, typed as the bare name without its score/ folder', async () => {
  await judgedThrough(() => `ipns://${DNSLINK_NAME}`, 'score-provider-ipns')
}, TEST_TIMEOUT_MS)

it('an ipns:// provider under a signed key does the same, though the first gateway never answers', async () => {
  await judgedThrough((gateway) => `ipns://${gateway.keys['provider']!}/score`, 'score-provider-ipns-key', { deadFirst: true })
}, TEST_TIMEOUT_MS)
