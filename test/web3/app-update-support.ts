// What the app-update specs share: the fixture gateway and the Web3 Score provider they run against, a
// launch that keeps one profile across phases while the name moves, and the reads that tell which build a
// tab is running. A name moves between phases by relaunching the kept profile with another
// `ORIVON_TEST_ETH_FIXTURES`, since the verifier reads its fixture names once.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { launchElectron, profileDirOf } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { originHash } from '../../src/broker/grants/origin-hash.js'

export const PROVIDER_NAME = 'E2E update provider'

type Gateway = Awaited<ReturnType<typeof startFixtureGateway>>

export interface Rig {
  readonly gateway: Gateway
  /** The provider's base address, as Settings holds it. */
  readonly providerAddress: string
  readonly dnslinks: Record<string, string>
  close: () => Promise<void>
}

const bucketOf = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 2)

function evaluation (id: string, level: number): Record<string, unknown> {
  return { id, name: 'Update fixture', evaluated: '2026-10-05', trustlessity: { level, privacy: level === 4 } }
}

async function listen (server: Server): Promise<number> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as AddressInfo).port
}

/**
 * The sites a spec builds, a gateway serving them, and a provider that judges `judged` (site name -> level)
 * at the CID each root has. A static server, as a built provider is.
 */
export async function startRig (sites: Record<string, Record<string, string>>, judged: Record<string, number>): Promise<Rig> {
  const dnslinks: Record<string, string> = {}
  const gateway = await startFixtureGateway(sites, { dnslinks })
  const byBucket = new Map<string, Array<Record<string, unknown>>>()
  for (const [site, level] of Object.entries(judged)) {
    const id = `cid:${gateway.roots[site]!}`
    byBucket.set(bucketOf(id), [...(byBucket.get(bucketOf(id)) ?? []), evaluation(id, level)])
  }
  const files = new Map<string, string>([['/score/provider.json', JSON.stringify({ standard: 'orivon-web3-score/1', name: PROVIDER_NAME, bucketHexChars: 2 })]])
  for (const [bucket, entries] of byBucket) files.set(`/score/website/${bucket}.json`, JSON.stringify({ standard: 'orivon-web3-score/1', subject: 'website', bucket, entries }))
  const server = createServer((req, res) => {
    const body = files.get(req.url ?? '')
    if (body === undefined) res.writeHead(404).end()
    else res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  })
  const port = await listen(server)
  return {
    gateway,
    providerAddress: `http://127.0.0.1:${String(port)}/score`,
    dnslinks,
    close: async () => {
      await gateway.close()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

export interface PhaseOptions {
  /** Name -> where it points: a site of the rig, or `dnslink://<domain>`. */
  readonly names: Record<string, string>
  /** The profile a former phase kept; absent for the first launch. */
  readonly reuse?: string
  readonly env?: Record<string, string>
}

/** One run of the shell on the rig, with the verifier host listening. */
export async function launchPhase (rig: Rig, { names, reuse, env = {} }: PhaseOptions): Promise<ElectronApplication> {
  const fixtures = Object.fromEntries(Object.entries(names).map(([name, target]) => [name, target.startsWith('dnslink://') ? target : `ipfs://${rig.gateway.roots[target]!}`]))
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    ...(reuse === undefined ? {} : { reuseProfile: reuse }),
    seedProfile: async (dir: string) => {
      if (reuse !== undefined) return
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'web3.scoreProvider': rig.providerAddress } }))
    },
    env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify(fixtures), ORIVON_TEST_IPFS_GATEWAYS: rig.gateway.url, ORIVON_TEST_DOH: `${rig.gateway.url}/dns-query`, ...env }
  })
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
  if (!listening) throw new Error('the verifier host never reported listening')
  await waitFor(() => app.windows().length === 2)
  await waitForAddressBarStable(findChrome(app))
  return app
}

export const profileOf = (app: ElectronApplication): string => {
  const dir = profileDirOf(app)
  if (dir === undefined) throw new Error('the launch has no profile directory')
  return dir
}

/** What the pin of `origin` records, or undefined while there is none. */
export function pinOf (app: ElectronApplication, origin: string): { content?: { cid: string, via: string, pointersVerified: boolean }, version: string } | undefined {
  const file = join(profileOf(app), 'apps', originHash(origin), 'pin.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { content?: { cid: string, via: string, pointersVerified: boolean }, version: string } : undefined
}

export function quietOf (app: ElectronApplication, origin: string): unknown {
  const file = join(profileOf(app), 'apps', originHash(origin), 'update-offer.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}

/** The build every live tab at `url` reports on its page, newest first; a tab that has not run its script, or that does not answer within 3 s (a page mid-navigation never does), reports null. */
export async function buildsAt (app: ElectronApplication, url: string): Promise<Array<string | null>> {
  return await app.evaluate(async ({ webContents }, address) => {
    const tabs = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === address).sort((a, b) => b.id - a.id)
    return await Promise.all(tabs.map(async (contents) => await Promise.race([contents.executeJavaScript('document.body?.dataset?.ran ?? null').catch(() => null), new Promise<null>((resolve) => { setTimeout(resolve, 3_000, null) })]) as string | null))
  }, url)
}

/** True once a tab at `url` has finished loading and runs as an app tab: the page holds `orivon` and the Node globals only an app tab gets. A first visit's page is an ordinary website until it is allowed, so `orivon` alone does not say the reload has ended. */
export async function runsAsApp (app: ElectronApplication, url: string): Promise<boolean> {
  return await app.evaluate(async ({ webContents }, address) => {
    const tab = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.getURL() === address)
    if (tab === undefined || tab.isLoading()) return false
    return await tab.executeJavaScript('typeof window.orivon === "object" && typeof process !== "undefined"').catch(() => false) as boolean
  }, url)
}

/** Opens `url` in a new tab, the way the shell's own new-tab command does. */
export async function openTab (app: ElectronApplication, url: string): Promise<void> {
  await findChrome(app).evaluate((address: string) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(address) }, url)
}

/** True when `predicate` holds within `ms`, re-asked on a short beat. */
export async function eventually (predicate: () => Promise<boolean> | boolean, ms = 20_000): Promise<boolean> {
  return await waitFor(predicate, ms)
}
