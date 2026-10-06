// `orivon.trust.websiteScore`: a page that declares and is granted `trust.score` asks the Web3 Score provider the
// person chose in Settings about an `ipfs://` or `.eth` address, and gets the provider's name and the level it
// judged. Driven from a real page over the real IPC pipe, with the grant answered in the question panel the way a
// person answers it. The provider is a plain static server and the `.eth` names resolve through the fixture
// gateway, so nothing leaves the machine; every request the provider receives is read to prove it names a bucket
// and never the site. A lookup's partition is proven by page-score-lookup.test.ts: a fixture name's mount asks the
// gateway for no block, so no log here could show which partition warmed.
//
// The pages are loopback origins made apps by the developer-only registration, so the e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-trust-website-score.test.ts
import { afterAll, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { waitFor } from '../support/smoke-helpers.mjs'
import { runPhase } from '../support/e2e-helpers.js'
import { launchShell, visit } from '../support/qa-helpers.js'
import { answerQuestion, noNativeDialogs, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { appManifest, grantApp, pageCall, startAppServer, type AppServer } from '../app-behaviours/app-behaviour-support.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { bucketOf, listen } from './score-provider-support.js'

const PROVIDER_NAME = 'Trust e2e provider'
const SCORED_ETH_LEVEL = 4
const SCORED_IPFS_LEVEL = 3
const TEST_TIMEOUT_MS = 240_000

const APP_MANIFEST = { orivonApiVersion: 0, id: 'trust.orivon.fixture', name: 'Trust fixture', version: '1.0.0', entry: 'index.html', capabilities: {}, domain: 'bound.eth' }

const page = (title: string): Record<string, string> => ({ 'index.html': `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${title}</body>` })

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Outcome { readonly ok: boolean, readonly code?: string | undefined, readonly value?: { provider: string | null, level: number | null } }

/** Each address asked in turn from the page; a rejection is recorded by its code. Closes over nothing: it runs in the page. */
async function lookups (addresses: readonly unknown[]): Promise<Outcome[]> {
  const orivon = (window as unknown as { orivon: { trust: { websiteScore: (address: unknown) => Promise<{ provider: string | null, level: number | null }> } } }).orivon
  const out: Outcome[] = []
  for (const address of addresses) {
    try {
      out.push({ ok: true, value: await orivon.trust.websiteScore(address) })
    } catch (error) {
      out.push({ ok: false, code: (error as { code?: string }).code })
    }
  }
  return out
}

/** Asks for the same address until the broker answers `limit`, or `max` calls have been answered. */
async function untilLimit (address: string, max: number): Promise<{ calls: number, code: string | undefined }> {
  const orivon = (window as unknown as { orivon: { trust: { websiteScore: (address: string) => Promise<unknown> } } }).orivon
  for (let calls = 1; calls <= max; calls += 1) {
    try {
      await orivon.trust.websiteScore(address)
    } catch (error) {
      return { calls, code: (error as { code?: string }).code }
    }
  }
  return { calls: max, code: undefined }
}

/** Asks the person for `trust.score` from the page, and answers the question with `label`. */
async function requestAndAnswer (app: ElectronApplication, server: AppServer, view: Page, label: string): Promise<{ granted: boolean, asked: string }> {
  const asking = pageCall(server, view, async () => {
    const orivon = (window as unknown as { orivon: { app: { requestGrant: (r: { capability: string }) => Promise<boolean> } } }).orivon
    return await orivon.app.requestGrant({ capability: 'trust.score' })
  })
  const question = await readQuestion(await waitQuestion(app))
  await answerQuestion(app, label)
  return { granted: await asking, asked: JSON.stringify(question) }
}

it('[app:score-lookup-needs-the-trust-grant] [app:score-lookup-answers-the-chosen-provider] a page granted trust.score gets the level the chosen provider judges for ipfs:// and .eth addresses, and a page without the grant is refused', async () => {
  const gateway = await startFixtureGateway({ ipfsScored: page('ipfs scored'), ethScored: page('eth scored'), ethPlain: page('eth plain'), ipfsPlain: page('ipfs plain'), ethApp: { ...page('eth app'), '.well-known/orivon.json': JSON.stringify(APP_MANIFEST) } })
  const roots = gateway.roots
  const asked: string[] = []
  const entries = [{ id: `cid:${roots['ipfsScored']!}`, level: SCORED_IPFS_LEVEL }, { id: `cid:${roots['ethScored']!}`, level: SCORED_ETH_LEVEL }, { id: `cid:${roots['ethApp']!}`, level: SCORED_ETH_LEVEL }]
  const files = new Map<string, string>([['/score/provider.json', JSON.stringify({ standard: 'orivon-web3-score/1', name: PROVIDER_NAME, bucketHexChars: 2 })]])
  for (const { id } of entries) {
    const bucket = bucketOf(id)
    files.set(`/score/website/${bucket}.json`, JSON.stringify({
      standard: 'orivon-web3-score/1',
      subject: 'website',
      bucket,
      entries: entries.filter((entry) => bucketOf(entry.id) === bucket).map((entry) => ({ id: entry.id, name: 'Fixture site', evaluated: '2026-10-05', trustlessity: { level: entry.level, privacy: false } }))
    }))
  }
  const provider: { server: Server, port: number } = await listen((req, res) => {
    asked.push(req.url ?? '')
    const body = files.get(req.url ?? '')
    if (body === undefined) res.writeHead(404).end()
    else res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  })
  const providerAddress = `http://127.0.0.1:${String(provider.port)}/score`
  const denied = await startAppServer()
  const granted = await startAppServer()
  const bare = await startAppServer()
  const manifest = appManifest('trust-score', { secrets: {}, trust: { score: true } })
  const env = {
    ORIVON_DEV_ORIGINS: '1',
    ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'scored.eth': `ipfs://${roots['ethScored']!}`, 'plain.eth': `ipfs://${roots['ethPlain']!}`, 'bound.eth': `ipfs://${roots['ethApp']!}`, 'borrowed.eth': `ipfs://${roots['ethApp']!}` }),
    ORIVON_TEST_IPFS_GATEWAYS: gateway.url
  }
  const verifierListening = async (app: ElectronApplication): Promise<boolean> => await waitFor(async () => await app.evaluate(() => {
    const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures
    seam?.start?.()
    return seam?.listening === true
  }), 20_000)

  try {
    await runPhase('trust-website-score', async (check) => {
      const first = await launchShell({
        env,
        seedProfile: async (dir: string) => {
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'web3.scoreProvider': providerAddress } }))
        }
      })
      try {
        const { app, chrome } = first
        await stubNativeDialogs(app)
        check('the verifier host is listening', await verifierListening(app))

        // A page that declares trust.score but was never granted it.
        await grantApp(app, denied.origin, manifest, [{ capability: 'secrets', patterns: [] }])
        const deniedView = await visit(app, chrome, `${denied.origin}/`)
        const before = await pageCall(denied, deniedView, lookups, [`ipfs://${roots['ipfsScored']!}`])
        check(`[app:score-lookup-needs-the-trust-grant] a page that declared trust.score but was not granted it is refused: denied (${JSON.stringify(before)})`, before[0]?.ok === false && before[0].code === 'denied')
        const deny = await requestAndAnswer(app, denied, deniedView, 'Deny')
        check(`the question names what is shared (${deny.asked})`, deny.asked.includes('Web3 Score provider'))
        check('Deny resolves false', !deny.granted)
        const after = await pageCall(denied, deniedView, lookups, [`ipfs://${roots['ipfsScored']!}`, 'scored.eth'])
        check(`[app:score-lookup-needs-the-trust-grant] and the lookup stays refused after a Deny (${JSON.stringify(after)})`, after.every((outcome) => !outcome.ok && outcome.code === 'denied'))
        check(`nothing reached the provider for a refused page (${asked.join(', ')})`, asked.length === 0)

        // A page that is granted it, by answering the question in the panel.
        await grantApp(app, granted.origin, manifest, [{ capability: 'secrets', patterns: [] }])
        const grantedView = await visit(app, chrome, `${granted.origin}/`)
        const allow = await requestAndAnswer(app, granted, grantedView, 'Allow')
        check('Allow resolves true', allow.granted)
        const answers = await pageCall(granted, grantedView, lookups, [
          `ipfs://${roots['ipfsScored']!}/index.html`,
          'https://scored.eth/page',
          'scored.eth',
          `ipfs://${roots['ipfsPlain']!}`,
          'plain.eth',
          'https://example.com/',
          'not an address',
          42,
          'bound.eth',
          'https://borrowed.eth/'
        ])
        const level = (index: number): number | null | undefined => answers[index]?.value?.level
        check(`[app:score-lookup-answers-the-chosen-provider] an ipfs:// address answers the judged level and the provider's name (${JSON.stringify(answers[0])})`, answers[0]?.value?.provider === PROVIDER_NAME && level(0) === SCORED_IPFS_LEVEL)
        check(`a .eth name over https answers its content's level (${JSON.stringify(answers[1])})`, answers[1]?.value?.provider === PROVIDER_NAME && level(1) === SCORED_ETH_LEVEL)
        check(`and so does a bare .eth name (${JSON.stringify(answers[2])})`, answers[2]?.value?.provider === PROVIDER_NAME && level(2) === SCORED_ETH_LEVEL)
        check(`content the provider has no score for answers level null, still naming the provider (${JSON.stringify([answers[3], answers[4]])})`, [answers[3], answers[4]].every((outcome) => outcome?.value?.provider === PROVIDER_NAME && outcome.value.level === null))
        check(`a web address answers level null (${JSON.stringify(answers[5])})`, answers[5]?.value?.provider === PROVIDER_NAME && level(5) === null)
        check(`text that is no address answers level null (${JSON.stringify(answers[6])})`, answers[6]?.value?.provider === PROVIDER_NAME && level(6) === null)
        check(`a value that is not a string is refused: invalid (${JSON.stringify(answers[7])})`, answers[7]?.ok === false && answers[7].code === 'invalid')

        check(`a name the judged content's manifest names as its home answers the judged level (${JSON.stringify(answers[8])})`, answers[8]?.value?.provider === PROVIDER_NAME && level(8) === SCORED_ETH_LEVEL)
        check(`a name that points at the same content but is not that home answers level null: the level is not borrowed (${JSON.stringify(answers[9])})`, answers[9]?.value?.provider === PROVIDER_NAME && level(9) === null)

        const bucketRequests = /^\/score\/(provider\.json|website\/[0-9a-f]{2}\.json)$/
        const named = Object.values(roots).flatMap((root) => [root, root.slice(-12)])
        check(`the provider was asked only for its description and buckets, never for a site (${asked.join(', ')})`, asked.every((url) => bucketRequests.test(url)) && !asked.some((url) => named.some((part) => url.includes(part))) && !asked.some((url) => url.includes('eth')))

        // A page that loops is refused past its bucket.
        const drained = await pageCall(granted, grantedView, untilLimit, 'https://example.com/', 140)
        check(`[app:score-lookup-needs-the-trust-grant] a page asking in a loop is refused: limit, once its 128-lookup bucket is spent (${JSON.stringify(drained)})`, drained.code === 'limit' && drained.calls > 100 && drained.calls <= 140)
        check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
      } finally {
        await closeElectron(first.app)
      }

      // No provider chosen: the answer is empty and the provider is never asked.
      const askedBefore = asked.length
      const second = await launchShell({ env })
      try {
        const { app, chrome } = second
        check('the verifier host is listening with no provider chosen', await verifierListening(app))
        await grantApp(app, bare.origin, manifest, [{ capability: 'trust.score', patterns: [] }])
        const view = await visit(app, chrome, `${bare.origin}/`)
        const empty = await pageCall(bare, view, lookups, [`ipfs://${roots['ipfsScored']!}`, 'scored.eth'])
        check(`[app:score-lookup-answers-the-chosen-provider] with no provider chosen the answer is provider null, level null (${JSON.stringify(empty)})`, empty.every((outcome) => outcome.ok && outcome.value?.provider === null && outcome.value.level === null))
        check(`and nothing was asked of the provider (${String(asked.length - askedBefore)} requests)`, asked.length === askedBefore)
      } finally {
        await closeElectron(second.app)
      }
    })
  } finally {
    for (const server of [denied, granted, bare]) await server.close()
    await new Promise<void>((resolve) => { provider.server.close(() => { resolve() }); provider.server.closeAllConnections() })
    await gateway.close()
  }
}, TEST_TIMEOUT_MS)
