// The namespace sweep: which chrome.* members an extension sees, per context.
// test/apps/extensions/api-sweep/ asks for every API permission Orivon serves
// and reports `typeof chrome.<ns>.<member>` from its service worker, an
// extension page and a content script. Each namespace has ONE file in
// api-sweep/expected/<ns>.json, owned by the lane that builds it:
//   { "worker": { member: kind }, "page": { ... }, "content": { ... } }
// A context missing from the file must not see the namespace at all, and no
// file means no context sees it. A lane that adds or removes a member edits
// its own file, so a change to chrome.* is always a visible diff.
//
// A second test opens DevTools on a tab: the extension's devtools_page runs in
// the frontend's subframe and chrome.devtools.panels.create must call back.
//
// Run with `npm run test:e2e`, or through scripts/run-headless.mjs with
// test/vitest.e2e.config.ts after scripts/build-e2e.mjs.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { FIXTURES_DIR } from './extensions-fixtures.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const FIXTURE_DIR = join(FIXTURES_DIR, 'api-sweep')
const EXPECTED_DIR = join(FIXTURE_DIR, 'expected')
const TEST_TIMEOUT_MS = 150_000

type Members = Record<string, string>
interface Described { type: string, members?: Members }
interface SweepReport { href: string, chromeKeys: string[], ns: Record<string, Described> }
type Context = 'worker' | 'page' | 'content'
type Expected = Partial<Record<Context, Members>>

const servers: Server[] = []

afterAll(async () => {
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function startFixtureServer (): Promise<string> {
  const created = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>sweep-fixture</title><body>sweep</body>')
  })
  servers.push(created)
  await new Promise<void>((resolve) => { created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return `http://127.0.0.1:${String(address.port)}/`
}

function readExpected (): Map<string, Expected> {
  const byNamespace = new Map<string, Expected>()
  for (const file of readdirSync(EXPECTED_DIR)) {
    if (!file.endsWith('.json')) continue
    byNamespace.set(file.slice(0, -'.json'.length), JSON.parse(readFileSync(join(EXPECTED_DIR, file), 'utf8')) as Expected)
  }
  return byNamespace
}

/** The namespace names sweep.js lists. */
function listedNamespaces (): Set<string> {
  const source = readFileSync(join(FIXTURE_DIR, 'sweep.js'), 'utf8')
  const body = /const NAMESPACES = \[([\s\S]*?)\]/.exec(source)?.[1] ?? ''
  return new Set(body.split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter((item) => item !== ''))
}

function sorted (members: Members): Members {
  return Object.fromEntries(Object.entries(members).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** One line per difference between what a context reported and what its
 * namespace files say. */
function differences (context: Context, report: SweepReport, expected: Map<string, Expected>): string[] {
  const lines: string[] = []
  for (const [name, described] of Object.entries(report.ns)) {
    const want = expected.get(name)?.[context]
    if (want === undefined) {
      if (described.type !== 'undefined') lines.push(`${context}: chrome.${name} exists (${described.type}) but expected/${name}.json does not list it for ${context}`)
      continue
    }
    if (described.type === 'undefined') {
      lines.push(`${context}: chrome.${name} is undefined, expected members ${Object.keys(want).join(', ')}`)
      continue
    }
    const got = sorted(described.members ?? {})
    const wanted = sorted(want)
    for (const member of new Set([...Object.keys(got), ...Object.keys(wanted)])) {
      if (got[member] !== wanted[member]) {
        lines.push(`${context}: chrome.${name}.${member} is ${got[member] ?? 'missing'}, expected ${wanted[member] ?? 'missing'}`)
      }
    }
  }
  return lines
}

async function launchWithSweep (onId: (id: string) => void): Promise<Awaited<ReturnType<typeof launchElectron>>> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    seedProfile: async (dir) => { onId(seedFixture(dir, 'api-sweep')) },
    sandbox: true
  })
  const loaded = await waitFor(async () => (await app.evaluate(
    ({ session }) => session.defaultSession.extensions.getAllExtensions().length
  )) === 1)
  if (!loaded) throw new Error('the api-sweep fixture did not load at boot')
  await waitRecovered(app)
  return app
}

it('reports the same chrome.* surface per context as the expected files say', async () => {
  const fixtureUrl = await startFixtureServer()

  await runPhase('extensions api sweep', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchWithSweep((id) => { extensionId = id })

      const expected = readExpected()
      const listed = listedNamespaces()
      const unknown = [...expected.keys()].filter((name) => !listed.has(name))
      check('every expected file names a namespace sweep.js lists', unknown.length === 0, unknown.join(', '))

      const pageWc = await openExtensionPage(app, extensionId, 'page.html')
      const pageJson = await app.evaluate(async ({ webContents }, id: number) =>
        await webContents.fromId(id)?.executeJavaScript('JSON.stringify(globalThis.__sweep())', true), pageWc)
      const pageReport = JSON.parse(String(pageJson)) as SweepReport
      const pageDiffs = differences('page', pageReport, expected)
      check('the extension page sees exactly the expected members', pageDiffs.length === 0, pageDiffs.join('\n'))

      const reply = await rpc(app, pageWc, '__sweep')
      check('the service worker answered the sweep', reply.ok, JSON.stringify(reply).slice(0, 300))
      if (reply.ok) {
        const workerDiffs = differences('worker', reply.result as SweepReport, expected)
        check('the service worker sees exactly the expected members', workerDiffs.length === 0, workerDiffs.join('\n'))
      }

      const view = await navigateToFixture(app, fixtureUrl, 'sweep-fixture')
      const published = await waitFor(async () => (await evaluateRetrying(view, () => document.documentElement.dataset['orivonSweep'] ?? '')) !== '')
      check('the content script published its sweep', published)
      if (published) {
        const sweepJson = await evaluateRetrying(view, () => document.documentElement.dataset['orivonSweep'] ?? '')
        const contentDiffs = differences('content', JSON.parse(sweepJson) as SweepReport, expected)
        check('the content script sees exactly the expected members', contentDiffs.length === 0, contentDiffs.join('\n'))
      }

      const known = new Set(Object.keys(pageReport.ns))
      const stray = pageReport.chromeKeys.filter((key) => !known.has(key))
      check('chrome has no top-level key sweep.js does not list', stray.length === 0, stray.join(', '))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)

it('keeps chrome.devtools usable in a devtools_page, so panels.create calls back', async () => {
  const fixtureUrl = await startFixtureServer()

  await runPhase('extensions devtools page', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchWithSweep((id) => { extensionId = id })
      const live = app
      await navigateToFixture(app, fixtureUrl, 'sweep-fixture')
      const pageWc = await openExtensionPage(app, extensionId, 'page.html')

      await app.evaluate(({ webContents }, url: string) => {
        const tab = webContents.getAllWebContents().find((wc) => wc.getURL() === url)
        tab?.openDevTools({ mode: 'detach', activate: false })
      }, fixtureUrl)

      const read = async (): Promise<{ created?: boolean, reachable?: boolean } | undefined> => {
        const reply = await rpc(live, pageWc, 'chrome.storage.local.get', ['devtoolsPanel'])
        return reply.ok ? (reply.result as { devtoolsPanel?: { created?: boolean, reachable?: boolean } }).devtoolsPanel : undefined
      }
      const called = await waitFor(async () => (await read())?.created === true, 30_000)
      check('chrome.devtools.panels.create called back in the devtools page', called, JSON.stringify(await read()))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
