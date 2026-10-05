// A Web3 Score provider chosen in Settings judges a page Orivon checked:
// the shield, its label and the Web3 Score page show the judged level and
// name the provider, the page lists the provider's operations and
// connections, and a page the provider has no score for keeps its observed
// level. The provider is a plain static server, as a static build of
// web3-score-manager is (docs/architecture/web3-score-provider.md), and
// every request it receives is checked to carry a bucket, never the
// identity itself.
//
// The pages are loopback origins in developer mode, whose served DDOC tree
// stands in for an installed app's pin (src/main/dev/local-ddoc.ts).
import { afterAll, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { bucketFile, bucketOf, listen, readScore, startSite } from './score-provider-support.js'

const SCORED = 'sha256:' + '1a'.repeat(32)
const UNSCORED = 'sha256:' + '2b'.repeat(32)
// Its bucket answers after the shield's 3 s wait, once the page has stopped pushing state.
const SLOW = 'sha256:' + '3c'.repeat(32)
const SLOW_BUCKET_MS = 4_500
const PROVIDER_NAME = 'E2E provider'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function startProvider (asked: string[]): Promise<{ server: Server, port: number }> {
  const files = new Map<string, string>([
    ['/score/provider.json', JSON.stringify({ standard: 'orivon-web3-score/1', name: PROVIDER_NAME, bucketHexChars: 2 })],
    [`/score/website/${bucketOf(SLOW)}.json`, bucketFile(SLOW, 4)],
    [`/score/website/${bucketOf(SCORED)}.json`, JSON.stringify({
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
    })]
  ])
  return await listen((req, res) => {
    asked.push(req.url ?? '')
    const body = files.get(req.url ?? '')
    const answer = (): void => {
      if (body === undefined) res.writeHead(404).end()
      else res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    }
    if (req.url === `/score/website/${bucketOf(SLOW)}.json`) setTimeout(answer, SLOW_BUCKET_MS)
    else answer()
  })
}

it('the provider chosen in Settings judges a checked page, is named wherever its level shows, and never sees the identity', async () => {
  await runPhase('score-provider', async (check) => {
    const asked: string[] = []
    const provider = await startProvider(asked)
    const scored = await startSite('scored fixture', SCORED)
    const unscored = await startSite('unscored fixture', UNSCORED)
    const slow = await startSite('slow fixture', SLOW)
    const address = `http://127.0.0.1:${String(provider.port)}/score`
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        env: { ORIVON_DEV_ORIGINS: '1' },
        seedProfile: async (dir: string) => {
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'web3.scoreProvider': address } }))
        }
      })

      await navigateToFixture(app, `http://127.0.0.1:${String(scored.port)}/`, 'scored fixture')
      const judged = await readScore(app, '3')
      check(`the shield paints the judged Level 3, marked "Web2.5" (${judged.level}/${judged.mark})`, judged.level === '3' && judged.mark === 'Web2.5')
      check(`its label names the provider and developer mode (${judged.label})`, judged.label === `Website level 3 (Web2.5), judged by ${PROVIDER_NAME} (developer mode)`)
      check(`the Web3 Score page leads with Website level 3 (${judged.heading})`, judged.heading === 'Website level 3')
      check('the page names the provider and its address as the judge', judged.text.includes(`judged by ${PROVIDER_NAME} (${address})`))
      check('the page keeps what Orivon observed beside the judgement', judged.text.includes('Observed by this browser: Level 2'))
      check('the page shows the provider\'s summary', judged.text.includes('Open source, and runs only its own code.'))
      check('the page lists the provider\'s operations', judged.headings.includes(`Operations, judged by ${PROVIDER_NAME}`) && judged.text.includes('Sign a transfer + Privacy'))
      check('the page lists the provider\'s connections', judged.headings.includes(`Connections, judged by ${PROVIDER_NAME}`) && judged.text.includes('Price API'))

      await navigateToFixture(app, `http://127.0.0.1:${String(unscored.port)}/`, 'unscored fixture')
      const plain = await readScore(app, '2')
      check(`a page the provider has no score for keeps Level 2 (${plain.level}/${plain.mark})`, plain.level === '2' && plain.mark === 'Web2.5')
      check(`its label names no provider (${plain.label})`, !plain.label.includes('judged'))
      check('its page says the provider has no score for it', plain.text.includes(`${PROVIDER_NAME} has no score for this page`))

      await navigateToFixture(app, `http://127.0.0.1:${String(slow.port)}/`, 'slow fixture')
      const late = await readScore(app, '4')
      check(`a provider slower than the shield's wait still lands: Level 4 once it answers (${late.level})`, late.level === '4' && late.label.includes(`judged by ${PROVIDER_NAME}`))
      check(`the open page shows it too (${late.heading})`, late.heading === 'Website level 4')

      const leaked = asked.filter((url) => [SCORED, UNSCORED, SLOW].some((id) => url.includes(id.slice(7))))
      check(`the provider was asked only for its description and buckets (${asked.join(', ')})`, leaked.length === 0 && asked.every((url) => /^\/score\/(provider\.json|website\/[0-9a-f]{2}\.json)$/.test(url)))
      expect([judged.level, plain.level, late.level, leaked.length]).toEqual(['3', '2', '4', 0])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      for (const { server } of [provider, scored, unscored, slow]) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
}, TEST_TIMEOUT_MS)
